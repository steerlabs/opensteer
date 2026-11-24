import type { DesktopBrowserExtensionAction } from "@opensteer/protocol/desktop";
import {
  BaseWindow,
  BrowserWindow,
  Menu,
  MenuItem,
  Notification,
  nativeImage,
  webFrameMain,
  type ContextMenuParams,
  type Cookie,
  type Extension,
  type NativeImage,
  type Session,
  type WebContents,
  type WebFrameMain,
} from "electron";
import type { ExtensionCallContext, ExtensionRouter } from "./extension-router.js";
import {
  canAccessCookieUrl,
  canReadTabDetails,
  cookieAccessUrls,
  declaredHostPermissions,
  declaredOptionalHostPermissions,
  declaredOptionalPermissions,
  declaredPermissions,
  hasHostPermission,
  hasManifestPermission,
  isRecord,
  isRestrictedWebStoreUrl,
  matchesPattern,
  matchesTitlePattern,
  patternCovers,
  resolveExtensionFile,
  resolveExtensionPageUrl,
  validateExtensionUrl,
} from "./permissions.js";

const WINDOW_ID_NONE = -1;
const WINDOW_ID_CURRENT = -2;
const TAB_ID_NONE = -1;
const POPUP_MIN_WIDTH = 25;
const POPUP_MIN_HEIGHT = 25;
const POPUP_MAX_WIDTH = 800;
const POPUP_MAX_HEIGHT = 600;
const POPUP_PADDING = 5;
const MAX_ACTION_TITLE_LEN = 512;
const MAX_BADGE_TEXT_LEN = 64;
const MAX_BADGE_COLOR_LEN = 64;
const MAX_ICON_DATA_URL_LEN = 256 * 1_024;
const MAX_MENU_ITEMS_PER_EXTENSION = 256;
const MAX_NOTIFICATIONS_PER_EXTENSION = 64;

export interface AnchorRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ManagedTab {
  readonly contents: WebContents;
  readonly open: (url: string, active: boolean) => WebContents;
  readonly close: () => void;
  readonly presentedWindow: () => BaseWindow | null;
}

export interface ChromeApisHost {
  readonly session: Session;
  readonly router: ExtensionRouter;
  readonly sharedWindow: BaseWindow;
  readonly openTab: (url: string, active: boolean, targetWindow?: BaseWindow | null) => WebContents;
  readonly createExtensionWindow: (urls: readonly string[], focused: boolean) => BaseWindow;
  readonly closeExtensionWindow: (window: BaseWindow) => boolean;
  readonly onActionChanged: () => void;
  readonly isClosed: () => boolean;
  /** Returns true only while the owning profile is admitted (not recovering, suspended, or retired). */
  readonly canAccessCookies: () => boolean;
}

interface ActionIconSpec {
  readonly path?: string | Readonly<Record<string, string>> | undefined;
  readonly imageData?: string | Readonly<Record<string, string>> | undefined;
}

interface TabSnapshot {
  readonly active: boolean;
  readonly audible: boolean;
  readonly autoDiscardable: boolean;
  readonly discarded: boolean;
  readonly favIconUrl: string | undefined;
  readonly frozen: boolean;
  readonly groupId: number;
  readonly height: number;
  readonly highlighted: boolean;
  readonly id: number;
  readonly incognito: boolean;
  readonly index: number;
  readonly mutedInfo: { readonly muted: boolean };
  readonly pinned: boolean;
  readonly selected: boolean;
  readonly status: "loading" | "complete";
  readonly title: string;
  readonly url: string;
  readonly width: number;
  readonly windowId: number;
}

interface ActionDetails {
  title?: string;
  popup?: string;
  badgeText?: string;
  badgeColor?: string | null;
  icon?: ActionIconSpec;
}

interface ExtensionActionState extends ActionDetails {
  readonly tabs: Map<number, ActionDetails>;
}

interface ContextMenuProps {
  readonly id: string;
  readonly type: "normal" | "checkbox" | "radio" | "separator";
  readonly title: string;
  readonly contexts: readonly string[];
  readonly enabled: boolean;
  readonly visible: boolean;
  readonly checked?: boolean;
  readonly parentId?: string;
  readonly documentUrlPatterns?: readonly string[];
  readonly targetUrlPatterns?: readonly string[];
}

function clampString(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function normalizeBadgeColor(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? clampString(trimmed, MAX_BADGE_COLOR_LEN) : null;
  }
  if (Array.isArray(value) && value.length >= 3) {
    const [r, g, b, a = 255] = value;
    if (
      typeof r === "number" &&
      typeof g === "number" &&
      typeof b === "number" &&
      typeof a === "number" &&
      Number.isFinite(r) &&
      Number.isFinite(g) &&
      Number.isFinite(b) &&
      Number.isFinite(a)
    ) {
      if (a <= 0) return null;
      const rr = Math.max(0, Math.min(255, Math.round(r)));
      const gg = Math.max(0, Math.min(255, Math.round(g)));
      const bb = Math.max(0, Math.min(255, Math.round(b)));
      if (a >= 255) return `rgb(${rr}, ${gg}, ${bb})`;
      const alpha = Number((Math.max(0, Math.min(255, a)) / 255).toFixed(3));
      return `rgba(${rr}, ${gg}, ${bb}, ${alpha})`;
    }
  }
  return null;
}

function pickBestSizedEntry(map: Readonly<Record<string, string>>): string | undefined {
  const entries = Object.entries(map).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0,
  );
  if (!entries.length) return undefined;
  entries.sort((left, right) => {
    const a = Number.parseInt(left[0], 10) || 0;
    const b = Number.parseInt(right[0], 10) || 0;
    const aDist = a >= 32 ? a - 32 : 1_000 - a;
    const bDist = b >= 32 ? b - 32 : 1_000 - b;
    return aDist - bDist;
  });
  return entries[0]?.[1];
}

const MAX_ICON_PATH_LEN = 512;
const MAX_ICON_SIZE_ENTRIES = 8;

function sanitizeActionIconSpec(details: Record<string, unknown>): ActionIconSpec | null {
  const result: {
    path?: string | Record<string, string>;
    imageData?: string | Record<string, string>;
  } = {};
  let hasField = false;

  if (details.path !== undefined) {
    if (typeof details.path === "string") {
      if (!details.path || details.path.length > MAX_ICON_PATH_LEN) return null;
      result.path = details.path;
      hasField = true;
    } else if (isRecord(details.path)) {
      const entries = Object.entries(details.path);
      if (!entries.length || entries.length > MAX_ICON_SIZE_ENTRIES) return null;
      const cleaned: Record<string, string> = {};
      for (const [size, val] of entries) {
        if (
          !/^\d{1,4}$/u.test(size) ||
          typeof val !== "string" ||
          !val ||
          val.length > MAX_ICON_PATH_LEN
        ) {
          return null;
        }
        cleaned[size] = val;
      }
      result.path = cleaned;
      hasField = true;
    } else {
      return null;
    }
  }

  if (details.imageData !== undefined) {
    if (typeof details.imageData === "string") {
      if (
        !details.imageData.startsWith("data:image/png;base64,") ||
        details.imageData.length > MAX_ICON_DATA_URL_LEN
      ) {
        return null;
      }
      result.imageData = details.imageData;
      hasField = true;
    } else if (isRecord(details.imageData)) {
      const entries = Object.entries(details.imageData);
      if (!entries.length || entries.length > MAX_ICON_SIZE_ENTRIES) return null;
      const cleaned: Record<string, string> = {};
      for (const [size, val] of entries) {
        if (
          !/^\d{1,4}$/u.test(size) ||
          typeof val !== "string" ||
          !val.startsWith("data:image/png;base64,") ||
          val.length > MAX_ICON_DATA_URL_LEN
        ) {
          return null;
        }
        cleaned[size] = val;
      }
      result.imageData = cleaned;
      hasField = true;
    } else {
      return null;
    }
  }

  return hasField ? result : null;
}

export function resolveExtensionIconImage(
  extension: Extension,
  spec?: ActionIconSpec,
): NativeImage | null {
  if (spec?.imageData) {
    const dataUrl =
      typeof spec.imageData === "string" ? spec.imageData : pickBestSizedEntry(spec.imageData);
    if (dataUrl?.startsWith("data:image/") && dataUrl.length <= MAX_ICON_DATA_URL_LEN) {
      const image = nativeImage.createFromDataURL(dataUrl);
      if (!image.isEmpty()) return image.resize({ width: 32, quality: "best" });
    }
  }
  let relativePath: string | undefined;
  if (spec?.path) {
    relativePath = typeof spec.path === "string" ? spec.path : pickBestSizedEntry(spec.path);
  }
  if (!relativePath) {
    const manifest = isRecord(extension.manifest) ? extension.manifest : {};
    const action = isRecord(manifest.action) ? manifest.action.default_icon : undefined;
    if (typeof action === "string") relativePath = action;
    else if (isRecord(action)) relativePath = pickBestSizedEntry(action as Record<string, string>);
    if (!relativePath && isRecord(manifest.icons)) {
      relativePath = pickBestSizedEntry(manifest.icons as Record<string, string>);
    }
  }
  if (!relativePath) return null;
  const absolute = resolveExtensionFile(extension.path, relativePath);
  if (!absolute) return null;
  const image = nativeImage.createFromPath(absolute);
  return image.isEmpty() ? null : image.resize({ width: 32, quality: "best" });
}

function getWindowState(win: BaseWindow): "normal" | "minimized" | "maximized" | "fullscreen" {
  if (win.isFullScreen()) return "fullscreen";
  if (win.isMaximized()) return "maximized";
  if (win.isMinimized()) return "minimized";
  return "normal";
}

function getFrameId(frame: WebFrameMain): number {
  return frame === frame.top ? 0 : frame.frameTreeNodeId;
}

function getParentFrameId(frame: WebFrameMain): number {
  return frame.parent ? getFrameId(frame.parent) : -1;
}

function getFrameDetails(frame: WebFrameMain) {
  return {
    url: frame.url,
    documentId: "",
    documentLifecycle: "active",
    errorOccurred: false,
    frameType: frame.parent ? "sub_frame" : "outermost_frame",
    frameId: getFrameId(frame),
    parentFrameId: getParentFrameId(frame),
  };
}

function cookieToChrome(cookie: Cookie) {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain ?? "",
    hostOnly: Boolean(cookie.hostOnly),
    session: Boolean(cookie.session),
    path: cookie.path ?? "/",
    httpOnly: Boolean(cookie.httpOnly),
    secure: Boolean(cookie.secure),
    sameSite: cookie.sameSite ?? "unspecified",
    ...(cookie.expirationDate !== undefined ? { expirationDate: cookie.expirationDate } : {}),
    storeId: "0",
  };
}

function assertSupportedCookieSelector(details: Record<string, unknown>): void {
  if (details.storeId !== undefined && details.storeId !== "0") {
    throw new Error(`Unsupported cookie storeId: ${String(details.storeId)}`);
  }
  if (details.partitionKey !== undefined) {
    throw new Error("Partitioned cookie selectors are not supported in this browser.");
  }
}

function originOfUrl(urlString: string): string | null {
  try {
    const parsed = new URL(urlString);
    return parsed.origin && parsed.origin !== "null" ? parsed.origin : null;
  } catch {
    return null;
  }
}

function parseStrictStringArray(value: unknown, fieldName: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${fieldName} must be an array of strings.`);
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) {
      throw new Error(`${fieldName} entries must be non-empty strings.`);
    }
    out.push(item);
  }
  return out;
}

const cookieCauseMap: Record<string, string> = {
  explicit: "explicit",
  overwrite: "overwrite",
  expired: "expired",
  evicted: "evicted",
  "expired-overwrite": "expired_overwrite",
};

/** Frameless native Electron popup anchored directly under a clicked extension toolbar button. */
class ExtensionPopupWindow {
  readonly extensionId: string;
  readonly window: BrowserWindow;
  readonly #parent: BaseWindow;
  readonly #anchorRect: AnchorRect;
  readonly #originPrefix: string;
  #destroyed = false;
  #hidden = true;

  constructor(options: {
    readonly extensionId: string;
    readonly extensionName: string;
    readonly session: Session;
    readonly parent: BaseWindow;
    readonly url: string;
    readonly anchorRect: AnchorRect;
    readonly onOpenTab: (url: string) => void;
    readonly onDestroyed: () => void;
  }) {
    this.extensionId = options.extensionId;
    this.#parent = options.parent;
    this.#anchorRect = options.anchorRect;
    this.#originPrefix = `chrome-extension://${options.extensionId}/`;
    this.window = new BrowserWindow({
      show: false,
      frame: true,
      title: clampString(options.extensionName || options.extensionId, MAX_ACTION_TITLE_LEN),
      parent: options.parent,
      movable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      resizable: false,
      skipTaskbar: true,
      backgroundColor: "#ffffff",
      roundedCorners: true,
      width: POPUP_MIN_WIDTH,
      height: POPUP_MIN_HEIGHT,
      webPreferences: {
        session: options.session,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        contextIsolation: true,
        enablePreferredSizeMode: true,
      },
    });
    // Keep the trusted native title bar pinned to the verified extension name so
    // popup web content cannot spoof its attribution via document.title.
    this.window.on("page-title-updated", (event) => event.preventDefault());

    const destroy = () => {
      if (this.#destroyed) return;
      this.#destroyed = true;
      if (!this.#parent.isDestroyed()) {
        this.#parent.off("closed", destroy);
        this.#parent.off("hide", destroy);
      }
      if (!this.window.isDestroyed()) {
        if (!this.window.webContents.isDestroyed() && this.window.webContents.isDevToolsOpened()) {
          this.window.webContents.closeDevTools();
        }
        this.window.off("closed", destroy);
        this.window.destroy();
      }
      options.onDestroyed();
    };
    this.destroy = destroy;

    const maybeCloseOnBlur = () => {
      if (this.#destroyed || this.window.isDestroyed()) return;
      if (!this.window.webContents.isDestroyed() && this.window.webContents.isDevToolsOpened()) {
        return;
      }
      destroy();
    };

    const contents = this.window.webContents;
    // Confine ALL navigations — top-level AND subframes — strictly to the extension's own origin.
    const guardTopNavigation = (event: Electron.Event, targetUrl: string) => {
      if (targetUrl.startsWith(this.#originPrefix)) return;
      event.preventDefault();
      if (isWebOrOwnExtensionUrl(targetUrl, this.extensionId)) {
        options.onOpenTab(targetUrl);
        destroy();
      }
    };
    contents.on("will-navigate", guardTopNavigation);
    contents.on("will-redirect", guardTopNavigation);
    contents.on("will-frame-navigate", (details) => {
      if (details.url.startsWith(this.#originPrefix) || details.url === "about:blank") return;
      details.preventDefault();
      if (details.isMainFrame && isWebOrOwnExtensionUrl(details.url, this.extensionId)) {
        options.onOpenTab(details.url);
        destroy();
      }
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (isWebOrOwnExtensionUrl(url, this.extensionId)) {
        options.onOpenTab(url);
        destroy();
      }
      return { action: "deny" };
    });
    contents.on("preferred-size-changed", (_event, size) => {
      if (this.#destroyed || this.window.isDestroyed() || this.#parent.isDestroyed()) return;
      this.#resizeAndPosition(size.width, size.height);
      if (this.#hidden) {
        this.#hidden = false;
        this.window.show();
      }
    });
    contents.on("devtools-closed", maybeCloseOnBlur);
    this.window.on("blur", maybeCloseOnBlur);
    this.window.on("closed", destroy);
    this.#parent.once("closed", destroy);
    this.#parent.on("hide", destroy);

    void contents.loadURL(options.url).catch(() => destroy());
  }

  readonly destroy: () => void;

  get isDestroyed(): boolean {
    return this.#destroyed || this.window.isDestroyed();
  }

  #resizeAndPosition(rawWidth: number, rawHeight: number): void {
    const width = Math.floor(Math.min(POPUP_MAX_WIDTH, Math.max(rawWidth || 0, POPUP_MIN_WIDTH)));
    const height = Math.floor(
      Math.min(POPUP_MAX_HEIGHT, Math.max(rawHeight || 0, POPUP_MIN_HEIGHT)),
    );
    const parentBounds = this.#parent.getBounds();
    const contentBounds = this.#parent.getContentBounds();
    const titlebarHeight = parentBounds.height - contentBounds.height;
    let x = parentBounds.x + this.#anchorRect.x + this.#anchorRect.width - width;
    const minX = parentBounds.x + POPUP_PADDING;
    const maxX = parentBounds.x + parentBounds.width - width - POPUP_PADDING;
    x = Math.floor(Math.max(minX, Math.min(x, Math.max(minX, maxX))));
    const y = Math.floor(
      parentBounds.y +
        titlebarHeight +
        this.#anchorRect.y +
        this.#anchorRect.height +
        POPUP_PADDING,
    );
    this.window.setBounds({ x, y, width, height });
  }
}

function isWebOrOwnExtensionUrl(urlString: string, extensionId: string): boolean {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return true;
    return parsed.protocol === "chrome-extension:" && parsed.hostname === extensionId;
  } catch {
    return false;
  }
}

/**
 * Complete permission-enforced Chrome MV3 API implementation for one saved profile Session.
 */
export class ChromeExtensionApis {
  readonly #host: ChromeApisHost;
  readonly #tabs = new Map<
    WebContents,
    { readonly tab: ManagedTab; window: BaseWindow; favicon: string | undefined }
  >();
  readonly #windows = new Set<BaseWindow>();
  readonly #windowActiveTab = new WeakMap<BaseWindow, WebContents>();
  readonly #windowEmittedRemoved = new WeakSet<BaseWindow>();
  readonly #actions = new Map<string, ExtensionActionState>();
  readonly #iconDataCache = new Map<string, string | null>();
  readonly #menus = new Map<string, Map<string, ContextMenuProps>>();
  readonly #notifications = new Map<string, Notification>();
  /** `activeTab` grants: extensionId -> Map<tabId, grantedOrigin>, cleared on navigation/close. */
  readonly #activeTabGrants = new Map<string, Map<number, string>>();
  readonly #tabCleanups = new WeakMap<WebContents, () => void>();
  #lastFocusedWindowId: number;
  #popup: ExtensionPopupWindow | null = null;
  #actionUpdateQueued = false;
  readonly #onExtensionLoaded: (_event: Electron.Event, extension: Extension) => void;
  readonly #onExtensionUnloaded: (_event: Electron.Event, extension: Extension) => void;
  readonly #onCookieChanged: (
    _event: Electron.Event,
    cookie: Cookie,
    cause: string,
    removed: boolean,
  ) => void;

  constructor(host: ChromeApisHost) {
    this.#host = host;
    this.#windows.add(host.sharedWindow);
    this.#lastFocusedWindowId = host.sharedWindow.id;
    this.#observeWindow(host.sharedWindow, false);

    this.#registerHandlers();

    this.#onExtensionLoaded = (_event, extension) => {
      this.#initExtensionAction(extension);
      this.#scheduleActionChanged();
    };
    this.#onExtensionUnloaded = (_event, extension) => {
      this.#actions.delete(extension.id);
      this.#menus.delete(extension.id);
      this.#activeTabGrants.delete(extension.id);
      this.#clearIconCacheFor(extension.id);
      if (this.#popup?.extensionId === extension.id) {
        this.#popup.destroy();
        this.#popup = null;
      }
      for (const [key, notif] of this.#notifications) {
        if (key.startsWith(`${extension.id}:`)) {
          notif.close();
          this.#notifications.delete(key);
        }
      }
      this.#scheduleActionChanged();
    };
    this.#onCookieChanged = (_event, cookie, cause, removed) => {
      if (!this.#host.canAccessCookies()) return;
      const urls = cookieAccessUrls(cookie);
      if (!urls.length) return;
      const payload = {
        cause: cookieCauseMap[cause] ?? cause,
        cookie: cookieToChrome(cookie),
        removed,
      };
      this.#host.router.broadcastAuthorized(
        "cookies.onChanged",
        (extension) => {
          const allowed = urls.some((url) => canAccessCookieUrl(extension.manifest, url));
          return allowed ? [payload] : null;
        },
        () => this.#host.canAccessCookies(),
      );
    };

    host.session.extensions.on("extension-loaded", this.#onExtensionLoaded);
    host.session.extensions.on("extension-unloaded", this.#onExtensionUnloaded);
    host.session.cookies.on("changed", this.#onCookieChanged);
    for (const extension of host.session.extensions.getAllExtensions()) {
      this.#initExtensionAction(extension);
    }
  }

  dispose(): void {
    this.#popup?.destroy();
    this.#popup = null;
    this.#host.session.extensions.off("extension-loaded", this.#onExtensionLoaded);
    this.#host.session.extensions.off("extension-unloaded", this.#onExtensionUnloaded);
    this.#host.session.cookies.off("changed", this.#onCookieChanged);
    for (const notif of this.#notifications.values()) notif.close();
    this.#notifications.clear();
    for (const [contents] of this.#tabs) {
      this.#tabCleanups.get(contents)?.();
      this.#tabCleanups.delete(contents);
    }
    this.#tabs.clear();
    this.#actions.clear();
    this.#menus.clear();
    this.#activeTabGrants.clear();
    this.#iconDataCache.clear();
  }

  addWindow(window: BaseWindow): void {
    if (this.#windows.has(window)) return;
    this.#windows.add(window);
    this.#observeWindow(window, true);
  }

  addTab(tab: ManagedTab, window: BaseWindow): () => void {
    const contents = tab.contents;
    if (this.#tabs.has(contents)) return () => undefined;
    if (!this.#windows.has(window)) this.addWindow(window);
    const entry: { readonly tab: ManagedTab; window: BaseWindow; favicon: string | undefined } = {
      tab,
      window,
      favicon: undefined,
    };
    this.#tabs.set(contents, entry);
    if (!this.#getActiveTabInWindow(window)) {
      this.#setActiveTab(contents);
    }

    const tabId = contents.id;
    let prevSnapshot = this.#rawTabSnapshot(contents, entry);

    const emitUpdated = () => {
      if (contents.isDestroyed() || !this.#tabs.has(contents)) return;
      const next = this.#rawTabSnapshot(contents, entry);
      const changeInfo: Record<string, unknown> = {};
      let changed = false;
      for (const key of ["audible", "favIconUrl", "status", "title", "url"] as const) {
        if (next[key] !== prevSnapshot[key]) {
          changeInfo[key] = next[key];
          changed = true;
        }
      }
      if (next.mutedInfo.muted !== prevSnapshot.mutedInfo.muted) {
        changeInfo.mutedInfo = next.mutedInfo;
        changed = true;
      }
      if (!changed) return;
      prevSnapshot = next;
      this.#host.router.broadcastAuthorized("tabs.onUpdated", (extension) => {
        const sanitizedTab = this.#sanitizeTabForExtension(extension, next);
        const canRead = canReadTabDetails(
          extension.manifest,
          next.url,
          this.#hasActiveTabGrant(extension.id, tabId, next.url),
        );
        const filteredChange: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(changeInfo)) {
          if (!canRead && (k === "url" || k === "title" || k === "favIconUrl")) continue;
          filteredChange[k] = v;
        }
        if (!Object.keys(filteredChange).length) return null;
        return [tabId, filteredChange, sanitizedTab];
      });
    };

    const onFavicon = (_event: Electron.Event, favicons: string[]) => {
      entry.favicon = favicons[0];
      emitUpdated();
    };

    const onDidStartNav = (
      _event: Electron.Event,
      url: string,
      isInPlace: boolean,
      isMainFrame: boolean,
      frameProcessId: number,
      frameRoutingId: number,
    ) => {
      if (isMainFrame && !isInPlace) {
        // Preserve activeTab across same-origin navigations per Chrome's activeTab contract,
        // revoking immediately whenever navigation targets another origin.
        this.#revokeActiveTabIfOriginChanged(tabId, url);
      }
      emitUpdated();
      if (isInPlace) return;
      const frame = webFrameMain.fromId(frameProcessId, frameRoutingId);
      if (!frame) return;
      this.#emitWebNavigation("onBeforeNavigate", {
        frameId: getFrameId(frame),
        frameType: frame.parent ? "sub_frame" : "outermost_frame",
        documentLifecycle: "active",
        parentFrameId: getParentFrameId(frame),
        processId: frame.processId,
        tabId,
        timeStamp: Date.now(),
        url,
      });
    };

    const onDidFrameNavigate = (
      _event: Electron.Event,
      url: string,
      _httpResponseCode: number,
      _httpStatusText: string,
      isMainFrame: boolean,
      frameProcessId: number,
      frameRoutingId: number,
    ) => {
      if (isMainFrame) {
        this.#revokeActiveTabIfOriginChanged(tabId, url);
      }
      emitUpdated();
      const frame = webFrameMain.fromId(frameProcessId, frameRoutingId);
      if (!frame) return;
      this.#emitWebNavigation("onCommitted", {
        frameId: getFrameId(frame),
        parentFrameId: getParentFrameId(frame),
        frameType: frame.parent ? "sub_frame" : "outermost_frame",
        transitionType: "link",
        transitionQualifiers: [],
        documentLifecycle: "active",
        processId: frameProcessId,
        tabId,
        timeStamp: Date.now(),
        url,
      });
    };

    const onDidNavigateInPage = (
      _event: Electron.Event,
      url: string,
      _isMainFrame: boolean,
      frameProcessId: number,
      frameRoutingId: number,
    ) => {
      emitUpdated();
      const frame = webFrameMain.fromId(frameProcessId, frameRoutingId);
      if (!frame) return;
      this.#emitWebNavigation("onHistoryStateUpdated", {
        frameId: getFrameId(frame),
        parentFrameId: getParentFrameId(frame),
        frameType: frame.parent ? "sub_frame" : "outermost_frame",
        transitionType: "link",
        transitionQualifiers: [],
        documentLifecycle: "active",
        processId: frameProcessId,
        tabId,
        timeStamp: Date.now(),
        url,
      });
    };

    const onDidFrameFinishLoad = (
      _event: Electron.Event,
      _isMainFrame: boolean,
      frameProcessId: number,
      frameRoutingId: number,
    ) => {
      const frame = webFrameMain.fromId(frameProcessId, frameRoutingId);
      if (!frame) return;
      this.#emitWebNavigation("onCompleted", {
        frameId: getFrameId(frame),
        parentFrameId: getParentFrameId(frame),
        frameType: frame.parent ? "sub_frame" : "outermost_frame",
        documentLifecycle: "active",
        processId: frameProcessId,
        tabId,
        timeStamp: Date.now(),
        url: frame.url,
      });
    };

    const onDomReady = () => {
      if (contents.isDestroyed()) return;
      const frame = contents.mainFrame;
      if (!frame) return;
      this.#emitWebNavigation("onDOMContentLoaded", {
        frameId: getFrameId(frame),
        parentFrameId: getParentFrameId(frame),
        frameType: "outermost_frame",
        documentLifecycle: "active",
        processId: frame.processId,
        tabId,
        timeStamp: Date.now(),
        url: frame.url,
      });
    };

    const onSimple = () => emitUpdated();
    const bindSimple = (attach: boolean) => {
      const fn = attach ? "on" : "off";
      contents[fn]("page-title-updated", onSimple);
      contents[fn]("did-start-loading", onSimple);
      contents[fn]("did-stop-loading", onSimple);
      contents[fn]("media-started-playing", onSimple);
      contents[fn]("media-paused", onSimple);
      contents[fn]("did-redirect-navigation", onSimple);
    };
    bindSimple(true);
    contents.on("page-favicon-updated", onFavicon);
    contents.on("did-start-navigation", onDidStartNav);
    contents.on("did-frame-navigate", onDidFrameNavigate);
    contents.on("did-navigate-in-page", onDidNavigateInPage);
    contents.on("did-frame-finish-load", onDidFrameFinishLoad);
    contents.on("dom-ready", onDomReady);

    const cleanup = () => {
      if (!this.#tabs.has(contents)) return;
      this.#tabs.delete(contents);
      this.#tabCleanups.delete(contents);
      this.#revokeActiveTabForTab(tabId);
      for (const action of this.#actions.values()) {
        if (action.tabs.delete(tabId)) this.#scheduleActionChanged();
      }
      if (!contents.isDestroyed()) {
        bindSimple(false);
        contents.off("page-favicon-updated", onFavicon);
        contents.off("did-start-navigation", onDidStartNav);
        contents.off("did-frame-navigate", onDidFrameNavigate);
        contents.off("did-navigate-in-page", onDidNavigateInPage);
        contents.off("did-frame-finish-load", onDidFrameFinishLoad);
        contents.off("dom-ready", onDomReady);
      }
      const win = entry.window;
      if (this.#windowActiveTab.get(win) === contents) {
        const nextInWindow = [...this.#tabs.entries()].find(
          ([wc, item]) => item.window === win && !wc.isDestroyed(),
        )?.[0];
        if (nextInWindow) this.#windowActiveTab.set(win, nextInWindow);
        else this.#windowActiveTab.delete(win);
      }
      const isWindowClosing = win.isDestroyed();
      const windowId = isWindowClosing ? WINDOW_ID_NONE : win.id;
      this.#host.router.broadcastAuthorized("tabs.onRemoved", () => [
        tabId,
        { windowId, isWindowClosing },
      ]);
    };
    this.#tabCleanups.set(contents, cleanup);
    contents.once("destroyed", cleanup);

    const createdSnapshot = this.#rawTabSnapshot(contents, entry);
    this.#host.router.broadcastAuthorized("tabs.onCreated", (extension) => [
      this.#sanitizeTabForExtension(extension, createdSnapshot),
    ]);
    return cleanup;
  }

  selectTab(contents: WebContents): void {
    const entry = this.#tabs.get(contents);
    if (!entry || contents.isDestroyed() || entry.window.isDestroyed()) return;
    const prev = this.#windowActiveTab.get(entry.window);
    if (prev && prev !== contents && this.#popup) {
      this.#popup.destroy();
      this.#popup = null;
    }
    this.#setActiveTab(contents);
  }

  /** Resolves an extension's toolbar button state for a specific page (`tabContents`). */
  resolveAction(
    extension: Extension,
    tabContents?: WebContents,
  ): DesktopBrowserExtensionAction | null {
    const manifest = isRecord(extension.manifest) ? extension.manifest : {};
    const state = this.#actions.get(extension.id);
    if (!state && !isRecord(manifest.action)) return null;
    const tabOverride = tabContents ? state?.tabs.get(tabContents.id) : undefined;
    const title = clampString(
      tabOverride?.title ?? state?.title ?? extension.name,
      MAX_ACTION_TITLE_LEN,
    );
    const badgeText = clampString(
      tabOverride?.badgeText ?? state?.badgeText ?? "",
      MAX_BADGE_TEXT_LEN,
    );
    const rawColor =
      tabOverride?.badgeColor !== undefined ? tabOverride.badgeColor : (state?.badgeColor ?? null);
    const badgeColor = rawColor ? clampString(rawColor, MAX_BADGE_COLOR_LEN) : null;
    const popupPath = tabOverride?.popup !== undefined ? tabOverride.popup : state?.popup;
    const hasPopup = Boolean(resolveExtensionPageUrl(extension.id, popupPath));
    const iconSpec = tabOverride?.icon ?? state?.icon;
    const icon = this.#cachedIconDataUrl(extension, iconSpec);
    return { title, badgeText, badgeColor, icon, hasPopup };
  }

  /** Returns the extension's base icon as a cached PNG data URL. */
  extensionIconDataUrl(extension: Extension): string | null {
    return this.#cachedIconDataUrl(extension, undefined);
  }

  /** Activates an extension's toolbar action anchored directly to the clicked `hostWindow`. */
  activateAction(options: {
    readonly extensionId: string;
    readonly tabContents: WebContents;
    readonly hostWindow: BaseWindow;
    readonly eventType: "click" | "contextmenu";
    readonly anchorRect: AnchorRect;
  }): void {
    const extension = this.#host.session.extensions.getExtension(options.extensionId);
    if (!extension || options.tabContents.isDestroyed() || options.hostWindow.isDestroyed()) return;
    this.selectTab(options.tabContents);

    if (options.eventType === "contextmenu") {
      this.#openActionContextMenu(
        extension,
        options.tabContents,
        options.hostWindow,
        options.anchorRect,
      );
      return;
    }

    // Trusted user gesture: grant activeTab ONLY if declared in manifest, bound to tab + origin.
    this.#grantActiveTab(extension, options.tabContents);

    if (this.#popup) {
      const sameExtension = !this.#popup.isDestroyed && this.#popup.extensionId === extension.id;
      this.#popup.destroy();
      this.#popup = null;
      if (sameExtension) return;
    }

    const popupUrl = this.#popupUrlForTab(extension.id, options.tabContents.id);
    if (popupUrl) {
      this.#openPopupWindow(extension, options.hostWindow, popupUrl, options.anchorRect);
      return;
    }

    const entry = this.#tabs.get(options.tabContents);
    if (!entry) return;
    const snapshot = this.#rawTabSnapshot(options.tabContents, entry);
    this.#host.router.sendToExtension(
      extension.id,
      "action.onClicked",
      this.#sanitizeTabForExtension(extension, snapshot),
    );
  }

  /** Programmatic `Extensions.triggerAction` (trusted CDP agent invocation). */
  triggerAction(extensionId: string, tabContents?: WebContents): void {
    const extension = this.#host.session.extensions.getExtension(extensionId);
    if (!extension) throw new Error(`No extension ${extensionId} in this profile.`);
    const target = tabContents ?? this.#getActiveTabOfCurrentWindow();
    if (!target || target.isDestroyed()) {
      throw new Error("No active tab in this profile to trigger the extension action on.");
    }
    const entry = this.#tabs.get(target);
    const presented = entry?.tab.presentedWindow();
    if (presented && !presented.isDestroyed()) {
      const [width = 800] = presented.getSize();
      this.activateAction({
        extensionId,
        tabContents: target,
        hostWindow: presented,
        eventType: "click",
        anchorRect: { x: Math.max(0, width - 80), y: 40, width: 32, height: 32 },
      });
      return;
    }
    // Headless/unpresented tab: grant activeTab if declared, open popup as tab or fire onClicked.
    this.#grantActiveTab(extension, target);
    const popupUrl = this.#popupUrlForTab(extension.id, target.id);
    if (popupUrl) {
      this.#host.openTab(popupUrl, true);
      return;
    }
    if (entry) {
      const snapshot = this.#rawTabSnapshot(target, entry);
      this.#host.router.sendToExtension(
        extension.id,
        "action.onClicked",
        this.#sanitizeTabForExtension(extension, snapshot),
      );
    }
  }

  /** Extension items for a page's right-click context menu. */
  contextMenuItems(contents: WebContents, params: ContextMenuParams): MenuItem[] {
    if (!this.#tabs.has(contents) || contents.isDestroyed()) return [];
    const contextTypes = contextTypesFromParams(params);
    const documentUrl = params.frameURL || params.pageURL || contents.getURL();
    const targetUrl = params.linkURL || params.srcURL || "";
    const result: MenuItem[] = [];

    for (const [extensionId, itemMap] of this.#menus) {
      const extension = this.#host.session.extensions.getExtension(extensionId);
      if (!extension || !hasManifestPermission(extension.manifest, "contextMenus")) continue;
      const matching = [...itemMap.values()].filter((props) =>
        menuItemMatches(props, contextTypes, documentUrl, targetUrl),
      );
      if (!matching.length) continue;
      const built = this.#buildMenuItems(extension, matching, contents, params);
      if (built.length === 1) {
        result.push(built[0]!);
      } else if (built.length > 1) {
        const submenu = new Menu();
        for (const child of built) submenu.append(child);
        const icon = resolveExtensionIconImage(extension)?.resize({ width: 16, height: 16 });
        result.push(
          new MenuItem({
            label: extension.name,
            type: "submenu",
            ...(icon ? { icon } : {}),
            submenu,
          }),
        );
      }
    }
    return result;
  }

  /** Extension-initiated `chrome.action.openPopup()`: NEVER grants `activeTab` or fires `onClicked`. */
  #openPopupFromExtension(extension: Extension): void {
    const target = this.#getActiveTabOfCurrentWindow();
    if (!target || target.isDestroyed()) return;
    const popupUrl = this.#popupUrlForTab(extension.id, target.id);
    if (!popupUrl) {
      throw new Error("Extension declares no popup for the active tab.");
    }
    const presented = this.#tabs.get(target)?.tab.presentedWindow();
    if (!presented || presented.isDestroyed()) {
      throw new Error("Cannot open extension popup without a visible browser window.");
    }
    if (this.#popup) {
      this.#popup.destroy();
      this.#popup = null;
    }
    const [width = 800] = presented.getSize();
    this.#openPopupWindow(extension, presented, popupUrl, {
      x: Math.max(0, width - 80),
      y: 40,
      width: 32,
      height: 32,
    });
  }

  #popupUrlForTab(extensionId: string, tabId: number): string | null {
    const state = this.#actions.get(extensionId);
    const tabOverride = state?.tabs.get(tabId);
    const popupPath = tabOverride?.popup !== undefined ? tabOverride.popup : state?.popup;
    return resolveExtensionPageUrl(extensionId, popupPath);
  }

  #openPopupWindow(
    extension: Extension,
    hostWindow: BaseWindow,
    popupUrl: string,
    anchorRect: AnchorRect,
  ): void {
    const popup = new ExtensionPopupWindow({
      extensionId: extension.id,
      extensionName: extension.name,
      session: this.#host.session,
      parent: hostWindow,
      url: popupUrl,
      anchorRect,
      onOpenTab: (url) => {
        try {
          this.#host.openTab(url, true);
        } catch {
          // Ignore when no opener tab remains.
        }
      },
      onDestroyed: () => {
        if (this.#popup === popup) this.#popup = null;
      },
    });
    this.#popup = popup;
  }

  #openActionContextMenu(
    extension: Extension,
    tabContents: WebContents,
    hostWindow: BaseWindow,
    anchorRect: AnchorRect,
  ): void {
    const manifest = isRecord(extension.manifest) ? extension.manifest : {};
    const menu = new Menu();
    menu.append(
      new MenuItem({
        label: extension.name,
        click: () => {
          const home =
            typeof manifest.homepage_url === "string" &&
            isWebOrOwnExtensionUrl(manifest.homepage_url, extension.id)
              ? manifest.homepage_url
              : `https://chromewebstore.google.com/detail/${extension.id}`;
          this.#host.openTab(home, true);
        },
      }),
    );

    const actionMenuItems = [...(this.#menus.get(extension.id)?.values() ?? [])].filter(
      (item) =>
        item.visible &&
        (item.contexts.includes("action") ||
          item.contexts.includes("browser_action") ||
          item.contexts.includes("all")),
    );
    if (actionMenuItems.length) {
      menu.append(new MenuItem({ type: "separator" }));
      for (const item of this.#buildMenuItems(extension, actionMenuItems, tabContents)) {
        menu.append(item);
      }
    }

    const optionsPage =
      isRecord(manifest.options_ui) && typeof manifest.options_ui.page === "string"
        ? manifest.options_ui.page
        : typeof manifest.options_page === "string"
          ? manifest.options_page
          : undefined;
    const optionsUrl = resolveExtensionPageUrl(extension.id, optionsPage);
    if (optionsUrl) {
      menu.append(new MenuItem({ type: "separator" }));
      menu.append(
        new MenuItem({
          label: "Options",
          click: () => this.#host.openTab(optionsUrl, true),
        }),
      );
    }

    menu.popup({
      window: hostWindow as unknown as BrowserWindow,
      x: Math.floor(anchorRect.x),
      y: Math.floor(anchorRect.y + anchorRect.height),
    });
  }

  #buildMenuItems(
    extension: Extension,
    items: readonly ContextMenuProps[],
    tabContents: WebContents,
    params?: ContextMenuParams,
  ): MenuItem[] {
    const icon = resolveExtensionIconImage(extension)?.resize({ width: 16, height: 16 });
    const byId = new Map<string, { props: ContextMenuProps; children: ContextMenuProps[] }>();
    for (const props of items) byId.set(props.id, { props, children: [] });
    const roots: ContextMenuProps[] = [];
    for (const props of items) {
      if (props.parentId && byId.has(props.parentId)) {
        byId.get(props.parentId)!.children.push(props);
      } else {
        roots.push(props);
      }
    }
    const buildNode = (props: ContextMenuProps, topLevel: boolean): MenuItem => {
      const node = byId.get(props.id)!;
      const label = params ? formatMenuTitle(props.title, params) : props.title;
      if (node.children.length > 0) {
        const submenu = new Menu();
        for (const child of node.children) submenu.append(buildNode(child, false));
        return new MenuItem({
          label,
          type: "submenu",
          enabled: props.enabled,
          ...(topLevel && icon ? { icon } : {}),
          submenu,
        });
      }
      if (props.type === "separator") return new MenuItem({ type: "separator" });
      return new MenuItem({
        label,
        type: props.type,
        enabled: props.enabled,
        ...(props.checked !== undefined ? { checked: props.checked } : {}),
        ...(topLevel && icon ? { icon } : {}),
        click: () => this.#fireContextMenuClick(extension, props, tabContents, params),
      });
    };
    return roots.map((root) => buildNode(root, true));
  }

  #fireContextMenuClick(
    extension: Extension,
    props: ContextMenuProps,
    tabContents: WebContents,
    params?: ContextMenuParams,
  ): void {
    if (tabContents.isDestroyed()) return;
    this.#grantActiveTab(extension, tabContents);
    const entry = this.#tabs.get(tabContents);
    const tabDetails = entry
      ? this.#sanitizeTabForExtension(extension, this.#rawTabSnapshot(tabContents, entry))
      : undefined;
    const info: Record<string, unknown> = {
      menuItemId: props.id,
      ...(props.parentId ? { parentMenuItemId: props.parentId } : {}),
      editable: Boolean(params?.isEditable),
      pageUrl: params?.pageURL || tabContents.getURL(),
      ...(params?.frameURL ? { frameUrl: params.frameURL } : {}),
      ...(params?.linkURL ? { linkUrl: params.linkURL } : {}),
      ...(params?.srcURL ? { srcUrl: params.srcURL } : {}),
      ...(params?.selectionText ? { selectionText: params.selectionText } : {}),
      ...(params?.mediaType && params.mediaType !== "none" ? { mediaType: params.mediaType } : {}),
    };
    this.#host.router.sendToExtension(extension.id, "contextMenus.onClicked", info, tabDetails);
  }

  #observeWindow(window: BaseWindow, emitCreated: boolean): void {
    const windowId = window.id;
    window.on("focus", () => {
      if (this.#lastFocusedWindowId === windowId) return;
      this.#lastFocusedWindowId = windowId;
      this.#host.router.broadcastAuthorized("windows.onFocusChanged", () => [windowId]);
    });
    window.on("resized", () => {
      if (window.isDestroyed()) return;
      this.#host.router.broadcastAuthorized("windows.onBoundsChanged", (extension) => [
        this.#windowDetails(extension, window, false),
      ]);
    });
    window.once("closed", () => {
      this.#windows.delete(window);
      if (this.#lastFocusedWindowId === windowId && !this.#host.sharedWindow.isDestroyed()) {
        this.#lastFocusedWindowId = this.#host.sharedWindow.id;
      }
      this.#emitWindowRemovedOnce(window, windowId);
    });
    if (emitCreated) {
      this.#host.router.broadcastAuthorized("windows.onCreated", (extension) => [
        this.#windowDetails(extension, window, false),
      ]);
    }
  }

  #emitWindowRemovedOnce(window: BaseWindow, windowId: number): void {
    if (this.#windowEmittedRemoved.has(window)) return;
    this.#windowEmittedRemoved.add(window);
    this.#host.router.broadcastAuthorized("windows.onRemoved", () => [windowId]);
  }

  #setActiveTab(contents: WebContents): void {
    const entry = this.#tabs.get(contents);
    if (!entry || contents.isDestroyed() || entry.window.isDestroyed()) return;
    const prev = this.#windowActiveTab.get(entry.window);
    this.#windowActiveTab.set(entry.window, contents);
    if (prev !== contents) {
      this.#host.router.broadcastAuthorized("tabs.onActivated", () => [
        { tabId: contents.id, windowId: entry.window.id },
      ]);
      this.#scheduleActionChanged();
    }
  }

  #getActiveTabInWindow(win: BaseWindow): WebContents | null {
    if (win.isDestroyed()) return null;
    const active = this.#windowActiveTab.get(win);
    if (active && !active.isDestroyed() && this.#tabs.has(active)) return active;
    return null;
  }

  #getCurrentWindow(): BaseWindow | null {
    const byFocus = this.#getWindowById(this.#lastFocusedWindowId);
    if (byFocus) return byFocus;
    if (!this.#host.sharedWindow.isDestroyed() && this.#windows.has(this.#host.sharedWindow)) {
      return this.#host.sharedWindow;
    }
    return [...this.#windows].find((win) => !win.isDestroyed()) ?? null;
  }

  #getWindowById(windowId: number): BaseWindow | null {
    if (windowId === WINDOW_ID_CURRENT) return this.#getCurrentWindow();
    return [...this.#windows].find((win) => !win.isDestroyed() && win.id === windowId) ?? null;
  }

  #getActiveTabOfCurrentWindow(): WebContents | null {
    const win = this.#getCurrentWindow();
    if (!win) return null;
    return this.#getActiveTabInWindow(win);
  }

  #getTabById(tabId: number): WebContents | null {
    for (const contents of this.#tabs.keys()) {
      if (!contents.isDestroyed() && contents.id === tabId) return contents;
    }
    return null;
  }

  #rawTabSnapshot(
    contents: WebContents,
    entry: {
      readonly tab: ManagedTab;
      readonly window: BaseWindow;
      readonly favicon: string | undefined;
    },
  ): TabSnapshot {
    const win = entry.window.isDestroyed() ? null : entry.window;
    const activeTab = win ? this.#getActiveTabInWindow(win) : null;
    const [width = 0, height = 0] = win ? win.getSize() : [0, 0];
    const windowTabs = [...this.#tabs.entries()].filter(
      ([wc, item]) => !wc.isDestroyed() && item.window === entry.window,
    );
    const index = windowTabs.findIndex(([wc]) => wc === contents);
    return {
      active: activeTab === contents,
      audible: contents.isCurrentlyAudible(),
      autoDiscardable: true,
      discarded: false,
      favIconUrl: entry.favicon,
      frozen: false,
      groupId: -1,
      height,
      highlighted: activeTab === contents,
      id: contents.id,
      incognito: !this.#host.session.isPersistent(),
      index: Math.max(0, index),
      mutedInfo: { muted: contents.audioMuted },
      pinned: false,
      selected: activeTab === contents,
      status: contents.isLoading() ? "loading" : "complete",
      title: contents.getTitle(),
      url: contents.getURL(),
      width,
      windowId: win ? win.id : WINDOW_ID_NONE,
    };
  }

  #sanitizeTabForExtension(extension: Extension, snapshot: TabSnapshot): Record<string, unknown> {
    const allowed = canReadTabDetails(
      extension.manifest,
      snapshot.url,
      this.#hasActiveTabGrant(extension.id, snapshot.id, snapshot.url),
    );
    if (allowed) return { ...snapshot };
    const { url: _u, title: _t, favIconUrl: _f, ...safe } = snapshot;
    return safe;
  }

  #windowDetails(
    extension: Extension,
    win: BaseWindow,
    populate: boolean,
  ): Record<string, unknown> {
    const [left = 0, top = 0] = win.getPosition();
    const [width = 0, height = 0] = win.getSize();
    const details: Record<string, unknown> = {
      id: win.id,
      focused: win.isFocused(),
      top,
      left,
      width,
      height,
      incognito: !this.#host.session.isPersistent(),
      type: "normal",
      state: getWindowState(win),
      alwaysOnTop: win.isAlwaysOnTop(),
    };
    if (populate) {
      details.tabs = [...this.#tabs.entries()]
        .filter(([wc, entry]) => !wc.isDestroyed() && entry.window === win)
        .map(([wc, entry]) =>
          this.#sanitizeTabForExtension(extension, this.#rawTabSnapshot(wc, entry)),
        );
    }
    return details;
  }

  /**
   * Grants `activeTab` ONLY when the extension declares `"activeTab"` in its manifest,
   * bound strictly to `(tabId, currentOrigin)`, and never on the Chrome Web Store origin.
   */
  #grantActiveTab(extension: Extension, tabContents: WebContents): void {
    if (!hasManifestPermission(extension.manifest, "activeTab")) return;
    if (tabContents.isDestroyed()) return;
    const url = tabContents.getURL();
    if (isRestrictedWebStoreUrl(url)) return;
    const origin = originOfUrl(url);
    if (!origin) return;
    let map = this.#activeTabGrants.get(extension.id);
    if (!map) {
      map = new Map();
      this.#activeTabGrants.set(extension.id, map);
    }
    map.set(tabContents.id, origin);
  }

  #hasActiveTabGrant(extensionId: string, tabId: number, currentUrl: string): boolean {
    const grantedOrigin = this.#activeTabGrants.get(extensionId)?.get(tabId);
    if (!grantedOrigin) return false;
    return originOfUrl(currentUrl) === grantedOrigin;
  }

  #revokeActiveTabForTab(tabId: number): void {
    for (const map of this.#activeTabGrants.values()) map.delete(tabId);
  }

  #revokeActiveTabIfOriginChanged(tabId: number, nextUrl: string): void {
    const nextOrigin = originOfUrl(nextUrl);
    for (const map of this.#activeTabGrants.values()) {
      const granted = map.get(tabId);
      if (granted && granted !== nextOrigin) map.delete(tabId);
    }
  }

  #emitWebNavigation(eventName: string, details: Record<string, unknown>): void {
    this.#host.router.broadcastAuthorized(`webNavigation.${eventName}`, (extension) =>
      hasManifestPermission(extension.manifest, "webNavigation") ? [details] : null,
    );
  }

  #initExtensionAction(extension: Extension): void {
    const manifest = isRecord(extension.manifest) ? extension.manifest : {};
    const actionManifest = isRecord(manifest.action) ? manifest.action : null;
    if (!actionManifest) return;
    const state: ExtensionActionState = {
      title: clampString(
        typeof actionManifest.default_title === "string" && actionManifest.default_title
          ? actionManifest.default_title
          : extension.name,
        MAX_ACTION_TITLE_LEN,
      ),
      ...(typeof actionManifest.default_popup === "string"
        ? { popup: actionManifest.default_popup }
        : {}),
      badgeText: "",
      badgeColor: null,
      tabs: new Map(),
    };
    this.#actions.set(extension.id, state);
  }

  #ensureActionState(extension: Extension): ExtensionActionState {
    let state = this.#actions.get(extension.id);
    if (!state) {
      this.#initExtensionAction(extension);
      state = this.#actions.get(extension.id);
    }
    if (!state) {
      state = {
        title: clampString(extension.name, MAX_ACTION_TITLE_LEN),
        badgeText: "",
        badgeColor: null,
        tabs: new Map(),
      };
      this.#actions.set(extension.id, state);
    }
    return state;
  }

  #scheduleActionChanged(): void {
    if (this.#actionUpdateQueued || this.#host.isClosed()) return;
    this.#actionUpdateQueued = true;
    queueMicrotask(() => {
      this.#actionUpdateQueued = false;
      if (!this.#host.isClosed()) this.#host.onActionChanged();
    });
  }

  #cachedIconDataUrl(extension: Extension, spec?: ActionIconSpec): string | null {
    const cacheKey = `${extension.id}\n${extension.version}\n${extension.path}\n${spec ? JSON.stringify(spec) : ""}`;
    if (this.#iconDataCache.has(cacheKey)) return this.#iconDataCache.get(cacheKey) ?? null;
    const raw = resolveExtensionIconImage(extension, spec)?.toDataURL() ?? null;
    const dataUrl =
      raw && raw.startsWith("data:image/png;base64,") && raw.length <= MAX_ICON_DATA_URL_LEN
        ? raw
        : null;
    this.#iconDataCache.set(cacheKey, dataUrl);
    return dataUrl;
  }

  #clearIconCacheFor(extensionId: string): void {
    const prefix = `${extensionId}\n`;
    for (const key of this.#iconDataCache.keys()) {
      if (key.startsWith(prefix)) this.#iconDataCache.delete(key);
    }
  }

  #registerHandlers(): void {
    const { router } = this.#host;
    const requirePermission = (ctx: ExtensionCallContext, permission: string) => {
      if (!hasManifestPermission(ctx.extension.manifest, permission)) {
        throw new Error(`Extension ${ctx.extension.id} lacks required "${permission}" permission.`);
      }
    };
    const requireAdmittedCookies = () => {
      if (!this.#host.canAccessCookies()) {
        throw new Error("Browser profile cookies are unavailable.");
      }
    };

    // --- action ---
    const getActionProp = <K extends keyof ActionDetails>(
      ctx: ExtensionCallContext,
      details: unknown,
      key: K,
      fallback: ActionDetails[K],
    ): ActionDetails[K] => {
      const state = this.#ensureActionState(ctx.extension);
      const tabId =
        isRecord(details) && typeof details.tabId === "number" ? details.tabId : undefined;
      if (tabId !== undefined) {
        const tabOverride = state.tabs.get(tabId);
        if (tabOverride && tabOverride[key] !== undefined) return tabOverride[key];
      }
      return state[key] ?? fallback;
    };
    const setActionProp = <K extends keyof ActionDetails>(
      ctx: ExtensionCallContext,
      details: unknown,
      key: K,
      value: ActionDetails[K],
    ) => {
      const state = this.#ensureActionState(ctx.extension);
      const tabId =
        isRecord(details) && typeof details.tabId === "number" ? details.tabId : undefined;
      if (tabId !== undefined) {
        // Bound per-tab action overrides strictly to currently open tabs in this profile.
        if (!this.#getTabById(tabId)) return;
        const tabState = state.tabs.get(tabId) ?? {};
        tabState[key] = value;
        state.tabs.set(tabId, tabState);
      } else {
        (state as ActionDetails)[key] = value;
      }
      this.#scheduleActionChanged();
    };

    router.handle("action.getTitle", (ctx, details) =>
      getActionProp(ctx, details, "title", ctx.extension.name),
    );
    router.handle("action.setTitle", (ctx, details) => {
      const raw =
        isRecord(details) && typeof details.title === "string" ? details.title : ctx.extension.name;
      setActionProp(ctx, details, "title", clampString(raw, MAX_ACTION_TITLE_LEN));
    });
    router.handle(
      "action.getPopup",
      (ctx, details) => getActionProp(ctx, details, "popup", "") ?? "",
    );
    router.handle("action.setPopup", (ctx, details) => {
      const popup =
        isRecord(details) && typeof details.popup === "string"
          ? clampString(details.popup, 2_048)
          : "";
      setActionProp(ctx, details, "popup", popup);
    });
    router.handle(
      "action.getBadgeText",
      (ctx, details) => getActionProp(ctx, details, "badgeText", "") ?? "",
    );
    router.handle("action.setBadgeText", (ctx, details) => {
      const text =
        isRecord(details) && typeof details.text === "string"
          ? clampString(details.text, MAX_BADGE_TEXT_LEN)
          : "";
      setActionProp(ctx, details, "badgeText", text);
    });
    router.handle("action.getBadgeBackgroundColor", (ctx, details) =>
      getActionProp(ctx, details, "badgeColor", null),
    );
    router.handle("action.setBadgeBackgroundColor", (ctx, details) => {
      const color = isRecord(details) ? normalizeBadgeColor(details.color) : null;
      setActionProp(ctx, details, "badgeColor", color);
    });
    router.handle("action.setIcon", (ctx, details) => {
      if (!isRecord(details)) return;
      const spec = sanitizeActionIconSpec(details);
      if (!spec) {
        throw new Error("Invalid or oversized action icon specification.");
      }
      this.#clearIconCacheFor(ctx.extension.id);
      setActionProp(ctx, details, "icon", spec);
    });
    router.handle("action.getUserSettings", () => ({ isOnToolbar: true }));
    // Extension-initiated popup open: strictly separate from trusted click — NEVER grants activeTab.
    router.handle("action.openPopup", (ctx) => {
      this.#openPopupFromExtension(ctx.extension);
    });

    // --- tabs ---
    router.handle("tabs.get", (ctx, tabId) => {
      if (typeof tabId !== "number") return { id: TAB_ID_NONE };
      const wc = this.#getTabById(tabId);
      const entry = wc ? this.#tabs.get(wc) : undefined;
      if (!wc || !entry) return { id: TAB_ID_NONE };
      return this.#sanitizeTabForExtension(ctx.extension, this.#rawTabSnapshot(wc, entry));
    });
    router.handle("tabs.getCurrent", (ctx) => {
      if (ctx.type !== "frame") return undefined;
      const wc = ctx.sender as WebContents;
      const entry = this.#tabs.get(wc);
      if (!entry || wc.isDestroyed()) return undefined;
      return this.#sanitizeTabForExtension(ctx.extension, this.#rawTabSnapshot(wc, entry));
    });
    router.handle("tabs.getAllInWindow", (ctx, windowId) => {
      const win = this.#getWindowById(typeof windowId === "number" ? windowId : WINDOW_ID_CURRENT);
      if (!win) return [];
      return [...this.#tabs.entries()]
        .filter(([wc, entry]) => !wc.isDestroyed() && entry.window === win)
        .map(([wc, entry]) =>
          this.#sanitizeTabForExtension(ctx.extension, this.#rawTabSnapshot(wc, entry)),
        );
    });
    router.handle("tabs.query", (ctx, rawInfo) => {
      const info = isRecord(rawInfo) ? rawInfo : {};
      const currentWindow = this.#getCurrentWindow();
      const results: Record<string, unknown>[] = [];
      for (const [wc, entry] of this.#tabs) {
        if (wc.isDestroyed()) continue;
        const raw = this.#rawTabSnapshot(wc, entry);
        if (typeof info.active === "boolean" && info.active !== raw.active) continue;
        if (typeof info.pinned === "boolean" && info.pinned !== raw.pinned) continue;
        if (typeof info.audible === "boolean" && info.audible !== raw.audible) continue;
        if (typeof info.muted === "boolean" && info.muted !== raw.mutedInfo.muted) continue;
        if (typeof info.status === "string" && info.status !== raw.status) continue;
        if (info.currentWindow === true && (!currentWindow || raw.windowId !== currentWindow.id)) {
          continue;
        }
        if (typeof info.windowId === "number") {
          const targetWinId =
            info.windowId === WINDOW_ID_CURRENT ? currentWindow?.id : info.windowId;
          if (raw.windowId !== targetWinId) continue;
        }
        const canRead = canReadTabDetails(
          ctx.extension.manifest,
          raw.url,
          this.#hasActiveTabGrant(ctx.extension.id, raw.id, raw.url),
        );
        if (typeof info.title === "string") {
          if (!canRead || !matchesTitlePattern(info.title, raw.title)) continue;
        }
        if (typeof info.url === "string" || Array.isArray(info.url)) {
          if (!canRead) continue;
          const patterns = Array.isArray(info.url)
            ? info.url.filter((item): item is string => typeof item === "string")
            : [info.url];
          if (!patterns.some((pattern) => matchesPattern(pattern, raw.url))) continue;
        }
        results.push(this.#sanitizeTabForExtension(ctx.extension, raw));
      }
      return results;
    });
    router.handle("tabs.create", (ctx, rawProps) => {
      const props = isRecord(rawProps) ? rawProps : {};
      const url =
        typeof props.url === "string"
          ? validateExtensionUrl(props.url, ctx.extension.id)
          : "about:blank";
      const active = props.active !== false;
      const targetWin =
        typeof props.windowId === "number" ? this.#getWindowById(props.windowId) : null;
      const wc = this.#host.openTab(url, active, targetWin);
      const entry = this.#tabs.get(wc);
      if (!entry) return { id: wc.id, url };
      return this.#sanitizeTabForExtension(ctx.extension, this.#rawTabSnapshot(wc, entry));
    });
    router.handle("tabs.update", async (ctx, arg1, arg2) => {
      const tabId = typeof arg1 === "number" ? arg1 : undefined;
      const props = isRecord(arg1) ? arg1 : isRecord(arg2) ? arg2 : {};
      const wc =
        tabId !== undefined ? this.#getTabById(tabId) : this.#getActiveTabOfCurrentWindow();
      const entry = wc ? this.#tabs.get(wc) : undefined;
      if (!wc || !entry) return undefined;
      if (typeof props.url === "string") {
        const safeUrl = validateExtensionUrl(props.url, ctx.extension.id);
        await wc.loadURL(safeUrl);
      }
      if (typeof props.muted === "boolean") wc.setAudioMuted(props.muted);
      if (props.active === true) this.#setActiveTab(wc);
      return this.#sanitizeTabForExtension(ctx.extension, this.#rawTabSnapshot(wc, entry));
    });
    router.handle("tabs.remove", (_ctx, idOrIds) => {
      const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
      for (const id of ids) {
        if (typeof id !== "number") continue;
        const wc = this.#getTabById(id);
        const entry = wc ? this.#tabs.get(wc) : undefined;
        if (entry) entry.tab.close();
      }
    });
    router.handle("tabs.reload", (_ctx, arg1, arg2) => {
      const tabId = typeof arg1 === "number" ? arg1 : undefined;
      const props = isRecord(arg1) ? arg1 : isRecord(arg2) ? arg2 : {};
      const wc =
        tabId !== undefined ? this.#getTabById(tabId) : this.#getActiveTabOfCurrentWindow();
      if (!wc) return;
      if (props.bypassCache === true) wc.reloadIgnoringCache();
      else wc.reload();
    });
    router.handle("tabs.goBack", (_ctx, tabId) => {
      const wc =
        typeof tabId === "number" ? this.#getTabById(tabId) : this.#getActiveTabOfCurrentWindow();
      wc?.navigationHistory.goBack();
    });
    router.handle("tabs.goForward", (_ctx, tabId) => {
      const wc =
        typeof tabId === "number" ? this.#getTabById(tabId) : this.#getActiveTabOfCurrentWindow();
      wc?.navigationHistory.goForward();
    });
    router.handle("tabs.insertCSS", async (ctx, arg1, arg2) => {
      const tabId = typeof arg1 === "number" ? arg1 : undefined;
      const details = isRecord(arg1) ? arg1 : isRecord(arg2) ? arg2 : {};
      const wc =
        tabId !== undefined ? this.#getTabById(tabId) : this.#getActiveTabOfCurrentWindow();
      if (!wc) return;
      const url = wc.getURL();
      if (isRestrictedWebStoreUrl(url)) {
        throw new Error("Extensions cannot inject CSS into the Chrome Web Store.");
      }
      const allowed =
        hasHostPermission(ctx.extension.manifest, url) ||
        this.#hasActiveTabGrant(ctx.extension.id, wc.id, url);
      if (!allowed) {
        throw new Error(`Extension ${ctx.extension.id} cannot inject CSS into ${url}.`);
      }
      if (typeof details.code === "string") {
        await wc.insertCSS(details.code);
      }
    });

    // --- windows ---
    router.handle("windows.get", (ctx, windowId, queryOptions) => {
      const win = this.#getWindowById(typeof windowId === "number" ? windowId : WINDOW_ID_CURRENT);
      if (!win) return { id: WINDOW_ID_NONE };
      const populate = isRecord(queryOptions) && queryOptions.populate === true;
      return this.#windowDetails(ctx.extension, win, populate);
    });
    router.handle("windows.getCurrent", (ctx, queryOptions) => {
      const win = this.#getCurrentWindow();
      if (!win) return null;
      const populate = isRecord(queryOptions) && queryOptions.populate === true;
      return this.#windowDetails(ctx.extension, win, populate);
    });
    router.handle("windows.getLastFocused", (ctx, queryOptions) => {
      const win = this.#getCurrentWindow();
      if (!win) return null;
      const populate = isRecord(queryOptions) && queryOptions.populate === true;
      return this.#windowDetails(ctx.extension, win, populate);
    });
    router.handle("windows.getAll", (ctx, queryOptions) => {
      const populate = isRecord(queryOptions) && queryOptions.populate === true;
      return [...this.#windows]
        .filter((win) => !win.isDestroyed())
        .map((win) => this.#windowDetails(ctx.extension, win, populate));
    });
    router.handle("windows.create", (ctx, rawDetails) => {
      const details = isRecord(rawDetails) ? rawDetails : {};
      if (details.incognito === true) {
        throw new Error("Incognito windows are not supported for profile extensions.");
      }
      const rawUrls = Array.isArray(details.url)
        ? details.url.filter((item): item is string => typeof item === "string")
        : typeof details.url === "string"
          ? [details.url]
          : ["about:blank"];
      const urls = rawUrls.map((item) => validateExtensionUrl(item, ctx.extension.id));
      const created = this.#host.createExtensionWindow(urls, details.focused !== false);
      return this.#windowDetails(ctx.extension, created, true);
    });
    router.handle("windows.update", (ctx, windowId, rawProps) => {
      const win = this.#getWindowById(typeof windowId === "number" ? windowId : WINDOW_ID_CURRENT);
      if (!win) return undefined;
      const props = isRecord(rawProps) ? rawProps : {};
      if (props.state === "maximized") win.maximize();
      else if (props.state === "minimized") win.minimize();
      else if (props.state === "normal" && (win.isMinimized() || win.isMaximized())) win.restore();
      return this.#windowDetails(ctx.extension, win, false);
    });
    router.handle("windows.remove", (_ctx, windowId) => {
      const win = this.#getWindowById(typeof windowId === "number" ? windowId : WINDOW_ID_CURRENT);
      if (!win) return;
      const id = win.id;
      const removed = this.#host.closeExtensionWindow(win);
      if (removed && win.isDestroyed()) {
        this.#windows.delete(win);
        this.#emitWindowRemovedOnce(win, id);
      }
    });

    // --- cookies (gated on profile admission + manifest permission + host access) ---
    router.handle("cookies.get", async (ctx, rawDetails) => {
      requireAdmittedCookies();
      requirePermission(ctx, "cookies");
      if (
        !isRecord(rawDetails) ||
        typeof rawDetails.url !== "string" ||
        typeof rawDetails.name !== "string"
      ) {
        throw new Error("cookies.get requires url and name.");
      }
      assertSupportedCookieSelector(rawDetails);
      if (!canAccessCookieUrl(ctx.extension.manifest, rawDetails.url)) {
        throw new Error(
          `Extension ${ctx.extension.id} lacks host permission for ${rawDetails.url}.`,
        );
      }
      const list = await this.#host.session.cookies.get({
        url: rawDetails.url,
        name: rawDetails.name,
      });
      return list.length > 0 ? cookieToChrome(list[0]!) : null;
    });
    router.handle("cookies.getAll", async (ctx, rawDetails) => {
      requireAdmittedCookies();
      requirePermission(ctx, "cookies");
      const details = isRecord(rawDetails) ? rawDetails : {};
      assertSupportedCookieSelector(details);
      if (
        typeof details.url === "string" &&
        !canAccessCookieUrl(ctx.extension.manifest, details.url)
      ) {
        return [];
      }
      const filter: Electron.CookiesGetFilter = {
        ...(typeof details.url === "string" ? { url: details.url } : {}),
        ...(typeof details.name === "string" ? { name: details.name } : {}),
        ...(typeof details.domain === "string" ? { domain: details.domain } : {}),
        ...(typeof details.path === "string" ? { path: details.path } : {}),
        ...(typeof details.secure === "boolean" ? { secure: details.secure } : {}),
        ...(typeof details.session === "boolean" ? { session: details.session } : {}),
      };
      const list = await this.#host.session.cookies.get(filter);
      return list
        .filter((cookie) =>
          cookieAccessUrls(cookie).some((url) => canAccessCookieUrl(ctx.extension.manifest, url)),
        )
        .map(cookieToChrome);
    });
    router.handle("cookies.set", async (ctx, rawDetails) => {
      requireAdmittedCookies();
      requirePermission(ctx, "cookies");
      if (!isRecord(rawDetails) || typeof rawDetails.url !== "string") {
        throw new Error("cookies.set requires url.");
      }
      assertSupportedCookieSelector(rawDetails);
      if (!canAccessCookieUrl(ctx.extension.manifest, rawDetails.url)) {
        throw new Error(
          `Extension ${ctx.extension.id} lacks host permission for ${rawDetails.url}.`,
        );
      }
      await this.#host.session.cookies.set(rawDetails as unknown as Electron.CookiesSetDetails);
      const list = await this.#host.session.cookies.get({
        url: rawDetails.url,
        ...(typeof rawDetails.name === "string" ? { name: rawDetails.name } : {}),
      });
      return list.length > 0 ? cookieToChrome(list[0]!) : null;
    });
    router.handle("cookies.remove", async (ctx, rawDetails) => {
      requireAdmittedCookies();
      requirePermission(ctx, "cookies");
      if (
        !isRecord(rawDetails) ||
        typeof rawDetails.url !== "string" ||
        typeof rawDetails.name !== "string"
      ) {
        throw new Error("cookies.remove requires url and name.");
      }
      assertSupportedCookieSelector(rawDetails);
      if (!canAccessCookieUrl(ctx.extension.manifest, rawDetails.url)) {
        throw new Error(
          `Extension ${ctx.extension.id} lacks host permission for ${rawDetails.url}.`,
        );
      }
      await this.#host.session.cookies.remove(rawDetails.url, rawDetails.name);
      return { url: rawDetails.url, name: rawDetails.name, storeId: "0" };
    });
    router.handle("cookies.getAllCookieStores", (ctx) => {
      requireAdmittedCookies();
      requirePermission(ctx, "cookies");
      const tabIds = [...this.#tabs.keys()].filter((wc) => !wc.isDestroyed()).map((wc) => wc.id);
      return [{ id: "0", tabIds }];
    });

    // --- contextMenus ---
    router.handle("contextMenus.create", (ctx, rawProps) => {
      requirePermission(ctx, "contextMenus");
      if (!isRecord(rawProps) || typeof rawProps.id !== "string" || !rawProps.id) return;
      let map = this.#menus.get(ctx.extension.id);
      if (map && !map.has(rawProps.id) && map.size >= MAX_MENU_ITEMS_PER_EXTENSION) {
        throw new Error("Extension exceeded maximum context menu items.");
      }
      const type =
        rawProps.type === "checkbox" || rawProps.type === "radio" || rawProps.type === "separator"
          ? rawProps.type
          : "normal";
      const title = typeof rawProps.title === "string" ? clampString(rawProps.title, 256) : "";
      if (!title && type !== "separator") return;
      const contexts = Array.isArray(rawProps.contexts)
        ? rawProps.contexts.filter((item): item is string => typeof item === "string")
        : ["page"];
      const item: ContextMenuProps = {
        id: clampString(rawProps.id, 128),
        type,
        title,
        contexts: contexts.length ? contexts : ["page"],
        enabled: rawProps.enabled !== false,
        visible: rawProps.visible !== false,
        ...(typeof rawProps.checked === "boolean" ? { checked: rawProps.checked } : {}),
        ...(typeof rawProps.parentId === "string" || typeof rawProps.parentId === "number"
          ? { parentId: clampString(String(rawProps.parentId), 128) }
          : {}),
        ...(Array.isArray(rawProps.documentUrlPatterns)
          ? {
              documentUrlPatterns: rawProps.documentUrlPatterns
                .filter((item): item is string => typeof item === "string")
                .slice(0, 64),
            }
          : {}),
        ...(Array.isArray(rawProps.targetUrlPatterns)
          ? {
              targetUrlPatterns: rawProps.targetUrlPatterns
                .filter((item): item is string => typeof item === "string")
                .slice(0, 64),
            }
          : {}),
      };
      if (!map) {
        map = new Map();
        this.#menus.set(ctx.extension.id, map);
      }
      map.set(item.id, item);
    });
    router.handle("contextMenus.update", (ctx, id, rawProps) => {
      requirePermission(ctx, "contextMenus");
      if ((typeof id !== "string" && typeof id !== "number") || !isRecord(rawProps)) return;
      const map = this.#menus.get(ctx.extension.id);
      const existing = map?.get(String(id));
      if (!map || !existing) return;
      map.set(existing.id, {
        ...existing,
        ...(typeof rawProps.title === "string" ? { title: clampString(rawProps.title, 256) } : {}),
        ...(typeof rawProps.enabled === "boolean" ? { enabled: rawProps.enabled } : {}),
        ...(typeof rawProps.visible === "boolean" ? { visible: rawProps.visible } : {}),
        ...(typeof rawProps.checked === "boolean" ? { checked: rawProps.checked } : {}),
      });
    });
    router.handle("contextMenus.remove", (ctx, id) => {
      requirePermission(ctx, "contextMenus");
      if (typeof id !== "string" && typeof id !== "number") return;
      const map = this.#menus.get(ctx.extension.id);
      map?.delete(String(id));
      if (map?.size === 0) this.#menus.delete(ctx.extension.id);
    });
    router.handle("contextMenus.removeAll", (ctx) => {
      requirePermission(ctx, "contextMenus");
      this.#menus.delete(ctx.extension.id);
    });

    // --- webNavigation ---
    router.handle("webNavigation.getFrame", (ctx, rawDetails) => {
      requirePermission(ctx, "webNavigation");
      if (!isRecord(rawDetails) || typeof rawDetails.tabId !== "number") return null;
      const wc = this.#getTabById(rawDetails.tabId);
      if (!wc || wc.isDestroyed()) return null;
      const targetId = typeof rawDetails.frameId === "number" ? rawDetails.frameId : 0;
      const frame = wc.mainFrame.framesInSubtree.find((item) => getFrameId(item) === targetId);
      return frame ? getFrameDetails(frame) : null;
    });
    router.handle("webNavigation.getAllFrames", (ctx, rawDetails) => {
      requirePermission(ctx, "webNavigation");
      if (!isRecord(rawDetails) || typeof rawDetails.tabId !== "number") return [];
      const wc = this.#getTabById(rawDetails.tabId);
      if (!wc || wc.isDestroyed()) return [];
      return wc.mainFrame.framesInSubtree.map(getFrameDetails);
    });

    // --- notifications ---
    router.handle("notifications.create", (ctx, arg1, arg2) => {
      requirePermission(ctx, "notifications");
      const id = typeof arg1 === "string" && arg1 ? clampString(arg1, 128) : `notif-${Date.now()}`;
      const opts = isRecord(arg1) ? arg1 : isRecord(arg2) ? arg2 : null;
      if (!opts || typeof opts.title !== "string" || typeof opts.message !== "string") {
        throw new Error("notifications.create requires title and message.");
      }
      const prefix = `${ctx.extension.id}:`;
      const key = `${prefix}${id}`;
      if (!this.#notifications.has(key)) {
        let count = 0;
        for (const existingKey of this.#notifications.keys()) {
          if (existingKey.startsWith(prefix)) count++;
        }
        if (count >= MAX_NOTIFICATIONS_PER_EXTENSION) {
          throw new Error("Extension exceeded maximum active notifications.");
        }
      }
      this.#notifications.get(key)?.close();
      let icon: string | NativeImage | undefined;
      if (typeof opts.iconUrl === "string" && opts.iconUrl) {
        if (opts.iconUrl.startsWith("data:image/")) {
          if (opts.iconUrl.length > MAX_ICON_DATA_URL_LEN) {
            throw new Error("Notification icon exceeds size limit.");
          }
          const parsed = nativeImage.createFromDataURL(opts.iconUrl);
          if (!parsed.isEmpty()) icon = parsed;
        } else {
          const resolved = resolveExtensionFile(ctx.extension.path, opts.iconUrl);
          if (!resolved) throw new Error("Invalid notification iconUrl.");
          icon = resolved;
        }
      }
      const notification = new Notification({
        title: clampString(opts.title, 256),
        body: clampString(opts.message, 1_024),
        silent: opts.silent === true,
        ...(icon ? { icon } : {}),
      });
      this.#notifications.set(key, notification);
      notification.on("click", () => {
        this.#host.router.sendToExtension(ctx.extension.id, "notifications.onClicked", id);
      });
      notification.once("close", () => {
        this.#notifications.delete(key);
        this.#host.router.sendToExtension(ctx.extension.id, "notifications.onClosed", id, true);
      });
      notification.show();
      return id;
    });
    router.handle("notifications.clear", (ctx, id) => {
      requirePermission(ctx, "notifications");
      if (typeof id !== "string") return false;
      const key = `${ctx.extension.id}:${id}`;
      const existing = this.#notifications.get(key);
      if (!existing) return false;
      existing.close();
      this.#notifications.delete(key);
      return true;
    });
    router.handle("notifications.getAll", (ctx) => {
      requirePermission(ctx, "notifications");
      const prefix = `${ctx.extension.id}:`;
      const out: Record<string, boolean> = {};
      for (const key of this.#notifications.keys()) {
        if (key.startsWith(prefix)) out[key.slice(prefix.length)] = true;
      }
      return out;
    });
    router.handle("notifications.getPermissionLevel", (ctx) => {
      requirePermission(ctx, "notifications");
      return Notification.isSupported() ? "granted" : "denied";
    });
    router.handle("notifications.update", (ctx, id) => {
      requirePermission(ctx, "notifications");
      return typeof id === "string" && this.#notifications.has(`${ctx.extension.id}:${id}`);
    });

    // --- permissions (strict validation, no silent escalation) ---
    router.handle("permissions.getAll", (ctx) => ({
      permissions: declaredPermissions(ctx.extension.manifest),
      origins: declaredHostPermissions(ctx.extension.manifest),
    }));
    router.handle("permissions.contains", (ctx, rawQuery) => {
      if (!isRecord(rawQuery)) throw new Error("permissions.contains requires a query object.");
      const reqPerms = parseStrictStringArray(rawQuery.permissions, "permissions");
      const reqOrigins = parseStrictStringArray(rawQuery.origins, "origins");
      const currentPerms = new Set(declaredPermissions(ctx.extension.manifest));
      const currentOrigins = declaredHostPermissions(ctx.extension.manifest);
      if (!reqPerms.every((perm) => currentPerms.has(perm))) return false;
      if (
        !reqOrigins.every((origin) =>
          currentOrigins.some((granted) => patternCovers(granted, origin)),
        )
      ) {
        return false;
      }
      return true;
    });
    router.handle("permissions.request", (ctx, rawRequest) => {
      if (!isRecord(rawRequest)) throw new Error("permissions.request requires a request object.");
      const reqPerms = parseStrictStringArray(rawRequest.permissions, "permissions");
      const reqOrigins = parseStrictStringArray(rawRequest.origins, "origins");
      const allowedOptionalPerms = new Set([
        ...declaredPermissions(ctx.extension.manifest),
        ...declaredOptionalPermissions(ctx.extension.manifest),
      ]);
      const allowedOptionalOrigins = [
        ...declaredHostPermissions(ctx.extension.manifest),
        ...declaredOptionalHostPermissions(ctx.extension.manifest),
      ];
      if (!reqPerms.every((perm) => allowedOptionalPerms.has(perm))) {
        throw new Error("Permissions request includes an undeclared permission.");
      }
      if (
        !reqOrigins.every((origin) =>
          allowedOptionalOrigins.some((declared) => patternCovers(declared, origin)),
        )
      ) {
        throw new Error("Permissions request includes an undeclared origin.");
      }
      const currentPerms = new Set(declaredPermissions(ctx.extension.manifest));
      const currentOrigins = declaredHostPermissions(ctx.extension.manifest);
      return (
        reqPerms.every((perm) => currentPerms.has(perm)) &&
        reqOrigins.every((origin) =>
          currentOrigins.some((granted) => patternCovers(granted, origin)),
        )
      );
    });
    router.handle("permissions.remove", () => false);

    // --- commands ---
    router.handle("commands.getAll", (ctx) => {
      const manifest = isRecord(ctx.extension.manifest) ? ctx.extension.manifest : {};
      if (!isRecord(manifest.commands)) return [];
      return Object.entries(manifest.commands).map(([name, value]) => {
        const entry = isRecord(value) ? value : {};
        return {
          name,
          description: typeof entry.description === "string" ? entry.description : "",
          shortcut: "",
        };
      });
    });

    // --- runtime ---
    router.handle("runtime.openOptionsPage", (ctx) => {
      const manifest = isRecord(ctx.extension.manifest) ? ctx.extension.manifest : {};
      const page =
        isRecord(manifest.options_ui) && typeof manifest.options_ui.page === "string"
          ? manifest.options_ui.page
          : typeof manifest.options_page === "string"
            ? manifest.options_page
            : undefined;
      const url = resolveExtensionPageUrl(ctx.extension.id, page);
      if (!url) throw new Error("Extension declares no options page.");
      this.#host.openTab(url, true);
    });
  }
}

function contextTypesFromParams(params: ContextMenuParams): Set<string> {
  const contexts = new Set<string>(["all"]);
  if (
    params.mediaType === "audio" ||
    params.mediaType === "video" ||
    params.mediaType === "image"
  ) {
    contexts.add(params.mediaType);
  }
  if (params.pageURL) contexts.add("page");
  if (params.linkURL) contexts.add("link");
  if (params.frameURL) contexts.add("frame");
  if (params.selectionText) contexts.add("selection");
  if (params.isEditable) contexts.add("editable");
  return contexts;
}

function menuItemMatches(
  props: ContextMenuProps,
  contextTypes: ReadonlySet<string>,
  documentUrl: string,
  targetUrl: string,
): boolean {
  if (!props.visible) return false;
  if (!props.contexts.some((context) => contextTypes.has(context))) return false;
  if (props.documentUrlPatterns?.length && documentUrl) {
    if (!props.documentUrlPatterns.some((pattern) => matchesPattern(pattern, documentUrl))) {
      return false;
    }
  }
  if (props.targetUrlPatterns?.length && targetUrl) {
    if (!props.targetUrlPatterns.some((pattern) => matchesPattern(pattern, targetUrl))) {
      return false;
    }
  }
  return true;
}

function formatMenuTitle(title: string, params: ContextMenuParams): string {
  if (params.selectionText && title.includes("%s")) {
    return title.split("%s").join(params.selectionText);
  }
  return title;
}
