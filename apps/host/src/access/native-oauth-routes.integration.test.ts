import {
  createId,
  opensteerDesktopHostOAuthCallback,
  opensteerDesktopOAuthClientId,
  opensteerHostNativeOAuthClients,
  opensteerMobileHostOAuthCallback,
  opensteerMobileOAuthClientId,
} from "@opensteer/core";
import { createDatabase, migrateToLatest } from "@opensteer/database";
import { IdentityService } from "@opensteer/identity";
import { rpcFailure, rpcSuccess, type HostApiHandlers } from "@opensteer/protocol";
import { createHash } from "node:crypto";
import { decodeJwt } from "jose";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HostAuthenticator } from "../identity/auth.js";
import { createIdentityRpcHandlers, registerIdentityRoutes } from "../identity/identity-routes.js";
import { registerHostApi } from "../server/host-api-registration.js";
import { injectRpcRequest } from "../server/test-host-api-request.js";
import Fastify from "fastify";

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const origin = "http://127.0.0.1:4310";
const database = createDatabase({
  applicationName: "opensteer-native-oauth-route-integration-test",
  connectionString: databaseUrl ?? "postgres://unconfigured",
  maxConnections: 4,
});

integration("Host native OAuth routes", () => {
  beforeAll(async () => migrateToLatest(database));
  beforeEach(async () => {
    await sql`
      truncate table
        host_oauth_consents,
        host_oauth_access_tokens,
        host_oauth_refresh_tokens,
        host_oauth_clients,
        auth_jwks,
        auth_rate_limits,
        auth_verifications,
        auth_admissions,
        auth_sso_providers,
        owner_enrollments,
        security_effects,
        security_audit,
        auth_accounts,
        auth_sessions,
        users
      restart identity cascade
    `.execute(database);
  });
  afterAll(async () => database.destroy());

  it("publishes public endpoint URLs and proxies the complete PKCE exchange", async () => {
    const endedSessions: string[] = [];
    const { app } = await hostWithNativeOAuth((sessionId) => endedSessions.push(sessionId));
    try {
      const signup = await injectRpcRequest(
        app,
        "auth.password.signUp",
        { email: "native-route@example.com", password: "correct horse battery staple" },
        { origin },
      );
      expect(signup.statusCode).toBe(200);

      for (const path of [
        "/.well-known/openid-configuration",
        "/.well-known/oauth-authorization-server",
      ]) {
        const metadata = await app.inject({ method: "GET", url: path });
        expect(metadata.statusCode).toBe(200);
        expect(metadata.json()).toMatchObject({
          authorization_endpoint: `${origin}/v1/auth/native/oauth2/authorize`,
          issuer: origin,
          jwks_uri: `${origin}/v1/auth/native/jwks`,
          token_endpoint: `${origin}/v1/auth/native/oauth2/token`,
        });
        expect(metadata.body).not.toContain("/internal/better-auth");
      }

      const verifier = "route-pkce-verifier-with-at-least-forty-three-characters-0123456789";
      const authorize = new URL("/v1/auth/native/oauth2/authorize", origin);
      authorize.searchParams.set("client_id", opensteerDesktopOAuthClientId);
      authorize.searchParams.set(
        "code_challenge",
        createHash("sha256").update(verifier).digest("base64url"),
      );
      authorize.searchParams.set("code_challenge_method", "S256");
      authorize.searchParams.set("redirect_uri", opensteerDesktopHostOAuthCallback);
      authorize.searchParams.set("response_type", "code");
      authorize.searchParams.set("scope", "openid profile email offline_access host:access");
      authorize.searchParams.set("state", createId("authSession"));
      const prompt = await app.inject({
        headers: { accept: "application/json" },
        method: "GET",
        url: `${authorize.pathname}${authorize.search}`,
      });
      expect(prompt.statusCode).toBe(200);
      const oauthQuery = new URL(prompt.json().url as string, origin).search.slice(1);
      const signIn = await injectRpcRequest(
        app,
        "auth.password.signIn",
        {
          email: "native-route@example.com",
          oauthQuery,
          password: "correct horse battery staple",
        },
        { origin },
      );
      expect(signIn.statusCode, signIn.body).toBe(200);
      const signedIn = signIn.json<{ data: { redirectUrl: string } }>();
      const consentPage = new URL(signedIn.data.redirectUrl);
      expect(consentPage.origin).toBe(origin);
      const sessionCookie = cookieHeader(signIn.headers["set-cookie"]);
      const consent = await injectRpcRequest(
        app,
        "auth.native.complete",
        { accept: true, oauthQuery: consentPage.search.slice(1) },
        { cookie: sessionCookie, origin },
      );
      expect(consent.statusCode, consent.body).toBe(200);
      const consentPayload = consent.json<{ data: { url: string } }>();
      expect(consentPayload, consent.body).toMatchObject({
        data: { url: expect.any(String) },
      });
      const callback = new URL(consentPayload.data.url);
      const token = await app.inject({
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
        payload: new URLSearchParams({
          client_id: opensteerDesktopOAuthClientId,
          code: callback.searchParams.get("code") ?? "",
          code_verifier: verifier,
          grant_type: "authorization_code",
          redirect_uri: opensteerDesktopHostOAuthCallback,
          resource: origin,
        }).toString(),
        url: "/v1/auth/native/oauth2/token",
      });
      expect(token.statusCode).toBe(200);
      const tokenBody = token.json<{ access_token: string; id_token: string }>();
      expect(tokenBody).toMatchObject({
        access_token: expect.any(String),
        refresh_token: expect.any(String),
        token_type: "Bearer",
      });

      const sessions = await injectRpcRequest(
        app,
        "sessions.list",
        {},
        { authorization: `Bearer ${tokenBody.access_token}` },
      );
      expect(sessions.statusCode, sessions.body).toBe(200);
      const sessionBody = sessions.json<{
        data: { sessions: Array<{ current: boolean; id: string }> };
      }>();
      expect(sessionBody.data.sessions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ current: true }),
          expect.objectContaining({ current: false }),
        ]),
      );
      const revocableSession = sessionBody.data.sessions.find((session) => !session.current);
      expect(revocableSession).toBeDefined();
      const revoked = await injectRpcRequest(
        app,
        "commands.dispatch",
        {
          idempotencyKey: "native-oauth-session-revoke",
          sessionId: revocableSession!.id,
          type: "session.revoke",
        },
        { authorization: `Bearer ${tokenBody.access_token}`, origin },
      );
      expect(revoked.statusCode, revoked.body).toBe(200);
      expect(endedSessions).toEqual([revocableSession!.id]);

      const repeated = await app.inject({
        headers: { accept: "application/json", cookie: sessionCookie },
        method: "GET",
        url: `${authorize.pathname}${authorize.search}`,
      });
      expect(repeated.statusCode, repeated.body).toBe(200);
      expect(new URL(repeated.json().url as string, origin).origin).toBe(origin);

      const currentSession = sessionBody.data.sessions.find((session) => session.current);
      expect(currentSession).toBeDefined();
      const ended = await app.inject({
        method: "GET",
        url: endSessionUrl(opensteerDesktopOAuthClientId, tokenBody.id_token),
      });
      expect(ended.statusCode, ended.body).toBe(200);
      expect(endedSessions).toEqual([revocableSession!.id, currentSession!.id]);
    } finally {
      await app.close();
    }
  });

  it("ends the session a revoked native token hangs from, and only that one", async () => {
    const endedSessions: string[] = [];
    const { app } = await hostWithNativeOAuth((sessionId) => endedSessions.push(sessionId));
    try {
      const credentials = {
        email: "native-revoke@example.com",
        password: "correct horse battery staple",
      } as const;
      expect(
        (await injectRpcRequest(app, "auth.password.signUp", credentials, { origin })).statusCode,
      ).toBe(200);

      // Two applications, each authorized from its own browser: that is what
      // makes them two sessions, and what one signing out must not disturb.
      const phone = await nativeAuthorization(app, {
        callback: opensteerMobileHostOAuthCallback,
        clientId: opensteerMobileOAuthClientId,
        credentials,
      });
      const desktop = await nativeAuthorization(app, {
        callback: opensteerDesktopHostOAuthCallback,
        clientId: opensteerDesktopOAuthClientId,
        credentials,
      });
      const before = await injectRpcRequest(
        app,
        "sessions.list",
        {},
        { authorization: `Bearer ${phone.accessToken}` },
      );
      expect(before.statusCode, before.body).toBe(200);
      const listed = before.json<{ data: { sessions: readonly { id: string }[] } }>();
      const phoneSessionId = listed.data.sessions.find(
        (session) => (session as { current?: boolean }).current === true,
      )?.id;
      expect(phoneSessionId).toBeDefined();

      const revoked = await app.inject({
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
        payload: new URLSearchParams({
          client_id: opensteerMobileOAuthClientId,
          token: phone.refreshToken,
          token_type_hint: "refresh_token",
        }).toString(),
        url: "/v1/auth/native/oauth2/revoke",
      });
      expect(revoked.statusCode, revoked.body).toBe(200);
      expect(endedSessions).toEqual([phoneSessionId]);

      // The access token outlives its refresh token by ten minutes, so the
      // session row is the only thing that can stop it now.
      const afterRevocation = await injectRpcRequest(
        app,
        "sessions.list",
        {},
        { authorization: `Bearer ${phone.accessToken}` },
      );
      expect(afterRevocation.statusCode).toBe(401);
      await expect(
        database
          .selectFrom("authSessions")
          .select("id")
          .where("id", "=", phoneSessionId as never)
          .executeTakeFirst(),
      ).resolves.toBeUndefined();

      const survivor = await injectRpcRequest(
        app,
        "sessions.list",
        {},
        { authorization: `Bearer ${desktop.accessToken}` },
      );
      expect(survivor.statusCode, survivor.body).toBe(200);
      expect(
        survivor
          .json<{ data: { sessions: readonly { id: string }[] } }>()
          .data.sessions.some((session) => session.id === phoneSessionId),
      ).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("authenticates native end-session before ending only the named session", async () => {
    const endedSessions: string[] = [];
    const { app } = await hostWithNativeOAuth((sessionId) => endedSessions.push(sessionId));
    try {
      const credentials = {
        email: "native-end-session@example.com",
        password: "correct horse battery staple",
      } as const;
      expect(
        (await injectRpcRequest(app, "auth.password.signUp", credentials, { origin })).statusCode,
      ).toBe(200);
      const phone = await nativeAuthorization(app, {
        callback: opensteerMobileHostOAuthCallback,
        clientId: opensteerMobileOAuthClientId,
        credentials,
      });
      const desktop = await nativeAuthorization(app, {
        callback: opensteerDesktopHostOAuthCallback,
        clientId: opensteerDesktopOAuthClientId,
        credentials,
      });
      const sessions = await injectRpcRequest(
        app,
        "sessions.list",
        {},
        { authorization: `Bearer ${desktop.accessToken}` },
      );
      const desktopSessionId = sessions
        .json<{ data: { sessions: readonly { current: boolean; id: string }[] } }>()
        .data.sessions.find((session) => session.current)?.id;
      expect(desktopSessionId).toBeDefined();

      const tokenParts = desktop.idToken.split(".");
      const signature = tokenParts[2]!;
      tokenParts[2] = `${signature.startsWith("a") ? "b" : "a"}${signature.slice(1)}`;
      const tampered = tokenParts.join(".");
      expect(
        (
          await app.inject({
            method: "GET",
            url: endSessionUrl(opensteerDesktopOAuthClientId, tampered),
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: "GET",
            url: endSessionUrl(opensteerMobileOAuthClientId, desktop.idToken),
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `${endSessionUrl(opensteerDesktopOAuthClientId, desktop.idToken)}&post_logout_redirect_uri=${encodeURIComponent("https://attacker.example")}`,
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            headers: { "content-type": "application/json" },
            method: "POST",
            payload: JSON.stringify({ id_token_hint: desktop.idToken }),
            url: "/v1/auth/native/oauth2/end-session",
          })
        ).statusCode,
      ).toBe(415);
      expect(
        (
          await app.inject({
            headers: { "content-type": "application/x-www-form-urlencoded" },
            method: "POST",
            payload: new URLSearchParams({ id_token_hint: "x".repeat(25 * 1_024) }).toString(),
            url: "/v1/auth/native/oauth2/end-session",
          })
        ).statusCode,
      ).toBe(413);
      expect(endedSessions).toEqual([]);
      expect(
        (
          await injectRpcRequest(
            app,
            "sessions.list",
            {},
            { authorization: `Bearer ${desktop.accessToken}` },
          )
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await injectRpcRequest(
            app,
            "sessions.list",
            {},
            { authorization: `Bearer ${phone.accessToken}` },
          )
        ).statusCode,
      ).toBe(200);

      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 11 * 60 * 1_000);
      expect((decodeJwt(desktop.idToken).exp ?? Number.POSITIVE_INFINITY) * 1_000).toBeLessThan(
        Date.now(),
      );
      const ended = await app
        .inject({
          headers: { "content-type": "application/x-www-form-urlencoded" },
          method: "POST",
          payload: new URLSearchParams({
            client_id: opensteerDesktopOAuthClientId,
            id_token_hint: desktop.idToken,
          }).toString(),
          url: "/v1/auth/native/oauth2/end-session",
        })
        .finally(() => vi.useRealTimers());
      expect(ended.statusCode, ended.body).toBe(200);
      expect(endedSessions).toEqual([desktopSessionId]);
      expect(
        (
          await injectRpcRequest(
            app,
            "sessions.list",
            {},
            { authorization: `Bearer ${desktop.accessToken}` },
          )
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await injectRpcRequest(
            app,
            "sessions.list",
            {},
            { authorization: `Bearer ${phone.accessToken}` },
          )
        ).statusCode,
      ).toBe(200);
    } finally {
      await app.close();
    }
  });
});

/** One complete PKCE authorization, from a browser session of its own. */
async function nativeAuthorization(
  app: Awaited<ReturnType<typeof hostWithNativeOAuth>>["app"],
  input: {
    readonly callback: string;
    readonly clientId: string;
    readonly credentials: { readonly email: string; readonly password: string };
  },
): Promise<{
  readonly accessToken: string;
  readonly idToken: string;
  readonly refreshToken: string;
}> {
  const verifier = `${input.clientId}-pkce-verifier-with-at-least-forty-three-characters`;
  const authorize = new URL("/v1/auth/native/oauth2/authorize", origin);
  authorize.searchParams.set("client_id", input.clientId);
  authorize.searchParams.set(
    "code_challenge",
    createHash("sha256").update(verifier).digest("base64url"),
  );
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("redirect_uri", input.callback);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", "openid profile email offline_access host:access");
  authorize.searchParams.set("state", createId("authSession"));
  const prompt = await app.inject({
    headers: { accept: "application/json" },
    method: "GET",
    url: `${authorize.pathname}${authorize.search}`,
  });
  const signIn = await injectRpcRequest(
    app,
    "auth.password.signIn",
    {
      ...input.credentials,
      oauthQuery: new URL(prompt.json().url as string, origin).search.slice(1),
    },
    { origin },
  );
  const redirectUrl = signIn.json<{ data: { redirectUrl: string } }>().data.redirectUrl;
  const consent = await injectRpcRequest(
    app,
    "auth.native.complete",
    { accept: true, oauthQuery: new URL(redirectUrl).search.slice(1) },
    { cookie: cookieHeader(signIn.headers["set-cookie"]), origin },
  );
  const callback = new URL(consent.json<{ data: { url: string } }>().data.url);
  const token = await app.inject({
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
    payload: new URLSearchParams({
      client_id: input.clientId,
      code: callback.searchParams.get("code") ?? "",
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: input.callback,
      resource: origin,
    }).toString(),
    url: "/v1/auth/native/oauth2/token",
  });
  const body = token.json<{ access_token: string; id_token: string; refresh_token: string }>();
  return {
    accessToken: body.access_token,
    idToken: body.id_token,
    refreshToken: body.refresh_token,
  };
}

function endSessionUrl(clientId: string, idToken: string): string {
  const url = new URL("/v1/auth/native/oauth2/end-session", origin);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("id_token_hint", idToken);
  return `${url.pathname}${url.search}`;
}

/**
 * A Host serving the native authorization server, with the one command this
 * suite dispatches wired through to the identity service.
 */
async function hostWithNativeOAuth(onSessionEnded?: (sessionId: string) => void) {
  const identity = new IdentityService(database, {
    deployment: { cloud: false, kind: "self-hosted", name: null },
    localPasswordEnabled: true,
    nativeOAuth: { clients: opensteerHostNativeOAuthClients },
    ...(onSessionEnded ? { onSessionEnded } : {}),
    oidcProviders: [],
    publicOrigin: new URL(origin),
    secret: "host-route-native-oauth-secret-at-least-thirty-two-bytes",
    exposure: "networked",
    signupPolicy: "open",
  });
  await identity.initialize();
  const app = Fastify();
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );
  const authenticator = new HostAuthenticator({ identity, publicUrl: new URL(origin) });
  registerIdentityRoutes(app, authenticator);
  const identityHandlers = {
    ...createIdentityRpcHandlers(authenticator),
    "commands.dispatch": async (command, context) => {
      if (command.type !== "session.revoke" || !context.session) {
        return rpcFailure({
          code: "not_found" as const,
          message: "Command is not registered in this test.",
          retryable: false,
        });
      }
      await identity.revokeSession(context.session, command.sessionId);
      return rpcSuccess({ type: command.type });
    },
  } satisfies Partial<HostApiHandlers>;
  const handlers = new Proxy(identityHandlers, {
    get: (target, property) =>
      Reflect.get(target, property) ??
      (async () =>
        rpcFailure({
          code: "not_found",
          message: "RPC is not registered in this test.",
          retryable: false,
        })),
  }) as HostApiHandlers;
  registerHostApi(app, authenticator, handlers);
  return { app, identity };
}

function cookieHeader(value: string | string[] | undefined): string {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.map((entry) => entry.split(";", 1)[0]).join("; ");
}
