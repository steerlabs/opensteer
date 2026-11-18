import type { FastifyInstance } from "fastify";
import { Readable } from "node:stream";
import { z } from "zod";
import { readBoundedResponse } from "@opensteer/shared/boundedJson";
import type { PluginService } from "./plugin-service.js";

const params = z.strictObject({
  plugin: z.string().regex(/^app_[0-9a-f-]{36}$/u),
  subscription: z.string().regex(/^whk_[a-zA-Z0-9-]{1,100}$/u),
});
export const pluginWebhookPath = "/hooks/v1/plugins/:plugin/:subscription";
export const pluginWebhookBodyLimit = 1024 * 1024;

/** Public callbacks authenticate in plugin code; no Host credential or JSON parsing reaches it. */
export function registerPluginWebhookRoutes(
  app: FastifyInstance,
  options: {
    service: Pick<PluginService, "webhook" | "readStream">;
    origin: () => Promise<string | undefined>;
    admit: (address: string) => Promise<boolean>;
  },
) {
  void app.register(async (hooks) => {
    hooks.removeAllContentTypeParsers();
    hooks.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) =>
      done(null, body),
    );
    hooks.all(
      pluginWebhookPath,
      {
        bodyLimit: pluginWebhookBodyLimit,
        logLevel: "silent",
        onRequest: async (request, reply) => {
          if (!(await options.admit(request.ip)))
            return reply.header("retry-after", "60").code(429).send();
        },
      },
      async (request, reply) => {
        reply.headers({
          "cache-control": "no-store",
          "content-security-policy": "sandbox; default-src 'none'; frame-ancestors 'none'",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        });
        const parsed = params.safeParse(request.params);
        if (!parsed.success) return reply.code(404).send();
        const origin = await options.origin();
        if (!origin) return reply.code(404).send();
        const controller = new AbortController();
        const disconnected = () => {
          if (!reply.raw.writableFinished) controller.abort();
        };
        reply.raw.once("close", disconnected);
        try {
          const headers = Object.fromEntries(
            Object.entries(request.headers).flatMap(([name, value]) =>
              value !== undefined && !["cookie", "x-opensteer-app-origin"].includes(name)
                ? [[name, Array.isArray(value) ? value.join(", ") : value]]
                : [],
            ),
          );
          const result = await options.service.webhook(
            {
              ...parsed.data,
              request: {
                url: new URL(request.raw.url ?? "/", origin).href,
                method: request.method,
                headers,
                body: Buffer.isBuffer(request.body) ? request.body.toString("base64") : "",
              },
            },
            { caller: "personal", mode: "automatic" },
            controller.signal,
          );
          for (const name of [
            "content-type",
            "webhook-allowed-origin",
            "webhook-allowed-rate",
            "retry-after",
            "allow",
          ])
            if (result.headers[name]) reply.header(name, result.headers[name]);
          const body = result.stream
            ? await readBoundedResponse(
                new Response(
                  Readable.toWeb(
                    Readable.from(options.service.readStream(result.stream, controller.signal)),
                  ) as ReadableStream<Uint8Array>,
                ),
                { maximumBytes: pluginWebhookBodyLimit, signal: controller.signal },
              )
            : Buffer.from(result.body, "base64");
          return reply.code(result.status).send(Buffer.from(body));
        } catch {
          return reply.code(503).send();
        } finally {
          reply.raw.off("close", disconnected);
          controller.abort();
        }
      },
    );
    hooks.setErrorHandler((error, _request, reply) => {
      const status =
        typeof error === "object" &&
        error !== null &&
        "statusCode" in error &&
        error.statusCode === 413
          ? 413
          : 400;
      void reply.header("cache-control", "no-store").code(status).send();
    });
  });
}
