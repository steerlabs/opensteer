import { rejectDuplicateCredentialHeaders } from "../identity/request-credential-headers.js";
import { bindAnonymousClientAddress } from "../identity/anonymous-client-address.js";
import {
  HostApiErrorSchema,
  expectedMutationSessionHeader,
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
  apiCurrentQueryParameter,
  apiVersionQueryParameter,
  hostApiCurrentHeader,
  hostApiVersion,
  hostApiVersionHeader,
  minimumHostApiVersion,
  negotiatedHostApiVersion,
} from "@opensteer/deployment-authority";
import { unversionedRoute } from "./unversioned-route.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AuthenticatedHostSession, HostAuthenticator } from "../identity/auth.js";
import { errorStatus, normalizeHostError } from "./http-errors.js";
import { afterResponse } from "./after-response.js";
import { requestAbortSignal } from "./request-abort-signal.js";

export const hostApiScopes = {
  "personal.shell.get": "session",
  "personal.readiness.get": "session",
  "tasks.page": "session",
  "thread.snapshot.get": "session",
  "thread.items.page": "session",
  "node.items.page": "session",
  "thread.overlays.page": "session",
  "transcript.item.get": "session",
  "resources.detail.get": "session",
  "attention.get": "session",
  "needsYou.get": "session",
  "browser.searchSuggestions.get": "session",
  "browser.contextCandidate.get": "session",
  "browser.tabIcon.get": "session",
  "browser.history.get": "session",
  "browser.history.icons.get": "session",
  "agentPhone.target.get": "session",
  "tabs.get": "session",
  "tabs.state": "session",
  "apps.list": "session",
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
  "channel.connection.check": "mutation",
  "channels.get": "session",
  "connections.list": "session",
  "connections.authorization.get": "session",
  "connections.activity": "session",
  "threads.activity": "session",
  "personal.remoteAccess.get": "session",
  "personal.accountLink.get": "session",
  "plugins.overview.get": "session",
  "devices.overview.get": "session",
  "plugins.installed.list": "session",
  "plugins.installed.page": "session",
  "plugins.local.get": "session",
  "plugins.get": "session",
  "plugins.tools.list": "session",
  "plugins.skills.list": "session",
  "plugins.versions.list": "session",
  "plugins.page.view": "session",
  "plugins.catalog.list": "session",
  "plugins.catalog.get": "session",
  "plugins.icons.get": "session",
  "plugins.accounts.list": "session",
  "plugins.account.review": "session",
  "plugins.schedule.runs": "session",
  "plugins.workflow.runs": "session",
  "plugins.webhook.setup.get": "session",
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
  "plugin.authorization.get": "session",
  "plugin.authorization.methods": "session",
  "integration.grants.list": "session",
  "integration.computer.policy.get": "session",
  "integration.computer.setup.review": "mutation",
  "integration.computer.setup.list": "session",
  "integration.server.secrets.list": "session",
  "integration.computer.session.stop": "mutation",
  "computer.app.windows": "mutation",
  "integration.computer.apps.approved": "session",
  "integration.computer.apps.installed": "mutation",
  "integration.platform.get": "session",
  "integrations.get": "session",
  "machines.list": "session",
  "machine.access.history": "session",
  "requests.list": "session",
  "tasks.list": "session",
  "run.attempts.list": "session",
  "sessions.list": "session",
  "asset.urls": "session",
  "file.open": "session",
  "file.content": "session",
  "thread.assignments.list": "session",
  "thread.browserUsage.get": "session",
  "thread.inputQueue.get": "session",
  "thread.message.revisions.list": "session",
  "thread.messages.list": "session",
  "thread.requests.list": "session",
  "references.resolve": "session",
  "triggers.get": "session",
  "triggers.list": "session",
} satisfies Record<keyof typeof hostApi, HostApiScope>;

export function registerHostApi(
  app: FastifyInstance,
  authenticator: HostAuthenticator,
  handlers: Partial<HostApiHandlers>,
  options: HostApiRegistrationOptions = {},
): void {
  for (const name of Object.keys(hostApi) as (keyof typeof hostApi)[])
    registerHostApiMember(app, authenticator, handlers, name, options);
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
  const guards = new WeakMap<
    FastifyRequest,
    NonNullable<ReturnType<NonNullable<HostApiRegistrationOptions["guardResponse"]>>>
  >();
  app.route({
    onSend: (request, reply, payload, done) => {
      const guard = guards.get(request);
      if (reply.statusCode < 400 && guard && !guard.current()) {
        done(new OpensteerError({ code: "forbidden", message: "Content access changed." }));
        return;
      }
      done(null, payload);
    },
    onResponse: async (request) => guards.get(request)?.release(),
    // Every refusal, from the version gate and body parsing through
    // authentication to the handler, is a result of the call in the envelope
    // the client parses, never the root handler's different shape.
    errorHandler: (error, request, reply) => {
      const normalized = normalizeHostError(error);
      if (normalized.status >= 500) request.log.error({ err: error }, "rpc failed");
      else if (name === "commands.dispatch" || normalized.error.reason)
        // Reasons are stable codes; messages and payloads can carry addresses.
        request.log.info(
          {
            rpc: name,
            code: normalized.error.code,
            reason: normalized.error.reason ?? null,
            cause: refusalCause(error),
          },
          "rpc refused",
        );
      void reply
        .status(normalized.status)
        .header("cache-control", "no-store")
        .send({
          error: HostApiErrorSchema.parse(normalized.error),
          ok: false,
        });
    },
    onRequest: async (request) => {
      requireNegotiatedVersion(request);
      await rejectDuplicateCredentialHeaders(request);
    },
    handler: async (request, reply) => {
      const scope =
        name in hostApiScopes ? hostApiScopes[name as keyof typeof hostApiScopes] : "session";
      const authenticated = await authenticateScope(authenticator, scope, request);
      const expected = request.headers[expectedMutationSessionHeader];
      if (
        name === "commands.dispatch" &&
        expected !== undefined &&
        expected !== authenticated?.session.id
      ) {
        throw new OpensteerError({
          code: "forbidden",
          reason: "session-changed",
          message: "This request belongs to another sign-in.",
        });
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
      // Sign-out admits the session before revoking it and returns an empty receipt.
      const guard =
        authenticated &&
        name !== "commands.dispatch" &&
        name !== "auth.signOut" &&
        options.guardResponse?.(input, context);
      if (guard) {
        guards.set(request, guard);
        reply.raw.once("close", guard.release);
      }
      const handler = handlers[name];
      if (!handler)
        throw new OpensteerError({
          code: "not_found",
          message: "Procedure unavailable on this Host",
        });
      await options.admit?.(name, input, context);
      const output = await handler(input, context);
      if (output.ok && guard) await options.revalidateResponse?.(context);
      if (output.ok && options.projectResponse && !declaration.stream) {
        return sendResult(
          declaration,
          { ok: true, data: await options.projectResponse(name, output.data, context) },
          request,
          reply,
        );
      }
      return sendResult(declaration, output, request, reply);
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
  const raw: unknown =
    declaration.method === "POST" && !declaration.binaryRequest
      ? request.body
      : JSON.parse(z.strictObject({ input: z.string().max(262_144) }).parse(request.query).input);
  return declaration.payload.parse(raw) as z.output<Declaration["payload"]>;
}

function sendResult<Declaration extends RpcDeclaration>(
  declaration: Declaration,
  output: RpcResult<unknown, z.output<Declaration["error"]>>,
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
 * The version gate, run before anything else this route does.
 *
 * It precedes authentication, the origin comparison and the payload parse on
 * purpose: a caller outside this Host's window may be sending a payload whose
 * fields no longer mean what this tree thinks they mean, so no part of it is
 * dispatched. A missing version is refused like one outside the window.
 */
export function requireNegotiatedVersion(request: FastifyRequest): void {
  if (negotiatedHostApiVersion(request.headers) !== null) return;
  const stated = request.headers[hostApiVersionHeader];
  const current = request.headers[hostApiCurrentHeader];
  const serves = `Opensteer protocol ${minimumHostApiVersion} through ${hostApiVersion}`;
  const detail =
    typeof stated === "string"
      ? `This deployment serves ${serves}; the caller stated ${stated}${typeof current === "string" ? ` through ${current}` : ""}.`
      : `This deployment serves ${serves} and the caller stated none.`;
  throw new OpensteerError({
    code: "bad_request",
    message: `Update Opensteer to connect to this Host. ${detail}`,
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

/** A Host API call's context: the same for a route that sends the person's command to the door. */
export function createContext(
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
  readonly guardResponse?: (
    input: unknown,
    context: HostApiServerContext,
  ) => { current(): boolean; release(): void };
  readonly revalidateResponse?: (context: HostApiServerContext) => Promise<void>;
  readonly admit?: (
    name: keyof typeof hostApi,
    input: unknown,
    context: HostApiServerContext,
  ) => Promise<void>;
  readonly projectResponse?: (
    name: keyof typeof hostApi,
    data: unknown,
    context: HostApiServerContext,
  ) => Promise<unknown>;
}

export function carryWebSocketVersion(request: FastifyRequest): void {
  if (request.headers.upgrade?.toLowerCase() !== "websocket") return;
  const query = new URL(request.url, "http://localhost").searchParams;
  const carry = (parameter: string, header: string) => {
    const versions = query.getAll(parameter);
    if (!versions.length) return;
    const held = request.headers[header];
    request.headers[header] =
      versions.length === 1 && (held === undefined || held === versions[0])
        ? versions[0]
        : "invalid";
  };
  carry(apiVersionQueryParameter, hostApiVersionHeader);
  carry(apiCurrentQueryParameter, hostApiCurrentHeader);
}

/**
 * Every personal `/v1/` route refuses a caller on another epoch before
 * authentication, unless the route itself is declared `unversionedRoute`.
 * Rpc members run the same check per member.
 */
export function installPersonalVersionGate(app: FastifyInstance): void {
  app.addHook("onRequest", async (request) => {
    carryWebSocketVersion(request);
    if (!request.url.startsWith("/v1/") || request.url.startsWith("/v1/rpc/")) return;
    const exemption = request.routeOptions.config.apiVersion;
    if (
      exemption === unversionedRoute.apiVersion ||
      (typeof exemption === "function" && exemption(request))
    )
      return;
    requireNegotiatedVersion(request);
  });
}
