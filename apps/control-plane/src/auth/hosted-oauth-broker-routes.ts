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
  ReturnHostedOAuthAttemptRequestSchema,
} from "@opensteer/control-plane-protocol";
import type { FastifyInstance } from "fastify";
import { escapeHtml, statusPageBody, type BrowserPageFonts } from "@opensteer/shared/browserPage";
import { z } from "zod";
import type { ControlPlaneAuth, ControlPlaneAuthenticator } from "./auth.js";
import { ControlPlaneError } from "../server/errors.js";
import {
  hostedOAuthBindingCookieName,
  HostedOAuthBrokerRefusal,
  type HostedOAuthBrokerService,
} from "./hosted-oauth-broker-service.js";
import type { ControlPlaneStore } from "../database/store.js";
import { toWebHeaders } from "../portal/routes.js";
import { sendBrowserPage } from "../portal/pages.js";

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
    readonly auth?: ControlPlaneAuth;
    readonly broker: HostedOAuthBrokerService;
    readonly fonts?: BrowserPageFonts;
    readonly store: ControlPlaneStore;
  },
): void {
  app.get("/v1/oauth-broker/metadata", async (request, reply) => {
    const { version } = MetadataQuerySchema.parse(request.query);
    return reply
      .header("cache-control", "public, max-age=300")
      .send(dependencies.broker.metadata(version === "2"));
  });

  app.get("/v1/oauth-broker/mcp/client-metadata.json", async (_request, reply) =>
    reply
      .header("cache-control", "public, max-age=300")
      .send(dependencies.broker.mcpClientMetadata()),
  );

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
      const params = AttemptParamsSchema.safeParse(request.params);
      if (!params.success) {
        request.log.warn(
          { attemptId: null, reason: "launch-attempt-invalid" },
          "Hosted OAuth launch refused",
        );
        return reply
          .code(400)
          .header("referrer-policy", "no-referrer")
          .send(launchFailurePage(reply, dependencies.fonts, "invalid"));
      }
      const { attemptId } = params.data;
      void reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
      const query = LaunchQuerySchema.safeParse(request.query);
      if (!query.success) {
        request.log.warn(
          { attemptId, reason: "invalid-launch-ticket" },
          "Hosted OAuth launch refused",
        );
        return reply.code(400).send(launchFailurePage(reply, dependencies.fonts, "invalid"));
      }
      const { ticket } = query.data;
      let inspection;
      try {
        inspection = await dependencies.broker.inspectLaunch(attemptId, ticket);
      } catch {
        request.log.warn(
          { attemptId, reason: "launch-context-invalid" },
          "Hosted OAuth launch refused",
        );
        return reply.code(400).send(launchFailurePage(reply, dependencies.fonts, "invalid"));
      }
      if (inspection.status !== "ready") {
        request.log.warn(
          { attemptId, reason: `link-${inspection.status}` },
          "Hosted OAuth launch refused",
        );
        return reply
          .code(400)
          .send(launchFailurePage(reply, dependencies.fonts, inspection.status));
      }
      let accountId = null;
      if (inspection.finish !== "app") {
        try {
          const principal = await dependencies.authenticator.authenticate(
            toWebHeaders(request.headers),
          );
          accountId = principal.accountId;
        } catch (error) {
          if (!(error instanceof ControlPlaneError) || error.code !== "unauthorized") {
            request.log.warn(
              { attemptId, reason: "launch-session-refused" },
              "Hosted OAuth launch refused",
            );
            return reply.code(403).send(launchFailurePage(reply, dependencies.fonts, "invalid"));
          }
          request.log.warn(
            { attemptId, reason: "sign-in-required" },
            "Hosted OAuth launch refused",
          );
          const signIn = new URL("/sign-in", "https://opensteer.invalid");
          signIn.searchParams.set("return_to", request.url);
          return reply
            .header("pragma", "no-cache")
            .code(302)
            .redirect(`${signIn.pathname}${signIn.search}`);
        }
      }
      let authorizationUrl: string;
      try {
        authorizationUrl = await dependencies.broker.launchAuthorization(
          accountId,
          attemptId,
          ticket,
        );
      } catch (error) {
        const reason =
          error instanceof HostedOAuthBrokerRefusal
            ? error.refusalReason
            : "launch-validation-failed";
        request.log.warn({ attemptId, reason }, "Hosted OAuth launch refused");
        if (reason === "account-mismatch") {
          const session = await dependencies.auth?.api.getSession({
            headers: toWebHeaders(request.headers),
          });
          const body =
            statusPageBody({
              mark: "person",
              tone: "warn",
              title: "Use the linked Opensteer Account",
              detail: `This browser is signed in${session ? ` as ${session.user.email}` : " to another Account"}. Switch to the Opensteer Account linked to that Opensteer.`,
            }) +
            `<form method="post" action="/sign-in/google"><input type="hidden" name="return_to" value="${escapeHtml(request.url)}"><input type="hidden" name="switch_account" value="1"><button class="btn btn--primary" type="submit">Switch account</button></form>`;
          return reply.code(403).send(
            sendBrowserPage(reply, {
              body,
              fonts: dependencies.fonts,
              layout: "plain",
              title: "Switch Account · Opensteer",
            }),
          );
        }
        return reply.code(400).send(launchFailurePage(reply, dependencies.fonts, "invalid"));
      }
      return reply
        .header("cache-control", "no-store")
        .header("pragma", "no-cache")
        .header("referrer-policy", "no-referrer")
        .code(303)
        .header(
          "set-cookie",
          `${hostedOAuthBindingCookieName(attemptId)}=${ticket}; Path=/v1/oauth-broker; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
        )
        .redirect(authorizationUrl);
    },
  );

  app.get<{ Params: { provider: string } }>(
    "/v1/oauth-broker/callback/:provider",
    async (request, reply) => {
      const params = CallbackParamsSchema.safeParse(request.params);
      if (!params.success) {
        request.log.warn(
          { attemptId: null, reason: "callback-provider-invalid" },
          "Hosted OAuth authorization callback was rejected",
        );
        void reply.code(400).header("referrer-policy", "no-referrer");
        return reply.send(
          sendBrowserPage(reply, {
            body: callbackPageBody(false),
            fonts: dependencies.fonts,
            layout: "plain",
            title: "Sign-in didn’t finish · Opensteer",
          }),
        );
      }
      const { provider } = params.data;
      let completed = false;
      try {
        const result = await dependencies.broker.completeAuthorization({
          parameters: new URL(request.url, "https://opensteer.invalid").searchParams,
          cookieHeader: request.headers.cookie,
          provider,
        });
        if (result.status === "failed" || result.status === "denied") {
          request.log.warn(
            {
              attemptId: result.attemptId,
              reason: result.failureCode ?? "authorization-failed",
            },
            "Hosted OAuth authorization failed",
          );
        }
        completed = result.status === "sealed";
        if (result.returnKind === "open-app" && result.returnUrl) {
          const held = result.status === "held";
          const title = held
            ? "Finishing in Opensteer"
            : result.status === "denied"
              ? "Sign-in was declined"
              : "Sign-in didn’t finish";
          void reply.header("referrer-policy", "no-referrer");
          const body = statusPageBody({
            mark: held ? "check" : "alert",
            tone: held ? "ok" : "warn",
            title,
            detail: held
              ? "Open Opensteer to finish connecting."
              : "Open Opensteer to see the result and try again.",
            action: { href: result.returnUrl, label: "Open Opensteer" },
          }).replace('class="btn"', 'class="btn btn--primary"');
          const html = sendBrowserPage(reply, {
            body,
            fonts: dependencies.fonts,
            layout: "plain",
            title,
          });
          // The default policy has no navigation restriction; custom app schemes are
          // allowed for both the visible link and this best-effort refresh.
          return reply
            .code(200)
            .send(
              html.replace(
                "</head>",
                `<meta http-equiv="refresh" content="0;url=${escapeHtml(result.returnUrl)}"></head>`,
              ),
            );
        }
        if (result.returnUrl) {
          return reply
            .header("cache-control", "no-store")
            .header("pragma", "no-cache")
            .header("referrer-policy", "no-referrer")
            .code(303)
            .redirect(result.returnUrl);
        }
      } catch (error) {
        request.log.warn(
          {
            attemptId: error instanceof HostedOAuthBrokerRefusal ? error.attemptId : null,
            reason:
              error instanceof HostedOAuthBrokerRefusal
                ? error.refusalReason
                : "callback-validation-failed",
          },
          "Hosted OAuth authorization callback was rejected",
        );
      }
      void reply.code(completed ? 200 : 400).header("referrer-policy", "no-referrer");
      return reply.send(
        sendBrowserPage(reply, {
          body: callbackPageBody(completed),
          fonts: dependencies.fonts,
          layout: "plain",
          title: completed ? "Signed in · Opensteer" : "Sign-in didn’t finish · Opensteer",
        }),
      );
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
    "/v1/host/oauth-broker/attempts/:attemptId/return",
    async (request, reply) => {
      const params = AttemptParamsSchema.safeParse(request.params);
      if (!params.success) {
        request.log.warn(
          { attemptId: null, reason: "return-attempt-invalid" },
          "Hosted OAuth return refused",
        );
        throw new ControlPlaneError("bad_request", "Hosted OAuth return attempt is invalid");
      }
      const { attemptId } = params.data;
      void reply.header("cache-control", "no-store");
      try {
        const authority = await dependencies.store.authenticateHostCredential(
          firstHeader(request.headers.authorization),
        );
        const body = ReturnHostedOAuthAttemptRequestSchema.parse(request.body);
        if (body.attemptId !== attemptId)
          throw new ControlPlaneError("bad_request", "Hosted OAuth return attempt mismatch");
        return reply
          .header("cache-control", "no-store")
          .send(await dependencies.broker.returnAttempt(authority, attemptId, body.returnProof));
      } catch (error) {
        request.log.warn(
          {
            attemptId,
            reason:
              error instanceof HostedOAuthBrokerRefusal
                ? error.refusalReason
                : "return-request-refused",
          },
          "Hosted OAuth return refused",
        );
        throw error;
      }
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
function callbackPageBody(completed: boolean): string {
  return statusPageBody(
    completed
      ? {
          detail: "Go back to Opensteer to finish connecting. You can close this tab.",
          mark: "check",
          title: "You’re signed in",
          tone: "ok",
        }
      : {
          detail: "Go back to Opensteer to try again. You can close this tab.",
          mark: "alert",
          title: "Sign-in didn’t finish",
          tone: "warn",
        },
  );
}

function launchFailurePage(
  reply: import("fastify").FastifyReply,
  fonts: BrowserPageFonts | undefined,
  status: "expired" | "used" | "invalid",
) {
  const title =
    status === "used"
      ? "This link was already used"
      : status === "expired"
        ? "This link expired"
        : "This link is invalid or expired";
  return sendBrowserPage(reply, {
    fonts,
    layout: "plain",
    title,
    body: statusPageBody({
      mark: "alert",
      tone: "warn",
      title,
      detail: "Start Connect again in Opensteer.",
    }),
  });
}
