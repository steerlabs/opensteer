import type { DesktopBrowserExtension } from "@opensteer/protocol/desktop";
import {
  readPrivateFileText,
  replacePrivateFileAtomically,
} from "@opensteer/shared/atomicPrivateFile";
import {
  BaseWindow,
  BrowserWindow,
  dialog,
  type ContextMenuParams,
  type Extension,
  type MenuItem,
  type Session,
  type WebContents,
} from "electron";
import { realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  ChromeExtensionApis,
  resolveExtensionIconImage,
  type AnchorRect,
  type ManagedTab,
} from "./extensions/chrome-apis.js";
import { ExtensionRouter } from "./extensions/extension-router.js";
import {
  assertExtensionId,
  compareVersions,
  isExtensionId,
  isRecord,
  permissionWarnings,
  permissionsExpanded,
  resolveExtensionPageUrl,
  siteAccess,
} from "./extensions/permissions.js";
import {
  WebStoreController,
  applyStoreUpdateIfSafe,
  crxDownloadUrl,
  discoverStoreExtensions,
  ensureStoreManifestWebStoreExclusion,
  fetchStoreUpdates,
  stageCrx3FromUrl,
  writeStoreLedger,
  type StagedCrxInstall,
  type StoreLedger,
  type WebStoreInstallRequest,
} from "./extensions/web-store.js";

export { isExtensionId, permissionWarnings, siteAccess };
export type { AnchorRect, ManagedTab as ExtensionTab };

const UNPACKED_LIST_FILE = "unpacked.json";
const API_PRELOAD_ID = "opensteer-chrome-extension-api";
/** Chrome's own cadence for Web Store update checks. */
const UPDATE_INTERVAL_MS = 5 * 60 * 60 * 1_000;
const MAX_UNPACKED = 256;
const UnpackedListSchema = z.array(z.string().min(1).max(4_096)).max(MAX_UNPACKED);

const sessions = new WeakMap<Session, ProfileExtensions>();
const closingSessions = new WeakMap<Session, Promise<void>>();
const MAX_EXTENSION_NAME_LEN = 256;
const MAX_EXTENSION_VERSION_LEN = 64;
const MAX_OPTIONS_URL_LEN = 2_048;

function clampText(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

export interface ProfileExtensionsPreloads {
  readonly apiPreloadPath: string;
  readonly webStorePreloadPath: string;
}

export interface ProfileExtensionsOptions {
  readonly preloads?: ProfileExtensionsPreloads;
  readonly canAccessCookies?: () => boolean;
}

export function extensionPreloadPaths(siblingPreloadPath?: string): ProfileExtensionsPreloads {
  const dir = siblingPreloadPath ? path.dirname(siblingPreloadPath) : import.meta.dirname;
  return {
    apiPreloadPath: path.join(dir, "chrome-extension-api-preload.cjs"),
    webStorePreloadPath: path.join(dir, "chrome-web-store-preload.cjs"),
  };
}

/**
 * Chrome extensions of one saved profile, kept as Chrome keeps them: Web Store
 * extensions under `<profile>/Extensions/<id>/<version>_0` tracked by `store.json`,
 * and unpacked folders loaded in place from paths listed in `unpacked.json`.
 */
export class ProfileExtensions {
  readonly #session: Session;
  readonly #directory: string;
  readonly #preloads: ProfileExtensionsPreloads;
  readonly #canAccessCookies: () => boolean;
  readonly #tabs = new Map<WebContents, { readonly tab: ManagedTab; window: BaseWindow | null }>();
  readonly #extensionWindows = new Set<BaseWindow>();
  readonly #listeners = new Set<() => void>();
  #firstUpdateTimer: NodeJS.Timeout | null = null;
  #updateInterval: NodeJS.Timeout | null = null;
  /** Durable active Store installs: extensionId -> { version, dirName }. */
  #storeLedger: StoreLedger = {};
  readonly #ready: Promise<void>;
  #attached: {
    readonly router: ExtensionRouter;
    readonly apis: ChromeExtensionApis;
    readonly webStore: WebStoreController;
    readonly sharedWindow: BaseWindow;
    readonly onChanged: () => void;
  } | null = null;
  #active: ManagedTab | null = null;
  #openingWindow: BaseWindow | null = null;
  #unpacked: readonly string[] = [];
  /** Every load, Store install, update, uninstall and close runs through one queue. */
  #mutation: Promise<unknown> = Promise.resolve();
  #closed = false;

  /** The extensions of a saved profile's Session; null for Guest and the app's own Sessions. */
  static of(session: Session): ProfileExtensions | null {
    const current = sessions.get(session) ?? null;
    return current && !current.#closed ? current : null;
  }

  static for(
    session: Session,
    profileDirectory: string,
    options: ProfileExtensionsOptions = {},
  ): ProfileExtensions {
    let extensions = sessions.get(session);
    if (!extensions || extensions.#closed) {
      extensions = new ProfileExtensions(
        session,
        path.join(profileDirectory, "Extensions"),
        options.preloads ?? extensionPreloadPaths(),
        options.canAccessCookies ?? (() => true),
      );
      sessions.set(session, extensions);
    }
    return extensions;
  }

  private constructor(
    session: Session,
    directory: string,
    preloads: ProfileExtensionsPreloads,
    canAccessCookies: () => boolean,
  ) {
    this.#session = session;
    this.#directory = directory;
    this.#preloads = preloads;
    this.#canAccessCookies = canAccessCookies;
    // A profile whose extensions fail to load still opens without them.
    this.#ready = this.#mutate(() => this.#start()).catch((error: unknown) =>
      reportFailure(directory, error),
    );
  }

  /** Resolves once installed extensions have loaded so first pages run their content scripts. */
  ready(): Promise<void> {
    return this.#ready;
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  addTab(tab: ManagedTab): () => void {
    const window = this.#openingWindow ?? this.#attached?.sharedWindow ?? null;
    this.#tabs.set(tab.contents, { tab, window });
    const removeApiTab = window ? this.#attached?.apis.addTab(tab, window) : undefined;
    this.#active ??= tab;
    return () => {
      const entry = this.#tabs.get(tab.contents);
      this.#tabs.delete(tab.contents);
      removeApiTab?.();
      if (
        entry?.window &&
        this.#extensionWindows.has(entry.window) &&
        !this.#tabsOf(entry.window).length
      ) {
        this.#dropExtensionWindow(entry.window);
      }
      if (this.#active === tab) {
        const next = [...this.#tabs.values()].find(
          ({ tab: candidate }) => !candidate.contents.isDestroyed(),
        );
        this.#active = null;
        if (next) this.selectTab(next.tab.contents);
      }
    };
  }

  /** The person is looking at this tab: it is the one extensions act on. */
  selectTab(contents: WebContents): void {
    const entry = this.#tabs.get(contents);
    if (!entry || contents.isDestroyed() || entry.window?.isDestroyed()) return;
    this.#active = entry.tab;
    this.#attached?.apis.selectTab(contents);
  }

  /** Lists installed extensions with their resolved per-tab toolbar actions for `tabContents`. */
  list(tabContents?: WebContents): DesktopBrowserExtension[] {
    const apis = this.#attached?.apis;
    return this.#loaded()
      .map((extension) => {
        const options = optionsPage(extension);
        const rawOptionsUrl = options ? resolveExtensionPageUrl(extension.id, options) : null;
        const optionsUrl =
          rawOptionsUrl && rawOptionsUrl.length <= MAX_OPTIONS_URL_LEN ? rawOptionsUrl : null;
        const rawName = typeof extension.name === "string" ? extension.name.trim() : "";
        const name = clampText(rawName || extension.id, MAX_EXTENSION_NAME_LEN);
        const rawVersion = typeof extension.version === "string" ? extension.version.trim() : "";
        const version = clampText(rawVersion || "0", MAX_EXTENSION_VERSION_LEN);
        let icon: string | null = null;
        let action: DesktopBrowserExtension["action"] = null;
        try {
          icon = apis?.extensionIconDataUrl(extension) ?? null;
          action = apis?.resolveAction(extension, tabContents) ?? null;
        } catch {
          // One malformed extension icon/action must never break management of the others.
        }
        return {
          id: extension.id,
          name,
          version,
          icon,
          action,
          optionsUrl,
          unpacked: this.#isUnpacked(extension),
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  /** `Extensions.getExtensions`, in CDP's shape. */
  describe(): { id: string; name: string; version: string; path: string; enabled: boolean }[] {
    return this.#loaded().map((extension) => ({
      id: extension.id,
      name: extension.name,
      version: extension.version,
      path: extension.path,
      enabled: true,
    }));
  }

  /** Clicks or right-clicks an extension's toolbar button anchored directly to `hostWindow`. */
  activateAction(options: {
    readonly extensionId: string;
    readonly tabContents: WebContents;
    readonly hostWindow: BaseWindow;
    readonly eventType: "click" | "contextmenu";
    readonly anchorRect: AnchorRect;
  }): void {
    this.#assertAttached();
    this.#attached!.apis.activateAction(options);
  }

  /** `Extensions.triggerAction`, for CDP agents. */
  async triggerAction(extensionId: string, tabContents?: WebContents): Promise<void> {
    assertExtensionId(extensionId);
    await this.#ready;
    this.#assertAttached();
    this.#attached!.apis.triggerAction(extensionId, tabContents);
  }

  /**
   * `Extensions.loadUnpacked`: loads the folder in place, as Chrome's Load unpacked
   * does, and keeps it across restarts. Reloading the same folder keeps its ID and storage.
   */
  async loadUnpacked(requested: string): Promise<string> {
    if (!path.isAbsolute(requested) || path.resolve(requested) !== requested) {
      throw new Error("Extension path must be an absolute, normalized folder path.");
    }
    const folder = await realpath(requested).catch(() => requested);
    const manifestStat = await stat(path.join(folder, "manifest.json")).catch(() => null);
    if (!manifestStat?.isFile()) throw new Error(`No manifest.json in ${requested}.`);
    await this.#ready;
    return this.#mutate(async () => {
      this.#assertAttached();
      const known = this.#unpacked.includes(folder);
      if (!known && this.#unpacked.length >= MAX_UNPACKED) {
        throw new Error(`A profile keeps at most ${MAX_UNPACKED} unpacked extensions.`);
      }
      for (const extension of this.#loaded()) {
        if (extension.path === folder) this.#session.extensions.removeExtension(extension.id);
      }
      const extension = await this.#session.extensions.loadExtension(folder);
      if (this.#storeLedger[extension.id]) {
        const nextLedger = { ...this.#storeLedger };
        delete nextLedger[extension.id];
        await this.#saveStoreLedger(nextLedger);
      }
      if (!known) {
        try {
          await this.#saveUnpacked([...this.#unpacked, folder]);
        } catch (error) {
          this.#session.extensions.removeExtension(extension.id);
          throw error;
        }
      }
      return extension.id;
    });
  }

  /** Removes an extension, and deletes a Store extension's managed folder. */
  async uninstall(extensionId: string): Promise<void> {
    assertExtensionId(extensionId);
    await this.#ready;
    await this.#mutate(async () => {
      this.#assertAttached();
      const extension = this.#session.extensions.getExtension(extensionId);
      if (!extension) throw new Error(`No extension ${extensionId} in this profile.`);
      if (this.#isUnpacked(extension)) {
        await this.#saveUnpacked(this.#unpacked.filter((folder) => folder !== extension.path));
        this.#session.extensions.removeExtension(extensionId);
      } else {
        const nextLedger = { ...this.#storeLedger };
        delete nextLedger[extensionId];
        await this.#saveStoreLedger(nextLedger);
        this.#session.extensions.removeExtension(extensionId);
        await rm(path.join(this.#directory, extensionId), { recursive: true, force: true });
      }
    });
  }

  /** Installs a Store package by ID (used by smoke tests and programmatic installs). */
  async installFromStore(
    extensionId: string,
    expectedManifest?: Record<string, unknown>,
  ): Promise<Extension> {
    assertExtensionId(extensionId);
    await this.#ready;
    const staged = await stageCrx3FromUrl(
      crxDownloadUrl(extensionId),
      extensionId,
      expectedManifest,
    );
    return this.#commitStagedInstall(staged);
  }

  /** Asks the person in `window` to confirm, as Chrome does, then removes the extension. */
  async confirmUninstall(extensionId: string, window: BaseWindow): Promise<void> {
    const extension = this.#session.extensions.getExtension(extensionId);
    if (!extension) return;
    const icon = resolveExtensionIconImage(extension);
    const { response } = await dialog.showMessageBox(window, {
      buttons: ["Remove", "Cancel"],
      cancelId: 1,
      defaultId: 0,
      ...(icon ? { icon } : {}),
      message: `Remove “${extension.name}”?`,
      type: "none",
    });
    if (response === 0) await this.uninstall(extensionId);
  }

  /** Opens the Chrome Web Store in an isolated, extension-free window bound to this profile. */
  openWebStore(parent?: BaseWindow, url?: string): BrowserWindow {
    this.#assertAttached();
    return this.#attached!.webStore.openWindow({
      ...(parent ? { parent } : {}),
      ...(url ? { url } : {}),
      onOpenExternalUrl: (externalUrl) => {
        try {
          this.#openTab(externalUrl, true, null);
        } catch {
          // Ignore when no browser tab is open in this profile.
        }
      },
    });
  }

  /** Extension items for a page's right-click context menu. */
  contextMenuItems(contents: WebContents, params: ContextMenuParams): MenuItem[] {
    if (!this.#attached || !this.#tabs.has(contents)) return [];
    return this.#attached.apis.contextMenuItems(contents, params);
  }

  /** The profile is being retired or deleted: stop updates, dispose IPC, and unload extensions. */
  async close(): Promise<void> {
    this.#closed = true;
    const finishClose = (async () => {
      if (this.#firstUpdateTimer) {
        clearTimeout(this.#firstUpdateTimer);
        this.#firstUpdateTimer = null;
      }
      if (this.#updateInterval) {
        clearInterval(this.#updateInterval);
        this.#updateInterval = null;
      }
      await this.#mutation;
      const attached = this.#attached;
      this.#attached = null;
      if (!attached) return;
      this.#session.extensions.off("extension-loaded", attached.onChanged);
      this.#session.extensions.off("extension-unloaded", attached.onChanged);
      attached.webStore.dispose();
      attached.apis.dispose();
      attached.router.dispose();
      for (const win of this.#extensionWindows) {
        if (!win.isDestroyed()) win.destroy();
      }
      this.#extensionWindows.clear();
      if (!attached.sharedWindow.isDestroyed()) attached.sharedWindow.destroy();
      const extensions = this.#session.extensions;
      for (const extension of extensions.getAllExtensions()) {
        extensions.removeExtension(extension.id);
      }
      this.#storeLedger = {};
    })();
    closingSessions.set(this.#session, finishClose);
    try {
      await finishClose;
    } finally {
      if (closingSessions.get(this.#session) === finishClose) {
        closingSessions.delete(this.#session);
      }
    }
  }

  async #commitStagedInstall(staged: StagedCrxInstall): Promise<Extension> {
    try {
      return await this.#mutate(async () => {
        this.#assertAttached();
        const existing = this.#session.extensions.getExtension(staged.extensionId);
        if (existing) {
          await staged.cleanup();
          return existing;
        }
        // Ensure store.json exists BEFORE publishing any directory on disk so a crash
        // between commit and ledger update can never trigger a legacy directory scan on restart.
        await this.#saveStoreLedger(this.#storeLedger);
        const committed = await staged.commit(this.#directory);
        let loaded: Extension | null = null;
        try {
          loaded = await this.#session.extensions.loadExtension(committed.path);
          await this.#saveStoreLedger({
            ...this.#storeLedger,
            [loaded.id]: { version: staged.version, dirName: committed.dirName },
          });
          return loaded;
        } catch (error) {
          if (loaded) this.#session.extensions.removeExtension(loaded.id);
          await rm(committed.path, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
      });
    } catch (error) {
      await staged.cleanup();
      throw error;
    }
  }

  #mutate<T>(change: () => Promise<T>): Promise<T> {
    const next = this.#mutation.then(change);
    this.#mutation = next.catch(() => undefined);
    return next;
  }

  async #start(): Promise<void> {
    // Wait for any retiring controller on the same Session to finish unloading extensions first.
    await closingSessions.get(this.#session)?.catch(() => undefined);
    if (this.#closed) return;
    this.#registerApiPreload();

    const sharedWindow = new BaseWindow({ show: false, width: 1_280, height: 800 });
    const router = new ExtensionRouter(this.#session);
    const apis = new ChromeExtensionApis({
      session: this.#session,
      router,
      sharedWindow,
      openTab: (url, active, targetWindow) => this.#openTab(url, active, targetWindow),
      createExtensionWindow: (urls, focused) => {
        const created = new BaseWindow({ show: false, width: 1_280, height: 800 });
        this.#extensionWindows.add(created);
        apis.addWindow(created);
        for (const url of urls) this.#openTab(url, focused, created);
        return created;
      },
      closeExtensionWindow: (closing) => {
        if (closing === sharedWindow) return false;
        const tabs = this.#tabsOf(closing);
        for (const { tab } of tabs) tab.close();
        if (!tabs.length) this.#dropExtensionWindow(closing);
        return true;
      },
      onActionChanged: () => this.#notifyListeners(),
      isClosed: () => this.#closed,
      canAccessCookies: () => !this.#closed && this.#canAccessCookies(),
    });
    const webStore = new WebStoreController({
      profileSession: this.#session,
      preloadPath: this.#preloads.webStorePreloadPath,
      confirmInstall: (request) => this.#confirmInstall(request),
      commitStagedInstall: (staged) => this.#commitStagedInstall(staged),
    });

    const onChanged = () => this.#notifyListeners();
    this.#attached = { router, apis, webStore, sharedWindow, onChanged };

    for (const entry of this.#tabs.values()) {
      entry.window = sharedWindow;
      apis.addTab(entry.tab, sharedWindow);
    }
    if (this.#active) apis.selectTab(this.#active.contents);

    this.#session.extensions.on("extension-loaded", onChanged);
    this.#session.extensions.on("extension-unloaded", onChanged);

    // Load Store installs and unpacked folders in parallel so startup stays fast.
    const [storeCandidates, unpackedFolders] = await Promise.all([
      discoverStoreExtensions(this.#directory),
      this.#readUnpacked(),
    ]);
    if (this.#closed) return;
    this.#unpacked = unpackedFolders;

    const loadedLedger: StoreLedger = {};
    const storeLoads = storeCandidates.map(async (candidate) => {
      if (this.#closed) return;
      const existing = this.#session.extensions.getExtension(candidate.id);
      if (existing) {
        loadedLedger[candidate.id] = {
          version: candidate.version,
          dirName: path.basename(candidate.path),
        };
        return;
      }
      try {
        await ensureStoreManifestWebStoreExclusion(candidate.path);
        const loaded = await this.#session.extensions.loadExtension(candidate.path);
        if (!this.#closed) {
          loadedLedger[loaded.id] = {
            version: candidate.version,
            dirName: path.basename(candidate.path),
          };
        }
      } catch (error) {
        reportFailure(candidate.path, error);
      }
    });

    const survivingUnpacked: (string | null)[] = Array.from(
      { length: unpackedFolders.length },
      () => null,
    );
    const unpackedLoads = unpackedFolders.map(async (folder, index) => {
      if (this.#closed) return;
      try {
        await this.#session.extensions.loadExtension(folder);
        survivingUnpacked[index] = folder;
      } catch (error) {
        reportFailure(folder, error);
      }
    });

    await Promise.all([...storeLoads, ...unpackedLoads]);
    if (this.#closed) return;

    this.#storeLedger = loadedLedger;
    // Always persist the ledger (even when empty) so future startups never fall back to legacy scanning.
    await this.#saveStoreLedger(loadedLedger).catch((error: unknown) =>
      reportFailure(this.#directory, error),
    );

    const kept = survivingUnpacked.filter((item): item is string => item !== null);
    if (kept.length !== this.#unpacked.length) {
      await this.#saveUnpacked(kept).catch((error: unknown) =>
        reportFailure(this.#directory, error),
      );
    }

    const scheduleUpdateCheck = () => {
      if (this.#closed) return;
      void this.#checkForStoreUpdates().catch((error: unknown) =>
        reportFailure(this.#directory, error),
      );
    };
    const first = setTimeout(scheduleUpdateCheck, 60_000);
    const later = setInterval(scheduleUpdateCheck, UPDATE_INTERVAL_MS);
    first.unref();
    later.unref();
    this.#firstUpdateTimer = first;
    this.#updateInterval = later;
  }

  async #checkForStoreUpdates(): Promise<void> {
    if (this.#closed || !this.#attached) return;
    const storeOwned = this.#loaded().filter(
      (extension) => Boolean(this.#storeLedger[extension.id]) && !this.#isUnpacked(extension),
    );
    if (!storeOwned.length) return;
    const updates = await fetchStoreUpdates(storeOwned);
    for (const update of updates) {
      if (this.#closed) return;
      try {
        await applyStoreUpdateIfSafe({
          update,
          commitUnderLock: (staged) =>
            this.#mutate(async () => {
              if (this.#closed || !this.#attached) {
                await staged.cleanup();
                return "skipped-stale";
              }
              const liveRecord = this.#storeLedger[staged.extensionId];
              const liveExt = this.#session.extensions.getExtension(staged.extensionId);
              if (!liveRecord || !liveExt || this.#isUnpacked(liveExt)) {
                await staged.cleanup();
                return "skipped-stale";
              }
              // Re-check version advance & permissions against the CURRENT live extension under lock.
              if (compareVersions(liveExt.version, staged.version) >= 0) {
                await staged.cleanup();
                return "skipped-stale";
              }
              if (permissionsExpanded(liveExt.manifest, staged.manifest)) {
                await staged.cleanup();
                return "skipped-permissions";
              }
              // Ensure store.json exists durably on disk BEFORE publishing any updated directory
              // so a crash after commit can never resurrect an uncommitted version via legacy scan.
              await this.#saveStoreLedger(this.#storeLedger);
              const oldPath = liveExt.path;
              const committed = await staged.commit(this.#directory);
              this.#session.extensions.removeExtension(staged.extensionId);
              try {
                await this.#session.extensions.loadExtension(committed.path);
                await this.#saveStoreLedger({
                  ...this.#storeLedger,
                  [staged.extensionId]: { version: staged.version, dirName: committed.dirName },
                });
              } catch (error) {
                // Roll back disk and restore the previous working extension.
                if (this.#session.extensions.getExtension(staged.extensionId)) {
                  this.#session.extensions.removeExtension(staged.extensionId);
                }
                await rm(committed.path, { recursive: true, force: true }).catch(() => undefined);
                await this.#session.extensions.loadExtension(oldPath).catch(() => undefined);
                throw error;
              }
              if (path.resolve(oldPath) !== path.resolve(committed.path)) {
                await rm(oldPath, { recursive: true, force: true }).catch(() => undefined);
              }
              return "updated";
            }),
        });
      } catch (error) {
        reportFailure(update.id, error);
      }
    }
  }

  #registerApiPreload(): void {
    for (const preload of this.#session.getPreloadScripts()) {
      if (preload.id === API_PRELOAD_ID || preload.id === `${API_PRELOAD_ID}-sw`) {
        this.#session.unregisterPreloadScript(preload.id);
      }
    }
    this.#session.registerPreloadScript({
      id: API_PRELOAD_ID,
      type: "frame",
      filePath: this.#preloads.apiPreloadPath,
    });
    this.#session.registerPreloadScript({
      id: `${API_PRELOAD_ID}-sw`,
      type: "service-worker",
      filePath: this.#preloads.apiPreloadPath,
    });
  }

  #notifyListeners(): void {
    if (this.#closed) return;
    for (const listener of this.#listeners) listener();
  }

  #dropExtensionWindow(window: BaseWindow): void {
    this.#extensionWindows.delete(window);
    if (!window.isDestroyed()) window.destroy();
  }

  #tabsOf(window: BaseWindow): { readonly tab: ManagedTab }[] {
    return [...this.#tabs.values()].filter((entry) => entry.window === window);
  }

  async #confirmInstall(request: WebStoreInstallRequest): Promise<boolean> {
    if (this.#closed) return false;
    const window = request.window;
    if (!window || window.isDestroyed()) return false;
    const warnings = permissionWarnings(request.manifest);
    const detail = warnings.length ? warnings.join("\n") : undefined;
    const { response } = await dialog.showMessageBox(window, {
      buttons: ["Add Extension", "Cancel"],
      cancelId: 1,
      defaultId: 0,
      ...(detail ? { detail } : {}),
      ...(request.icon.isEmpty() ? {} : { icon: request.icon.resize({ width: 64 }) }),
      message: `Add “${request.localizedName}”?`,
      type: "none",
    });
    return response === 0 && !this.#closed;
  }

  #isUnpacked(extension: Extension): boolean {
    if (this.#unpacked.includes(extension.path)) return true;
    return !this.#storeLedger[extension.id];
  }

  #assertAttached(): void {
    if (this.#closed || !this.#attached) {
      throw new Error("Extensions are unavailable in this browser profile.");
    }
  }

  #loaded(): Extension[] {
    return this.#attached && !this.#closed ? this.#session.extensions.getAllExtensions() : [];
  }

  #openTab(
    url: string | undefined,
    active: boolean,
    window: BaseWindow | null = null,
  ): WebContents {
    const from = this.#active ?? this.#tabs.values().next().value?.tab;
    if (!from) throw new Error("This profile has no open tab to open another beside.");
    this.#openingWindow = window && window !== this.#attached?.sharedWindow ? window : null;
    try {
      return from.open(url ?? "about:blank", active);
    } finally {
      this.#openingWindow = null;
    }
  }

  async #saveStoreLedger(next: StoreLedger): Promise<void> {
    await writeStoreLedger(this.#directory, next);
    this.#storeLedger = next;
  }

  async #readUnpacked(): Promise<string[]> {
    const file = path.join(this.#directory, UNPACKED_LIST_FILE);
    const text = await readPrivateFileText(file, 1_024 * 1_024, {
      invalid: () => new Error("The unpacked extensions list is unreadable."),
      exposed: () => new Error("The unpacked extensions list is not private."),
    });
    if (!text) return [];
    const parsed = UnpackedListSchema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new Error("The unpacked extensions list is malformed.");
    return parsed.data.filter((folder) => path.isAbsolute(folder));
  }

  async #saveUnpacked(next: readonly string[]): Promise<void> {
    const content = `${JSON.stringify(UnpackedListSchema.parse(next), null, 2)}\n`;
    await replacePrivateFileAtomically(path.join(this.#directory, UNPACKED_LIST_FILE), content);
    this.#unpacked = next;
  }
}

function optionsPage(extension: Extension): string | null {
  const manifest: unknown = extension.manifest;
  if (!isRecord(manifest)) return null;
  const ui = manifest.options_ui;
  const page = isRecord(ui) && typeof ui.page === "string" ? ui.page : manifest.options_page;
  return typeof page === "string" && page.length > 0 ? page.replace(/^\/+/u, "") : null;
}

function reportFailure(location: string, error: unknown): void {
  process.stderr.write(
    `${JSON.stringify({
      event: "browser.extension.load-failed",
      location: path.basename(location),
      error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    })}\n`,
  );
}
