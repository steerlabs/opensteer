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

function callbackPage(completed: boolean): string {
  const title = completed ? "Authorization received" : "Authorization not completed";
  const detail = completed
    ? "Return to Opensteer. Your encrypted authorization result is waiting to be claimed."
    : "Return to Opensteer for details or to try again.";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>html{color-scheme:dark;font:16px system-ui;background:#0b0b0b;color:#f5f5f5}main{max-width:36rem;margin:18vh auto;padding:2rem}p{color:#b8b8b8;line-height:1.55}</style></head><body><main><h1>${title}</h1><p>${detail}</p></main></body></html>`;
}
