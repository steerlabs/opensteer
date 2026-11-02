import { AppIdSchema } from "@opensteer/core";
import { rpcSuccess, type HostApiHandlers } from "@opensteer/protocol";
import { appFrameHeaders } from "@opensteer/shared/appFrame";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireSession } from "../integrations/integration-rpc-context.js";
import type { AppService } from "./app-service.js";

export function createAppHandlers(
  apps: Pick<AppService, "get" | "view">,
): Pick<HostApiHandlers, "apps.get" | "apps.view"> {
  return {
    "apps.get": async (input, context) =>
      rpcSuccess(await apps.get(input.appId, requireSession(context).user.id)),
    "apps.view": async (input, context) =>
      rpcSuccess(await apps.view(input.appId, requireSession(context).user.id, input.theme)),
  };
}

/** This download has its own capability; ambient Opensteer credentials confer no access. */
export function registerAppRoutes(app: FastifyInstance, apps: AppService): void {
  app.get("/v1/apps/:appId/content", { logLevel: "silent" }, async (request, reply) => {
    for (const [name, value] of Object.entries(appFrameHeaders())) reply.header(name, value);
    const { appId } = z.object({ appId: AppIdSchema }).parse(request.params);
    const { token, theme } = z
      .object({
        token: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
        theme: z.enum(["light", "dark"]).default("light"),
      })
      .parse(request.query);
    return reply.send(await apps.content(appId, token, theme));
  });
}
