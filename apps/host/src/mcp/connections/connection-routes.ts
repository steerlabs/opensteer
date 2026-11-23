import { agentOperationCursor, listAgentOperations } from "@opensteer/database";
import { embedderAssertionParam } from "@opensteer/control-plane-protocol";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { ConnectionCaller } from "../agent-caller.js";
import type { UserId } from "@opensteer/core";
import { OpensteerError } from "@opensteer/core";
import {
  AgentConnectionConsentSchema,
  rpcSuccess,
  type AgentConnection,
  type AgentConnectionConsent,
  type HostApiHandlers,
  type HostApiCommand,
  type HostApiServerContext,
} from "@opensteer/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { exchangeRouteOrigin } from "../../access/session-exchange-routes.js";
import {
  ConnectionOAuth,
  ConnectionOAuthError,
  ConnectionOAuthRedirectError,
  mcpIssuerPath,
  mcpResourcePath,
  mcpResourceMetadataPath,
  mcpServerMetadataPath,
  presentIdentity,
} from "./connection-oauth.js";
import { connectionCredentialPrefix } from "./connection-authenticator.js";

export interface ConnectionRoutesOptions {
  readonly oauth: ConnectionOAuth;
  readonly canonicalOrigin: string;
  readonly loopbackOriginAliases: boolean;
  readonly remoteOrigin?: (() => Promise<string | null>) | undefined;
}

/** Headers select an allowed route, never the owner or their consent. */
export async function connectionRequestOrigin(
  request: FastifyRequest,
  options: ConnectionRoutesOptions,
): Promise<string> {
  const origin = exchangeRouteOrigin(request);
  const url = new URL(origin);
  if (
    typeof request.headers.host !== "string" ||
    request.headers.host.toLowerCase() !== url.host.toLowerCase()
  )
    throw forbiddenRoute();
  if (origin === options.canonicalOrigin) return origin;
  const canonical = new URL(options.canonicalOrigin);
  if (
    options.loopbackOriginAliases &&
    url.protocol === "http:" &&
    url.port === canonical.port &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    return origin;
  if (url.protocol === "https:" && origin === (await options.remoteOrigin?.())) return origin;
  throw forbiddenRoute();
}
function forbiddenRoute() {
  return new OpensteerError({
    code: "forbidden",
    message: "The MCP connection route is not available.",
  });
}

export function registerConnectionRoutes(
  app: FastifyInstance,
  options: ConnectionRoutesOptions,
): void {
  const { oauth } = options;
  app.addHook("onClose", async () => oauth.close());
  const getOrigin = (request: FastifyRequest) => connectionRequestOrigin(request, options);
  app.addHook("onRequest", async (request, reply) => {
    if (request.url.split("?", 1)[0] !== mcpResourcePath) return;
    const header = request.headers.authorization;
    // Runs and programs reach this path on the runtime origin, which a
    // self-hosted gateway may keep private; the MCP service checks them there.
    // Only connected agents, and requests that must learn how to become one,
    // are bound to an approved connection route.
    const connecting =
      !header ||
      (typeof header === "string" &&
        /^Bearer /i.test(header) &&
        header.slice(7).startsWith(connectionCredentialPrefix));
    if (!connecting) return;
    const origin = await getOrigin(request);
    if (!header)
      return reply
        .code(401)
        .header("www-authenticate", challenge(origin))
        .send({ error: "unauthorized" });
    // Resource binding is checked once for this request; the MCP handler
    // forwards this caller through authInfo, never through a transport session.
    try {
      const connection = await oauth.authenticator.authenticate(
        header.slice(7),
        origin + mcpResourcePath,
      );
      const caller: ConnectionCaller = {
        ...connection,
        kind: "connection",
        key: `connection:${connection.connectionId}`,
      };
      (request.raw as typeof request.raw & { auth?: AuthInfo }).auth = {
        token: header.slice(7),
        clientId: caller.key,
        scopes: [],
        extra: { caller },
      };
    } catch {
      return reply
        .code(401)
        .header("www-authenticate", challenge(origin))
        .send({ error: "unauthorized" });
    }
  });
  const rootMetadataPath = "/.well-known/oauth-authorization-server";
  const serverMetadataPaths = [mcpServerMetadataPath];
  if (!app.hasRoute({ method: "GET", url: rootMetadataPath }))
    serverMetadataPaths.push(rootMetadataPath);
  app.addHook("onSend", async (request, reply, payload) => {
    const path = request.url.split("?", 1)[0];
    if (
      path === mcpResourceMetadataPath ||
      serverMetadataPaths.includes(path ?? "") ||
      path === "/.well-known/oauth-protected-resource" ||
      path === `${mcpIssuerPath}/register` ||
      path === `${mcpIssuerPath}/token`
    ) {
      reply.header("access-control-allow-origin", "*");
    }
    if (request.url.split("?", 1)[0] === mcpResourcePath && reply.statusCode === 401)
      reply.header("www-authenticate", challenge(await getOrigin(request)));
    return payload;
  });
  for (const path of [mcpResourceMetadataPath, "/.well-known/oauth-protected-resource"])
    app.get(path, async (request, reply) => {
      const origin = await getOrigin(request);
      return reply.header("cache-control", "no-store").send({
        resource: origin + mcpResourcePath,
        authorization_servers: [origin + mcpIssuerPath],
        bearer_methods_supported: ["header"],
        resource_name: "Opensteer",
        scopes_supported: ["opensteer"],
      });
    });
  for (const path of serverMetadataPaths)
    app.get(path, async (request, reply) => {
      const issuer = (await getOrigin(request)) + mcpIssuerPath;
      return reply.header("cache-control", "no-store").send({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["opensteer"],
        authorization_response_iss_parameter_supported: true,
      });
    });
  // Keep OAuth errors and responses away from generic error serializers and logs.
  app.register(async (routes) => {
    for (const path of [`${mcpIssuerPath}/register`, `${mcpIssuerPath}/token`])
      routes.options(path, async (_request, reply) =>
        reply
          .header("access-control-allow-methods", "POST, OPTIONS")
          .header("access-control-allow-headers", "Content-Type")
          .code(204)
          .send(),
      );
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof ConnectionOAuthRedirectError)
        return reply
          .header("cache-control", "no-store")
          .header("referrer-policy", "no-referrer")
          .redirect(error.redirect, 303);
      const status =
        error instanceof ConnectionOAuthError
          ? error.status
          : error instanceof OpensteerError && error.code === "unauthorized"
            ? 401
            : error instanceof OpensteerError && error.code === "forbidden"
              ? 403
              : 400;
      return reply
        .code(status)
        .header("cache-control", "no-store")
        .header("referrer-policy", "no-referrer")
        .send({ error: error instanceof ConnectionOAuthError ? error.error : "invalid_request" });
    });
    routes.post(`${mcpIssuerPath}/register`, { bodyLimit: 16_384 }, async (request, reply) =>
      reply
        .code(201)
        .header("cache-control", "no-store")
        .send(oauth.register(await getOrigin(request), request.body)),
    );
    routes.get(`${mcpIssuerPath}/authorize`, async (request, reply) => {
      const parameters = new URL(request.url, options.canonicalOrigin).searchParams;
      if (parameters.getAll(embedderAssertionParam).length > 1) {
        parameters.set(embedderAssertionParam, "");
      }
      const path = await oauth.authorize(await getOrigin(request), uniqueParameters(parameters));
      return reply
        .header("cache-control", "no-store")
        .header("referrer-policy", "no-referrer")
        .redirect(path, 303);
    });
    // The browser need not hold a Host login. This nonce only finishes an
    // owner-approved request to its registered callback; redemption still needs PKCE.
    routes.get(`${mcpIssuerPath}/complete`, async (request, reply) => {
      const input = z
        .object({ request: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
        .parse(uniqueParameters(new URL(request.url, options.canonicalOrigin).searchParams));
      const redirect = oauth.complete(input.request, await getOrigin(request));
      return reply
        .header("cache-control", "no-store")
        .header("referrer-policy", "no-referrer")
        .redirect(redirect, 303);
    });
    routes.post(`${mcpIssuerPath}/token`, { bodyLimit: 24_576 }, async (request, reply) => {
      const media = request.headers["content-type"]?.split(";", 1)[0];
      const body: unknown =
        media === "application/x-www-form-urlencoded" && Buffer.isBuffer(request.body)
          ? uniqueParameters(
              new URLSearchParams(new TextDecoder("utf8", { fatal: true }).decode(request.body)),
            )
          : media === "application/json"
            ? request.body
            : undefined;
      return reply
        .header("cache-control", "no-store")
        .header("pragma", "no-cache")
        .send(await oauth.exchange(await getOrigin(request), body));
    });
  });
}
function challenge(origin: string) {
  return `Bearer resource_metadata="${origin}${mcpResourceMetadataPath}"`;
}
function uniqueParameters(parameters: URLSearchParams): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of parameters) {
    if (Object.hasOwn(result, key)) throw new ConnectionOAuthError("invalid_request");
    Object.defineProperty(result, key, { value, enumerable: true });
  }
  return result;
}

export function createConnectionRpcHandlers(
  oauth: ConnectionOAuth,
  chromeTabGrantCatalog?: (
    ownerId: UserId,
  ) => Promise<
    Pick<AgentConnectionConsent, "chromeTabs" | "chromeTabsNeedPairing" | "chromeTabsRepairNames">
  >,
): Pick<
  HostApiHandlers,
  "connections.list" | "connections.authorization.get" | "connections.activity" | "threads.activity"
> {
  return {
    "connections.activity": async (input, context) =>
      rpcSuccess(
        await listAgentOperations(oauth.store.database, {
          userId: requireOwner(context).user.id,
          connectionId: input.connectionId,
          limit: 50,
          ...optionalBefore(input.before),
        }),
      ),
    "threads.activity": async (input, context) =>
      rpcSuccess(
        await listAgentOperations(oauth.store.database, {
          userId: requireOwner(context).user.id,
          threadId: input.threadId,
          limit: 50,
          ...optionalBefore(input.before),
        }),
      ),
    "connections.list": async (input, context) => {
      const connections = (
        await oauth.store.list(requireOwner(context).user.id, { includeRevoked: true })
      ).map(withIdentity);
      return rpcSuccess(
        input.includeRevoked
          ? { connections, endedConnections: [] }
          : {
              // A paused chat is still connected: it waits, and comes back with what it holds.
              connections: connections.filter(
                (connection) => connection.state === "active" || connection.state === "paused",
              ),
              endedConnections: connections.filter(
                (connection) => connection.state !== "active" && connection.state !== "paused",
              ),
            },
      );
    },
    "connections.authorization.get": async (input, context) => {
      const ownerId = requireOwner(context).user.id;
      const consent = await oauth.consent(input.requestId, ownerId);
      return rpcSuccess(
        AgentConnectionConsentSchema.parse({
          ...consent,
          grantsAvailable: true,
          ...(await chromeTabGrantCatalog?.(ownerId)),
        }),
      );
    },
  };
}
/** A connection with how the Home words who asked, from what it recorded at consent. */
function withIdentity(connection: AgentConnection): AgentConnection {
  return connection.identityAtConsent
    ? { ...connection, identity: presentIdentity(connection.identityAtConsent) }
    : connection;
}
export type ConnectionCommand = Extract<
  HostApiCommand,
  {
    type:
      | "connection.revoke"
      | "connection.authorize"
      | "connection.update"
      | "connection.remove"
      | "connection.uncertain.acknowledge";
  }
>;
export function isConnectionCommand(command: HostApiCommand): command is ConnectionCommand {
  return (
    command.type === "connection.revoke" ||
    command.type === "connection.authorize" ||
    command.type === "connection.update" ||
    command.type === "connection.remove" ||
    command.type === "connection.uncertain.acknowledge"
  );
}
/** What a connection change leaves for the runtime once it committed. */
export interface ConnectionCommandEffects {
  /** Stops the lineage's durable work: Requests, queued inputs, Runs and automations. */
  readonly stopLineage?: (
    userId: UserId,
    connectionId: string,
    reason: "disconnect" | "narrowed",
  ) => Promise<void>;
}
export function connectionCommandEffects(options: {
  readonly store: Pick<import("@opensteer/database").OpensteerStore, "driveConnectionCleanups">;
  readonly closeLineage: (connectionId: string, revision?: number) => Promise<void>;
  readonly stopper?: NonNullable<
    Parameters<import("@opensteer/database").OpensteerStore["driveConnectionCleanups"]>[0]
  >["stopper"];
  readonly onFailure: (error: unknown, connectionId?: string) => void;
  /** After a lineage was stopped: abort this process's work for sessions that ended. */
  readonly afterStop?: (connectionId: string, reason: "disconnect" | "narrowed") => Promise<void>;
}): ConnectionCommandEffects & { readonly driveCleanups: () => Promise<void> } {
  const driveCleanups = async () => {
    const { failures } = await options.store.driveConnectionCleanups({
      ...(options.stopper ? { stopper: options.stopper } : {}),
      onCleanup: async ({ connectionId, reason, minimumGrantRevision }) => {
        const narrowed = reason === "narrowed";
        await options.closeLineage(connectionId, narrowed ? minimumGrantRevision : undefined);
        await options.afterStop?.(connectionId, narrowed ? "narrowed" : "disconnect");
      },
    });
    for (const error of failures) options.onFailure(error);
  };
  return { driveCleanups, stopLineage: driveCleanups };
}
export async function handleConnectionCommand(
  oauth: ConnectionOAuth,
  command: ConnectionCommand,
  context: HostApiServerContext,
  effects: ConnectionCommandEffects = {},
) {
  const session = requireOwner(context);
  switch (command.type) {
    case "connection.revoke":
      // Authority ends when this commits; a retry still finishes stopping the lineage.
      await oauth.store.revoke(session.user.id, command.connectionId);
      await effects.stopLineage?.(session.user.id, command.connectionId, "disconnect");
      return { type: "connection.revoke" as const };
    case "connection.update": {
      const { connection, narrowed } = await oauth.store.update(session.user.id, {
        connectionId: command.connectionId,
        expectedRevision: command.expectedRevision,
        ...(command.label !== undefined ? { label: command.label } : {}),
        ...(command.accessMode !== undefined ? { accessMode: command.accessMode } : {}),
        ...(command.grant !== undefined ? { grant: command.grant } : {}),
      });
      if (narrowed) await effects.stopLineage?.(session.user.id, command.connectionId, "narrowed");
      // The connection as the list draws it (a chat with its account, who is you, its tasks), so
      // a screen that keeps this answer loses nothing until its next read.
      const listed = (await oauth.store.list(session.user.id, { includeRevoked: true })).find(
        ({ id }) => id === connection.id,
      );
      return { type: "connection.update" as const, connection: withIdentity(listed ?? connection) };
    }
    case "connection.remove":
      await oauth.store.remove(session.user.id, command.connectionId);
      await effects.stopLineage?.(session.user.id, command.connectionId, "disconnect");
      return { type: "connection.remove" as const };
    case "connection.uncertain.acknowledge":
      await oauth.store.acknowledgeUncertain(session.user.id, command.connectionId);
      return { type: "connection.uncertain.acknowledge" as const };
    case "connection.authorize":
      return oauth.decide(command, session.user.id, session.id);
  }
}
function requireOwner(context: HostApiServerContext) {
  if (!context.session || context.session.user.disabledAt !== null)
    throw new OpensteerError({
      code: "unauthorized",
      message: "Sign in to manage connected agents.",
    });
  return context.session;
}

function optionalBefore(before: string | undefined) {
  const cursor = agentOperationCursor(before);
  return cursor ? { before: cursor } : {};
}
