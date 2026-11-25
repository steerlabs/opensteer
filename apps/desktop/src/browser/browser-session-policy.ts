import type { DesktopDownloads } from "../downloads/desktop-downloads.js";
import type { Session } from "electron";
import { browserIdentity, isExtensionUrl } from "@opensteer/browser-core";
import {
  isDynamicExtensionHop,
  recordDynamicExtensionRequestHop,
  recordExtensionRedirect,
  takeDynamicExtensionRequestHop,
} from "./extensions/extension-redirects.js";
import { mayReachExtensionResource } from "./extensions/web-accessible.js";
import { isLoopbackHostname } from "@opensteer/core";
import { browserPagePermissionsPolicy } from "@opensteer/browser-runtime-core/page-policy";

export { browserIdentity, chromeUserAgent } from "@opensteer/browser-core";
export type { BrowserIdentity, BrowserUserAgentMetadata } from "@opensteer/browser-core";

export interface BrowserSessionPolicyOptions {
  readonly provider?: boolean;
  readonly requestGate?: BrowserSessionRequestGate;
  readonly onUploadRequest?: (webContentsId: number, requestId: number) => void;
  readonly onRequestFinished?: (requestId: number) => void;
  readonly onMainFrameRequest?: (webContentsId: number, method: string) => void;
  /** Whether a WebContents is currently controlled by a connected agent (cancels `chrome-extension:` requests). */
  readonly isConnectionWebContents?: (webContentsId: number) => boolean;
  readonly acceptLanguages?: string;
  readonly downloads: Pick<DesktopDownloads, "accept">;
  /** Absolute path of the bundled `browser-page-preload.cjs`. */
  readonly pagePolicyPreloadPath: string;
}

/**
 * Permissions Chromium grants without asking and that genuinely work in this
 * browser; everything else stays denied until a person-facing prompt exists.
 */
const grantedPermissions = new Set([
  "background-sync",
  "fullscreen",
  "payment-handler",
  "screen-wake-lock",
  "sensors",
]);
// Clipboard stays denied: this browser shares the person's own clipboard,
// and page script must not write it without the person copying. The CDP
// router refuses a connected agent's copy, cut, paste and clipboard
// permission grants for the same reason.
/** Expands each preferred language with its base language, as Chrome does. */
export function browserAcceptLanguages(preferred: readonly string[]): string {
  const languages: string[] = [];
  for (const language of preferred) {
    if (!languages.includes(language)) languages.push(language);
    const base = language.split("-")[0];
    if (base && base !== language && !languages.includes(base)) languages.push(base);
  }
  return languages.join(",");
}

const requestGates = new WeakMap<Session, BrowserSessionRequestGate>();
export function bindBrowserSessionRequestGate(
  session: Session,
  gate: BrowserSessionRequestGate,
): void {
  requestGates.set(session, gate);
}

/**
 * The rules every Browser Session page shares: no device permissions except
 * HTML fullscreen, downloads owned by the desktop, negotiated WebAuthn policy, only web schemes, and a Chrome
 * user agent.
 */
export function applyBrowserSessionPolicy(
  session: Session,
  options: BrowserSessionPolicyOptions,
): void {
  if (options.requestGate) bindBrowserSessionRequestGate(session, options.requestGate);
  const identity = browserIdentity(session.getUserAgent());
  session.setUserAgent(
    identity.userAgent,
    ...(options.acceptLanguages ? [options.acceptLanguages] : []),
  );
  session.webRequest.onBeforeRequest((details, callback) => {
    if (details.webContentsId !== undefined && !["GET", "HEAD"].includes(details.method))
      options.onUploadRequest?.(details.webContentsId, details.id);
    if (details.resourceType === "mainFrame" && details.webContentsId !== undefined)
      options.onMainFrameRequest?.(details.webContentsId, details.method);
    const kind = classifyBrowserRequest(details.url);
    if (kind === "denied") callback({ cancel: true });
    // An extension's own files are part of the browser, not the web: they
    // never wait for the profile's cookies, and its worker starts from them.
    // Pages controlled by a connected agent cannot load or probe extension URLs (M1a, S1);
    // any other page loads only what the extension lists as web-accessible for it.
    else if (kind === "extension") {
      const cancel =
        (details.webContentsId !== undefined &&
          options.isConnectionWebContents?.(details.webContentsId) === true) ||
        !mayRequestExtensionResource(session, details);
      callback({ cancel });
    } else if (requestGates.has(session))
      requestGates.get(session)!.beforeRequest(details.webContentsId, callback);
    else callback({ cancel: false });
  });
  // A navigation a server redirects into an extension is judged by the origin that redirects
  // (W1): only this hook names it, before the page's `will-redirect` takes it. It also sees
  // Chromium's own rewrite of an extension's dynamic address into its static one, for any request.
  session.webRequest.onBeforeRedirect(
    { urls: ["<all_urls>", "chrome-extension://*/*"] },
    (details) => {
      if (!details.redirectURL.includes("chrome-extension:")) return;
      const navigation =
        details.resourceType === "mainFrame" || details.resourceType === "subFrame";
      if (!navigation) {
        if (isDynamicExtensionHop(details.url, details.redirectURL))
          recordDynamicExtensionRequestHop(details.id, details.redirectURL);
        return;
      }
      if (details.webContentsId === undefined || !isExtensionUrl(details.redirectURL)) return;
      let frameTreeNodeId: number | undefined;
      try {
        frameTreeNodeId = details.frame?.frameTreeNodeId;
      } catch {
        frameTreeNodeId = undefined;
      }
      if (frameTreeNodeId === undefined) return;
      recordExtensionRedirect(
        details.webContentsId,
        frameTreeNodeId,
        details.url,
        details.redirectURL,
      );
    },
  );
  if (options.onRequestFinished) {
    session.webRequest.onCompleted((details) => options.onRequestFinished!(details.id));
    session.webRequest.onErrorOccurred((details) => options.onRequestFinished!(details.id));
  }
  session.setPermissionCheckHandler((_contents, permission) => grantedPermissions.has(permission));
  session.setPermissionRequestHandler((_contents, permission, callback) =>
    callback(grantedPermissions.has(permission)),
  );
  // Electron never emits client hints on navigations (its client-hints
  // delegate is absent), while the renderer emits the same low-entropy hints
  // on subresource requests. Supply the navigation set from the same
  // identity so the wire agrees with what pages read in JS.
  if (identity.clientHints) {
    const hints = identity.clientHints;
    session.webRequest.onBeforeSendHeaders((details, callback) => {
      const hasHints = Object.keys(details.requestHeaders).some(
        (name) => name.toLowerCase() === "sec-ch-ua",
      );
      // Chrome sends hints to secure contexts, which includes loopback http.
      // The hostname comes from the parsed URL: a prefix match would take
      // "localhost" userinfo for a loopback host.
      const hintOrigin = details.url.startsWith("https://") || isLoopbackOrigin(details.url);
      if (hasHints || !hintOrigin) {
        callback({});
        return;
      }
      callback({
        requestHeaders: {
          ...details.requestHeaders,
          "Sec-CH-UA": hints.brands,
          "Sec-CH-UA-Mobile": "?0",
          "Sec-CH-UA-Platform": `"${hints.platform}"`,
        },
      });
    });
  }
  // Only this policy's own preload is replaced: the profile's extensions keep theirs.
  for (const preload of session.getPreloadScripts())
    if (preload.id === pagePolicyPreloadId) session.unregisterPreloadScript(preload.id);
  // The preload covers the first main-frame document, including documents
  // without response headers. Each page's debugger installs the negotiated
  // provider or absent policy in later documents and frames.
  session.registerPreloadScript({
    filePath: options.pagePolicyPreloadPath,
    id: pagePolicyPreloadId,
    type: "frame",
  });
  updateBrowserPasskeyPolicy(session, options.provider === true);
  options.downloads.accept(session);
}

/** Updates only the policy that depends on the negotiated provider mode. */
export function updateBrowserPasskeyPolicy(session: Session, provider: boolean): void {
  session.webRequest.onHeadersReceived(
    { types: ["mainFrame", "subFrame"], urls: ["<all_urls>"] },
    (details, callback) => {
      let deny = !provider;
      if (provider && details.resourceType === "subFrame") {
        // Keep the site's computed policy visible for the frames we serve. A
        // missing frame identity, like a foreign ancestor, is refused closed.
        const frame = details.frame;
        try {
          const origin = new URL(details.url).origin;
          let ancestor = frame?.parent;
          deny = !ancestor || origin === "null";
          while (ancestor) {
            if (new URL(ancestor.url).origin !== origin) deny = true;
            ancestor = ancestor.parent;
          }
        } catch {
          deny = true;
        }
      }
      callback({
        responseHeaders: deny
          ? withPagePermissionsPolicy(details.responseHeaders)
          : (details.responseHeaders ?? {}),
      });
    },
  );
}

/**
 * Adds the page policy as its own field line. Permissions-Policy lines combine
 * into one dictionary in which a repeated feature takes its last value, so a
 * site's own header cannot re-enable WebAuthn.
 */
function withPagePermissionsPolicy(
  headers: Record<string, string[]> = {},
): Record<string, string[]> {
  const name =
    Object.keys(headers).find((key) => key.toLowerCase() === "permissions-policy") ??
    "Permissions-Policy";
  return { ...headers, [name]: [...(headers[name] ?? []), browserPagePermissionsPolicy] };
}

function isLoopbackOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

const pagePolicyPreloadId = "opensteer-page-policy";

/**
 * Whether a page's own request for an extension resource may load (Chrome's web-accessible
 * rule, `mayReachExtensionResource`), judged by the requesting frame's origin, or by the
 * request's initiator when it has no frame (a worker, a keepalive request after its page went).
 * Navigations are decided by the page's navigation events instead: a load the browser itself
 * starts (an extension's popup, its options page) arrives here carrying the frame's previous
 * origin. A request with neither a frame nor an initiator is left to Chromium's own extension
 * loader, which already refuses a web page's request for a file that is not web-accessible.
 */
function mayRequestExtensionResource(
  session: Session,
  details: Electron.OnBeforeRequestListenerDetails,
): boolean {
  if (details.resourceType === "mainFrame" || details.resourceType === "subFrame") return true;
  // Chromium's own rewrite of an extension's dynamic address: it enforces the resource's access
  // at this static address itself.
  if (takeDynamicExtensionRequestHop(details.id, details.url)) return true;
  let origin: string | undefined;
  try {
    origin = details.frame ? details.frame.origin : details.initiatorOrigin;
  } catch {
    // The frame is gone: its initiator, if Electron gives one, still says who asked.
    if (details.initiatorOrigin === undefined) return false;
    origin = details.initiatorOrigin;
  }
  if (origin === undefined) return true;
  return mayReachExtensionResource(
    details.url,
    origin,
    (extensionId) => session.extensions.getExtension(extensionId)?.manifest as unknown,
  );
}

/**
 * Classifies one request URL without adding a second `new URL()` parse on the hot web path:
 * Chromium delivers canonical URLs here, so ordinary `https://`/`http://` requests skip extension
 * recursion while `chrome-extension:` and `blob:`/`filesystem:` wrappers are still caught.
 */
function classifyBrowserRequest(value: string): "denied" | "extension" | "web" {
  if (value.startsWith("chrome-extension:")) return "extension";
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "chrome-extension:") return "extension";
    if (
      (parsed.protocol === "blob:" || parsed.protocol === "filesystem:") &&
      isExtensionUrl(parsed.pathname)
    )
      return "extension";
    return ["blob:", "data:", "http:", "https:", "ws:", "wss:"].includes(parsed.protocol)
      ? "web"
      : "denied";
  } catch {
    return "denied";
  }
}

/** Session-wide: worker requests need the same restoration fence as page requests. */
export class BrowserSessionRequestGate {
  #mode: "closed" | "dormant" | "open" | "failed" = "closed";

  beforeRequest(
    _webContentsId: number | undefined,
    callback: (response: { cancel: boolean }) => void,
  ): void {
    callback({ cancel: this.#mode !== "open" });
  }

  close(): void {
    if (this.#mode !== "failed") this.#mode = "closed";
  }
  dormant(): void {
    if (this.#mode !== "failed") this.#mode = "dormant";
  }
  open(): void {
    if (this.#mode !== "failed") this.#mode = "open";
  }
  fail(): void {
    this.#mode = "failed";
  }
}
