import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { TrustedProxy } from "@opensteer/config";
import { isLoopbackHostname } from "@opensteer/core";
import { vettedClientAddressHeader } from "@opensteer/identity";
import type { HostApiServerContext } from "@opensteer/protocol";

const trustedProxies = new WeakMap<IncomingMessage, TrustedProxy>();

/** Records, before any route reads a forwarding header, which proxy this Host believes. */
export function installTrustedProxy(app: FastifyInstance, proxy: TrustedProxy): void {
  app.addHook("onRequest", async (request) => {
    trustedProxies.set(request.raw, proxy);
  });
}

/**
 * Replaces, at ingress, whatever a client said in the header the sign-in
 * library reads its address from with the address this Host's own proxy policy
 * vetted. Nothing downstream ever sees an address the client chose.
 */
export function installClientAddress(app: FastifyInstance): void {
  app.addHook("onRequest", async (request) => {
    request.headers[vettedClientAddressHeader] = anonymousClientAddress(request);
  });
}

/**
 * The proxy whose headers this request may carry: the configured one, and
 * only when the request came from this computer's own loopback interface,
 * where that proxy runs. A Host without the hook keeps the loopback tunnel
 * connector a Personal Host has always believed.
 */
export function forwardingProxy(request: FastifyRequest): TrustedProxy {
  const proxy = trustedProxies.get(request.raw) ?? "loopback-cloudflared";
  const peer = request.raw.socket.remoteAddress ?? "";
  return proxy !== "none" && isLoopbackHostname(peer) ? proxy : "none";
}

export function anonymousClientAddress(request: FastifyRequest): string {
  const proxy = forwardingProxy(request);
  if (proxy === "loopback-cloudflared") {
    const cloudflareAddress = request.headers["cf-connecting-ip"];
    if (typeof cloudflareAddress === "string" && isIP(cloudflareAddress) !== 0)
      return cloudflareAddress;
  }
  if (proxy === "loopback") {
    // The proxy appends the address it saw; earlier entries are the client's own claims.
    const forwarded = request.headers["x-forwarded-for"];
    const last = (typeof forwarded === "string" ? forwarded : "").split(",").at(-1)?.trim();
    if (last && isIP(last) !== 0) return last;
  }
  return isIP(request.ip) === 0 ? "unknown" : request.ip;
}

const addresses = new WeakMap<HostApiServerContext, string>();
export function bindAnonymousClientAddress(
  context: HostApiServerContext,
  request: FastifyRequest,
): void {
  addresses.set(context, anonymousClientAddress(request));
}
export function contextClientAddress(context: HostApiServerContext): string {
  return addresses.get(context) ?? "unknown";
}
