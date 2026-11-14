import type { DesktopDownloads } from "../downloads/desktop-downloads.js";
import type { Session } from "electron";
import { browserIdentity } from "@opensteer/browser-core";
import { browserPagePermissionsPolicy } from "@opensteer/browser-runtime-core/page-policy";

export { browserIdentity, chromeUserAgent } from "@opensteer/browser-core";
export type { BrowserIdentity, BrowserUserAgentMetadata } from "@opensteer/browser-core";

export interface BrowserSessionPolicyOptions {
  readonly provider?: boolean;
  readonly requestGate?: BrowserSessionRequestGate;
  readonly onUploadRequest?: (webContentsId: number, requestId: number) => void;
  readonly onRequestFinished?: (requestId: number) => void;
  readonly onMainFrameRequest?: (webContentsId: number, method: string) => void;
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
  "clipboard-sanitized-write",
  "fullscreen",
  "payment-handler",
  "screen-wake-lock",
  "sensors",
]);
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
    if (!isAllowedBrowserRequest(details.url)) callback({ cancel: true });
    else if (requestGates.has(session))
      requestGates.get(session)!.beforeRequest(details.webContentsId, callback);
    else callback({ cancel: false });
  });
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
      const hintOrigin =
        details.url.startsWith("https://") ||
        /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])([:/?#]|$)/u.test(details.url);
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
  for (const preload of session.getPreloadScripts()) {
    session.unregisterPreloadScript(preload.id);
  }
  // The preload covers the first main-frame document, including documents
  // without response headers. Each page's debugger installs the negotiated
  // provider or absent policy in later documents and frames.
  session.registerPreloadScript({ filePath: options.pagePolicyPreloadPath, type: "frame" });
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

function isAllowedBrowserRequest(value: string): boolean {
  try {
    return ["blob:", "data:", "http:", "https:", "ws:", "wss:"].includes(new URL(value).protocol);
  } catch {
    return false;
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
