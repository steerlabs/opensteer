import type { DesktopDownloads } from "../downloads/desktop-downloads.js";
import type { Session } from "electron";
import { browserPagePermissionsPolicy } from "@opensteer/browser-runtime-core/page-policy";

export interface BrowserSessionPolicyOptions {
  readonly provider?: boolean;
  readonly requestGate?: BrowserSessionRequestGate;
  readonly downloads: Pick<DesktopDownloads, "accept">;
  /** Absolute path of the bundled `browser-page-preload.cjs`. */
  readonly pagePolicyPreloadPath: string;
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
  session.webRequest.onBeforeRequest((details, callback) => {
    if (!isAllowedBrowserRequest(details.url)) callback({ cancel: true });
    else if (requestGates.has(session))
      requestGates.get(session)!.beforeRequest(details.webContentsId, callback);
    else callback({ cancel: false });
  });
  session.setPermissionCheckHandler((_contents, permission) => permission === "fullscreen");
  session.setPermissionRequestHandler((_contents, permission, callback) =>
    callback(permission === "fullscreen"),
  );
  for (const preload of session.getPreloadScripts()) {
    session.unregisterPreloadScript(preload.id);
  }
  // The preload covers the first main-frame document, including documents
  // without response headers. Each page's debugger installs the negotiated
  // provider or absent policy in later documents and frames.
  session.registerPreloadScript({ filePath: options.pagePolicyPreloadPath, type: "frame" });
  updateBrowserPasskeyPolicy(session, options.provider === true);
  options.downloads.accept(session);
  session.setUserAgent(chromeUserAgent(session.getUserAgent()));
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

/** Electron puts the whitespace-stripped app product immediately before Chrome. */
export function chromeUserAgent(userAgent: string): string {
  return userAgent
    .replace(/\s[^\s/]+\/[^\s]+(?=\sChrome\/)/gu, "")
    .replace(/\sElectron\/[^\s]+/gu, "");
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
  readonly #helpers = new Set<number>();

  beforeRequest(
    webContentsId: number | undefined,
    callback: (response: { cancel: boolean }) => void,
  ): void {
    callback({
      cancel:
        this.#mode !== "open" &&
        !(
          this.#mode !== "failed" &&
          webContentsId !== undefined &&
          this.#helpers.has(webContentsId)
        ),
    });
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
  /** Only synthetic Fetch-fulfilled storage helpers may cross a closed gate. */
  allowStorageHelper(webContentsId: number): () => void {
    this.#helpers.add(webContentsId);
    return () => {
      this.#helpers.delete(webContentsId);
    };
  }
}
