import Fastify from "fastify";
import { request as httpRequest } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { rejectDuplicateCredentialHeaders } from "./request-credential-headers.js";

describe("raw credential headers", () => {
  it.each(["Authorization", "Origin"])(
    "rejects raw duplicate %s fields before authentication",
    async (name) => {
      const app = Fastify();
      let normalized: string | string[] | undefined;
      const authenticate = vi.fn(() => ({ ok: true }));
      app.addHook("onRequest", async (request) => {
        normalized = request.headers[name.toLowerCase()];
      });
      app.addHook("onRequest", rejectDuplicateCredentialHeaders);
      app.setErrorHandler((error, _request, reply) =>
        reply.code(name === "Authorization" ? 401 : 403).send({ rejected: error instanceof Error }),
      );
      app.post("/mutation", authenticate);
      try {
        const address = await app.listen({ host: "127.0.0.1", port: 0 });
        const status = await new Promise<number>((resolve, reject) => {
          const request = httpRequest(
            `${address}/mutation`,
            {
              method: "POST",
              headers: [
                "Host",
                "127.0.0.1",
                name,
                name === "Authorization" ? "Bearer valid" : "https://host.example",
                name.toLowerCase(),
                "hostile",
              ],
              signal: AbortSignal.timeout(2000),
            },
            (response) => {
              response.resume();
              response.once("end", () => resolve(response.statusCode ?? 0));
              response.once("error", reject);
            },
          );
          request.once("error", reject);
          request.end();
        });
        expect(status).toBe(name === "Authorization" ? 401 : 403);
        expect(authenticate).not.toHaveBeenCalled();
        if (name === "Authorization") expect(normalized).toBe("Bearer valid");
      } finally {
        await app.close();
      }
    },
  );
});
