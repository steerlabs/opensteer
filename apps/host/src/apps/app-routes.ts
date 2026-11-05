import { Readable } from "node:stream";
import { hostInternalRoutePaths } from "../server/internal-routes.js";
import { appTunnelMaxFrameBytes } from "@opensteer/protocol";
import { appCorsHeaders } from "./app-proxy.js";
import { AppIdSchema } from "@opensteer/core";
import { rpcSuccess, type HostApiHandlers } from "@opensteer/protocol";
import { appFrameContentSecurityPolicy, appFrameHeaders } from "@opensteer/shared/appFrame";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireSession } from "../integrations/integration-rpc-context.js";
import type { AppGateway } from "./app-gateway.js";
import type { AppService } from "./app-service.js";

export function createAppHandlers(
  apps: Pick<AppService, "get" | "view">,
  gateway?: Pick<AppGateway, "entryUrl">,
): Pick<HostApiHandlers, "apps.get" | "apps.view"> {
  return {
    "apps.get": async (input, context) =>
      rpcSuccess(await apps.get(input.appId, requireSession(context).user.id)),
    "apps.view": async (input, context) => {
      const session = requireSession(context);
      const view = await apps.view(input.appId, session.user.id, input.theme);
      const entryUrl = gateway?.entryUrl(input.appId, session, input.theme, context.headers);
      return rpcSuccess({ ...view, ...(entryUrl ? { entryUrl } : {}) });
    },
  };
}

/** This download has its own capability; ambient Opensteer credentials confer no access. */
export function registerAppRoutes(app: FastifyInstance, apps: AppService): void {
  void app.register(async (proxy) => {
    proxy.removeAllContentTypeParsers();
    proxy.addContentTypeParser("*", (_request, payload, done) => done(null, payload));
    proxy.all(
      "/v1/apps/:appId/:theme/:token/*",
      { logLevel: "silent", bodyLimit: 32 * 1_024 * 1_024 },
      async (request, reply) => {
        for (const [name, value] of Object.entries({ ...appFrameHeaders(), ...appCorsHeaders }))
          reply.header(name, value);
        const parsed = z
          .object({
            appId: AppIdSchema,
            theme: z.enum(["light", "dark"]),
            token: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
            "*": z.string(),
          })
          .safeParse(request.params);
        if (!parsed.success) return reply.code(404).send("App not found");
        const { appId, theme, token } = parsed.data;
        const prefix = `/v1/apps/${appId}/${theme}/${token}`;
        const host = request.headers.host;
        // Explicit HTTP sources also match HTTPS, including behind TLS-terminating ingress.
        if (host && /^[A-Za-z0-9.[\]:_-]+$/u.test(host))
          reply.header(
            "content-security-policy",
            appFrameContentSecurityPolicy.replace(
              "connect-src 'self'",
              `connect-src 'self' http://${host}`,
            ),
          );
        const controller = new AbortController();
        const abort = () => controller.abort(new Error("App viewer disconnected"));
        const close = () => {
          if (!reply.raw.writableFinished) abort();
        };
        request.raw.once("aborted", abort);
        reply.raw.once("close", close);
        reply.raw.once("finish", () => {
          request.raw.off("aborted", abort);
          reply.raw.off("close", close);
        });
        try {
          if (request.method === "OPTIONS" && request.headers["access-control-request-method"]) {
            const latest = await apps.authorizeView(appId, token);
            if (!latest.version.server)
              return reply.code(404).type("text/plain").send("App not found");
            reply.header(
              "access-control-allow-methods",
              request.headers["access-control-request-method"],
            );
            const requested = request.headers["access-control-request-headers"];
            if (typeof requested === "string")
              reply.header("access-control-allow-headers", requested);
            return reply.code(204).send();
          }
          const path = request.raw.url!.slice(prefix.length) || "/";
          const result = await apps.response({
            appId,
            token,
            theme,
            prefix,
            path,
            method: request.method,
            headers: request.headers,
            body: request.body instanceof Readable ? request.body : request.raw,
            signal: controller.signal,
          });
          for (const [name, value] of Object.entries(result.headers))
            if (name.toLowerCase() !== "content-security-policy") reply.header(name, value);
          return reply.code(result.status).send(result.body);
        } catch {
          if (controller.signal.aborted) return reply;
          return reply.code(404).type("text/plain").send("App not found");
        }
      },
    );
  });
  app.get(
    hostInternalRoutePaths.appTunnel,
    { websocket: true, logLevel: "silent" },
    (socket, request) => {
      const ticket = z
        .object({ ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/u) })
        .safeParse(request.query);
      if (!ticket.success) {
        socket.close(1008, "App tunnel unavailable");
        return;
      }
      socket.on("message", (bytes) => {
        const size = Array.isArray(bytes)
          ? bytes.reduce((n, part) => n + part.length, 0)
          : bytes.byteLength;
        if (size > appTunnelMaxFrameBytes) socket.terminate();
      });
      apps.acceptTunnel(ticket.data.ticket, socket);
    },
  );
}
