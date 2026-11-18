import type { ClientLifecycle, HttpHostClientOptions } from "@opensteer/client/host";
import {
  HttpHostClient,
  type BrowserPreferencesStorage,
  type WebSocketClient,
} from "@opensteer/client/host";
import { desktopBridge } from "../desktop/desktop-bridge.js";
import { browserClientLifecycle } from "./browser-lifecycle.js";

export interface BrowserHostClientOptions {
  readonly desktopMedia?: boolean;
  readonly assetRoute?: HttpHostClientOptions["assetRoute"];
  readonly passkeys?: HttpHostClientOptions["passkeys"];
  readonly iphoneSetup?: HttpHostClientOptions["iphoneSetup"];
  readonly capabilities: Exclude<HttpHostClientOptions["capabilities"], undefined>;
  /** The Desktop renderer attaches to a selected Deployment rather than to the
   * origin that served this bundle. */
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly pacedUploads?: HttpHostClientOptions["pacedUploads"];
  /** The Desktop renderer states how long its hidden sockets last; a browser tab cannot. */
  readonly lifecycle?: ClientLifecycle;
  readonly webSocketFactory?: (url: string) => WebSocketClient;
}

/**
 * The Host client with this browser's capabilities supplied: the origin it was
 * served from and the document's own lifecycle. The shared
 * client reads none of these itself — a React Native bundle has no document —
 * so this is the one place the web app hands them over.
 */
export function createBrowserHostClient(options: BrowserHostClientOptions): HttpHostClient {
  return new HttpHostClient({
    ...(options.assetRoute ? { assetRoute: options.assetRoute } : {}),
    ...(options.desktopMedia ? { desktopMedia: true } : {}),
    deviceAccessRequests: "include",
    ...(options.passkeys ? { passkeys: options.passkeys } : {}),
    ...(options.iphoneSetup ? { iphoneSetup: options.iphoneSetup } : {}),
    capabilities: options.capabilities ?? null,
    baseUrl: options.baseUrl ?? window.location.origin,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.pacedUploads ? { pacedUploads: true } : {}),
    lifecycle: options.lifecycle ?? browserClientLifecycle(),
    browserPreferencesStorage,
    reportRealtimeFrame: (record) =>
      void desktopBridge()
        ?.reportRealtimeDiagnostic?.(record)
        .catch(() => undefined),
    viewerPlatform: /Mac|iPhone|iPad|iPod/u.test(navigator.platform) ? "mac" : "pc",
    origin: { app: desktopBridge() ? "desktop" : "web", device: browserDevice() },
    ...(options.webSocketFactory ? { webSocketFactory: options.webSocketFactory } : {}),
  });
}

/** iPadOS reports itself as a Mac, so touch tells the two apart. */
function browserDevice(): "phone" | "tablet" | "computer" {
  const agent = navigator.userAgent;
  if (/iPad|Tablet/u.test(agent) || (/Macintosh/u.test(agent) && navigator.maxTouchPoints > 1))
    return "tablet";
  if (/Android/u.test(agent)) return /Mobile/u.test(agent) ? "phone" : "tablet";
  return /Mobi|iPhone|iPod/u.test(agent) ? "phone" : "computer";
}

/**
 * Browser preferences use device storage; old local history is removed at startup.
 */
export const browserPreferencesStorage: BrowserPreferencesStorage = {
  keys: () => Object.keys(window.localStorage),
  getItem: (key) => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
  removeItem: (key) => window.localStorage.removeItem(key),
};
