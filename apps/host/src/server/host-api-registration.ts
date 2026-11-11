import { bindAnonymousClientAddress } from "../identity/anonymous-client-address.js";
import {
  HostApiErrorSchema,
  hostApi,
  hostApiVersionHeader,
  type HostApiHandlers,
  type HostApiScope,
  type HostApiServerContext,
  type RpcDeclaration,
  type RpcResult,
} from "@opensteer/protocol";
import { OpensteerError, unsupportedVersionReason } from "@opensteer/core";
import { attachmentMaxBytes } from "@opensteer/core";
import { hostApiVersion } from "@opensteer/deployment-authority";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AuthenticatedHostSession, HostAuthenticator } from "../identity/auth.js";
import { errorStatus, normalizeHostError } from "./http-errors.js";
import { afterResponse } from "./after-response.js";
import { requestAbortSignal } from "./request-abort-signal.js";

const hostApiScopes = {
  "automaticModels.get": "session",
  "plugins.overview.get": "session",
  "plugins.detail.get": "session",
  "plugins.directory.get": "session",
  "devices.overview.get": "session",
  "apps.get": "session",
  "apps.view": "mutation",
  "agentPhone.target.get": "session",
  "assignment.get": "session",
  "thread.assignments.list": "session",
  "thread.browserUsage.get": "session",
  "attachment.get": "session",
  "attachment.upload": "mutation",
  "attachment.content": "session",
  "auth.config": "public",
  "team.summary.get": "session",
  "team.invitations.list": "session",
  "team.people.list": "session",
  "team.member.get": "session",
  "team.directory.search": "session",
  "team.groups.list": "session",
  "team.group.get": "session",
  "team.project.access.get": "session",
  "team.access.explain": "session",
  "team.access.preview": "session",
  "team.member.preview": "session",
  "team.audit.list": "session",
  "team.project.settings.get": "session",
  "team.project.runtimeChoices": "session",
  "team.invitation.preview": "public",
  "team.invitation.exchange": "exact-origin",
  "team.invitation.accept": "mutation",
  "auth.invitation.accept": "mutation",
  "auth.invitation.exchange": "exact-origin",
  "auth.native.complete": "exact-origin",
  "auth.oidc.begin": "exact-origin",
  "auth.password.recover": "exact-origin",
  "auth.password.signIn": "exact-origin",
  "auth.password.signUp": "exact-origin",
  "auth.setup.claim": "exact-origin",
  "auth.setup.exchange": "exact-origin",
  "auth.signOut": "mutation",
  "bootstrap.get": "session",
  "browser.contextCandidate.get": "session",
  "browser.tabs.get": "session",
  "browser.searchSuggestions.get": "session",
  "workspace.tabs.get": "session",
  "browser.tabIcon.get": "session",
  "browser.history.get": "session",
  "browser.history.icons.get": "session",
  "browser.sources.get": "session",
  "browser.password-sign-in.get": "mutation",
  "browser.sources.inspect": "mutation",
  "channel.connection.check": "mutation",
  "channels.get": "session",
  "commands.dispatch": "mutation",
  "integration.computer.apps.approved": "session",
  "computer.app.windows": "mutation",
  "harness.authentication.get": "session",
  "harness.catalog.refresh": "mutation",
  "harness.modelServers.discover": "mutation",
  "voice.open": "mutation",
  "voice.start": "mutation",
  "voice.renew": "mutation",
  "voice.say": "mutation",
  "voice.context": "mutation",
  "voice.stop": "mutation",
  "integration.authorization.get": "session",
  "integration.grants.list": "session",
  "plugin.list": "session",
  "specialist.list": "session",
  "integration.platform.get": "session",
  "integration.computer.setup.list": "session",
  "integration.server.secrets.list": "session",
  "integration.computer.setup.review": "mutation",
  "integration.computer.policy.get": "session",
  // It reaches out to a live computer, so it is a mutation's scope rather than
  // a plain session read even though it changes nothing here.
  "integration.computer.apps.installed": "mutation",
  "integration.computer.session.stop": "mutation",
  "integrations.get": "session",
  "integration.repositoryAccess.check": "mutation",
  "machine.access.history": "session",
  "machines.list": "session",
  "requests.list": "session",
  "run.attempts.list": "session",
  "tasks.list": "session",
  "sessions.list": "session",
  "connections.list": "session",
  "connections.authorization.get": "session",
  "personal.remoteAccess.get": "session",
  "thread.events.list": "session",
  "node.events.list": "session",
  "tool.output.get": "session",
  "thread.messages.list": "session",
  "thread.readState.get": "session",
  "thread.inputQueue.get": "session",
  "thread.live.get": "session",
  "thread.requests.list": "session",
  "triggers.get": "session",
  "triggers.list": "session",
  "workspace.catalog.list": "session",
  "workspace.files.list": "session",
  "workspace.files.preview": "session",
  "workspace.invitations.list": "session",
  "workspace.members.list": "session",
  "workspace.prefetch": "mutation",
} satisfies Record<keyof typeof hostApi, HostApiScope>;

export function registerHostApi(
  app: FastifyInstance,
  authenticator: HostAuthenticator,
  handlers: HostApiHandlers,
): void {
  for (const name of Object.keys(hostApi) as (keyof typeof hostApi)[]) {
    registerHostApiMember(app, authenticator, handlers, name);
  }
}

function registerHostApiMember<Name extends keyof typeof hostApi>(
  app: FastifyInstance,
  authenticator: HostAuthenticator,
  handlers: HostApiHandlers,
  name: Name,
): void {
  const declaration = hostApi[name];
  const binaryRequest = "binaryRequest" in declaration && declaration.binaryRequest === true;
  app.route({
    handler: async (request, reply) => {
      // Authentication and origin refusals are results of the call like any
      // other, so they are raised inside the envelope the client parses rather
      // than escaping to the global handler, which answers in a different shape.
      try {
        requireNegotiatedVersion(request);
        let authenticated =
          name === "team.invitation.accept"
            ? await authenticator.authenticateTeamInvitationSessionContext(request.headers)
            : await authenticateScope(authenticator, hostApiScopes[name], request);
        if (
          (name === "team.invitation.preview" || name === "team.invitation.exchange") &&
          request.headers.authorization !== undefined
        ) {
          authenticated = await authenticator.authenticateSessionContext(request.headers);
        }
        if (binaryRequest && request.headers["content-type"] !== "application/octet-stream") {
          throw new OpensteerError({
            code: "bad_request",
            message: "Attachment upload requires application/octet-stream",
          });
        }
        const context = createContext(authenticated, request, reply, binaryRequest);
        bindAnonymousClientAddress(context, request);
        const input = rpcInput(declaration, request);
        const output = await handlers[name](input, context);
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
function requireNegotiatedVersion(request: FastifyRequest): void {
  const stated = request.headers[hostApiVersionHeader];
  if (stated === String(hostApiVersion)) return;
  throw new OpensteerError({
    code: "bad_request",
    message:
      typeof stated === "string"
        ? `This deployment speaks Opensteer protocol ${hostApiVersion}; the caller stated ${stated}.`
        : `This deployment speaks Opensteer protocol ${hostApiVersion} and the caller stated none.`,
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
