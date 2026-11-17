import type { FastifyInstance } from "fastify";
import { OpensteerError } from "@opensteer/core";
import { IntegrationAuthorizationAttemptIdSchema } from "@opensteer/integration-core";
import {
  rpcSuccess,
  type HostApiCommand,
  type HostApiCommandOutput,
  type HostApiHandlers,
  type HostApiServerContext,
} from "@opensteer/protocol";
import { requireSession, requireSurface } from "../server/rpc-context.js";
import { unversionedRoute } from "../server/unversioned-route.js";
import { registerOAuthCallbackRoute } from "../access/integration-authorization-routes.js";
import type { HostAuthenticator } from "../identity/auth.js";
import type { PluginOAuthService } from "./plugin-oauth-service.js";

const required = (service: PluginOAuthService | undefined) => {
  if (!service)
    throw new OpensteerError({ code: "not_found", message: "Plugin sign-in is unavailable" });
  return service;
};
export function pluginOAuthHandlers(
  service?: PluginOAuthService,
): Pick<HostApiHandlers, "plugin.authorization.get" | "plugin.authorization.methods"> {
  return {
    "plugin.authorization.get": async ({ attemptId }, context) =>
      rpcSuccess(
        await required(service).status(
          attemptId,
          requireSession(context).user.id,
          context.session!.id,
        ),
      ),
    "plugin.authorization.methods": async ({ connection }, context) =>
      rpcSuccess(await required(service).methods(connection, requireSession(context).user.id)),
  };
}
export type PluginOAuthCommand = Extract<
  HostApiCommand,
  { type: `plugin.authorization.${string}` | `plugin.oauthApp.${string}` }
>;
export function isPluginOAuthCommand(command: HostApiCommand): command is PluginOAuthCommand {
  return (
    command.type.startsWith("plugin.authorization.") || command.type.startsWith("plugin.oauthApp.")
  );
}
export async function handlePluginOAuthCommand(
  service: PluginOAuthService | undefined,
  command: PluginOAuthCommand,
  context: HostApiServerContext,
): Promise<HostApiCommandOutput> {
  const oauth = required(service);
  const session = requireSession(context);
  const owner = session.user.id;
  await oauth.assertOwner(owner);
  switch (command.type) {
    case "plugin.authorization.prepare":
      return {
        ...(await oauth.prepare(
          command.input,
          owner,
          JSON.stringify([owner, command.type, command.idempotencyKey]),
        )),
        type: command.type,
      };
    case "plugin.authorization.begin":
      return {
        ...(await oauth.begin(
          command.input,
          owner,
          requireSurface(context),
          JSON.stringify([owner, command.type, command.idempotencyKey]),
        )),
        type: command.type,
      };
    case "plugin.authorization.return":
      return {
        ...(await oauth.returned(command.attemptId, command.returnProof, owner, session.id)),
        type: command.type,
      };
    case "plugin.authorization.cancel":
      return { ...(await oauth.cancel(command.attemptId, owner)), type: command.type };
    case "plugin.oauthApp.save":
      return {
        type: command.type,
        client: await oauth.options.plugins.saveOAuthApp(
          { ...command.input, key: JSON.stringify([owner, command.type, command.idempotencyKey]) },
          {
            caller: "personal",
            mode: "automatic",
          },
        ),
      };
    case "plugin.oauthApp.remove":
      await oauth.options.plugins.removeOAuthApp(
        { client: command.client },
        { caller: "personal", mode: "automatic" },
      );
      return { type: command.type };
  }
}
export function registerPluginOAuthRoutes(
  app: FastifyInstance,
  service: PluginOAuthService,
  authenticator: HostAuthenticator,
) {
  app.get(
    "/v1/plugin-oauth/client-metadata.json",
    { config: unversionedRoute },
    async (_request, reply) =>
      reply.header("cache-control", "no-store").send({
        client_id: new URL("/v1/plugin-oauth/client-metadata.json", service.options.origin).href,
        client_name: "Opensteer",
        redirect_uris: [new URL("/v1/plugin-oauth/callback", service.options.origin).href],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
  );
  registerOAuthCallbackRoute(app, {
    attemptIdSchema: IntegrationAuthorizationAttemptIdSchema,
    authenticator,
    path: "/v1/plugin-oauth/callback",
    prepare: () => null,
    identify: (state) =>
      service.options.attempts.identifyCallback({ flow: "provider-oauth", state }),
    handle: (input) => service.directCallback(input),
  });
}
