import { BrowserPresentationUnavailable } from "../bridge/browser-presentation-result.js";
import {
  clipboard,
  Menu,
  type Input,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron";
import {
  pageViewport,
  type NativePresentationSource,
  type PresentedSurface,
} from "@opensteer/browser-runtime-core";
import type { BrowserSessionId, BrowserSurfaceId } from "@opensteer/protocol/browser";
import {
  DesktopBrowserPresentationIdSchema,
  type DesktopBrowserFindInput,
  type DesktopBrowserGlassInput,
  type DesktopBrowserOverlayInput,
  type DesktopBrowserPresentInput,
  type DesktopBrowserPresentResult,
  type DesktopBrowserPresentationEnd,
  type DesktopBrowserPresentationEvent,
  type DesktopBrowserPresentationId,
  type DesktopBrowserPresentationTarget,
  type DesktopBrowserPresentationUpdateInput,
  type DesktopForwardedKey,
  type DesktopGlassScene,
  type DesktopWindowRect,
} from "@opensteer/protocol/desktop";
import { desktopQuitShortcut, type ElectronAppWindow } from "../app/electron-window.js";
import {
  desktopBrowserAppFocusShortcut,
  desktopBrowserAppShortcut,
  workspaceTabCommand,
} from "../app/application-menu.js";
import type {
  DesktopBrowserSocketObservation,
  DesktopHostTransport,
} from "../connections/host-transport.js";
import { desktopBridgeChannels } from "../bridge/desktop-bridge-channels.js";
import {
  electronPagePresentation,
  type ElectronPagePresentation,
  type NativePlacement,
} from "./electron-browser-launcher.js";
import { PageGlass } from "./page-glass.js";

interface Authority {
  sockets: Set<string>;
}
interface PageSlot {
  readonly surface: PresentedSurface;
  readonly native: ElectronPagePresentation;
  revision: number;
  findRequestId: number | null;
  dispose(): void;
  placement: NativePlacement | null;
  following: Promise<void> | null;
  followPending: boolean;
  followAgain: boolean;
  followEpoch: number;
  disposed: boolean;
  cancelPaint(): void;
}
interface Presentation {
  readonly id: DesktopBrowserPresentationId;
  readonly owner: Owner;
  readonly sessionId: BrowserSessionId;
  readonly source: NativePresentationSource;
  readonly authority: Authority;
  rect: DesktopWindowRect;
  revision: number;
  page: PageSlot | null;
  pending: PageSlot | null;
  scene: DesktopGlassScene | null;
}
interface Owner {
  readonly window: ElectronAppWindow;
  readonly contents: WebContents;
  readonly overlays: Set<string>;
  glass: PageGlass | null;
  current: Presentation | null;
  restore: { presentation: Presentation; revision: number } | null;
  pageHadFocus: boolean;
  hardReload: boolean;
}

/** Main owns locality and socket authority; the engine alone writes page view bounds. */
export class DesktopBrowserPresentationManager {
  readonly #sources = new Set<NativePresentationSource>();
  readonly #owners = new Map<number, Owner>();
  readonly #passkeyListeners = new Set<() => void>();
  readonly #presentations = new Map<DesktopBrowserPresentationId, Presentation>();
  readonly #authority = new Map<number, Map<BrowserSessionId, Authority>>();
  readonly #transport: Pick<
    DesktopHostTransport,
    "observeBrowserSockets" | "closeSocketsForOwner" | "openBrowserSurface" | "passkeyConsumerToken"
  >;
  readonly #glassPreload: string;
  readonly #onError: (error: unknown) => void;
  readonly #quit: () => void;
  readonly #unsubscribe: () => void;

  constructor(options: {
    transport: Pick<
      DesktopHostTransport,
      | "observeBrowserSockets"
      | "closeSocketsForOwner"
      | "openBrowserSurface"
      | "passkeyConsumerToken"
    >;
    glassPreload: string;
    onError: (error: unknown) => void;
    quit: () => void;
  }) {
    this.#transport = options.transport;
    this.#glassPreload = options.glassPreload;
    this.#onError = options.onError;
    this.#quit = options.quit;
    this.#unsubscribe = options.transport.observeBrowserSockets((event) => this.#socket(event));
  }

  registerSource(source: NativePresentationSource): () => void {
    this.#sources.add(source);
    this.#passkeyChanged();
    return () => {
      this.#sources.delete(source);
      this.#passkeyChanged();
      for (const presentation of this.#presentations.values())
        if (presentation.source === source) this.#end(presentation, "runtime-stopped");
    };
  }

  attachWindow(window: ElectronAppWindow): void {
    const contents = window.webContents;
    const owner: Owner = {
      window,
      contents,
      overlays: new Set(),
      current: null,
      restore: null,
      pageHadFocus: false,
      hardReload: false,
      glass: null,
    };
    this.#owners.set(contents.id, owner);
    const gone = () => {
      owner.hardReload = false;
      this.#navigationMenu();
      for (const presentation of this.#presentations.values())
        if (presentation.owner === owner) this.#end(presentation, "renderer-gone");
      owner.overlays.clear();
      owner.restore = null;
      this.#transport.closeSocketsForOwner(contents.id);
    };
    contents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) gone();
    });
    contents.on("render-process-gone", gone);
    contents.once("destroyed", gone);
    window.once("closed", () => {
      gone();
      owner.glass?.close();
      this.#owners.delete(contents.id);
    });
    const focused = (focused: boolean) => {
      this.#navigationMenu();
      this.#emit(owner, { type: "window-focus", focused });
      for (const presentation of this.#presentations.values())
        if (presentation.owner === owner) this.#stage(presentation);
    };
    window.on("focus", () => focused(true));
    window.on("blur", () => focused(false));
    contents.on("zoom-changed", () => {
      if (owner.current) this.#stage(owner.current);
    });
  }

  isLocal(sessionId: BrowserSessionId): boolean {
    return [...this.#sources].some((source) => source.hasSession(sessionId));
  }

  /** A native request belongs to this exact visible page slot, not its retained viewer socket. */
  passkeyBinding(
    ownerId: number,
    sessionId: BrowserSessionId,
    surfaceId: string,
  ): object | "streamed" | null {
    if (!this.isLocal(sessionId)) return "streamed";
    const owner = this.#owners.get(ownerId);
    const presentation = owner?.current;
    const page = presentation?.page;
    if (
      !owner ||
      !presentation ||
      !page ||
      !this.#valid(presentation) ||
      presentation.sessionId !== sessionId ||
      page.surface.surfaceId !== surfaceId ||
      page.disposed ||
      !page.placement ||
      page.revision !== presentation.revision ||
      presentation.rect.width <= 0 ||
      presentation.rect.height <= 0 ||
      [...this.#presentations.values()].some(
        (candidate) =>
          candidate.owner === owner && (candidate !== presentation || candidate.pending !== null),
      )
    )
      return null;
    return page;
  }
  observePasskeyPresentation(listener: () => void): () => void {
    this.#passkeyListeners.add(listener);
    return () => {
      this.#passkeyListeners.delete(listener);
    };
  }
  #passkeyChanged(): void {
    for (const listener of this.#passkeyListeners) listener();
  }

  async present(
    sender: WebContents,
    input: DesktopBrowserPresentInput,
  ): Promise<DesktopBrowserPresentResult> {
    const owner = this.#owner(sender);
    const existing = owner.current;
    if (
      existing &&
      existing.sessionId === input.sessionId &&
      existing.page?.surface.surfaceId === input.surfaceId &&
      this.#valid(existing)
    ) {
      existing.rect = input.rect;
      this.#stage(existing);
      return { presentationId: existing.id, revision: existing.revision };
    }
    for (const candidate of this.#presentations.values())
      if (candidate.owner === owner && candidate !== owner.current)
        this.#end(candidate, "released");
    const source = [...this.#sources].find((candidate) => candidate.hasSession(input.sessionId));
    if (!source) throw new BrowserPresentationUnavailable("not-local");
    const authority = this.#authority.get(sender.id)?.get(input.sessionId);
    if (!authority?.sockets.size) throw new BrowserPresentationUnavailable("not-admitted");
    const presentation: Presentation = {
      id: DesktopBrowserPresentationIdSchema.parse(globalThis.crypto.randomUUID()),
      owner,
      source,
      sessionId: input.sessionId,
      authority,
      rect: input.rect,
      revision: 0,
      page: null,
      pending: null,
      scene: null,
    };
    this.#presentations.set(presentation.id, presentation);
    this.#passkeyChanged();
    try {
      this.#swap(presentation, input.surfaceId);
    } catch (error) {
      this.#end(presentation, "page-closed");
      throw error;
    }
    return { presentationId: presentation.id, revision: presentation.revision };
  }

  async update(
    sender: WebContents,
    input: DesktopBrowserPresentationUpdateInput,
  ): Promise<{ revision: number }> {
    const presentation = this.#owned(sender, input.presentationId);
    if (!presentation) throw new BrowserPresentationUnavailable("renderer-gone");
    if (input.rect) presentation.rect = input.rect;
    if (
      input.surfaceId &&
      input.surfaceId !== (presentation.pending ?? presentation.page)?.surface.surfaceId
    ) {
      presentation.revision += 1;
      this.#passkeyChanged();
      presentation.scene = null;
      if (presentation.page?.surface.surfaceId === input.surfaceId) {
        if (presentation.pending) this.#disposePage(presentation.pending);
        presentation.pending = null;
        presentation.page.revision = presentation.revision;
        presentation.page.findRequestId = null;
        this.#stage(presentation);
        this.#order(presentation.owner);
        return { revision: presentation.revision };
      }
      const requestedRevision = presentation.revision;
      try {
        this.#swap(presentation, input.surfaceId);
      } catch (error) {
        if (presentation.revision !== requestedRevision) return { revision: presentation.revision };
        this.#end(presentation, "page-closed");
        throw error;
      }
    } else this.#stage(presentation);
    return { revision: presentation.revision };
  }

  release(sender: WebContents, target: DesktopBrowserPresentationTarget): void {
    const presentation = this.#owned(sender, target.presentationId);
    if (presentation) this.#end(presentation, "released");
  }

  windowFocused(sender: WebContents): boolean {
    return this.#owner(sender).window.isFocused();
  }

  acquireOverlay(sender: WebContents, input: DesktopBrowserOverlayInput): void {
    const owner = this.#owner(sender);
    if (owner.overlays.has(input.overlayId)) return;
    if (!owner.overlays.size) {
      owner.restore = owner.current
        ? { presentation: owner.current, revision: owner.current.revision }
        : null;
      owner.pageHadFocus = owner.current?.page?.native.view.webContents.isFocused() ?? false;
    }
    owner.overlays.add(input.overlayId);
    if (!owner.current?.page) return;
    this.#order(owner);
    if (owner.window.isFocused()) owner.contents.focus();
  }

  releaseOverlay(sender: WebContents, input: DesktopBrowserOverlayInput): void {
    const owner = this.#owner(sender);
    if (!owner.overlays.delete(input.overlayId) || owner.overlays.size) return;
    this.#order(owner);
    if (
      owner.pageHadFocus &&
      owner.restore?.presentation === owner.current &&
      owner.restore?.revision === owner.current?.revision &&
      owner.current &&
      this.#valid(owner.current) &&
      owner.window.isFocused()
    )
      owner.current.page?.native.view.webContents.focus();
    owner.restore = null;
  }

  find(sender: WebContents, input: DesktopBrowserFindInput): void {
    const page = this.#target(sender, input)?.page;
    if (page)
      page.findRequestId = page.native.view.webContents.findInPage(input.query, {
        forward: input.forward,
        // Electron 44 forwards this option to Chromium as `new_session`.
        findNext: !input.findNext,
      });
  }
  stopFind(sender: WebContents, target: DesktopBrowserPresentationTarget): void {
    const page = this.#target(sender, target)?.page;
    if (!page) return;
    page.findRequestId = null;
    page.native.view.webContents.stopFindInPage("clearSelection");
  }
  async exitFullscreen(
    sender: WebContents,
    target: DesktopBrowserPresentationTarget,
  ): Promise<void> {
    const page = this.#target(sender, target)?.page;
    if (page) await page.native.exitFullscreen();
  }
  setGlass(sender: WebContents, input: DesktopBrowserGlassInput): void {
    const presentation = this.#target(sender, input);
    if (!presentation) return;
    presentation.scene = input.scene;
    this.#glass(presentation.owner);
  }
  focusPage(sender: WebContents, target: DesktopBrowserPresentationTarget): void {
    const presentation = this.#target(sender, target);
    if (
      presentation &&
      presentation.owner.current === presentation &&
      !presentation.owner.overlays.size &&
      presentation.owner.window.isFocused()
    )
      presentation.page?.native.view.webContents.focus();
  }

  setNavigationAvailable(sender: WebContents, input: { hardReload: boolean }): void {
    this.#owner(sender).hardReload = input.hardReload;
    this.#navigationMenu();
  }

  #navigationMenu(): void {
    const item = Menu.getApplicationMenu()?.getMenuItemById("browser-hard-reload");
    if (item)
      item.enabled = [...this.#owners.values()].some(
        // A closing window's own cleanup runs this while its window is already destroyed.
        (owner) => owner.hardReload && !owner.window.isDestroyed() && owner.window.isFocused(),
      );
  }

  /** Menu accelerators are page-first: Chromium calls these only after page dispatch. */
  menuKey(key: DesktopForwardedKey): void {
    const owner = [...this.#owners.values()].find((candidate) => candidate.window.isFocused());
    if (!owner) return;
    const page = owner.current?.page;
    if (page?.native.view.webContents.isFocused() && page.native.inputOutstanding()) return;
    if (key.shift && key.key.toLowerCase() === "r" && !owner.hardReload) return;
    if (key.key === "Escape" && page && !page.native.view.webContents.isFocused()) return;
    if (desktopBrowserAppFocusShortcut(key)) owner.contents.focus();
    this.#emit(owner, { type: "key", key });
  }

  endAll(): void {
    for (const presentation of this.#presentations.values()) this.#end(presentation, "released");
  }
  dispose(): void {
    this.endAll();
    this.#unsubscribe();
    this.#passkeyListeners.clear();
    for (const owner of this.#owners.values()) owner.glass?.close();
  }

  #socket(event: DesktopBrowserSocketObservation): void {
    let sessions = this.#authority.get(event.ownerId);
    if (!sessions) {
      sessions = new Map();
      this.#authority.set(event.ownerId, sessions);
    }
    let authority = sessions.get(event.sessionId);
    if (!authority) {
      authority = { sockets: new Set() };
      sessions.set(event.sessionId, authority);
    }
    if (event.type === "admitted") authority.sockets.add(event.connectionId);
    if (
      event.type !== "closed" ||
      !authority.sockets.delete(event.connectionId) ||
      authority.sockets.size
    )
      return;
    for (const presentation of this.#presentations.values())
      if (
        presentation.owner.contents.id === event.ownerId &&
        presentation.sessionId === event.sessionId
      )
        this.#end(presentation, "access-ended");
  }

  #swap(presentation: Presentation, surfaceId: BrowserSurfaceId): void {
    const surface = presentation.source.presentSurface(presentation.sessionId, surfaceId);
    if (!surface) throw new BrowserPresentationUnavailable("page-unavailable");
    const native = electronPagePresentation(surface.page);
    if (!native || native.view.webContents.isCrashed()) {
      surface.release();
      throw new BrowserPresentationUnavailable("page-unavailable");
    }
    for (const candidate of this.#presentations.values()) {
      if ([candidate.page, candidate.pending].some((page) => page?.native.view === native.view)) {
        surface.release();
        throw new BrowserPresentationUnavailable("page-unavailable");
      }
    }
    if (presentation.pending) this.#disposePage(presentation.pending);
    const page: PageSlot = {
      surface,
      native,
      revision: presentation.revision,
      findRequestId: null,
      placement: null,
      following: null,
      followPending: false,
      followAgain: false,
      followEpoch: 0,
      disposed: false,
      cancelPaint: () => undefined,
      dispose: () => undefined,
    };
    presentation.pending = page;
    this.#passkeyChanged();
    const disposeEvents = this.#observePage(presentation, page);
    page.dispose = disposeEvents;
    const owner = presentation.owner;
    try {
      native.mount(owner.window, this.#dips(presentation), (placement) => {
        if (
          !this.#valid(presentation) ||
          (presentation.page !== page && presentation.pending !== page)
        )
          return;
        page.placement = placement;
        if (presentation.page === page && owner.current === presentation)
          this.#placed(presentation, page);
      });
      this.#order(owner);
      native.setStage(this.#dips(presentation), owner.window.isFocused());
      this.#follow(presentation, page);
      const paint = new AbortController();
      page.cancelPaint = () => paint.abort();
      // Admission and dialog controls do not depend on paint. Keep the old
      // view until this mounted revision has compositor evidence.
      void native
        .waitForPaint(paint.signal)
        .then(() => {
          page.cancelPaint = () => undefined;
          if (!this.#valid(presentation) || presentation.pending !== page || page.disposed) return;
          const oldPresentation = owner.current;
          const oldPage = presentation.page;
          presentation.pending = null;
          presentation.page = page;
          owner.current = presentation;
          this.#passkeyChanged();
          this.#order(owner);
          this.#placed(presentation, page);
          this.#emit(owner, {
            type: "fullscreen",
            presentationId: presentation.id,
            revision: page.revision,
            active: native.isFullscreen(),
          });
          if (oldPage && oldPage !== page) this.#disposePage(oldPage);
          if (oldPresentation && oldPresentation !== presentation)
            this.#end(oldPresentation, "released");
        })
        .catch((error: unknown) => {
          if (page.disposed || !this.#valid(presentation) || presentation.pending !== page) return;
          this.#onError(error);
          this.#end(presentation, "page-closed");
        });
    } catch (error) {
      if (presentation.pending === page) presentation.pending = null;
      this.#disposePage(page);
      throw error;
    }
  }

  #observePage(presentation: Presentation, page: PageSlot): () => void {
    const contents = page.native.view.webContents;
    const current = () =>
      this.#valid(presentation) &&
      presentation.page === page &&
      presentation.owner.current === presentation;
    const passkeyInput = page.surface.page.observePasskeyInput?.(() => {
      if (!current()) return;
      const tokens = new Set<string>();
      for (const connectionId of presentation.authority.sockets) {
        const token = this.#transport.passkeyConsumerToken(
          presentation.owner.contents.id,
          connectionId,
          page.surface.surfaceId,
        );
        if (token) tokens.add(token);
      }
      page.surface.passkeyInput?.(
        tokens.size === 1 ? (tokens.values().next().value ?? null) : null,
      );
    });
    const surfaceEvents = page.surface.onEvent((event) => {
      if (event.type === "closed") this.#end(presentation, "page-closed");
      else {
        const stage = this.#dips(presentation);
        if (
          presentation.owner.window.isFocused() &&
          (event.geometry.person.width !== stage.width ||
            event.geometry.person.height !== stage.height)
        )
          this.#follow(presentation, page);
        if (presentation.page === page) this.#placed(presentation, page);
      }
    });
    const gone = () => this.#end(presentation, "page-closed");
    const key = (event: Electron.Event, input: Input) => {
      const outstanding = page.native.inputOutstanding();
      contents.setIgnoreMenuShortcuts(outstanding);
      if (input.type !== "keyDown" || !desktopBrowserAppShortcut(input)) return;
      event.preventDefault();
      if (outstanding || !current()) return;
      const tabCommand = workspaceTabCommand(input);
      if (desktopQuitShortcut(input, process.platform)) this.#quit();
      else if (tabCommand) {
        if (!presentation.owner.contents.isDestroyed())
          presentation.owner.contents.send(desktopBridgeChannels.workspaceTabCommand, tabCommand);
      } else {
        if (desktopBrowserAppFocusShortcut(forwardedKey(input)))
          presentation.owner.contents.focus();
        this.#emit(presentation.owner, { type: "key", key: forwardedKey(input) });
      }
    };
    const find = (_event: Electron.Event, result: Electron.Result) => {
      if (current() && result.requestId === page.findRequestId)
        this.#emit(presentation.owner, {
          type: "find",
          presentationId: presentation.id,
          revision: page.revision,
          matches: result.matches,
          activeMatch: result.activeMatchOrdinal,
          final: result.finalUpdate,
        });
    };
    const fullscreen = (active: boolean) => {
      if (current())
        this.#emit(presentation.owner, {
          type: "fullscreen",
          presentationId: presentation.id,
          revision: page.revision,
          active,
        });
    };
    const enter = () => fullscreen(true);
    const leave = () => fullscreen(false);
    const context = (_event: Electron.Event, params: Electron.ContextMenuParams) => {
      if (
        page.native.takeContextMenuTrigger() !== "person" ||
        page.native.inputOutstanding() ||
        !current()
      )
        return;
      const items: MenuItemConstructorOptions[] = [];
      const roles = (...names: NonNullable<Electron.MenuItemConstructorOptions["role"]>[]) => {
        for (const role of names) items.push({ role });
      };
      if (params.isEditable) {
        for (const suggestion of params.dictionarySuggestions)
          items.push({
            label: suggestion,
            click: () => {
              if (current()) contents.replaceMisspelling(suggestion);
            },
          });
        roles("undo", "redo", "cut", "copy", "paste", "pasteAndMatchStyle", "selectAll");
      } else if (params.selectionText) {
        roles("copy");
        if (process.platform === "darwin")
          items.push({
            label: "Look Up",
            click: () => {
              if (current()) contents.showDefinitionForSelection();
            },
          });
      }
      const open = (url: string) => {
        if (!current()) return;
        const connectionId = presentation.authority.sockets.values().next().value;
        if (connectionId)
          this.#transport.openBrowserSurface(presentation.owner.contents.id, connectionId, url);
      };
      if (params.linkURL)
        items.push(
          { label: "Open Link in New Tab", click: () => open(params.linkURL) },
          {
            label: "Copy Link Address",
            click: () => {
              if (current()) void clipboard.writeText(params.linkURL).catch(this.#onError);
            },
          },
        );
      if (params.mediaType === "image")
        items.push(
          { label: "Open Image in New Tab", click: () => open(params.srcURL) },
          {
            label: "Copy Image",
            click: () => {
              if (current()) contents.copyImageAt(params.x, params.y);
            },
          },
          {
            label: "Copy Image Address",
            click: () => {
              if (current()) void clipboard.writeText(params.srcURL).catch(this.#onError);
            },
          },
        );
      if (!items.length)
        items.push(
          {
            label: "Back",
            enabled: contents.navigationHistory.canGoBack(),
            click: () => {
              if (current()) contents.navigationHistory.goBack();
            },
          },
          {
            label: "Forward",
            enabled: contents.navigationHistory.canGoForward(),
            click: () => {
              if (current()) contents.navigationHistory.goForward();
            },
          },
          {
            label: "Reload",
            click: () => {
              if (current()) contents.reload();
            },
          },
        );
      Menu.buildFromTemplate(items).popup({ window: presentation.owner.window });
    };
    contents.on("before-input-event", key);
    contents.on("found-in-page", find);
    contents.on("enter-html-full-screen", enter);
    contents.on("leave-html-full-screen", leave);
    contents.on("context-menu", context);
    contents.on("render-process-gone", gone);
    return () => {
      passkeyInput?.();
      surfaceEvents();
      contents.off("before-input-event", key);
      contents.off("found-in-page", find);
      contents.off("enter-html-full-screen", enter);
      contents.off("leave-html-full-screen", leave);
      contents.off("context-menu", context);
      contents.off("render-process-gone", gone);
    };
  }

  #stage(presentation: Presentation): void {
    this.#passkeyChanged();
    for (const page of [presentation.page, presentation.pending]) {
      if (!page) continue;
      page.native.setStage(this.#dips(presentation), presentation.owner.window.isFocused());
      this.#follow(presentation, page);
    }
    if (presentation.page) this.#placed(presentation, presentation.page);
  }
  #follow(presentation: Presentation, page: PageSlot): void {
    if (!presentation.owner.window.isFocused()) {
      page.followEpoch += 1;
      page.followPending = false;
      page.followAgain = false;
      return;
    }
    if (page.following) {
      // Pending follows read the latest stage at execution. Once executing,
      // remember one more follow; explicit Fit/agent writes keep their own place.
      if (!page.followPending) page.followAgain = true;
      return;
    }
    const epoch = page.followEpoch;
    page.followPending = true;
    const operation = page.surface.follow(() => {
      page.followPending = false;
      if (
        page.disposed ||
        epoch !== page.followEpoch ||
        !this.#valid(presentation) ||
        !presentation.owner.window.isFocused()
      )
        return null;
      const { width, height } = this.#dips(presentation);
      return { width, height };
    });
    page.following = operation;
    void operation
      .catch((error: unknown) => {
        if (this.#valid(presentation) && !page.disposed) this.#onError(error);
      })
      .finally(() => {
        page.following = null;
        if (page.followAgain && !page.disposed) {
          page.followAgain = false;
          this.#follow(presentation, page);
        }
      });
  }

  #dips(presentation: Presentation): DesktopWindowRect {
    const zoom = presentation.owner.contents.getZoomFactor();
    const rect = presentation.rect;
    const x = Math.round(rect.x * zoom);
    const y = Math.round(rect.y * zoom);
    return {
      x,
      y,
      width: Math.max(1, Math.round((rect.x + rect.width) * zoom) - x),
      height: Math.max(1, Math.round((rect.y + rect.height) * zoom) - y),
    };
  }
  #placed(presentation: Presentation, page: PageSlot): void {
    if (!page.placement || !this.#valid(presentation)) return;
    const applied = page.surface.geometry();
    if (!applied) return;
    const viewport = pageViewport(applied.geometry);
    const placedViewport = pageViewport({
      person: page.placement.bounds,
      agent: page.placement.emulation,
    });
    // A focused stage can reach native bounds ahead of its queued ledger follow.
    // Never label that placement with the previous viewport's geometry revision.
    if (viewport.width !== placedViewport.width || viewport.height !== placedViewport.height)
      return;
    const zoom = presentation.owner.contents.getZoomFactor();
    const css = (rect: DesktopWindowRect) => ({
      x: rect.x / zoom,
      y: rect.y / zoom,
      width: rect.width / zoom,
      height: rect.height / zoom,
    });
    this.#emit(presentation.owner, {
      type: "placed",
      sessionId: presentation.sessionId,
      surfaceId: page.surface.surfaceId,
      appZoomFactor: zoom,
      geometryRevision: applied.geometryRevision,
      viewport,
      presentationId: presentation.id,
      revision: page.revision,
      bounds: css(page.placement.bounds),
      croppedRight: page.placement.crop.right,
      croppedBottom: page.placement.crop.bottom,
      glass: this.#supportsGlass(),
      stage: css(this.#dips(presentation)),
    });
    this.#glass(presentation.owner);
  }
  #order(owner: Owner): void {
    if (owner.window.isDestroyed()) return;
    const pages: PageSlot[] = [];
    for (const presentation of this.#presentations.values())
      if (presentation.owner === owner && presentation.pending) pages.push(presentation.pending);
    if (owner.current?.page) pages.push(owner.current.page);
    const views = pages.map((page) => page.native.view);
    if (owner.overlays.size || !owner.current?.page) views.push(owner.window.appView);
    const existing = owner.window.contentView.children.slice(-views.length);
    if (views.some((view, index) => existing[index] !== view)) {
      // No pending page is left above the current page/app before yielding.
      for (const view of views) owner.window.contentView.addChildView(view);
    }
    this.#glass(owner);
  }
  #supportsGlass(): boolean {
    // X11 without a compositor draws transparent children black; Linux uses app marks.
    return process.platform === "darwin" || process.platform === "win32";
  }
  #glass(owner: Owner): void {
    const scene = owner.current?.scene;
    if (
      !owner.glass &&
      this.#supportsGlass() &&
      owner.current?.page &&
      scene &&
      (scene.cursors.length || scene.croppedRight || scene.croppedBottom)
    )
      owner.glass = new PageGlass(owner.window, this.#glassPreload, this.#onError);
    owner.glass?.update(
      owner.current?.page?.placement?.bounds ?? null,
      owner.current?.scene ?? null,
      !owner.overlays.size && owner.current !== null,
    );
  }
  #end(presentation: Presentation, reason: DesktopBrowserPresentationEnd): void {
    if (!this.#presentations.delete(presentation.id)) return;
    const owner = presentation.owner;
    if (owner.current === presentation) owner.current = null;
    if (presentation.pending) this.#disposePage(presentation.pending);
    if (presentation.page) this.#disposePage(presentation.page);
    presentation.pending = null;
    presentation.page = null;
    this.#passkeyChanged();
    this.#order(owner);
    this.#emit(owner, { type: "ended", presentationId: presentation.id, reason });
  }
  #disposePage(page: PageSlot): void {
    if (page.disposed) return;
    page.disposed = true;
    page.followEpoch += 1;
    page.followAgain = false;
    try {
      page.findRequestId = null;
      if (!page.surface.page.isClosed())
        page.native.view.webContents.stopFindInPage("clearSelection");
      page.cancelPaint();
      page.dispose();
      page.native.unmount();
    } finally {
      page.surface.release();
    }
  }
  #valid(presentation: Presentation): boolean {
    return this.#presentations.get(presentation.id) === presentation;
  }
  #owner(sender: WebContents): Owner {
    const owner = this.#owners.get(sender.id);
    if (!owner || sender.isDestroyed() || owner.window.isDestroyed())
      throw new BrowserPresentationUnavailable("renderer-gone");
    return owner;
  }
  #owned(sender: WebContents, id: DesktopBrowserPresentationId): Presentation | null {
    const presentation = this.#presentations.get(id);
    return presentation?.owner.contents === sender && this.#valid(presentation)
      ? presentation
      : null;
  }
  #target(sender: WebContents, target: DesktopBrowserPresentationTarget): Presentation | null {
    const presentation = this.#owned(sender, target.presentationId);
    return presentation?.revision === target.revision &&
      presentation.page?.revision === target.revision
      ? presentation
      : null;
  }
  #emit(owner: Owner, event: DesktopBrowserPresentationEvent): void {
    if (!owner.contents.isDestroyed())
      owner.contents.send(desktopBridgeChannels.browserPresentationEvent, event);
  }
}

function forwardedKey(input: Input): DesktopForwardedKey {
  return {
    key: input.key,
    code: input.code || input.key,
    alt: input.alt,
    ctrl: input.control,
    meta: input.meta,
    shift: input.shift,
  };
}
