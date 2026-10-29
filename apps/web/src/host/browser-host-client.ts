import type { ClientLifecycle, HttpHostClientOptions } from "@opensteer/client/host";
import {
  HttpHostClient,
  type RecentSitesStorage,
  type WebSocketClient,
} from "@opensteer/client/host";
import { browserClientLifecycle } from "./browser-lifecycle.js";

export interface BrowserHostClientOptions {
  readonly capabilities: Exclude<HttpHostClientOptions["capabilities"], undefined>;
  /** The Desktop renderer attaches to a selected Deployment rather than to the
   * origin that served this bundle. */
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
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
    capabilities: options.capabilities ?? null,
    baseUrl: options.baseUrl ?? window.location.origin,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    lifecycle: options.lifecycle ?? browserClientLifecycle(),
    recentSitesStorage: browserRecentSitesStorage,
    viewerPlatform: /Mac|iPhone|iPad|iPod/u.test(navigator.platform) ? "mac" : "pc",
    ...(options.webSocketFactory ? { webSocketFactory: options.webSocketFactory } : {}),
  });
}

/**
 * Recent sites live in this browser's own storage. Reaching it can throw
 * (storage turned off); the store treats a throw as no storage at all.
 */
export const browserRecentSitesStorage: RecentSitesStorage = {
  getItem: (key) => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
  removeItem: (key) => window.localStorage.removeItem(key),
};
