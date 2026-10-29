import { createHash } from "node:crypto";
import { session, type OnBeforeRequestListenerDetails, type Session } from "electron";
import { ServiceOriginPolicy } from "./navigation-policy.js";

/**
 * Main-process HTTP transport for control-plane and discovery services.
 *
 * The renderer's default session is intentionally offline. Service traffic
 * uses a separate, in-memory Chromium session per origin so it can honor the
 * operating system's proxy and certificate configuration without sharing
 * cookies, cache, auth state, or request authority with the renderer or with
 * another service.
 */
export class ElectronServiceNetwork {
  readonly #sessions = new Map<string, Session>();

  fetch(input: URL | RequestInfo, init?: RequestInit): Promise<Response> {
    const url = serviceRequestUrl(input);
    return this.#session(url).fetch(input instanceof URL ? url.toString() : input, init);
  }

  async close(): Promise<void> {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.all(
      sessions.map(async (serviceSession) => {
        await serviceSession.closeAllConnections();
        await Promise.all([
          serviceSession.clearAuthCache(),
          serviceSession.clearCache(),
          serviceSession.clearStorageData(),
        ]);
      }),
    );
  }

  #session(url: URL): Session {
    const origin = url.origin;
    const existing = this.#sessions.get(origin);
    if (existing) return existing;
    const fingerprint = createHash("sha256").update(origin).digest("hex").slice(0, 24);
    const created = session.fromPartition(`opensteer-service-${fingerprint}`, { cache: false });
    const policy = new ServiceOriginPolicy(url);
    created.setPermissionCheckHandler(() => false);
    created.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    for (const preload of created.getPreloadScripts()) created.unregisterPreloadScript(preload.id);
    created.on("will-download", (event) => event.preventDefault());
    created.webRequest.onBeforeRequest(
      { urls: ["<all_urls>"] },
      (details: OnBeforeRequestListenerDetails, callback) => {
        callback({ cancel: !policy.allowsNetworkRequest(details.url) });
      },
    );
    this.#sessions.set(origin, created);
    return created;
  }
}

function serviceRequestUrl(input: URL | RequestInfo): URL {
  const value =
    input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error("Desktop service requests require an absolute URL.", { cause: error });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Desktop service requests require HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("Desktop service request URLs cannot contain credentials.");
  }
  return url;
}
