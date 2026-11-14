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
  app.setErrorHandler((error, request, reply) => {
    const normalized = normalizeHostError(error);
    if (normalized.status >= 500) request.log.error({ err: error }, "request failed");
    void reply.status(normalized.status).send({ error: normalized.error });
  });
}
