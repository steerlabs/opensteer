import { Readable } from "node:stream";
import { hostInternalRoutePaths } from "../server/internal-routes.js";
import { unversionedRoute } from "../server/unversioned-route.js";
import { appTunnelMaxFrameBytes } from "@opensteer/protocol";
import { appCorsHeaders } from "./app-proxy.js";
import { AppIdSchema } from "@opensteer/core";
import {
  rpcSuccess,
  type AppCommand,
  type AppCommandResult,
  type HostApiServerContext,
} from "@opensteer/protocol";
import type { UserId } from "@opensteer/core";
import type { AppTheme } from "@opensteer/shared/appFrame";
import type { AppsListInputSchema } from "@opensteer/protocol";
import { appFrameContentSecurityPolicy, appFrameHeaders } from "@opensteer/shared/appFrame";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireSession } from "../server/rpc-context.js";
import type { AppGateway } from "./app-gateway.js";
import type { AppService } from "./app-service.js";

export function createAppHandlers(
  apps: Pick<AppService, "get" | "list" | "view">,
  gateway?: Pick<AppGateway, "entryUrl">,
) {
  return {
    "apps.list": async (input: AppsListInput, context: HostApiServerContext) =>
      rpcSuccess({
        apps: await apps.list(
          { kind: "person", ownerId: requireSession(context).user.id },
          input.query,
        ),
      }),
    "apps.get": async (input: { appId: string }, context: HostApiServerContext) =>
      rpcSuccess(await apps.get(requireSession(context).user.id, input.appId)),
    "apps.view": async (
      input: { appId: string; theme: AppTheme },
      context: HostApiServerContext,
    ) => {
      const session = requireSession(context);
      const view = await apps.view(session.user.id, input.appId, input.theme);
      const entryUrl = gateway?.entryUrl(input.appId, session, input.theme, context.headers);
      return rpcSuccess({ ...view, ...(entryUrl ? { entryUrl } : {}) });
    },
  };
}

/** The person's app commands; each one goes through `commands.dispatch`. */
export async function handleAppCommand(
  apps: Pick<AppService, "rename" | "start" | "stop" | "delete">,
  command: AppCommand,
  ownerId: UserId,
): Promise<AppCommandResult> {
  const actor = { kind: "person", ownerId } as const;
  switch (command.type) {
    case "app.rename":
      return { type: command.type, app: await apps.rename(ownerId, command.appId, command.name) };
    case "app.start":
      return { type: command.type, app: await apps.start(actor, command.appId) };
    case "app.stop":
      return { type: command.type, app: await apps.stop(actor, command.appId) };
    case "app.delete":
      await apps.delete(actor, command.appId);
      return { type: command.type, appId: command.appId, deleted: true };
  }
}

/** This download has its own capability; ambient Opensteer credentials confer no access. */
type AppsListInput = z.infer<typeof AppsListInputSchema>;

export function registerAppRoutes(
  app: FastifyInstance,
  apps: Pick<AppService, "authorizeView" | "response" | "acceptTunnel">,
  pages?: import("../plugins/plugin-pages.js").PluginPages,
): void {
  void app.register(async (proxy) => {
    proxy.removeAllContentTypeParsers();
    proxy.addContentTypeParser("*", (_request, payload, done) => done(null, payload));
    const targets = [
      { route: "/v1/apps", target: apps },
      ...(pages ? [{ route: "/v1/plugin-pages", target: pages }] : []),
    ];
    for (const { route, target } of targets)
      proxy.all(
        `${route}/:appId/:theme/:token/*`,
        // An app's own frame loads these documents and resources; its token is the authority.
        { logLevel: "silent", bodyLimit: 32 * 1_024 * 1_024, config: unversionedRoute },
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
          const prefix = `${route}/${appId}/${theme}/${token}`;
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
              const latest = await target.authorizeView(appId, token);
              if ("version" in latest && !latest.version.server)
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
            const result = await target.response({
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
