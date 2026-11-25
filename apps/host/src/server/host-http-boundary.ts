import type { FastifyInstance } from "fastify";
import { rejectDuplicateCredentialHeaders } from "../identity/request-credential-headers.js";
import { normalizeHostError } from "./http-errors.js";

/**
 * The request boundary every Host shares, whatever its kind.
 *
 * Install it before registering any plugin: a plugin context that loads first
 * keeps Fastify's default error handler, which echoes exception messages.
 */
export function installHostHttpBoundary(app: FastifyInstance): void {
  app.addHook("onRequest", async (request) => {
    if (!request.url.startsWith("/v1/rpc/")) await rejectDuplicateCredentialHeaders(request);
  });
  // No response of the Home renders inside a frame, its API, its errors and its pages alike (D2):
  // independent of every browser's gate, an agent's page cannot hold the Home in a frame. A
  // response that names who may frame it (an app the Home frames itself) keeps that policy.
  app.addHook("onSend", async (_request, reply, payload) => {
    const declared = reply.getHeader("content-security-policy");
    const policy = Array.isArray(declared)
      ? declared.join(", ")
      : declared === undefined
        ? ""
        : String(declared);
    if (/frame-ancestors/iu.test(policy)) return payload;
    void reply.header(
      "content-security-policy",
      policy ? `${policy}; frame-ancestors 'none'` : "frame-ancestors 'none'",
    );
    if (!reply.hasHeader("x-frame-options")) void reply.header("x-frame-options", "DENY");
    return payload;
  });
  app.setErrorHandler((error, request, reply) => {
    const normalized = normalizeHostError(error);
    if (normalized.status >= 500 && !request.url.startsWith("/media/"))
      request.log.error({ err: error }, "request failed");
    void reply.status(normalized.status).send({ error: normalized.error });
  });
}
