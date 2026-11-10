import { isIP } from "node:net";
import type { FastifyRequest } from "fastify";
import type { HostApiServerContext } from "@opensteer/protocol";

// Use the same ingress address rules as the session-exchange routes.
export function anonymousClientAddress(request: FastifyRequest): string {
  const cloudflareAddress = request.headers["cf-connecting-ip"];
  if (typeof cloudflareAddress === "string" && isIP(cloudflareAddress) !== 0)
    return cloudflareAddress;
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
