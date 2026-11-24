import { createHash, X509Certificate } from "node:crypto";
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
  readonly #accountCertificate: { readonly key: string; readonly origin: string } | null;

  /**
   * `accountCertificate`, in a development launch only: the one key the account service's own
   * session accepts for the account host, as a stand-in account service is served (the first-run
   * journey's). Every other host and key on that session, and every other session, is Chromium's.
   */
  constructor(
    options: {
      readonly accountCertificate?: { readonly key: string; readonly origin: string } | null;
    } = {},
  ) {
    this.#accountCertificate = options.accountCertificate ?? null;
  }

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
    const pinned = this.#accountCertificate;
    if (pinned && new URL(pinned.origin).origin === origin) {
      const hostname = url.hostname;
      created.setCertificateVerifyProc((request, callback) => {
        // 0 accepts; -3 leaves the certificate to Chromium's own verification.
        callback(
          request.hostname === hostname && publicKeyOf(request.certificate.data) === pinned.key
            ? 0
            : -3,
        );
      });
    }
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

/** A PEM certificate's public key as a pin names it: the base64 SHA-256 of its SPKI. */
function publicKeyOf(pem: string): string | null {
  try {
    const key = new X509Certificate(pem).publicKey.export({ format: "der", type: "spki" });
    return createHash("sha256").update(key).digest("base64");
  } catch {
    return null;
  }
}
