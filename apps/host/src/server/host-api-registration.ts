import {
  HostApiErrorSchema,
  hostApi,
  hostApiVersionHeader,
  type HostApiCommand,
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
import { requestAbortSignal } from "./request-abort-signal.js";

const hostApiScopes = {
  "agentPhone.target.get": "session",
  "assignment.get": "session",
  "thread.assignments.list": "session",
  "thread.browserUsage.get": "session",
  "attachment.get": "session",
  "attachment.upload": "mutation",
  "attachment.content": "session",
  "auth.config": "public",
  "auth.invitation.accept": "exact-origin-session",
  "auth.invitation.exchange": "exact-origin",
  "auth.native.complete": "exact-origin",
  "auth.oidc.begin": "exact-origin",
  "auth.password.recover": "exact-origin",
  "auth.password.signIn": "exact-origin",
  "auth.password.signUp": "exact-origin",
  "auth.setup.claim": "exact-origin",
  "auth.setup.exchange": "exact-origin",
  "auth.signOut": "exact-origin-session",
  "bootstrap.get": "session",
  "browser.contextCandidate.get": "session",
  "browser.tabs.get": "session",
  "browser.searchSuggestions.get": "session",
  "workspace.tabs.get": "session",
  "browser.tabIcon.get": "session",
  "browser.sources.get": "session",
  "browser.sources.inspect": "mutation",
  "channel.connection.check": "mutation",
  "channels.get": "session",
  "commands.dispatch": "mutation",
  "integration.computer.apps.approved": "session",
  "computer.app.windows": "mutation",
  "harness.authentication.get": "session",
  "harness.catalog.refresh": "mutation",
  "harness.modelServers.discover": "mutation",
  "voice.start": "mutation",
  "voice.renew": "mutation",
  "voice.say": "mutation",
  "voice.next": "mutation",
  "voice.answer": "mutation",
  "voice.context": "mutation",
  "voice.stop": "mutation",
  "integration.authorization.get": "session",
  "integration.grants.list": "session",
  "integration.platform.get": "session",
  "integration.computer.setup.list": "session",
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
  "thread.events.list": "session",
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

/**
 * Commands that revoke a credential are the ones a hostile page most wants to
 * fire at a signed-in browser, and the mutation scope alone does not stop a
 * bearer-token caller, which skips the origin comparison entirely. These are
 * held to an exact-origin request no matter how the caller authenticated.
 */
// Commands here demand an exact origin for every credential kind — including
// bearer callers, which the mutation scope's cookie-only origin check skips.
// machine.revoke stays out deliberately: native clients revoke machines with
// bearer tokens and no browser origin.
// integration.uninstall belongs here too: it deletes a deployment-wide
// installation and, for a proposed integration, the stored account credentials
// that only its definition could use. Only the browser UI dispatches it.
// channel.connection.status.set revokes the messaging credentials of a whole
// provider workspace, and only the browser UI dispatches it.
// Listing a command costs something: the comparison is against the canonical
// origin, so a Personal remote session — whose origin is its route — is refused
// it, and on a Personal Deployment the command then works only at the computer
// running the Host. Commands that only reduce what agents can reach, and that an
// owner must be able to reach from wherever they are, therefore stay out:
// integration.disconnect (which is also how a computer app is switched off),
// integration.mcp.disconnect, harness.authentication.logout, and
// channel.connection.credentials.replace, which is how an owner repairs a
// connection whose provider credentials stopped working.
const exactOriginCommands: ReadonlySet<string> = new Set([
  "channel.connection.status.set",
  "integration.uninstall",
  "session.revoke",
  "workspace.delete",
] satisfies readonly HostApiCommand["type"][]);

// Every command carries its discriminator; the full payload schema still
// rejects anything malformed once the origin gate has run.
const commandTypeSchema = z.object({ type: z.string() });
// The one field the exception below reads, before the payload schema runs.
const revokedSessionSchema = z.object({ sessionId: z.string().max(256).optional() });

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
        const authenticated = await authenticateScope(authenticator, hostApiScopes[name], request);
        if (binaryRequest && request.headers["content-type"] !== "application/octet-stream") {
          throw new OpensteerError({
            code: "bad_request",
            message: "Attachment upload requires application/octet-stream",
          });
        }
        requireCommandOrigin(authenticator, name, request, authenticated);
        const context = createContext(authenticated, request, reply, binaryRequest);
        const input = rpcInput(declaration, request);
        const output = await handlers[name](input, context);
        return sendResult(declaration, output, request, reply);
      } catch (error) {
        const normalized = normalizeHostError(error);
        if (normalized.status >= 500) request.log.error({ err: error }, "rpc failed");
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

function requireCommandOrigin(
  authenticator: HostAuthenticator,
  name: keyof typeof hostApi,
  request: FastifyRequest,
  authenticated: AuthenticatedHostSession | null,
): void {
  if (name !== "commands.dispatch") return;
  const { type } = commandTypeSchema.parse(request.body);
  if (!exactOriginCommands.has(type)) return;
  if (type === "session.revoke" && endsItsOwnHeaderSession(authenticated, request.body)) return;
  authenticator.requireExactOrigin(request.headers);
}

/**
 * The one exception to the exact-origin gate, and the narrowest one that lets a
 * phone sign out at all.
 *
 * A native client has no browser origin to send — there is no page — so holding
 * `session.revoke` to one would make "sign out of this deployment" impossible
 * from anywhere but the owner's browser, and a phone would be left dropping its
 * copy of a credential the Host still honours. A caller presenting a *header*
 * credential is therefore allowed to end the session that credential is, and
 * nothing else: ending another session still needs the owner's browser, and a
 * cookie caller — the one a hostile page can make requests as — is never
 * excused, because that is the whole reason the gate exists.
 */
function endsItsOwnHeaderSession(
  authenticated: AuthenticatedHostSession | null,
  body: unknown,
): boolean {
  if (
    authenticated === null ||
    (authenticated.credentialKind !== "native-oauth" &&
      authenticated.credentialKind !== "personal-remote-header")
  ) {
    return false;
  }
  const revoked = revokedSessionSchema.safeParse(body);
  return revoked.success && revoked.data.sessionId === authenticated.session.id;
}

/**
 * Authenticates the caller for one scope. It runs before the command origin
 * gate because that gate now has a question only an authenticated caller can
 * answer, and authenticating changes nothing: a request refused afterwards has
 * had nothing dispatched on its behalf.
 */
async function authenticateScope(
  authenticator: HostAuthenticator,
  scope: HostApiScope,
  request: FastifyRequest,
): Promise<AuthenticatedHostSession | null> {
  if (scope.startsWith("exact-origin")) authenticator.requireExactOrigin(request.headers);
  if (scope === "session" || scope === "exact-origin-session") {
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
