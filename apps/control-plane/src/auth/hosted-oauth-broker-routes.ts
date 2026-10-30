import {
  AcknowledgeHostedOAuthRefreshRequestSchema,
  AcknowledgeHostedOAuthResultRequestSchema,
  AcknowledgeHostedOAuthResultResponseSchema,
  CreateHostedOAuthAttemptRequestSchema,
  CreateOAuthCallbackRelayRequestSchema,
  CreateHostedOAuthRevocationRequestSchema,
  CreateHostedOAuthRefreshRequestSchema,
  HostedOAuthAttemptIdSchema,
  HostedOAuthRefreshTransactionIdSchema,
  OAuthBrokerProviderSchema,
} from "@opensteer/control-plane-protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ControlPlaneAuthenticator } from "./auth.js";
import { ControlPlaneError } from "../server/errors.js";
import type { HostedOAuthBrokerService } from "./hosted-oauth-broker-service.js";
import type { ControlPlaneStore } from "../database/store.js";
import { toWebHeaders } from "../portal/routes.js";

const AttemptParamsSchema = z.strictObject({ attemptId: HostedOAuthAttemptIdSchema });
const RefreshParamsSchema = z.strictObject({
  transactionId: HostedOAuthRefreshTransactionIdSchema,
});
const LaunchQuerySchema = z.strictObject({
  ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
});
const CallbackParamsSchema = z.strictObject({ provider: OAuthBrokerProviderSchema });
const MetadataQuerySchema = z.strictObject({ version: z.literal("2").optional() });

export function registerHostedOAuthBrokerRoutes(
  app: FastifyInstance,
  dependencies: {
    readonly authenticator: ControlPlaneAuthenticator;
    readonly broker: HostedOAuthBrokerService;
    readonly store: ControlPlaneStore;
  },
): void {
  app.get("/v1/oauth-broker/metadata", async (request, reply) => {
    const { version } = MetadataQuerySchema.parse(request.query);
    return reply
      .header("cache-control", "public, max-age=300")
      .send(dependencies.broker.metadata(version === "2"));
  });

  app.post("/v1/host/oauth-broker/attempts", async (request, reply) => {
    const authority = await dependencies.store.authenticateHostCredential(
      firstHeader(request.headers.authorization),
    );
    const result = await dependencies.broker.createAuthorizationAttempt(
      authority,
      CreateHostedOAuthAttemptRequestSchema.parse(request.body),
    );
    return reply.header("cache-control", "no-store").send(result);
  });

  app.post("/v1/host/oauth-broker/callback-relays", async (request, reply) => {
    const authority = await dependencies.store.authenticateHostCredential(
      firstHeader(request.headers.authorization),
    );
    const result = await dependencies.broker.createCallbackRelay(
      authority,
      CreateOAuthCallbackRelayRequestSchema.parse(request.body),
    );
    return reply.header("cache-control", "no-store").send(result);
  });

  app.get<{ Params: { attemptId: string } }>(
    "/v1/oauth-broker/launch/:attemptId",
    async (request, reply) => {
      const { attemptId } = AttemptParamsSchema.parse(request.params);
      const { ticket } = LaunchQuerySchema.parse(request.query);
      let principal: Awaited<ReturnType<ControlPlaneAuthenticator["authenticate"]>>;
      try {
        principal = await dependencies.authenticator.authenticate(toWebHeaders(request.headers));
      } catch (error) {
        if (!(error instanceof ControlPlaneError) || error.code !== "unauthorized") throw error;
        const signIn = new URL("/sign-in", "https://opensteer.invalid");
        signIn.searchParams.set("return_to", request.url);
        return reply
          .header("cache-control", "no-store")
          .header("pragma", "no-cache")
          .header("referrer-policy", "no-referrer")
          .code(302)
          .redirect(`${signIn.pathname}${signIn.search}`);
      }
      const authorizationUrl = await dependencies.broker.launchAuthorization(
        principal.accountId,
        attemptId,
        ticket,
      );
      return reply
        .header("cache-control", "no-store")
        .header("pragma", "no-cache")
        .header("referrer-policy", "no-referrer")
        .code(303)
        .redirect(authorizationUrl);
    },
  );

  app.get<{ Params: { provider: string } }>(
    "/v1/oauth-broker/callback/:provider",
    async (request, reply) => {
      const { provider } = CallbackParamsSchema.parse(request.params);
      let completed = false;
      try {
        const result = await dependencies.broker.completeAuthorization({
          parameters: new URL(request.url, "https://opensteer.invalid").searchParams,
          provider,
        });
        if (result.status === "failed") {
          request.log.warn(
            {
              attemptId: result.attemptId,
              provider,
              failureCode: result.failureCode,
              providerError: result.providerError,
            },
            "Hosted OAuth authorization failed",
          );
        }
        completed = result.status === "sealed";
        if (result.returnUrl) {
          return reply
            .header("cache-control", "no-store")
            .header("pragma", "no-cache")
            .header("referrer-policy", "no-referrer")
            .code(303)
            .redirect(result.returnUrl);
        }
      } catch {
        request.log.warn({ provider }, "Hosted OAuth authorization callback was rejected");
      }
      return reply
        .code(completed ? 200 : 400)
        .header("cache-control", "no-store")
        .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'")
        .header("content-type", "text/html; charset=utf-8")
        .header("referrer-policy", "no-referrer")
        .header("x-content-type-options", "nosniff")
        .send(callbackPage(completed));
    },
  );

  app.get<{ Params: { attemptId: string } }>(
    "/v1/host/oauth-broker/attempts/:attemptId",
    async (request, reply) => {
      const authority = await dependencies.store.authenticateHostCredential(
        firstHeader(request.headers.authorization),
      );
      const { attemptId } = AttemptParamsSchema.parse(request.params);
      return reply
        .header("cache-control", "no-store")
        .send(await dependencies.broker.status(authority, attemptId));
    },
  );

  app.get<{ Params: { attemptId: string } }>(
    "/v1/host/oauth-broker/attempts/:attemptId/result",
    async (request, reply) => {
      const authority = await dependencies.store.authenticateHostCredential(
        firstHeader(request.headers.authorization),
      );
      const { attemptId } = AttemptParamsSchema.parse(request.params);
      return reply
        .header("cache-control", "no-store")
        .send(await dependencies.broker.pull(authority, attemptId));
    },
  );

  app.post<{ Params: { attemptId: string } }>(
    "/v1/host/oauth-broker/attempts/:attemptId/ack",
    async (request, reply) => {
      const authority = await dependencies.store.authenticateHostCredential(
        firstHeader(request.headers.authorization),
      );
      const { attemptId } = AttemptParamsSchema.parse(request.params);
      const body = AcknowledgeHostedOAuthResultRequestSchema.parse(request.body);
      if (body.attemptId !== attemptId) {
        throw new ControlPlaneError("bad_request", "Hosted OAuth ACK attempt mismatch");
      }
      await dependencies.broker.acknowledge(authority, attemptId);
      return reply.header("cache-control", "no-store").send(
        AcknowledgeHostedOAuthResultResponseSchema.parse({
          acknowledged: true,
          attemptId,
        }),
      );
    },
  );

  app.post("/v1/host/oauth-broker/refreshes", async (request, reply) => {
    const authority = await dependencies.store.authenticateHostCredential(
      firstHeader(request.headers.authorization),
    );
    return reply
      .header("cache-control", "no-store")
      .send(
        await dependencies.broker.refresh(
          authority,
          CreateHostedOAuthRefreshRequestSchema.parse(request.body),
        ),
      );
  });

  app.post("/v1/host/oauth-broker/revocations", async (request, reply) => {
    const authority = await dependencies.store.authenticateHostCredential(
      firstHeader(request.headers.authorization),
    );
    return reply
      .header("cache-control", "no-store")
      .send(
        await dependencies.broker.revoke(
          authority,
          CreateHostedOAuthRevocationRequestSchema.parse(request.body),
        ),
      );
  });

  app.get<{ Params: { transactionId: string } }>(
    "/v1/host/oauth-broker/refreshes/:transactionId/result",
    async (request, reply) => {
      const authority = await dependencies.store.authenticateHostCredential(
        firstHeader(request.headers.authorization),
      );
      const { transactionId } = RefreshParamsSchema.parse(request.params);
      return reply
        .header("cache-control", "no-store")
        .send(await dependencies.broker.pullRefresh(authority, transactionId));
    },
  );

  app.post<{ Params: { transactionId: string } }>(
    "/v1/host/oauth-broker/refreshes/:transactionId/ack",
    async (request, reply) => {
      const authority = await dependencies.store.authenticateHostCredential(
        firstHeader(request.headers.authorization),
      );
      const { transactionId } = RefreshParamsSchema.parse(request.params);
      const body = AcknowledgeHostedOAuthRefreshRequestSchema.parse(request.body);
      if (body.transactionId !== transactionId) {
        throw new ControlPlaneError("bad_request", "Hosted OAuth refresh ACK transaction mismatch");
      }
      await dependencies.broker.acknowledgeRefresh(authority, transactionId);
      return reply.header("cache-control", "no-store").send({ acknowledged: true, transactionId });
    },
  );
}

/**
 * Accept only the one Account-local return target the hosted broker creates.
 * The one-use launch ticket is a bearer value, so it may cross the Account
 * sign-in round trip but must never become a general-purpose redirect.
 */
export function hostedOAuthLaunchReturnTo(
  value: string | null | undefined,
  publicOrigin: URL,
): URL | null {
  if (value === null || value === undefined) return null;
  if (value.length === 0 || value.length > 1_024) {
    throw new ControlPlaneError("bad_request", "Hosted OAuth sign-in return is invalid");
  }
  let target: URL;
  try {
    target = new URL(value, publicOrigin);
  } catch (error) {
    throw new ControlPlaneError("bad_request", "Hosted OAuth sign-in return is invalid", {
      cause: error,
    });
  }
  if (
    target.origin !== publicOrigin.origin ||
    target.username.length > 0 ||
    target.password.length > 0 ||
    target.hash.length > 0
  ) {
    throw new ControlPlaneError("bad_request", "Hosted OAuth sign-in return is invalid");
  }
  const prefix = "/v1/oauth-broker/launch/";
  if (!target.pathname.startsWith(prefix)) {
    throw new ControlPlaneError("bad_request", "Hosted OAuth sign-in return is invalid");
  }
  HostedOAuthAttemptIdSchema.parse(target.pathname.slice(prefix.length));
  if (
    [...target.searchParams.keys()].some((key) => key !== "ticket") ||
    target.searchParams.getAll("ticket").length !== 1
  ) {
    throw new ControlPlaneError("bad_request", "Hosted OAuth sign-in return is invalid");
  }
  LaunchQuerySchema.parse({ ticket: target.searchParams.get("ticket") });
  return target;
}

function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

/**
 * Where a sign-in started on another device ends. A sealed result is not yet a
 * connection: the Host commits it when Opensteer next checks the attempt, so
 * the page sends the person back rather than announcing an account.
 */
function callbackPage(completed: boolean): string {
  const title = completed ? "You’re signed in" : "Sign-in didn’t finish";
  const detail = completed
    ? "Go back to Opensteer to finish connecting. You can close this tab."
    : "Go back to Opensteer to try again. You can close this tab.";
  const mark = completed
    ? '<path d="M7 12.5l3.2 3.2L17 9" stroke="#71c6a5"/>'
    : '<path d="M12 7.5v5.5M12 16.5v.01" stroke="#dfb36b"/>';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>html{color-scheme:dark;background:#080808;color:#f5f4f2;font:15px/1.5 system-ui,sans-serif}main{max-width:22rem;margin:22vh auto 0;padding:0 1.5rem;text-align:center}svg{width:44px;height:44px;margin-bottom:1rem}h1{font-size:1.35rem;font-weight:600;margin:0 0 .4rem}p{color:#8e8a86;margin:0}</style></head><body><main><svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10.5" stroke="#2a2a2a"/>${mark}</svg><h1>${title}</h1><p>${detail}</p></main></body></html>`;
}
