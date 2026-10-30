import type { DesktopDownloads } from "../downloads/desktop-downloads.js";
import type { Session } from "electron";
import { browserPagePermissionsPolicy } from "@opensteer/browser-runtime-core/page-policy";

export interface BrowserSessionPolicyOptions {
  readonly provider?: boolean;
  readonly downloads: Pick<DesktopDownloads, "accept">;
  /** Absolute path of the bundled `browser-page-preload.cjs`. */
  readonly pagePolicyPreloadPath: string;
}

/**
 * The rules every Browser Session page shares: no device permissions except
 * HTML fullscreen, downloads owned by the desktop, no WebAuthn, only web schemes, and a Chrome
 * user agent.
 */
export function applyBrowserSessionPolicy(
  session: Session,
  options: BrowserSessionPolicyOptions,
): void {
  session.setPermissionCheckHandler((_contents, permission) => permission === "fullscreen");
  session.setPermissionRequestHandler((_contents, permission, callback) =>
    callback(permission === "fullscreen"),
  );
  for (const preload of session.getPreloadScripts()) {
    session.unregisterPreloadScript(preload.id);
  }
  // Pages see a browser without WebAuthn (see page-policy). The response
  // header disables it in every frame beneath a document. Documents without
  // one, such as a popup its opener writes into or a page a service worker
  // serves, get the policy script: this preload in a page's main frame, which
  // covers its first document, and the page's debugger script everywhere
  // else (ElectronBrowserPage).
  session.registerPreloadScript({ filePath: options.pagePolicyPreloadPath, type: "frame" });
  session.webRequest.onHeadersReceived(
    { types: ["mainFrame", "subFrame"], urls: ["<all_urls>"] },
    (details, callback) => {
      let deny = !options.provider;
      if (options.provider && details.resourceType === "subFrame") {
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
  session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowedBrowserRequest(details.url) });
  });
  options.downloads.accept(session);
  session.setUserAgent(chromeUserAgent(session.getUserAgent()));
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
