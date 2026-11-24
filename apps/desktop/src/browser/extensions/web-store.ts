import {
  readPrivateFileText,
  replacePrivateFileAtomically,
} from "@opensteer/shared/atomicPrivateFile";
import { readBoundedResponse } from "@opensteer/shared/boundedJson";
import {
  BrowserWindow,
  app,
  ipcMain,
  nativeImage,
  session as electronSession,
  type BaseWindow,
  type Extension,
  type IpcMainInvokeEvent,
  type NativeImage,
  type Session,
  type WebFrameMain,
} from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  CHROME_WEB_STORE_PUBLISHER_KEY_HASHES,
  MAX_CRX_BYTES,
  injectWebStoreContentScriptExclusions,
  parseAndVerifyCrx3,
  unpackCrx3,
} from "./crx3.js";
import {
  assertExtensionId,
  assertExtensionVersion,
  compareVersions,
  declaredHostPermissions,
  declaredPermissions,
  isExtensionId,
  isRecord,
  permissionsExpanded,
  resolveExtensionFile,
  sameApprovedManifest,
} from "./permissions.js";

export const CHROME_WEB_STORE_ORIGIN = "https://chromewebstore.google.com";
const GOOGLE_CRX_DOWNLOAD_URL = "https://clients2.google.com/service/update2/crx";
const GOOGLE_OMAHA_UPDATE_URL = "https://update.googleapis.com/service/update2/json";
const ALLOWED_UPDATE_URLS = new Set([GOOGLE_CRX_DOWNLOAD_URL]);
const MAX_REDIRECT_HOPS = 5;
const STORE_LEDGER_FILE = "store.json";

const StoreLedgerSchema = z.record(
  z.string().regex(/^[a-p]{32}$/u),
  z.strictObject({
    version: z.string().regex(/^\d{1,9}(?:\.\d{1,9}){0,3}$/u),
    dirName: z.string().regex(/^\d{1,9}(?:\.\d{1,9}){0,3}_0$/u),
  }),
);
export type StoreLedger = z.infer<typeof StoreLedgerSchema>;

export const WebStoreResult = {
  ALREADY_INSTALLED: "already_installed",
  BLOCKED_BY_POLICY: "blocked_by_policy",
  ICON_ERROR: "icon_error",
  INSTALL_ERROR: "install_error",
  INSTALL_IN_PROGRESS: "install_in_progress",
  INVALID_ICON_URL: "invalid_icon_url",
  INVALID_ID: "invalid_id",
  MANIFEST_ERROR: "manifest_error",
  SUCCESS: "success",
  UNKNOWN_ERROR: "unknown_error",
  USER_CANCELLED: "user_cancelled",
} as const;

export const WebStoreInstallStatus = {
  DEPRECATED_MANIFEST_VERSION: "deprecated_manifest_version",
  ENABLED: "enabled",
  INSTALLABLE: "installable",
} as const;

export interface WebStoreInstallRequest {
  readonly id: string;
  readonly localizedName: string;
  readonly manifest: Record<string, unknown>;
  readonly icon: NativeImage;
  readonly frame: WebFrameMain;
  readonly window: BaseWindow | null;
}

export interface DiscoveredStoreExtension {
  readonly id: string;
  readonly version: string;
  readonly path: string;
}

export interface StagedCrxInstall {
  readonly extensionId: string;
  readonly version: string;
  readonly manifest: Record<string, unknown>;
  readonly stagingDir: string;
  readonly cleanup: () => Promise<void>;
  /** Moves the verified staging folder atomically into `<extensionsRoot>/<id>/<version>_0`. */
  readonly commit: (
    extensionsRoot: string,
  ) => Promise<{ readonly path: string; readonly dirName: string }>;
}

function chromeVersion(): string {
  return process.versions.chrome || "152.0.0.0";
}

function omahaPlatform(): string {
  if (process.platform === "darwin") return "mac";
  if (process.platform === "win32") return "win";
  return process.platform;
}

function omahaArch(): string {
  return process.arch === "ia32" ? "x86" : process.arch;
}

export function crxDownloadUrl(extensionId: string): string {
  assertExtensionId(extensionId);
  const url = new URL(GOOGLE_CRX_DOWNLOAD_URL);
  url.searchParams.set("response", "redirect");
  url.searchParams.set("acceptformat", "crx3");
  const x = new URLSearchParams();
  x.set("id", extensionId);
  x.set("uc", "");
  url.searchParams.set("x", x.toString());
  url.searchParams.set("prodversion", chromeVersion());
  return url.toString();
}

/**
 * Streams a bounded HTTPS download, validating HTTPS on every redirect hop
 * and aborting immediately if the response body exceeds `maxBytes`.
 */
export async function fetchBoundedHttpsBuffer(url: string, maxBytes: number): Promise<Buffer> {
  let current = new URL(url);
  if (current.protocol !== "https:") {
    throw new Error("Extension downloads require HTTPS.");
  }
  const controller = new AbortController();
  try {
    let response: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
      const next = await fetch(current.href, { signal: controller.signal, redirect: "manual" });
      if (next.status >= 300 && next.status < 400) {
        const location = next.headers.get("location");
        void next.body?.cancel().catch(() => undefined);
        if (!location) {
          throw new Error(`HTTP ${next.status} redirect missing Location header.`);
        }
        const redirected = new URL(location, current);
        if (redirected.protocol !== "https:") {
          throw new Error("Extension download redirected to a non-HTTPS URL.");
        }
        current = redirected;
        continue;
      }
      response = next;
      break;
    }
    if (!response) {
      throw new Error("Extension download exceeded maximum redirect hops.");
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} downloading from ${current.hostname}`);
    }
    const bytes = await readBoundedResponse(response, {
      maximumBytes: maxBytes,
      signal: controller.signal,
      sizeError: () => new Error("Download exceeds maximum allowed size."),
    });
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  } catch (error) {
    controller.abort();
    throw error;
  }
}

export interface StageCrx3Options {
  readonly expectedManifest?: Record<string, unknown>;
  /**
   * Required CRX3 publisher key hashes (defaults to the Chrome Web Store production publisher key).
   * Pass `null` only in unit tests using synthetic keys.
   */
  readonly requiredKeyHashes?: ReadonlySet<string> | null;
}

/**
 * Downloads, cryptographically verifies (including Chrome Web Store publisher proof),
 * and unpacks a CRX3 into a temporary staging directory OUTSIDE the profile's
 * Extensions folder. Nothing enters the profile until `commit()` is called.
 */
export async function stageCrx3FromUrl(
  url: string,
  expectedExtensionId: string,
  options: StageCrx3Options = {},
): Promise<StagedCrxInstall> {
  assertExtensionId(expectedExtensionId);
  const stagingRoot = await mkdtemp(path.join(os.tmpdir(), "opensteer-crx-stage-"));
  const unpackedDir = path.join(stagingRoot, "unpacked");
  const cleanup = async () => {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  };
  try {
    const raw = await fetchBoundedHttpsBuffer(url, MAX_CRX_BYTES);
    const requiredKeyHashes =
      options.requiredKeyHashes === undefined
        ? CHROME_WEB_STORE_PUBLISHER_KEY_HASHES
        : options.requiredKeyHashes;
    const crx = parseAndVerifyCrx3(
      raw,
      expectedExtensionId,
      requiredKeyHashes ? { requiredKeyHashes } : undefined,
    );
    const manifest = await unpackCrx3(crx, unpackedDir);
    const version = assertExtensionVersion(manifest.version);
    if (options.expectedManifest && !sameApprovedManifest(options.expectedManifest, manifest)) {
      throw new Error("The downloaded extension does not match the approved manifest.");
    }
    const dirName = `${version}_0`;
    return {
      extensionId: crx.extensionId,
      version,
      manifest,
      stagingDir: unpackedDir,
      cleanup,
      commit: async (extensionsRoot: string) => {
        const idDir = path.join(extensionsRoot, crx.extensionId);
        await mkdir(idDir, { recursive: true });
        const target = path.join(idDir, dirName);
        const sibling = path.join(idDir, `.staging-${randomUUID()}`);
        try {
          try {
            await rename(unpackedDir, sibling);
          } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code !== "EXDEV") throw error;
            await unpackCrx3(crx, sibling);
          }
          await rm(target, { recursive: true, force: true });
          await rename(sibling, target);
          return { path: target, dirName };
        } catch (error) {
          await rm(sibling, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        } finally {
          await cleanup();
        }
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/**
 * Ensures an already-unpacked Store extension's `manifest.json` excludes the Chrome Web Store
 * origin from declarative `content_scripts`, matching `unpackCrx3` for pre-existing profiles.
 */
export async function ensureStoreManifestWebStoreExclusion(extensionDir: string): Promise<void> {
  const manifestPath = path.join(extensionDir, "manifest.json");
  const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!isRecord(parsed)) return;
  if (injectWebStoreContentScriptExclusions(parsed)) {
    await writeFile(manifestPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  }
}

export async function readStoreLedger(extensionsRoot: string): Promise<StoreLedger | null> {
  const file = path.join(extensionsRoot, STORE_LEDGER_FILE);
  const text = await readPrivateFileText(file, 1_024 * 1_024, {
    invalid: () => new Error("The Store extensions ledger is unreadable."),
    exposed: () => new Error("The Store extensions ledger is not private."),
  });
  if (text === undefined) return null;
  const parsed = StoreLedgerSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error("The Store extensions ledger is malformed.");
  }
  return parsed.data;
}

export async function writeStoreLedger(extensionsRoot: string, ledger: StoreLedger): Promise<void> {
  const validated = StoreLedgerSchema.parse(ledger);
  await replacePrivateFileAtomically(
    path.join(extensionsRoot, STORE_LEDGER_FILE),
    `${JSON.stringify(validated, null, 2)}\n`,
  );
}

/**
 * Discovers active Store-installed extensions under `extensionsRoot`.
 * When `store.json` exists, loads strictly the committed active version per ID so
 * failed or rolled-back version directories can never resurrect on restart.
 * If `store.json` exists but is unreadable, exposed, or corrupt, fails closed (`[]`)
 * rather than falling back to the legacy directory scan.
 */
export async function discoverStoreExtensions(
  extensionsRoot: string,
): Promise<DiscoveredStoreExtension[]> {
  const rootStat = await stat(extensionsRoot).catch(() => null);
  if (!rootStat?.isDirectory()) return [];

  let ledger: StoreLedger | null;
  try {
    ledger = await readStoreLedger(extensionsRoot);
  } catch {
    return [];
  }
  if (ledger !== null) {
    const entries: DiscoveredStoreExtension[] = [];
    for (const [id, record] of Object.entries(ledger)) {
      const candidatePath = path.join(extensionsRoot, id, record.dirName);
      try {
        const raw = await readFile(path.join(candidatePath, "manifest.json"), "utf8");
        const manifest: unknown = JSON.parse(raw);
        if (!isRecord(manifest) || typeof manifest.key !== "string") continue;
        const version = assertExtensionVersion(manifest.version);
        if (version !== record.version) continue;
        entries.push({ id, version, path: candidatePath });
      } catch {
        // Ignore missing/corrupted directory; caller prunes stale ledger entries if needed.
      }
    }
    return entries;
  }

  // Legacy fallback before store.json exists: scan <id>/<version>_0 once.
  const idEntries = await readdir(extensionsRoot, { withFileTypes: true }).catch(() => []);
  const latestById = new Map<string, DiscoveredStoreExtension>();
  for (const idEntry of idEntries) {
    if (!idEntry.isDirectory() || !isExtensionId(idEntry.name)) continue;
    const idDir = path.join(extensionsRoot, idEntry.name);
    const versionEntries = await readdir(idDir, { withFileTypes: true }).catch(() => []);
    for (const versionEntry of versionEntries) {
      if (!versionEntry.isDirectory() || versionEntry.name.startsWith(".")) continue;
      const candidatePath = path.join(idDir, versionEntry.name);
      try {
        const raw = await readFile(path.join(candidatePath, "manifest.json"), "utf8");
        const manifest: unknown = JSON.parse(raw);
        if (!isRecord(manifest) || typeof manifest.key !== "string") continue;
        const version = assertExtensionVersion(manifest.version);
        const existing = latestById.get(idEntry.name);
        if (!existing || compareVersions(existing.version, version) < 0) {
          latestById.set(idEntry.name, { id: idEntry.name, version, path: candidatePath });
        }
      } catch {
        // Ignore corrupted folders.
      }
    }
  }
  return [...latestById.values()];
}

export interface AvailableStoreUpdate {
  readonly id: string;
  readonly version: string;
  readonly url: string;
}

/** Resolves an Omaha 3.1 package URL from `urls.url[].codebase` + `manifest.packages.package[].name`. */
export function resolveOmahaPackageUrl(codebase: string, packageName?: string): string | null {
  try {
    const base = new URL(codebase);
    if (base.protocol !== "https:") return null;
    if (!packageName) return base.href;
    if (base.pathname.endsWith(`/${packageName}`) || base.pathname.endsWith(packageName)) {
      return base.href;
    }
    const baseWithSlash = codebase.endsWith("/") ? codebase : `${codebase}/`;
    const resolved = new URL(packageName, baseWithSlash);
    return resolved.protocol === "https:" ? resolved.href : null;
  } catch {
    return null;
  }
}

/** Queries Google's Omaha v3.1 endpoint for newer versions of explicitly Store-owned extensions. */
export async function fetchStoreUpdates(
  storeExtensions: readonly Extension[],
): Promise<AvailableStoreUpdate[]> {
  const eligible = storeExtensions.filter((extension) => {
    const manifest = extension.manifest as Record<string, unknown> | undefined;
    return (
      isRecord(manifest) &&
      typeof manifest.key === "string" &&
      typeof manifest.update_url === "string" &&
      ALLOWED_UPDATE_URLS.has(manifest.update_url)
    );
  });
  if (!eligible.length) return [];

  const byId = new Map(eligible.map((ext) => [ext.id, ext]));
  const version = chromeVersion();
  const body = {
    request: {
      "@updater": "opensteer-chrome-web-store",
      acceptformat: "crx3",
      app: eligible.map((ext) => ({ appid: ext.id, updatecheck: {} })),
      os: { platform: omahaPlatform(), arch: omahaArch() },
      prodversion: version,
      protocol: "3.1",
      requestid: randomUUID(),
      sessionid: randomUUID(),
      testsource: "",
    },
  };
  const response = await fetch(GOOGLE_OMAHA_UPDATE_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Goog-Update-Interactivity": "bg",
      "X-Goog-Update-AppId": eligible.map((ext) => ext.id).join(","),
      "X-Goog-Update-Updater": `chromiumcrx-${version}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) return [];
  const text = await response.text();
  const prefix = ")]}'\n";
  if (!text.startsWith(prefix)) return [];
  const parsed: unknown = JSON.parse(text.slice(prefix.length));
  if (!isRecord(parsed) || !isRecord(parsed.response) || !Array.isArray(parsed.response.app)) {
    return [];
  }
  const updates: AvailableStoreUpdate[] = [];
  for (const entry of parsed.response.app) {
    if (!isRecord(entry) || typeof entry.appid !== "string") continue;
    const ext = byId.get(entry.appid);
    const check = isRecord(entry.updatecheck) ? entry.updatecheck : null;
    if (!ext || !check || check.status !== "ok") continue;
    const manifest = isRecord(check.manifest) ? check.manifest : null;
    const urls = isRecord(check.urls) && Array.isArray(check.urls.url) ? check.urls.url : [];
    const codebase =
      isRecord(urls[0]) && typeof urls[0].codebase === "string" ? urls[0].codebase : null;
    const packages =
      isRecord(manifest?.packages) && Array.isArray(manifest.packages.package)
        ? manifest.packages.package
        : [];
    const pkgName =
      isRecord(packages[0]) && typeof packages[0].name === "string" ? packages[0].name : undefined;
    const nextVersion = typeof manifest?.version === "string" ? manifest.version : null;
    if (!codebase || !nextVersion) continue;
    const resolvedUrl = resolveOmahaPackageUrl(codebase, pkgName);
    if (!resolvedUrl) continue;
    if (compareVersions(ext.version, nextVersion) >= 0) continue;
    updates.push({ id: ext.id, version: nextVersion, url: resolvedUrl });
  }
  return updates;
}

/**
 * Downloads & verifies an update into staging outside the mutation queue, then delegates
 * live re-validation (version advance, permission non-expansion, atomic swap + rollback)
 * to `commitUnderLock`.
 */
export async function applyStoreUpdateIfSafe(options: {
  readonly update: AvailableStoreUpdate;
  readonly commitUnderLock: (
    staged: StagedCrxInstall,
  ) => Promise<"updated" | "skipped-permissions" | "skipped-stale">;
}): Promise<"updated" | "skipped-permissions" | "skipped-stale"> {
  const staged = await stageCrx3FromUrl(options.update.url, options.update.id);
  try {
    if (staged.version !== options.update.version) {
      await staged.cleanup();
      return "skipped-stale";
    }
    return await options.commitUnderLock(staged);
  } catch (error) {
    await staged.cleanup();
    throw error;
  }
}

export async function resolveVerifiedManifestName(
  stagingDir: string,
  manifest: Record<string, unknown>,
  fallbackId: string,
): Promise<string> {
  const rawName = typeof manifest.name === "string" ? manifest.name.trim() : "";
  if (!rawName) return fallbackId;
  const msgMatch = /^__MSG_([A-Za-z0-9_@]+)__$/u.exec(rawName);
  if (!msgMatch) return rawName;
  const msgKey = msgMatch[1]!.toLowerCase();
  const defaultLocale =
    typeof manifest.default_locale === "string" ? manifest.default_locale.trim() : "";
  if (defaultLocale && /^[A-Za-z0-9_-]+$/u.test(defaultLocale)) {
    const messagesFile = resolveExtensionFile(
      stagingDir,
      `_locales/${defaultLocale}/messages.json`,
    );
    if (messagesFile) {
      try {
        const parsed: unknown = JSON.parse(await readFile(messagesFile, "utf8"));
        if (isRecord(parsed)) {
          for (const [key, entry] of Object.entries(parsed)) {
            if (
              key.toLowerCase() === msgKey &&
              isRecord(entry) &&
              typeof entry.message === "string" &&
              entry.message.trim()
            ) {
              return entry.message.trim();
            }
          }
        }
      } catch {
        // Fall back to extension ID if the locale bundle is malformed.
      }
    }
  }
  return fallbackId;
}

export function extractVerifiedManifestIcon(
  stagingDir: string,
  manifest: Record<string, unknown>,
): NativeImage {
  const icons = isRecord(manifest.icons) ? manifest.icons : null;
  if (!icons) return nativeImage.createEmpty();
  const entries = Object.entries(icons)
    .filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0,
    )
    .sort(
      (left, right) => (Number.parseInt(right[0], 10) || 0) - (Number.parseInt(left[0], 10) || 0),
    );
  for (const [, rel] of entries) {
    const file = resolveExtensionFile(stagingDir, rel);
    if (!file) continue;
    const image = nativeImage.createFromPath(file);
    if (!image.isEmpty()) return image;
  }
  return nativeImage.createEmpty();
}

function extensionInfoForStore(extension: Extension): Record<string, unknown> {
  const manifest = isRecord(extension.manifest) ? extension.manifest : {};
  const options =
    isRecord(manifest.options_ui) && typeof manifest.options_ui.page === "string"
      ? manifest.options_ui.page
      : typeof manifest.options_page === "string"
        ? manifest.options_page
        : "";
  return {
    description: typeof manifest.description === "string" ? manifest.description : "",
    enabled: true,
    homepageUrl: typeof manifest.homepage_url === "string" ? manifest.homepage_url : "",
    hostPermissions: declaredHostPermissions(manifest),
    icons: [],
    id: extension.id,
    installType: "normal",
    isApp: false,
    mayDisable: true,
    name: extension.name,
    offlineEnabled: Boolean(manifest.offline_enabled),
    optionsUrl: options ? `chrome-extension://${extension.id}/${options.replace(/^\/+/u, "")}` : "",
    permissions: declaredPermissions(manifest),
    shortName: typeof manifest.short_name === "string" ? manifest.short_name : extension.name,
    type: "extension",
    updateUrl: typeof manifest.update_url === "string" ? manifest.update_url : "",
    version: extension.version,
  };
}

export interface WebStoreControllerOptions {
  /** The saved profile's Session where extensions are installed and queried. */
  readonly profileSession: Session;
  /**
   * Optional isolated, extension-free Session used exclusively to host the Chrome Web Store UI.
   * Defaults to a fresh ephemeral partition (`opensteer-cws:<uuid>`) with zero extensions loaded
   * so neither static content scripts nor Electron's native `chrome.scripting` can touch the Store.
   */
  readonly storeSession?: Session;
  readonly preloadPath: string;
  readonly confirmInstall: (request: WebStoreInstallRequest) => Promise<boolean>;
  readonly commitStagedInstall: (staged: StagedCrxInstall) => Promise<Extension>;
}

const WEB_STORE_PRELOAD_ID = "opensteer-chrome-web-store";
const webStoreSessions = new Map<Session, WebStoreController>();
let webStoreIpcRegistered = false;

function isWebStoreUrl(url: string): boolean {
  try {
    return new URL(url).origin === CHROME_WEB_STORE_ORIGIN;
  } catch {
    return false;
  }
}

function isHttpOrHttpsUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

function ensureWebStoreIpc(): void {
  if (webStoreIpcRegistered) return;
  webStoreIpcRegistered = true;

  const handle = (
    channel: string,
    fn: (controller: WebStoreController, event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ) => {
    ipcMain.handle(channel, async (event, ...args) => {
      // Strictly the real Chrome Web Store top-level document inside the isolated Store Session —
      // never a lookalike host, subframe, or any tab on the profile's extension-loaded Session.
      if (
        event.senderFrame?.origin !== CHROME_WEB_STORE_ORIGIN ||
        event.senderFrame !== event.sender.mainFrame
      ) {
        return undefined;
      }
      const controller = webStoreSessions.get(event.sender.session);
      if (!controller) return undefined;
      return await fn(controller, event, ...args);
    });
  };

  handle("opensteer-cws:beginInstall", (controller, event, details) =>
    controller.handleBeginInstall(event, details),
  );
  handle("opensteer-cws:completeInstall", () => WebStoreResult.SUCCESS);
  handle("opensteer-cws:getExtensionStatus", (controller, _event, id, manifestJson) =>
    controller.handleGetStatus(id, manifestJson),
  );
  handle("opensteer-cws:getFullChromeVersion", () => ({
    version_number: chromeVersion(),
    app_name: app.getName(),
  }));
  handle("opensteer-cws:getMV2DeprecationStatus", () => "soft_disable");
  handle("opensteer-cws:getWebGLStatus", async () => {
    await app.getGPUInfo("basic").catch(() => undefined);
    const features = app.getGPUFeatureStatus();
    return features.webgl?.startsWith("enabled") ? "webgl_allowed" : "webgl_blocked";
  });
  handle("opensteer-cws:getAll", (controller) => controller.handleGetAll());
  // Pages can never remove extensions; removal happens only in Opensteer's own menu.
  handle("opensteer-cws:uninstall", () => WebStoreResult.UNKNOWN_ERROR);
}

/**
 * Handles Chrome Web Store page integration for one saved profile using an isolated,
 * extension-free `storeSession` so no extension content script or native `chrome.scripting`
 * call on the profile's `Session` can ever reach or script the Store page.
 */
export class WebStoreController {
  readonly storeSession: Session;
  readonly #options: WebStoreControllerOptions;
  readonly #installing = new Set<string>();
  #window: BrowserWindow | null = null;
  #confirming = false;
  #disposed = false;

  constructor(options: WebStoreControllerOptions) {
    this.#options = options;
    this.storeSession =
      options.storeSession ??
      electronSession.fromPartition(`opensteer-cws:${randomUUID()}`, { cache: false });
    if (this.storeSession === options.profileSession) {
      throw new Error("WebStoreController requires a dedicated Session separate from the profile.");
    }
    ensureWebStoreIpc();
    webStoreSessions.set(this.storeSession, this);
    for (const preload of this.storeSession.getPreloadScripts()) {
      if (preload.id === WEB_STORE_PRELOAD_ID) {
        this.storeSession.unregisterPreloadScript(preload.id);
      }
    }
    this.storeSession.registerPreloadScript({
      id: WEB_STORE_PRELOAD_ID,
      type: "frame",
      filePath: options.preloadPath,
    });
  }

  /** Opens (or focuses) the isolated Chrome Web Store window bound to this profile. */
  openWindow(
    options: {
      readonly parent?: BaseWindow;
      readonly url?: string;
      readonly onOpenExternalUrl?: (url: string) => void;
    } = {},
  ): BrowserWindow {
    if (this.#disposed) {
      throw new Error("Chrome Web Store controller is closed.");
    }
    const targetUrl =
      options.url && isWebStoreUrl(options.url) ? options.url : `${CHROME_WEB_STORE_ORIGIN}/`;
    if (this.#window && !this.#window.isDestroyed()) {
      if (options.url && isWebStoreUrl(options.url)) {
        void this.#window.loadURL(targetUrl).catch(() => undefined);
      }
      if (this.#window.isMinimized()) this.#window.restore();
      this.#window.show();
      this.#window.focus();
      return this.#window;
    }

    const win = new BrowserWindow({
      title: "Chrome Web Store",
      width: 1_120,
      height: 780,
      minWidth: 720,
      minHeight: 520,
      show: true,
      ...(options.parent && !options.parent.isDestroyed() ? { parent: options.parent } : {}),
      webPreferences: {
        session: this.storeSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
      },
    });
    this.#window = win;

    const contents = win.webContents;
    const guardNavigation = (event: Electron.Event, url: string) => {
      if (isWebStoreUrl(url)) return;
      event.preventDefault();
      if (isHttpOrHttpsUrl(url)) options.onOpenExternalUrl?.(url);
    };
    contents.on("will-navigate", guardNavigation);
    contents.on("will-redirect", guardNavigation);
    contents.setWindowOpenHandler(({ url }) => {
      if (isWebStoreUrl(url)) {
        void contents.loadURL(url).catch(() => undefined);
      } else if (isHttpOrHttpsUrl(url)) {
        options.onOpenExternalUrl?.(url);
      }
      return { action: "deny" };
    });
    win.once("closed", () => {
      if (this.#window === win) this.#window = null;
    });
    void win.loadURL(targetUrl).catch(() => undefined);
    return win;
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#window && !this.#window.isDestroyed()) {
      this.#window.destroy();
    }
    this.#window = null;
    if (webStoreSessions.get(this.storeSession) === this) {
      webStoreSessions.delete(this.storeSession);
    }
    for (const preload of this.storeSession.getPreloadScripts()) {
      if (preload.id === WEB_STORE_PRELOAD_ID) {
        this.storeSession.unregisterPreloadScript(preload.id);
      }
    }
  }

  handleGetAll(): Record<string, unknown>[] {
    if (this.#disposed) return [];
    return this.#options.profileSession.extensions.getAllExtensions().map(extensionInfoForStore);
  }

  handleGetStatus(id: unknown, manifestJson: unknown): string {
    if (this.#disposed || !isExtensionId(id)) return WebStoreInstallStatus.INSTALLABLE;
    if (typeof manifestJson === "string") {
      try {
        const parsed: unknown = JSON.parse(manifestJson);
        if (
          isRecord(parsed) &&
          typeof parsed.manifest_version === "number" &&
          parsed.manifest_version < 3
        ) {
          return WebStoreInstallStatus.DEPRECATED_MANIFEST_VERSION;
        }
      } catch {
        // Ignore unparseable status probe manifest.
      }
    }
    const existing = this.#options.profileSession.extensions.getExtension(id);
    return existing ? WebStoreInstallStatus.ENABLED : WebStoreInstallStatus.INSTALLABLE;
  }

  async handleBeginInstall(
    event: IpcMainInvokeEvent,
    rawDetails: unknown,
  ): Promise<{ readonly result: string; readonly message?: string }> {
    if (this.#disposed || !isRecord(rawDetails)) {
      return { result: WebStoreResult.UNKNOWN_ERROR };
    }
    const id = rawDetails.id;
    if (!isExtensionId(id)) {
      return { result: WebStoreResult.INVALID_ID };
    }
    if (this.#installing.has(id) || this.#confirming) {
      return { result: WebStoreResult.INSTALL_IN_PROGRESS };
    }
    if (typeof rawDetails.manifest !== "string") {
      return { result: WebStoreResult.MANIFEST_ERROR };
    }
    let pageManifest: unknown;
    try {
      pageManifest = JSON.parse(rawDetails.manifest);
    } catch {
      return { result: WebStoreResult.MANIFEST_ERROR };
    }
    if (!isRecord(pageManifest)) {
      return { result: WebStoreResult.MANIFEST_ERROR };
    }
    if (typeof pageManifest.manifest_version === "number" && pageManifest.manifest_version < 3) {
      return { result: WebStoreResult.BLOCKED_BY_POLICY };
    }
    if (this.#options.profileSession.extensions.getExtension(id)) {
      return { result: WebStoreResult.ALREADY_INSTALLED };
    }
    const frame = event.senderFrame;
    if (!frame || frame.isDestroyed()) {
      return { result: WebStoreResult.UNKNOWN_ERROR };
    }

    this.#installing.add(id);
    let staged: StagedCrxInstall | null = null;
    try {
      // Stage and verify the signed CRX3 artifact FIRST so the confirmation sheet shows
      // ONLY the verified package's own manifest, name, icon, and full permission warnings.
      staged = await stageCrx3FromUrl(crxDownloadUrl(id), id, { expectedManifest: pageManifest });
      if (this.#disposed || frame.isDestroyed()) {
        await staged.cleanup();
        return { result: WebStoreResult.USER_CANCELLED };
      }

      const verifiedManifest = staged.manifest;
      if (
        typeof verifiedManifest.manifest_version !== "number" ||
        verifiedManifest.manifest_version < 3
      ) {
        await staged.cleanup();
        return { result: WebStoreResult.BLOCKED_BY_POLICY };
      }
      const icon = extractVerifiedManifestIcon(staged.stagingDir, verifiedManifest);
      const localizedName = await resolveVerifiedManifestName(
        staged.stagingDir,
        verifiedManifest,
        id,
      );

      if (this.#confirming) {
        await staged.cleanup();
        return { result: WebStoreResult.INSTALL_IN_PROGRESS };
      }
      this.#confirming = true;
      let approved: boolean;
      try {
        approved = await this.#options.confirmInstall({
          id,
          localizedName,
          manifest: verifiedManifest,
          icon,
          frame,
          window: this.#window && !this.#window.isDestroyed() ? this.#window : null,
        });
      } finally {
        this.#confirming = false;
      }
      if (!approved || this.#disposed) {
        await staged.cleanup();
        return { result: WebStoreResult.USER_CANCELLED };
      }
      const installed = await this.#options.commitStagedInstall(staged);
      staged = null;
      queueMicrotask(() => {
        if (!frame.isDestroyed()) {
          try {
            frame.send("opensteer-cws:onInstalled", extensionInfoForStore(installed));
          } catch {
            // Ignore frame teardown races.
          }
        }
      });
      return { result: WebStoreResult.SUCCESS };
    } catch (error) {
      await staged?.cleanup();
      return {
        result: WebStoreResult.INSTALL_ERROR,
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.#installing.delete(id);
    }
  }
}

export { permissionsExpanded };
