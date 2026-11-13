import { rejectDuplicateCredentialHeaders } from "../identity/request-credential-headers.js";
import { assertTeamApiVersion } from "../team/services.js";
import { toWebHeaders } from "../identity/auth.js";
import { bindAnonymousClientAddress } from "../identity/anonymous-client-address.js";
import {
  HostApiErrorSchema,
  hostApi,
  type HostApiHandlers,
  type HostApiScope,
  type HostApiServerContext,
  type RpcDeclaration,
  type RpcResult,
} from "@opensteer/protocol";
import { OpensteerError, unsupportedVersionReason } from "@opensteer/core";
import { attachmentMaxBytes } from "@opensteer/core";
import {
  apiNegotiation,
  apiVersionHeader,
  apiVersionQueryParameter,
  statesApiVersion,
} from "@opensteer/deployment-authority";
import type { DeploymentKind } from "@opensteer/core";
import { unversionedRoute } from "./unversioned-route.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AuthenticatedHostSession, HostAuthenticator } from "../identity/auth.js";
import { errorStatus, normalizeHostError } from "./http-errors.js";
import { afterResponse } from "./after-response.js";
import { requestAbortSignal } from "./request-abort-signal.js";

export const hostApiScopes = {
  "attention.get": "session",
  "needsYou.get": "session",
  "team.bootstrap.get": "session",
  "team.sidebar.get": "session",
  "team.channels.list": "session",
  "team.channel.get": "session",
  "team.channel.access.get": "session",
  "team.channel.instructions.get": "session",
  "team.messages.page": "session",
  "team.thread.page": "session",
  "team.message.get": "session",
  "team.messages.check": "session",
  "team.search": "session",
  "team.members.list": "session",
  "team.groups.list": "session",
  "team.group.get": "session",
  "team.invites.list": "session",
  "team.invite.current.get": "session",
  "team.audit.page": "session",
  "team.notices.page": "session",
  "team.knowledge.topics.list": "session",
  "team.knowledge.topic.get": "session",
  "team.knowledge.topic.access.get": "session",
  "team.agent.requests.get": "session",
  "team.agent.recipient.get": "session",
  "team.links.list": "session",
  "teams.links.list": "session",
  "teams.threadTask.get": "session",
  "teams.replyTask.get": "session",
  "team.mentions.page": "session",
  "team.pins.page": "session",
  "team.files.page": "session",
  "team.knowledge.notes.page": "session",
  "team.knowledge.note.get": "session",
  "team.knowledge.note.history": "session",
  "browser.searchSuggestions.get": "session",
  "browser.contextCandidate.get": "session",
  "browser.tabIcon.get": "session",
  "browser.history.get": "session",
  "browser.history.icons.get": "session",
  "agentPhone.target.get": "session",
  "apps.get": "session",
  "apps.view": "mutation",
  "attachment.upload": "mutation",
  "attachment.get": "session",
  "attachment.content": "session",
  "browser.password-sign-in.get": "mutation",
  "browser.sources.get": "session",
  "browser.sources.inspect": "mutation",
  "auth.config": "public",
  "auth.native.complete": "exact-origin",
  "auth.oidc.begin": "exact-origin",
  "auth.password.recover": "exact-origin",
  "auth.password.signIn": "exact-origin",
  "auth.password.signUp": "exact-origin",
  "auth.setup.claim": "exact-origin",
  "auth.setup.exchange": "exact-origin",
  "auth.signOut": "mutation",
  "bootstrap.get": "session",
  "channel.connection.check": "mutation",
  "channels.get": "session",
  "connections.list": "session",
  "connections.authorization.get": "session",
  "personal.remoteAccess.get": "session",
  "plugins.overview.get": "session",
  "plugins.detail.get": "session",
  "plugins.directory.get": "session",
  "devices.overview.get": "session",
  "commands.dispatch": "mutation",
  "assignment.get": "session",
  "harness.authentication.get": "session",
  "automaticModels.get": "session",
  "harness.catalog.refresh": "mutation",
  "harness.modelServers.discover": "mutation",
  "voice.start": "mutation",
  "voice.open": "mutation",
  "voice.renew": "mutation",
  "voice.say": "mutation",
  "voice.stop": "mutation",
  "voice.context": "mutation",
  "integration.authorization.get": "session",
  "integration.grants.list": "session",
  "integration.computer.policy.get": "session",
  "integration.computer.setup.review": "mutation",
  "integration.computer.setup.list": "session",
  "integration.server.secrets.list": "session",
  "integration.computer.session.stop": "mutation",
  "computer.app.windows": "mutation",
  "integration.computer.apps.approved": "session",
  "integration.computer.apps.installed": "mutation",
  "specialist.list": "session",
  "plugin.list": "session",
  "integration.platform.get": "session",
  "integration.repositoryAccess.check": "mutation",
  "integrations.get": "session",
  "machines.list": "session",
  "machine.access.history": "session",
  "requests.list": "session",
  "tasks.list": "session",
  "run.attempts.list": "session",
  "sessions.list": "session",
  "tool.output.get": "session",
  "thread.events.list": "session",
  "node.events.list": "session",
  "thread.assignments.list": "session",
  "thread.browserUsage.get": "session",
  "thread.inputQueue.get": "session",
  "thread.live.get": "session",
  "thread.messages.list": "session",
  "thread.requests.list": "session",
  "triggers.get": "session",
  "triggers.list": "session",
} satisfies Record<keyof typeof hostApi, HostApiScope>;

export function registerHostApi(
  app: FastifyInstance,
  authenticator: HostAuthenticator,
  handlers: Partial<HostApiHandlers>,
  options: HostApiRegistrationOptions = { kind: "personal" },
): void {
  for (const name of Object.keys(hostApi) as (keyof typeof hostApi)[]) {
    const team = name.startsWith("team.");
    if (
      options.kind === "personal"
        ? team
        : !team && name !== "commands.dispatch" && !Object.hasOwn(handlers, name)
    )
      continue;
    registerHostApiMember(app, authenticator, handlers, name, options);
  }
}

function registerHostApiMember<Name extends keyof typeof hostApi>(
  app: FastifyInstance,
  authenticator: HostAuthenticator,
  handlers: Partial<HostApiHandlers>,
  name: Name,
  options: HostApiRegistrationOptions,
): void {
  const declaration = hostApi[name];
  const binaryRequest = "binaryRequest" in declaration && declaration.binaryRequest === true;
  app.route({
    onRequest: async (request, reply) => {
      try {
        if (options.kind === "team") assertTeamApiVersion(toWebHeaders(request.headers));
        else requireNegotiatedVersion(request);
        await rejectDuplicateCredentialHeaders(request);
      } catch (error) {
        const normalized = normalizeHostError(error);
        return reply
          .status(normalized.status)
          .header("cache-control", "no-store")
          .send({ ok: false, error: normalized.error });
      }
    },
    handler: async (request, reply) => {
      // Authentication and origin refusals are results of the call like any
      // other, so they are raised inside the envelope the client parses rather
      // than escaping to the global handler, which answers in a different shape.
      try {
        if (options.dispatch && (name.startsWith("team.") || name === "commands.dispatch")) {
          const raw =
            declaration.method === "POST"
              ? request.body
              : JSON.parse(
                  z.strictObject({ input: z.string().max(262144) }).parse(request.query).input,
                );
          const data = declaration.success.parse(
            await options.dispatch(name, raw, request),
          ) as z.output<(typeof declaration)["success"]>;
          return sendResult(declaration, { ok: true, data }, request, reply);
        }
        const scope =
          name in hostApiScopes ? hostApiScopes[name as keyof typeof hostApiScopes] : "session";
        const authenticated = await authenticateScope(authenticator, scope, request);
        if (binaryRequest && request.headers["content-type"] !== "application/octet-stream") {
          throw new OpensteerError({
            code: "bad_request",
            message: "Attachment upload requires application/octet-stream",
          });
        }
        const context = createContext(authenticated, request, reply, binaryRequest);
        bindAnonymousClientAddress(context, request);
        const input = rpcInput(declaration, request);
        const handler = handlers[name];
        if (!handler)
          throw new OpensteerError({
            code: "not_found",
            message: "Procedure unavailable on this Host",
          });
        const output = await handler(input, context);
        return sendResult(declaration, output, request, reply);
      } catch (error) {
        const normalized = normalizeHostError(error);
        if (normalized.status >= 500) request.log.error({ err: error }, "rpc failed");
        else if (normalized.error.reason)
          // Reasons are stable codes; messages and payloads can carry addresses.
          request.log.info(
            {
              rpc: name,
              code: normalized.error.code,
              reason: normalized.error.reason,
              cause: refusalCause(error),
            },
            "rpc refused",
          );
        return reply
          .status(normalized.status)
          .header("cache-control", "no-store")
          .send({
            error: HostApiErrorSchema.parse(normalized.error),
            ok: false,
          });
      }
    },
    method: declaration.method,
    ...(declaration.method === "POST"
      ? { bodyLimit: binaryRequest ? attachmentMaxBytes : 1 * 1_024 * 1_024 }
      : {}),
    url: `/v1/rpc/${name}`,
  });
}

function refusalCause(error: unknown): string | undefined {
  const cause = error instanceof Error ? error.cause : undefined;
  return cause instanceof OpensteerError ? cause.reason : undefined;
}

function rpcInput<Declaration extends RpcDeclaration>(
  declaration: Declaration,
  request: FastifyRequest,
): z.output<Declaration["payload"]> {
  if (declaration.method === "POST" && !declaration.binaryRequest) {
    return declaration.payload.parse(request.body) as z.output<Declaration["payload"]>;
  }
  const query = z.strictObject({ input: z.string().max(262_144) }).parse(request.query);
  return declaration.payload.parse(JSON.parse(query.input)) as z.output<Declaration["payload"]>;
}

function sendResult<Declaration extends RpcDeclaration>(
  declaration: Declaration,
  output: RpcResult<z.output<Declaration["success"]>, z.output<Declaration["error"]>>,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (!output.ok) {
    const error = HostApiErrorSchema.parse(output.error);
    return reply
      .status(errorStatus(error))
      .header("cache-control", "no-store")
      .send({ error, ok: false });
  }
  if (declaration.stream) {
    const stream = z
      .strictObject({
        bytes: z.instanceof(Uint8Array),
        metadata: z.record(z.string(), z.unknown()),
      })
      .parse(output.data);
    const metadata = stream.metadata;
    if (typeof metadata.contentType === "string") void reply.type(metadata.contentType);
    if (typeof metadata.etag === "string") void reply.header("etag", metadata.etag);
    if (typeof metadata.modifiedAt === "string") {
      void reply.header("last-modified", new Date(metadata.modifiedAt).toUTCString());
    }
    void reply
      .header("content-disposition", "attachment")
      .header("content-security-policy", "default-src 'none'; sandbox")
      .header("x-content-type-options", "nosniff")
      .header("x-opensteer-file-size", String(metadata.sizeBytes))
      .header("x-opensteer-file-truncated", String(metadata.truncated));
    applyCachePolicy(reply);
    if (isUnchanged(request, reply)) return reply.status(304).send();
    return reply.send(Buffer.from(stream.bytes));
  }
  applyCachePolicy(reply);
  if (isUnchanged(request, reply)) return reply.status(304).send();
  return reply.send(output);
}

/**
 * Every rpc reply carries one person's data through whatever proxy fronts this
 * Deployment, so nothing may be stored unless the handler issued a validator —
 * which is precisely the statement that revalidating is worthwhile.
 */
function applyCachePolicy(reply: FastifyReply): void {
  void reply.header("cache-control", reply.hasHeader("etag") ? "private, no-cache" : "no-store");
}

/** A validator is only worth issuing if the Host honours it on the way back in. */
function isUnchanged(request: FastifyRequest, reply: FastifyReply): boolean {
  const etag = reply.getHeader("etag");
  return typeof etag === "string" && request.headers["if-none-match"] === etag;
}

/**
 * The epoch gate, run before anything else this route does.
 *
 * It precedes authentication, the origin comparison and the payload parse on
 * purpose: a caller on another epoch may be sending a payload whose fields no
 * longer mean what this tree thinks they mean, so no part of it is dispatched.
 * A missing header is the same refusal as a wrong one — every client that
 * reaches this Host ships the header, because the Host serves its own web
 * bundle and the Desktop ships with the Host.
 */
export function requireNegotiatedVersion(
  request: FastifyRequest,
  kind: DeploymentKind = "personal",
): void {
  if (statesApiVersion(request.headers, kind)) return;
  const stated = request.headers[apiVersionHeader(kind)];
  throw new OpensteerError({
    code: "bad_request",
    message:
      typeof stated === "string"
        ? `This deployment speaks Opensteer protocol ${apiNegotiation(kind).apiVersion}; the caller stated ${stated}.`
        : `This deployment speaks Opensteer protocol ${apiNegotiation(kind).apiVersion} and the caller stated none.`,
    reason: unsupportedVersionReason,
  });
}

async function authenticateScope(
  authenticator: HostAuthenticator,
  scope: HostApiScope,
  request: FastifyRequest,
): Promise<AuthenticatedHostSession | null> {
  if (scope === "exact-origin") authenticator.requireExactOrigin(request.headers);
  if (scope === "session") {
    return authenticator.authenticateSessionContext(request.headers);
  }
  if (scope === "mutation") {
    return authenticator.authenticateSessionContext(request.headers, { mutation: true });
  }
  return null;
}

function createContext(
  authenticated: AuthenticatedHostSession | null,
  request: FastifyRequest,
  reply: FastifyReply,
  binaryRequest: boolean,
): HostApiServerContext {
  const binaryBody = binaryRequest ? z.instanceof(Buffer).parse(request.body) : null;
  return {
    ...(binaryBody
      ? {
          binaryBody: (async function* () {
            yield binaryBody;
          })(),
        }
      : {}),
    afterResponse: (effect) => afterResponse(reply, effect),
    headers: request.headers,
    requestId: request.id,
    requestUrl: request.url,
    session: authenticated?.session ?? null,
    setHeader: (name, value) => {
      void reply.header(name, value);
    },
    signal: requestAbortSignal(request.raw, reply.raw),
    surface: authenticated?.surface ?? null,
  };
}

export interface HostApiRegistrationOptions {
  readonly kind: DeploymentKind;
  readonly dispatch?: (
    name: keyof typeof hostApi,
    raw: unknown,
    request: FastifyRequest,
  ) => Promise<unknown>;
}

export function carryWebSocketVersion(request: FastifyRequest, kind: DeploymentKind): void {
  if (request.headers.upgrade?.toLowerCase() !== "websocket") return;
  const versions = new URL(request.url, "http://localhost").searchParams.getAll(
    apiVersionQueryParameter,
  );
  if (!versions.length) return;
  const header = apiVersionHeader(kind),
    held = request.headers[header];
  request.headers[header] =
    versions.length === 1 && (held === undefined || held === versions[0]) ? versions[0] : "invalid";
}

/**
 * Every personal `/v1/` route refuses a caller on another epoch before
 * authentication, unless the route itself is declared `unversionedRoute`.
 * Rpc members run the same check per member.
 */
export function installPersonalVersionGate(app: FastifyInstance): void {
  app.addHook("onRequest", async (request) => {
    carryWebSocketVersion(request, "personal");
    if (!request.url.startsWith("/v1/") || request.url.startsWith("/v1/rpc/")) return;
    if (request.routeOptions.config.apiVersion === unversionedRoute.apiVersion) return;
    requireNegotiatedVersion(request);
  });
}
