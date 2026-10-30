import {
  integrationAuthorizationBrowserReturn,
  IntegrationAuthorizationAttemptIdSchema,
  IntegrationOAuthAttemptIdSchema,
} from "@opensteer/integration-core";
import type { IntegrationAuthAttemptFailureReason } from "@opensteer/integration-core/ports";
import { oauthAuthorizationResponseState } from "@opensteer/integration-auth";
import { OpensteerError, type DeploymentId } from "@opensteer/core";
import {
  hostApi,
  rpcSuccess,
  type HostApiCommand,
  type HostApiCommandOutput,
  type HostApiHandlers,
  type HostApiServerContext,
} from "@opensteer/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { HostAuthenticator } from "../identity/auth.js";
import {
  integrationAuthAttemptLifetimeMilliseconds,
  type IntegrationAuthAttemptLifecycle,
} from "./integration-auth-attempt-service.js";
import type { IntegrationService } from "./integration-service.js";

const AttemptParamsSchema = z.strictObject({
  attemptId: IntegrationAuthorizationAttemptIdSchema,
});
const LaunchQuerySchema = z.strictObject({
  ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
});

export interface IntegrationAuthorizationRpcOptions {
  readonly attempts: IntegrationAuthAttemptLifecycle;
  readonly authenticator: HostAuthenticator;
  readonly deploymentId: DeploymentId;
  readonly integrations?: IntegrationService;
}

export function createIntegrationAuthorizationRpcHandlers(
  options: IntegrationAuthorizationRpcOptions,
): Pick<HostApiHandlers, "integration.authorization.get"> {
  return {
    "integration.authorization.get": async ({ attemptId }, context) => {
      const ownerUserId = requireOwner(context);
      const status =
        options.integrations && IntegrationOAuthAttemptIdSchema.safeParse(attemptId).success
          ? await options.integrations.authorizationStatus({
              attemptId: IntegrationOAuthAttemptIdSchema.parse(attemptId),
              ownerUserId,
            })
          : await options.attempts.status({ id: attemptId, ownerUserId });
      if (!status) throw unavailableAttempt();
      return rpcSuccess(
        hostApi["integration.authorization.get"].success.parse({
          connectionId: "connectionId" in status ? status.connectionId : null,
          expiresAt: status.expiresAt.toISOString(),
          failureCode: "failureCode" in status ? status.failureCode : null,
          status: status.status,
        }),
      );
    },
  };
}

export type IntegrationAuthorizationCommand = Extract<
  HostApiCommand,
  { readonly type: "integration.authorization.cancel" }
>;

export async function handleIntegrationAuthorizationCommand(
  options: IntegrationAuthorizationRpcOptions,
  command: IntegrationAuthorizationCommand,
  context: HostApiServerContext,
): Promise<HostApiCommandOutput> {
  const ownerUserId = requireOwner(context);
  await options.attempts.cancel({ id: command.attemptId, ownerUserId });
  const status = await options.attempts.status({ id: command.attemptId, ownerUserId });
  if (!status) throw unavailableAttempt();
  return {
    connectionId: status.connectionId,
    expiresAt: status.expiresAt.toISOString(),
    failureCode: null,
    status: status.status,
    type: command.type,
  };
}

export function registerIntegrationAuthorizationRoutes(
  app: FastifyInstance,
  options: IntegrationAuthorizationRpcOptions,
): void {
  app.get<{ Params: { attemptId: string } }>(
    "/v1/integration-authorizations/:attemptId/launch",
    // Any origin that reaches the Host may launch: the ticket is the authority. A
    // sign-in returning to this Host's own callback needs the binding cookie set
    // here on that callback's origin, and begin refuses one from a remote session.
    async (request, reply) => {
      const { attemptId } = AttemptParamsSchema.parse(request.params);
      const { ticket } = LaunchQuerySchema.parse(request.query);
      const launched = await options.attempts.launch({ id: attemptId, launchTicket: ticket });
      if (!launched) throw unavailableAttempt();
      return reply
        .header("cache-control", "no-store")
        .header("pragma", "no-cache")
        .header("referrer-policy", "no-referrer")
        .header(
          "set-cookie",
          authorizationBindingCookie(
            attemptId,
            launched.browserBinding,
            new URL(options.authenticator.publicOrigin).protocol === "https:",
          ),
        )
        .code(303)
        .redirect(launched.authorizationUrl);
    },
  );
}

interface OAuthCallbackOutcome {
  readonly failureReason?: IntegrationAuthAttemptFailureReason;
  readonly returnPath: string;
  readonly status: "completed" | "denied" | "failed";
  readonly surface: "desktop" | "native" | "web";
}

/**
 * Registers one provider or MCP OAuth callback. The step order is security-bearing: read the opaque
 * state, identify the attempt, require the launch cookie, then claim the attempt (which spends the
 * state exactly once) before any response validation or token exchange runs.
 */
export function registerOAuthCallbackRoute<Id, Prepared>(
  app: FastifyInstance,
  options: {
    readonly attemptIdSchema: z.ZodType<Id, unknown>;
    readonly authenticator: HostAuthenticator;
    readonly deploymentId?: DeploymentId;
    readonly handle: (input: {
      readonly attemptId: Id;
      readonly browserBinding: string;
      readonly parameters: URLSearchParams;
      readonly prepared: Prepared;
      readonly state: string;
    }) => Promise<OAuthCallbackOutcome>;
    readonly identify: (state: string) => Promise<unknown>;
    readonly kind: "mcp" | "provider";
    readonly path: string;
    readonly prepare: (request: FastifyRequest) => Prepared;
  },
): void {
  const label = options.kind === "mcp" ? "MCP" : "Integration";
  app.get(options.path, async (request, reply) => {
    options.authenticator.requireCanonicalSurface(request.headers);
    const prepared = options.prepare(request);
    const parameters = new URL(request.url, "https://opensteer.invalid").searchParams;
    let state: string;
    try {
      state = oauthAuthorizationResponseState(parameters);
    } catch {
      return failIntegrationAuthorizationBrowser(reply);
    }
    const parsedId = options.attemptIdSchema.safeParse(await options.identify(state));
    if (!parsedId.success) return failIntegrationAuthorizationBrowser(reply);
    const attemptId = parsedId.data;
    const browserBinding = readIntegrationAuthorizationBinding(
      request.headers.cookie,
      String(attemptId),
    );
    if (!browserBinding) return failIntegrationAuthorizationBrowser(reply);
    try {
      const result = await options.handle({
        attemptId,
        browserBinding,
        parameters,
        prepared,
        state,
      });
      if (result.status === "failed") {
        request.log.warn(
          { attemptId, failureReason: result.failureReason ?? "exchange-failed" },
          `${label} authorization callback failed`,
        );
      }
      return finishIntegrationAuthorizationBrowser(reply, {
        attemptId: String(attemptId),
        ...(options.deploymentId ? { deploymentId: options.deploymentId } : {}),
        publicOrigin: options.authenticator.publicOrigin,
        ...(result.failureReason ? { failureReason: result.failureReason } : {}),
        returnPath: result.returnPath,
        status: result.status,
        surface: result.surface,
      });
    } catch (error) {
      request.log.warn({ attemptId, err: error }, `${label} authorization callback failed`);
      clearIntegrationAuthorizationBinding(
        reply,
        String(attemptId),
        options.authenticator.publicOrigin,
      );
      return failIntegrationAuthorizationBrowser(reply);
    }
  });
}

export function readIntegrationAuthorizationBinding(
  cookieHeader: string | readonly string[] | undefined,
  attemptId: string,
): string | null {
  const header = typeof cookieHeader === "string" ? cookieHeader : cookieHeader?.[0];
  if (!header) return null;
  const name = authorizationBindingCookieName(attemptId);
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0 || pair.slice(0, separator).trim() !== name) continue;
    const value = pair.slice(separator + 1).trim();
    return /^[A-Za-z0-9_-]{43}$/u.test(value) ? value : null;
  }
  return null;
}

export function clearIntegrationAuthorizationBinding(
  reply: FastifyReply,
  attemptId: string,
  publicOrigin: string,
): FastifyReply {
  return reply.header(
    "set-cookie",
    `${authorizationBindingCookieName(attemptId)}=; Path=/v1; Max-Age=0; HttpOnly; SameSite=Lax${new URL(publicOrigin).protocol === "https:" ? "; Secure" : ""}`,
  );
}

export function finishIntegrationAuthorizationBrowser(
  reply: FastifyReply,
  input: {
    readonly attemptId: string;
    readonly failureReason?: IntegrationAuthAttemptFailureReason;
    readonly deploymentId?: DeploymentId;
    readonly publicOrigin: string;
    readonly returnPath: string;
    readonly status: "completed" | "denied" | "failed";
    readonly surface: "desktop" | "native" | "web";
  },
) {
  clearIntegrationAuthorizationBinding(reply, input.attemptId, input.publicOrigin);
  const destination = integrationAuthorizationBrowserReturn({
    attemptId: input.attemptId,
    canonicalOrigin: input.publicOrigin,
    ...(input.deploymentId ? { deploymentId: input.deploymentId } : {}),
    returnPath: input.returnPath,
    surface: input.surface,
  });
  if (destination.kind === "redirect") {
    return reply
      .code(303)
      .header("cache-control", "no-store")
      .header("referrer-policy", "no-referrer")
      .redirect(destination.location);
  }
  const completed = input.status === "completed";
  return reply
    .code(completed ? 200 : 400)
    .header("cache-control", "no-store")
    .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'")
    .header("content-type", "text/html; charset=utf-8")
    .header("referrer-policy", "no-referrer")
    .header("x-content-type-options", "nosniff")
    .send(
      resultPage(
        completed,
        input.failureReason === "provider-identity-already-connected" ? input.failureReason : null,
      ),
    );
}

export function failIntegrationAuthorizationBrowser(
  reply: FastifyReply,
  failureCode: "provider-identity-already-connected" | null = null,
) {
  return reply
    .code(400)
    .header("cache-control", "no-store")
    .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'")
    .header("content-type", "text/html; charset=utf-8")
    .header("referrer-policy", "no-referrer")
    .header("x-content-type-options", "nosniff")
    .send(resultPage(false, failureCode));
}

function authorizationBindingCookie(
  attemptId: string,
  browserBinding: string,
  secure: boolean,
): string {
  const maxAge = Math.ceil(integrationAuthAttemptLifetimeMilliseconds / 1_000);
  return `${authorizationBindingCookieName(attemptId)}=${browserBinding}; Path=/v1; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function authorizationBindingCookieName(attemptId: string): string {
  return `opensteer_integration_authorization_${attemptId.replaceAll("-", "_")}`;
}

function resultPage(
  completed: boolean,
  failureCode: "provider-identity-already-connected" | null = null,
): string {
  const title = completed ? "Connection complete" : "Connection not completed";
  const detail = completed
    ? "Return to Opensteer. You can close this tab."
    : failureCode === "provider-identity-already-connected"
      ? "This account is already connected by another user. Ask them to disconnect it, or return to Opensteer and connect with your own provider app."
      : "Return to Opensteer for details or to try again. You can close this tab.";
  const mark = completed
    ? '<path d="M7 12.5l3.2 3.2L17 9" stroke="#71c6a5"/>'
    : '<path d="M12 7.5v5.5M12 16.5v.01" stroke="#dfb36b"/>';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>html{color-scheme:dark;background:#080808;color:#f5f4f2;font:15px/1.5 system-ui,sans-serif}main{max-width:22rem;margin:22vh auto 0;padding:0 1.5rem;text-align:center}svg{width:44px;height:44px;margin-bottom:1rem}h1{font-size:1.35rem;font-weight:600;margin:0 0 .4rem}p{color:#8e8a86;margin:0}</style></head><body><main><svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10.5" stroke="#2a2a2a"/>${mark}</svg><h1>${title}</h1><p>${detail}</p></main></body></html>`;
}

function requireOwner(context: HostApiServerContext) {
  if (!context.session) {
    throw new OpensteerError({ code: "unauthorized", message: "Authentication required" });
  }
  return context.session.user.id;
}

function unavailableAttempt(): OpensteerError {
  return new OpensteerError({
    code: "not_found",
    message: "Integration authorization is invalid, expired, or already used",
  });
}
