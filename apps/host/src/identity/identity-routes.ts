import { OpensteerError } from "@opensteer/core";
import type { TokenFreeAuthResponse } from "@opensteer/identity";
import {
  hostApi,
  rpcSuccess,
  type HostApiHandlers,
  type HostApiServerContext,
} from "@opensteer/protocol";
import {
  CompleteHostAccountAdoptionRequestSchema,
  CompleteHostAccountAdoptionResponseSchema,
  ConsumeHostAccountAdoptionProofRequestSchema,
  ConsumeHostAccountAdoptionProofResponseSchema,
  HostAccountAdoptionProofIdSchema,
  IssueHostAccountAdoptionProofRequestSchema,
  IssueHostAccountAdoptionProofResponseSchema,
} from "@opensteer/control-plane-protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { HostAuthenticator } from "./auth.js";

const maximumNativeEndSessionBodyBytes = 24 * 1_024;

export type IdentityRpcHandlers = Pick<
  HostApiHandlers,
  | "auth.config"
  | "auth.invitation.accept"
  | "auth.invitation.exchange"
  | "auth.native.complete"
  | "auth.oidc.begin"
  | "auth.password.recover"
  | "auth.password.signIn"
  | "auth.password.signUp"
  | "auth.setup.claim"
  | "auth.setup.exchange"
  | "auth.signOut"
  | "sessions.list"
>;

export function createIdentityRpcHandlers(
  authenticator: HostAuthenticator,
  options: { readonly workspaceSharingAvailable?: boolean | undefined } = {},
): IdentityRpcHandlers {
  const identity = authenticator.identity;
  return {
    "auth.config": async () =>
      rpcSuccess(hostApi["auth.config"].success.parse(await identity.configuration())),
    "auth.invitation.accept": async (_input, context) => {
      requireWorkspaceSharing(options.workspaceSharingAvailable);
      const result = await identity.acceptInvitation(contextHeaders(context));
      applyResponseHeaders(context, result.headers);
      return rpcSuccess(
        hostApi["auth.invitation.accept"].success.parse({
          membership: {
            generation: result.membership.generation,
            id: result.membership.id,
            invitedBy: result.membership.invitedBy,
            joinedAt: result.membership.joinedAt.toISOString(),
            role: result.membership.role,
            state: result.membership.state,
            userId: result.membership.userId,
            workspaceId: result.membership.workspaceId,
          },
        }),
      );
    },
    "auth.invitation.exchange": async (input, context) => {
      requireWorkspaceSharing(options.workspaceSharingAvailable);
      return authSuccess(
        context,
        await identity.exchangeInvitation(input.selector, input.verifier, contextHeaders(context)),
      );
    },
    "auth.native.complete": async (input, context) => {
      const response = await identity.handleNativeOAuthRequest(
        new globalThis.Request(
          new URL("/v1/auth/native/oauth2/consent", authenticator.publicOrigin),
          {
            body: JSON.stringify({ accept: input.accept, oauth_query: input.oauthQuery }),
            headers: new Headers({
              ...Object.fromEntries(contextHeaders(context)),
              "content-type": "application/json",
            }),
            method: "POST",
          },
        ),
      );
      applyResponseHeaders(context, response.headers);
      const body: unknown = await response.json();
      // The consent endpoint refuses for reasons only it knows — an expired
      // consent code, a request that was never pending — and the person acting
      // on the screen needs that reason, not a generic rejection.
      if (!response.ok) throw nativeConsentRefusal(response.status, body);
      const { url } = z.object({ url: z.url() }).parse(body);
      return rpcSuccess({ url });
    },
    "auth.oidc.begin": async (input, context) =>
      authSuccess(
        context,
        await identity.beginOidcSignIn({
          headers: contextHeaders(context),
          ...(input.oauthQuery ? { oauthQuery: input.oauthQuery } : {}),
          providerId: input.providerId,
          returnPath: input.returnPath,
        }),
      ),
    "auth.password.recover": async (input) => {
      await identity.resetPasswordWithOperatorRecovery(input.token, input.newPassword);
      return rpcSuccess({});
    },
    "auth.password.signIn": async (input, context) =>
      authSuccess(
        context,
        await identity.signInPassword(input, contextHeaders(context), input.oauthQuery),
      ),
    "auth.password.signUp": async (input, context) =>
      authSuccess(context, await identity.signUpPassword(input, contextHeaders(context))),
    "auth.setup.claim": async (input, context) =>
      authSuccess(
        context,
        input.kind === "password"
          ? await identity.claimInitialOwner(input, contextHeaders(context))
          : await identity.claimLocalMachineOwner(input.token, contextHeaders(context)),
      ),
    "auth.setup.exchange": async (input, context) => {
      await authSuccess(
        context,
        await identity.exchangeInitialOwnerEnrollment(input.token, contextHeaders(context)),
      );
      return rpcSuccess({});
    },
    "auth.signOut": async (_input, context) => {
      await authSuccess(context, await identity.signOut(contextHeaders(context)));
      return rpcSuccess({});
    },
    "sessions.list": async (_input, context) =>
      rpcSuccess(
        hostApi["sessions.list"].success.parse({
          sessions: await identity.listSessions(requireRpcSession(context)),
        }),
      ),
  };
}

export function registerIdentityRoutes(
  app: FastifyInstance,
  authenticator: HostAuthenticator,
  options: {
    readonly acknowledgeAccountAdoption?: ((proofId: string) => Promise<void>) | undefined;
    readonly workspaceSharingAvailable?: boolean | undefined;
  } = {},
): void {
  const identity = authenticator.identity;

  app.get("/v1/auth/session", async (request) => ({
    session: await authenticator.authenticateSession(request.headers),
  }));

  app.post("/v1/auth/account-adoption/proofs", async (request, reply) => {
    authenticator.requireExactOrigin(request.headers);
    const session = await authenticator.authenticateSession(request.headers, { mutation: true });
    requireInstanceAdministrator(session);
    const body = IssueHostAccountAdoptionProofRequestSchema.parse(request.body);
    const proof = await identity.issueAccountAdoptionProof(session, body.account);
    return reply.header("cache-control", "no-store").send(
      IssueHostAccountAdoptionProofResponseSchema.parse({
        account: proof.account,
        authority: proof.deployment,
        expiresAt: proof.expiresAt.toISOString(),
        proofCredential: proof.proofCredential,
        proofId: proof.proofId,
      }),
    );
  });

  // Deliberately public: knowledge of the random, one-use proof credential is
  // the authentication. It grants only a tuple-bound proof response, never a
  // Host session or permission to mutate Host data.
  app.post<{ Params: { proofId: string } }>(
    "/v1/auth/account-adoption/proofs/:proofId/consume",
    async (request, reply) => {
      const proofId = HostAccountAdoptionProofIdSchema.parse(request.params.proofId);
      const body = ConsumeHostAccountAdoptionProofRequestSchema.parse(request.body);
      const consumed = await identity.consumeAccountAdoptionProof({
        expectedAccount: body.expectedAccount,
        expectedDeployment: body.expectedAuthority,
        proofCredential: body.proofCredential,
        proofId,
      });
      return reply.header("cache-control", "no-store").send(
        ConsumeHostAccountAdoptionProofResponseSchema.parse({
          account: consumed.account,
          authority: consumed.deployment,
          authorizedBy: consumed.authorizedBy,
          consumedAt: consumed.consumedAt.toISOString(),
          proofId: consumed.proofId,
        }),
      );
    },
  );

  if (identity?.accountAdoptionCompletionEnabled?.()) {
    if (!options.acknowledgeAccountAdoption) {
      throw new Error(
        "Account adoption completion requires a control-plane acknowledgement client",
      );
    }
    app.post("/v1/auth/account-adoption/complete", async (request, reply) => {
      authenticator.requireExactOrigin(request.headers);
      const session = await authenticator.authenticateSession(request.headers, { mutation: true });
      requireInstanceAdministrator(session);
      const body = CompleteHostAccountAdoptionRequestSchema.parse(request.body);
      const completed = await identity.completeAccountAdoption(body.completionGrant, session);
      await options.acknowledgeAccountAdoption!(completed.proofId);
      return reply.header("cache-control", "no-store").send(
        CompleteHostAccountAdoptionResponseSchema.parse({
          ...completed,
        }),
      );
    });
  }

  app.get("/v1/auth/oidc/callback", async (request, reply) => {
    const incoming = new Request(
      new URL(request.raw.url ?? request.url, authenticator.publicOrigin),
      {
        headers: requestHeaders(request),
        method: "GET",
      },
    );
    const response = await identity.handleOidcCallback(incoming);
    copyResponseHeaders(reply, response.headers);
    const body = Buffer.from(await response.arrayBuffer());
    return reply.status(response.status).send(body);
  });

  // Several focused Host service tests use a deliberately narrow authenticator
  // fake because they never exercise identity routes. Keep route registration
  // lazy while production still supplies the complete IdentityService.
  const nativeOpenIdConfiguration = identity?.nativeOpenIdConfiguration();
  if (nativeOpenIdConfiguration) {
    app.get("/.well-known/openid-configuration", async (request, reply) => {
      const response = await nativeOpenIdConfiguration(
        new Request(new URL(request.raw.url ?? request.url, authenticator.publicOrigin), {
          headers: requestHeaders(request),
          method: "GET",
        }),
      );
      return sendWebResponse(reply, response);
    });
    const authorizationServerMetadata = identity.nativeOAuthAuthorizationServerMetadata();
    if (!authorizationServerMetadata) throw new Error("Native OAuth metadata is incomplete");
    app.get("/.well-known/oauth-authorization-server", async (request, reply) => {
      const response = await authorizationServerMetadata(
        new Request(new URL(request.raw.url ?? request.url, authenticator.publicOrigin), {
          headers: requestHeaders(request),
          method: "GET",
        }),
      );
      return sendWebResponse(reply, response);
    });
    for (const route of [
      { method: "GET", path: "/v1/auth/native/jwks" },
      { method: "GET", path: "/v1/auth/native/oauth2/authorize" },
      { method: "GET", path: "/v1/auth/native/oauth2/end-session" },
      { method: "GET", path: "/v1/auth/native/oauth2/userinfo" },
      { method: "POST", path: "/v1/auth/native/oauth2/end-session" },
      { method: "POST", path: "/v1/auth/native/oauth2/revoke" },
      { method: "POST", path: "/v1/auth/native/oauth2/token" },
    ] as const) {
      app.route({
        ...(route.method === "POST" && route.path.endsWith("/end-session")
          ? { bodyLimit: maximumNativeEndSessionBodyBytes }
          : {}),
        handler: (request, reply) => {
          return handleNativeOAuth(identity, authenticator, request, reply);
        },
        method: route.method,
        url: route.path,
      });
    }
  }
}

function contextHeaders(context: HostApiServerContext): Headers {
  const headers = new Headers();
  for (const [name, raw] of Object.entries(context.headers)) {
    if (raw === undefined) continue;
    if (Array.isArray(raw)) {
      for (const value of raw) headers.append(name, value);
    } else {
      headers.set(name, String(raw));
    }
  }
  return headers;
}

function applyResponseHeaders(context: HostApiServerContext, headers: Headers): void {
  for (const [name, value] of headers.entries()) {
    if (name.toLowerCase() === "content-length" || name.toLowerCase() === "set-cookie") continue;
    context.setHeader(name, value);
  }
  const cookies = headers.getSetCookie();
  if (cookies.length > 0) context.setHeader("set-cookie", cookies);
}

function authSuccess<T>(context: HostApiServerContext, result: TokenFreeAuthResponse<T>) {
  applyResponseHeaders(context, result.headers);
  return rpcSuccess(result.data);
}

function nativeConsentRefusal(status: number, body: unknown): Error {
  // A failing consent endpoint is the Host's own fault and nothing the caller
  // can act on, so it takes the generic internal answer and the log with it.
  if (status >= 500) return new Error(`Native OAuth consent failed with status ${status}`);
  const refusal = z.object({ message: z.string().min(1).max(500) }).safeParse(body);
  return new OpensteerError({
    code: status === 401 ? "unauthorized" : status === 404 ? "not_found" : "bad_request",
    message: refusal.success ? refusal.data.message : "Authorization could not be completed",
  });
}

function requireRpcSession(context: HostApiServerContext) {
  if (!context.session) {
    throw new OpensteerError({ code: "unauthorized", message: "Authentication required" });
  }
  return context.session;
}

function requireWorkspaceSharing(available: boolean | undefined): void {
  if (available !== false) return;
  throw new OpensteerError({
    code: "forbidden",
    message: "Workspace sharing is unavailable for this Deployment",
  });
}

function requestHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [name, raw] of Object.entries(request.headers)) {
    if (raw === undefined) continue;
    if (Array.isArray(raw)) {
      for (const value of raw) headers.append(name, value);
    } else {
      headers.set(name, String(raw));
    }
  }
  return headers;
}

export function copyResponseHeaders(reply: FastifyReply, headers: Headers): void {
  for (const [name, value] of headers.entries()) {
    if (name.toLowerCase() === "content-length") continue;
    if (name.toLowerCase() === "set-cookie") continue;
    reply.header(name, value);
  }
  const cookies = headers.getSetCookie();
  if (cookies.length > 0) reply.header("set-cookie", cookies);
}

async function handleNativeOAuth(
  identity: HostAuthenticator["identity"],
  authenticator: HostAuthenticator,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const method = request.method.toUpperCase();
  const headers = requestHeaders(request);
  let body: Uint8Array<ArrayBuffer> | string | undefined;
  if (method !== "GET" && method !== "HEAD" && request.body !== undefined) {
    body = Buffer.isBuffer(request.body)
      ? new Uint8Array(request.body)
      : typeof request.body === "string"
        ? request.body
        : JSON.stringify(request.body);
  }
  const response = await identity.handleNativeOAuthRequest(
    new Request(new URL(request.raw.url ?? request.url, authenticator.publicOrigin), {
      ...(body === undefined ? {} : { body }),
      headers,
      method,
    }),
  );
  return sendWebResponse(reply, response);
}

async function sendWebResponse(reply: FastifyReply, response: Response) {
  copyResponseHeaders(reply, response.headers);
  return reply.status(response.status).send(Buffer.from(await response.arrayBuffer()));
}

export function requireInstanceAdministrator(
  session: Awaited<ReturnType<HostAuthenticator["authenticateSession"]>>,
): void {
  if (session.user.instanceRole !== "administrator") {
    throw new OpensteerError({ code: "forbidden", message: "Administrator access required" });
  }
}
