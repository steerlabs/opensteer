import { createHash, createHmac } from "node:crypto";
import {
  ControlPlaneAccountIdSchema,
  type ControlPlaneAccountId,
} from "@opensteer/control-plane-protocol";
import {
  opensteerAccountNativeOAuthClients,
  opensteerDesktopAccountOAuthCallback,
  opensteerAccountDeleteOAuthScopes,
  opensteerDesktopOAuthClientId,
} from "@opensteer/core";
import { handleOAuthUserInfo } from "better-auth/oauth2";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ControlPlaneAuthenticator,
  createControlPlaneAuth,
  freshAccountSessionMilliseconds,
  type ControlPlaneAuth,
} from "./auth.js";
import type { ControlPlaneConfig } from "../config.js";
import { ConnectLifecycleService } from "../account/connect-lifecycle.js";
import { createControlPlaneDatabase } from "../database/database.js";
import { migrateControlPlaneToLatest } from "../database/migrations.js";
import { createControlPlaneServer } from "../server/server.js";
import { ControlPlaneStore } from "../database/store.js";

const databaseUrl = process.env.OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const publicOrigin = new URL("https://accounts.auth.test.invalid");
const accountId = ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`);
const config: ControlPlaneConfig = {
  adoptionOperationKey: "A".repeat(43),
  personalAccountLinkOperationKey: "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM",
  authSecret: "test-control-plane-secret-with-at-least-32-bytes",
  connectDomain: "connect.auth.test.invalid",
  connectCloudflare: {
    accountId: "a".repeat(32),
    apiToken: "test-cloudflare-api-token",
    credentialDerivationSecret: "d".repeat(32),
    workersRouteBypass: false,
    zoneId: "b".repeat(32),
  },
  databaseUrl: databaseUrl ?? "postgresql://unconfigured",
  environment: "test",
  googleClientId: "test-google-client",
  googleClientSecret: "test-google-secret",
  listenHost: "127.0.0.1",
  listenPort: 41_142,
  portalOrigin: new URL("https://connect.auth.test.invalid"),
  nativeOAuthClients: opensteerAccountNativeOAuthClients,
  publicOrigin,
};

integration("Account OAuth freshness PostgreSQL boundary", () => {
  const database = createControlPlaneDatabase({
    connectionString: databaseUrl ?? "postgresql://unconfigured",
    maxConnections: 4,
  });
  const store = new ControlPlaneStore(database, publicOrigin, {
    portalOrigin: config.portalOrigin,
  });
  const connectLifecycle = new ConnectLifecycleService(database, {
    delete: async () => undefined,
    ensure: async () => Promise.reject(new Error("Connect is not used by this test")),
    readConnectorToken: async () => Promise.reject(new Error("Connect is not used by this test")),
    rotateConnectorToken: async () => Promise.reject(new Error("Connect is not used by this test")),
  });

  beforeAll(async () => {
    await migrateControlPlaneToLatest(database);
  });

  beforeEach(async () => {
    await sql`
      truncate table
        oauth_consents,
        oauth_access_tokens,
        oauth_refresh_token,
        oauth_clients,
        auth_jwks,
        auth_rate_limits,
        auth_verifications,
        auth_sessions,
        auth_accounts,
        users
      cascade
    `.execute(database);
    const now = new Date();
    await database
      .insertInto("users")
      .values({
        createdAt: now,
        displayName: "Account Owner",
        email: `owner-${accountId}@example.test`,
        emailVerified: true,
        id: accountId,
        image: null,
        updatedAt: now,
      })
      .execute();
    await store.ensureOfficialNativeClients({ clients: config.nativeOAuthClients });
  });

  afterAll(async () => {
    await database.destroy();
  });

  it("signs the synthetic purchase in as its own Account only, beside App Review (S7)", async () => {
    const appReview = {
      email: "appreview-two@opensteer.com",
      password: "review-test-password-with-at-least-24-characters",
    };
    const syntheticSignIn = {
      email: "synthetic@opensteer.com",
      password: "synthetic-test-password-with-24-characters",
    };
    const auth = createControlPlaneAuth(database, { ...config, appReview, syntheticSignIn });
    const signIn = (body: Record<string, string>) =>
      auth.handler(
        new Request(new URL("/api/auth/sign-in/app-review", publicOrigin), {
          method: "POST",
          headers: { "content-type": "application/json", origin: publicOrigin.origin },
          body: JSON.stringify(body),
        }),
      );
    // Each password signs in only its own account.
    expect(
      (await signIn({ email: appReview.email, password: syntheticSignIn.password })).status,
    ).toBe(401);
    expect(
      (await signIn({ email: syntheticSignIn.email, password: appReview.password })).status,
    ).toBe(401);
    // A person who already has an Account under that email is never signed in by it (U6).
    const personId = `usr_${crypto.randomUUID()}`;
    await sql`insert into public.users (id, display_name, email, email_verified)
      values (${personId}, 'A person', ${syntheticSignIn.email}, true)`.execute(database);
    expect((await signIn(syntheticSignIn)).status).toBe(401);
    await database
      .deleteFrom("users")
      .where("id", "=", personId as never)
      .execute();
    // The Account it makes itself is marked, and only that one signs in again.
    expect((await signIn(syntheticSignIn)).status).toBe(200);
    expect((await signIn(syntheticSignIn)).status).toBe(200);
    const made = await database
      .selectFrom("users")
      .select(["email", "syntheticAt"])
      .where("email", "in", [appReview.email, syntheticSignIn.email])
      .execute();
    expect(made).toEqual([{ email: syntheticSignIn.email, syntheticAt: expect.any(Date) }]);
    // Nothing else is ever linked into it: a Google sign-in under that email adds no account (S4).
    const { id: syntheticId } = await database
      .selectFrom("users")
      .select("id")
      .where("email", "=", syntheticSignIn.email)
      .executeTakeFirstOrThrow();
    const context = await auth.$context;
    await context.internalAdapter
      .linkAccount({ userId: syntheticId, providerId: "google", accountId: "google-subject" })
      .catch(() => undefined);
    expect(
      await database
        .selectFrom("authAccounts")
        .select("id")
        .where("userId", "=", syntheticId)
        .execute(),
    ).toEqual([]);
    await database.deleteFrom("users").where("email", "=", syntheticSignIn.email).execute();
  });

  it("opens a session for the synthetic purchase's Account only through its own sign-in (V4)", async () => {
    const syntheticSignIn = {
      email: "synthetic-race@example.test",
      password: "synthetic-test-password-with-24-characters",
    };
    const appReview = {
      email: "appreview-marked@example.test",
      password: "review-test-password-with-at-least-24-characters",
    };
    const auth = createControlPlaneAuth(database, { ...config, appReview, syntheticSignIn });
    const context = await auth.$context;
    const signIn = (body: Record<string, string>) =>
      auth.handler(
        new Request(new URL("/api/auth/sign-in/app-review", publicOrigin), {
          method: "POST",
          headers: { "content-type": "application/json", origin: publicOrigin.origin },
          body: JSON.stringify(body),
        }),
      );
    // A Google sign-in under that email, as Better Auth's own callback runs it.
    const oauth = (accountId: string) =>
      handleOAuthUserInfo({ context, headers: new Headers() } as never, {
        userInfo: {
          id: accountId,
          email: syntheticSignIn.email,
          emailVerified: true,
          name: "Fixture",
        },
        account: { providerId: "google", accountId },
        callbackURL: publicOrigin.origin,
        disableSignUp: false,
      });
    // The fourth look's reproduction: a Google sign-in run at the moment the mark is written, once
    // the Account and its session were committed. There is no such moment now: the insert that
    // makes the Account marks it, and no later write of the mark is made.
    interface Write {
      set(values: Record<string, unknown>): Write;
      where(...args: unknown[]): Write;
      execute(): Promise<unknown>;
    }
    const update = database.updateTable.bind(database) as unknown as (table: string) => Write;
    let during: unknown;
    const pause = vi.spyOn(database, "updateTable").mockImplementation(((table: string) => {
      const query = update(table);
      if (table !== "users") return query;
      const set = query.set.bind(query);
      vi.spyOn(query, "set").mockImplementation((values) => {
        const write = set(values);
        if ("syntheticAt" in values) {
          const where = write.where.bind(write);
          vi.spyOn(write, "where").mockImplementation((...args) => {
            const target = where(...args);
            const execute = target.execute.bind(target);
            vi.spyOn(target, "execute").mockImplementation(async () => {
              during = await oauth("fixture-existing");
              return execute();
            });
            return target;
          });
        }
        return write;
      });
      return query;
    }) as never);
    try {
      expect((await signIn(syntheticSignIn)).status).toBe(200);
    } finally {
      pause.mockRestore();
    }
    expect(during).toBeUndefined();
    const user = await database
      .selectFrom("users")
      .select(["id", "syntheticAt"])
      .where("email", "=", syntheticSignIn.email)
      .executeTakeFirstOrThrow();
    expect(user.syntheticAt).toBeInstanceOf(Date);
    // A provider link to it, however it came to exist (made in that gap before this release, or by
    // hand), opens no session; nor does a new one, which is never linked.
    await sql`insert into public.auth_accounts
      (id, account_id, provider_id, user_id, created_at, updated_at)
      values (${`aca_${crypto.randomUUID()}`}, 'fixture-existing', 'google', ${user.id}, now(),
        now())`.execute(database);
    expect(await oauth("fixture-existing")).toMatchObject({ data: null });
    expect(await oauth("fixture-new")).toMatchObject({
      error: "unable to link account",
      data: null,
    });
    // Its own sign-in still opens one.
    expect((await signIn(syntheticSignIn)).status).toBe(200);
    // App Review's password never signs in a marked Account, should its address ever be one.
    await sql`insert into public.users (id, display_name, email, email_verified, synthetic_at)
      values (${`acct_${crypto.randomUUID()}`}, 'Synthetic purchase', ${appReview.email}, true,
        now())`.execute(database);
    expect((await signIn(appReview)).status).toBe(401);
    expect(
      await database
        .selectFrom("authSessions")
        .innerJoin("users", "users.id", "authSessions.userId")
        .select("users.email")
        .where("users.email", "=", appReview.email)
        .execute(),
    ).toEqual([]);
    await database
      .deleteFrom("users")
      .where("email", "in", [syntheticSignIn.email, appReview.email])
      .execute();
  });

  it("starts a sign-in page left open past its expiry again, for every provider, never showing JSON", async () => {
    const appReview = {
      email: "appreview@opensteer.com",
      password: "review-test-password-with-at-least-24-characters",
    };
    const auth = createControlPlaneAuth(database, { ...config, appReview });
    const server = await createControlPlaneServer({
      appReviewSignIn: true,
      appleSignIn: {
        clientId: "com.opensteer.test.web",
        keyId: "ABCDE12345",
        privateKeyPem: "unused before the provider is called",
        teamId: "TEAM123456",
      },
      auth,
      authenticator: new ControlPlaneAuthenticator(auth, database, publicOrigin),
      connectLifecycle,
      portalOrigin: config.portalOrigin,
      publicOrigin,
      store,
    });
    const post = (path: string, fields: Record<string, string>) =>
      server.inject({
        method: "POST",
        url: path,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: publicOrigin.origin,
        },
        payload: new URLSearchParams(fields).toString(),
      });
    try {
      const page = await beginAuthorization(server, "", "login consent");
      page.searchParams.delete("test_verifier");
      const signed = page.search.slice(1);
      const original = new URLSearchParams(signed);
      for (const name of ["sig", "exp", "ba_iat", "ba_pl", "ba_param"]) original.delete(name);
      // The page stays open past the five minutes its signed query lasts.
      vi.useFakeTimers({ now: Date.now() + 5 * 60_000 + 1_000, toFake: ["Date"] });
      for (const [path, fields] of [
        ["/sign-in/app-review", appReview],
        ["/sign-in/google", {}],
        ["/sign-in/apple", {}],
      ] as const) {
        const late = await post(path, { ...fields, oauth_query: signed });
        expect(late.statusCode, `${path}: ${late.body}`).toBe(303);
        expect(late.body).not.toContain("invalid_signature");
        const restart = new URL(String(late.headers.location), publicOrigin);
        expect(restart.pathname).toBe("/api/auth/oauth2/authorize");
        expect(restart.searchParams.toString()).toBe(original.toString());
        // Authorize takes the original request again and hands out a fresh sign-in.
        const again = await server.inject({
          headers: { accept: "application/json" },
          method: "GET",
          url: restart.pathname + restart.search,
        });
        expect(again.statusCode, again.body).toBe(200);
        const fresh = new URL(String(again.json<{ url?: unknown }>().url), publicOrigin);
        expect(fresh.pathname).toBe(page.pathname);
        expect(Number(fresh.searchParams.get("exp"))).toBeGreaterThan(Date.now() / 1000);
      }
      // A query with no request in it to start again: the page that says so.
      const unreadable = await post("/sign-in/google", { oauth_query: "sig=invalid&exp=1" });
      expect(unreadable.statusCode).toBe(400);
      expect(unreadable.headers["content-type"]).toContain("text/html");
      expect(unreadable.body).toContain("That request expired");
      expect(unreadable.body).not.toContain("invalid_signature");
    } finally {
      vi.useRealTimers();
      await server.close();
    }
  });

  it("admits only the configured App Review credentials into a normal Account session", async () => {
    const appReview = {
      email: "appreview@opensteer.com",
      password: "review-test-password-with-at-least-24-characters",
    };
    const auth = createControlPlaneAuth(database, { ...config, appReview });
    const authenticator = new ControlPlaneAuthenticator(auth, database, publicOrigin);
    const server = await createControlPlaneServer({
      appReviewSignIn: true,
      auth,
      authenticator,
      connectLifecycle,
      portalOrigin: config.portalOrigin,
      publicOrigin,
      store,
    });
    const signIn = (
      fields: Record<string, string>,
      origin = publicOrigin.origin,
      navigate = false,
    ) =>
      server.inject({
        method: "POST",
        url: "/sign-in/app-review",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin,
          ...(navigate
            ? { accept: "text/html", "sec-fetch-mode": "navigate", "sec-fetch-site": "same-origin" }
            : {}),
        },
        payload: new URLSearchParams({ ...appReview, ...fields }).toString(),
      });
    try {
      const page = await server.inject({ method: "GET", url: "/sign-in" });
      expect(page.body).toContain("Sign in with email");
      const wrongPassword = await signIn({ password: "wrong" });
      expect(wrongPassword.statusCode).toBe(401);
      expect(wrongPassword.body).toContain("Email or password is incorrect.");
      expect(wrongPassword.body).toContain('action="/sign-in/app-review"');
      expect((await signIn({ email: "another@example.test" })).statusCode).toBe(401);
      expect((await signIn({}, "https://attacker.test.invalid")).statusCode).toBe(403);
      const direct = await auth.handler(
        new Request(new URL("/api/auth/sign-in/app-review", publicOrigin), {
          method: "POST",
          headers: { "content-type": "application/json", origin: "https://attacker.test.invalid" },
          body: JSON.stringify({ ...appReview, callbackURL: publicOrigin.origin }),
        }),
      );
      expect(direct.status).toBe(403);
      // A query that does not verify starts authorization again, which refuses
      // what a fresh request with it would be refused.
      const forged = await signIn({ oauth_query: "client_id=forged&sig=invalid" });
      expect(forged.statusCode).toBe(303);
      const forgedRestart = new URL(String(forged.headers.location), publicOrigin);
      expect(forgedRestart.pathname).toBe("/api/auth/oauth2/authorize");
      expect(forgedRestart.searchParams.toString()).toBe("client_id=forged");
      expect(
        (await server.inject({ method: "GET", url: forgedRestart.pathname + forgedRestart.search }))
          .statusCode,
      ).toBe(400);
      expect(
        await database
          .selectFrom("users")
          .select("id")
          .where("email", "!=", `owner-${accountId}@example.test`)
          .execute(),
      ).toEqual([]);

      for (const path of ["/sign-in/email", "/sign-up/email"]) {
        const refused = await server.inject({
          method: "POST",
          url: `/api/auth${path}`,
          headers: { "content-type": "application/json", origin: publicOrigin.origin },
          payload: { ...appReview, name: "Unwanted signup" },
        });
        expect(refused.statusCode).toBe(404);
      }

      const authorization = await beginAuthorization(server, "", "login consent");
      const verifier = authorization.searchParams.get("test_verifier")!;
      authorization.searchParams.delete("test_verifier");
      const signedIn = await signIn({
        email: " APPREVIEW@OPENSTEER.COM ",
        oauth_query: authorization.search.slice(1),
      });
      expect(signedIn.statusCode, signedIn.body).toBe(302);
      const cookies = [signedIn.headers["set-cookie"]]
        .flat()
        .filter((value): value is string => typeof value === "string");
      const sessionCookie = cookies.find((cookie) =>
        cookie.startsWith("__Secure-__Host-opensteer.account="),
      );
      expect(sessionCookie).toBeTruthy();
      expect(sessionCookie).toContain("HttpOnly");
      expect(sessionCookie).toContain("Secure");
      expect(sessionCookie).toContain("SameSite=Lax");
      const cookie = sessionCookie!.split(";")[0]!;
      const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
      expect(session?.user).toMatchObject({ email: appReview.email, emailVerified: true });
      const reviewerId = ControlPlaneAccountIdSchema.parse(session!.user.id);
      await expect(
        authenticator.authenticate(new Headers({ cookie }), { fresh: true }),
      ).resolves.toMatchObject({ accountId: reviewerId, kind: "session" });
      const consent = new URL(String(signedIn.headers.location), publicOrigin);
      expect(consent.pathname).toBe("/consent");
      consent.searchParams.set("test_verifier", verifier);
      const tokens = await consentAndExchange(server, cookie, consent);
      await expect(
        authenticator.authenticate(new Headers({ authorization: `Bearer ${tokens.accessToken}` })),
      ).resolves.toMatchObject({ accountId: reviewerId, kind: "bearer" });

      const browserAuthorization = await beginAuthorization(server, "", "login consent");
      browserAuthorization.searchParams.delete("test_verifier");
      const browserSignIn = await signIn(
        { oauth_query: browserAuthorization.search.slice(1) },
        publicOrigin.origin,
        true,
      );
      expect(browserSignIn.statusCode, browserSignIn.body).toBe(302);
      expect(new URL(String(browserSignIn.headers.location), publicOrigin).pathname).toBe(
        "/consent",
      );

      const returnTo = `${publicOrigin.origin}/v1/oauth-broker/launch/hoa_${crypto.randomUUID()}?ticket=${"t".repeat(43)}`;
      const hosted = await signIn({ return_to: returnTo });
      expect(hosted.statusCode, hosted.body).toBe(302);
      expect(hosted.headers.location).toBe(returnTo);
      expect(
        await database
          .selectFrom("users")
          .select("id")
          .where("email", "=", appReview.email)
          .execute(),
      ).toHaveLength(1);

      await database.deleteFrom("authRateLimits").execute();
      for (let attempt = 0; attempt < 30; attempt += 1) {
        expect((await signIn({ password: "wrong" })).statusCode).toBe(401);
      }
      expect((await signIn({})).statusCode).toBe(429);
    } finally {
      await server.close();
    }

    await database.deleteFrom("users").where("email", "=", appReview.email).execute();
    const offAuth = createControlPlaneAuth(database, config);
    const off = await createControlPlaneServer({
      auth: offAuth,
      authenticator: new ControlPlaneAuthenticator(offAuth, database, publicOrigin),
      connectLifecycle,
      portalOrigin: config.portalOrigin,
      publicOrigin,
      store,
    });
    try {
      const page = await off.inject({ method: "GET", url: "/sign-in" });
      expect(page.body).not.toContain("Sign in with email");
      for (const url of ["/sign-in/app-review", "/api/auth/sign-in/app-review"]) {
        const refused = await off.inject({
          method: "POST",
          url,
          headers: { "content-type": "application/json", origin: publicOrigin.origin },
          payload: appReview,
        });
        expect(refused.statusCode).toBe(404);
      }
      expect(
        await database
          .selectFrom("users")
          .select("id")
          .where("email", "=", appReview.email)
          .execute(),
      ).toEqual([]);
    } finally {
      await off.close();
    }
  });

  it("persists authTime, requires prompt=login step-up, and preserves it across rotation", async () => {
    const auth = createControlPlaneAuth(database, config);
    const authenticator = new ControlPlaneAuthenticator(auth, database, publicOrigin);
    const server = await createControlPlaneServer({
      auth,
      authenticator,
      connectLifecycle,
      portalOrigin: config.portalOrigin,
      publicOrigin,
      store,
    });
    try {
      const staleSession = await sessionCookie(auth, accountId);
      const staleAuthenticationTime = new Date(
        Date.now() - freshAccountSessionMilliseconds - 60_000,
      );
      await database
        .updateTable("authSessions")
        .set({ createdAt: staleAuthenticationTime })
        .where("id", "=", staleSession.sessionId)
        .executeTakeFirstOrThrow();

      const stalePage = await beginAuthorization(server, staleSession.cookie, "consent", "900");
      expect(stalePage.pathname).toBe("/sign-in");
      const staleTokens = await authorizeAndExchange(server, staleSession.cookie, "consent");
      const staleRefresh = await database
        .selectFrom("oauthRefreshToken")
        .select(["authTime", "revoked", "sessionId"])
        .where("sessionId", "=", staleSession.sessionId)
        .executeTakeFirstOrThrow();
      expect(staleRefresh.authTime?.getTime()).toBe(staleAuthenticationTime.getTime());
      expect(staleRefresh.revoked).toBeNull();
      await expect(
        authenticator.authenticate(
          new Headers({ authorization: `Bearer ${staleTokens.accessToken}` }),
          { fresh: true, scope: "account:delete" },
        ),
      ).rejects.toMatchObject({ code: "recent_sign_in_required" });
      await expect(
        authenticator.authenticate(new Headers({ cookie: staleSession.cookie }), { fresh: true }),
      ).rejects.toMatchObject({ code: "recent_sign_in_required" });

      const stepUp = await beginAuthorization(server, staleSession.cookie, "login consent");
      expect(stepUp.pathname).toBe("/sign-in");
      expect(stepUp.searchParams.get("prompt")).toBe("login consent");

      const freshSession = await sessionCookie(auth, accountId);
      const freshTokens = await consentAndExchange(server, freshSession.cookie, stepUp);
      const freshRefresh = await database
        .selectFrom("oauthRefreshToken")
        .select(["authTime", "revoked", "sessionId"])
        .where("sessionId", "=", freshSession.sessionId)
        .executeTakeFirstOrThrow();
      expect(freshRefresh.authTime?.getTime()).toBe(freshSession.createdAt.getTime());
      expect(freshRefresh.revoked).toBeNull();
      await expect(
        authenticator.authenticate(
          new Headers({ authorization: `Bearer ${freshTokens.accessToken}` }),
          { fresh: true, scope: "account:delete" },
        ),
      ).resolves.toMatchObject({ accountId, kind: "bearer" });
      await expect(
        authenticator.authenticate(new Headers({ cookie: freshSession.cookie }), { fresh: true }),
      ).resolves.toMatchObject({ accountId, kind: "session" });

      const revoke = await server.inject({
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
        payload: new URLSearchParams({
          client_id: opensteerDesktopOAuthClientId,
          resource: publicOrigin.origin,
          token: staleTokens.refreshToken,
          token_type_hint: "refresh_token",
        }).toString(),
        url: "/api/auth/oauth2/revoke",
      });
      expect(revoke.statusCode, revoke.body).toBe(200);
      const staleAfterStepUp = await database
        .selectFrom("oauthRefreshToken")
        .select(["authTime", "revoked"])
        .where("sessionId", "=", staleSession.sessionId)
        .executeTakeFirstOrThrow();
      expect(staleAfterStepUp.authTime?.getTime()).toBe(staleAuthenticationTime.getTime());
      expect(staleAfterStepUp.revoked).toBeInstanceOf(Date);

      const rotated = await refreshTokens(server, freshTokens.refreshToken);
      const activeFreshRefresh = await database
        .selectFrom("oauthRefreshToken")
        .select(["authTime", "revoked"])
        .where("sessionId", "=", freshSession.sessionId)
        .where("revoked", "is", null)
        .executeTakeFirstOrThrow();
      expect(activeFreshRefresh.authTime?.getTime()).toBe(freshSession.createdAt.getTime());
      await expect(
        authenticator.authenticate(
          new Headers({ authorization: `Bearer ${rotated.accessToken}` }),
          {
            fresh: true,
            scope: "account:delete",
          },
        ),
      ).resolves.toMatchObject({ accountId, kind: "bearer" });
    } finally {
      await server.close();
    }
  });

  it("returns a re-login redirect when consent cannot satisfy prompt=login", async () => {
    const auth = createControlPlaneAuth(database, config);
    const authenticator = new ControlPlaneAuthenticator(auth, database, publicOrigin);
    const server = await createControlPlaneServer({
      auth,
      authenticator,
      connectLifecycle,
      portalOrigin: config.portalOrigin,
      publicOrigin,
      store,
    });
    try {
      const session = await sessionCookie(auth, accountId);
      await database
        .updateTable("authSessions")
        .set({ createdAt: new Date(Date.now() - 901_000) })
        .where("id", "=", session.sessionId)
        .execute();
      const page = await beginAuthorization(server, session.cookie, "login consent");
      expect(page.pathname).toBe("/sign-in");
      page.searchParams.delete("test_verifier");
      const response = await server.inject({
        method: "POST",
        url: "/consent",
        headers: {
          cookie: session.cookie,
          origin: publicOrigin.origin,
          "content-type": "application/x-www-form-urlencoded",
        },
        payload: new URLSearchParams({
          decision: "accept",
          oauth_query: page.search.slice(1),
        }).toString(),
      });
      expect(response.statusCode, response.body).toBe(302);
      const redirect = new URL(String(response.headers.location));
      expect(redirect.origin).toBe(publicOrigin.origin);
      expect(redirect.pathname).toBe("/sign-in");
    } finally {
      await server.close();
    }
  });

  it("revokes offline credentials when the Account browser session signs out", async () => {
    const auth = createControlPlaneAuth(database, config);
    const authenticator = new ControlPlaneAuthenticator(auth, database, publicOrigin);
    const server = await createControlPlaneServer({
      auth,
      authenticator,
      connectLifecycle,
      portalOrigin: config.portalOrigin,
      publicOrigin,
      store,
    });
    try {
      const session = await sessionCookie(auth, accountId);
      const tokens = await authorizeAndExchange(server, session.cookie, "consent");
      const signOut = await server.inject({
        method: "POST",
        url: "/sign-out",
        headers: { cookie: session.cookie, origin: publicOrigin.origin },
      });
      expect(signOut.statusCode, signOut.body).toBe(303);
      expect((await requestRefresh(server, tokens.refreshToken)).statusCode).not.toBe(200);
      await expect(
        authenticator.authenticate(new Headers({ authorization: `Bearer ${tokens.accessToken}` })),
      ).rejects.toMatchObject({ code: "unauthorized" });
      expect(
        await database
          .selectFrom("oauthRefreshToken")
          .select("id")
          .where("sessionId", "=", session.sessionId)
          .execute(),
      ).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("rejects a retired native client's bearer and refresh tokens without ending the Account session", async () => {
    const auth = createControlPlaneAuth(database, config);
    const authenticator = new ControlPlaneAuthenticator(auth, database, publicOrigin);
    const server = await createControlPlaneServer({
      auth,
      authenticator,
      connectLifecycle,
      portalOrigin: config.portalOrigin,
      publicOrigin,
      store,
    });
    try {
      const session = await sessionCookie(auth, accountId);
      const tokens = await authorizeAndExchange(server, session.cookie, "consent");
      const bearer = new Headers({ authorization: `Bearer ${tokens.accessToken}` });
      await expect(authenticator.authenticate(bearer)).resolves.toMatchObject({ accountId });

      await store.ensureOfficialNativeClients({
        clients: config.nativeOAuthClients.filter(
          (client) => client.clientId !== opensteerDesktopOAuthClientId,
        ),
      });

      await expect(authenticator.authenticate(bearer)).rejects.toMatchObject({
        code: "unauthorized",
      });
      expect((await requestRefresh(server, tokens.refreshToken)).statusCode).not.toBe(200);
      await expect(
        authenticator.authenticate(new Headers({ cookie: session.cookie })),
      ).resolves.toMatchObject({ accountId, kind: "session" });
    } finally {
      await server.close();
    }
  });
});

async function authorizeAndExchange(
  server: Awaited<ReturnType<typeof createControlPlaneServer>>,
  cookie: string,
  prompt: "consent",
) {
  return consentAndExchange(server, cookie, await beginAuthorization(server, cookie, prompt));
}

async function beginAuthorization(
  server: Awaited<ReturnType<typeof createControlPlaneServer>>,
  cookie: string,
  prompt: "consent" | "login consent",
  maxAge?: string,
): Promise<URL> {
  const verifier = `desktop-pkce-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  const authorization = new URL("/api/auth/oauth2/authorize", publicOrigin);
  authorization.searchParams.set("client_id", opensteerDesktopOAuthClientId);
  authorization.searchParams.set(
    "code_challenge",
    createHash("sha256").update(verifier).digest("base64url"),
  );
  authorization.searchParams.set("code_challenge_method", "S256");
  if (maxAge || prompt === "login consent") {
    authorization.searchParams.set("max_age", maxAge ?? "0");
  }
  authorization.searchParams.set("prompt", prompt);
  authorization.searchParams.set("redirect_uri", opensteerDesktopAccountOAuthCallback);
  authorization.searchParams.set("resource", publicOrigin.origin);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("scope", opensteerAccountDeleteOAuthScopes.join(" "));
  authorization.searchParams.set("state", crypto.randomUUID());
  const response = await server.inject({
    headers: { accept: "application/json", cookie },
    method: "GET",
    url: authorization.pathname + authorization.search,
  });
  expect(response.statusCode, response.body).toBe(200);
  const page = new URL(String(response.json<{ url?: unknown }>().url), publicOrigin);
  page.searchParams.set("test_verifier", verifier);
  return page;
}

async function consentAndExchange(
  server: Awaited<ReturnType<typeof createControlPlaneServer>>,
  cookie: string,
  authorizationPage: URL,
) {
  const verifier = authorizationPage.searchParams.get("test_verifier");
  authorizationPage.searchParams.delete("test_verifier");
  expect(verifier).toBeTruthy();
  const consent = await server.inject({
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie,
      origin: publicOrigin.origin,
    },
    method: "POST",
    payload: new URLSearchParams({
      decision: "accept",
      oauth_query: authorizationPage.search.slice(1),
    }).toString(),
    url: "/consent",
  });
  expect(consent.statusCode, consent.body).toBe(302);
  const callback = new URL(String(consent.headers.location));
  expect(`${callback.protocol}${callback.pathname}`).toBe(opensteerDesktopAccountOAuthCallback);
  expect(callback.searchParams.get("iss")).toBe(publicOrigin.origin);
  const code = callback.searchParams.get("code");
  expect(code).toBeTruthy();
  const token = await server.inject({
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
    payload: new URLSearchParams({
      client_id: opensteerDesktopOAuthClientId,
      code: code ?? "",
      code_verifier: verifier ?? "",
      grant_type: "authorization_code",
      redirect_uri: opensteerDesktopAccountOAuthCallback,
      resource: publicOrigin.origin,
    }).toString(),
    url: "/api/auth/oauth2/token",
  });
  expect(token.statusCode, token.body).toBe(200);
  const body = token.json<{ access_token?: unknown; refresh_token?: unknown }>();
  expect(body).toMatchObject({
    access_token: expect.any(String),
    refresh_token: expect.any(String),
  });
  return { accessToken: String(body.access_token), refreshToken: String(body.refresh_token) };
}

async function refreshTokens(
  server: Awaited<ReturnType<typeof createControlPlaneServer>>,
  refreshToken: string,
) {
  const response = await requestRefresh(server, refreshToken);
  expect(response.statusCode, response.body).toBe(200);
  const body = response.json<{ access_token?: unknown; refresh_token?: unknown }>();
  expect(body).toMatchObject({
    access_token: expect.any(String),
    refresh_token: expect.any(String),
  });
  return { accessToken: String(body.access_token), refreshToken: String(body.refresh_token) };
}

function requestRefresh(
  server: Awaited<ReturnType<typeof createControlPlaneServer>>,
  refreshToken: string,
) {
  return server.inject({
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
    payload: new URLSearchParams({
      client_id: opensteerDesktopOAuthClientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      resource: publicOrigin.origin,
    }).toString(),
    url: "/api/auth/oauth2/token",
  });
}

async function sessionCookie(auth: ControlPlaneAuth, userId: ControlPlaneAccountId) {
  const context = await auth.$context;
  const session = await context.internalAdapter.createSession(userId);
  const signature = createHmac("sha256", config.authSecret).update(session.token).digest("base64");
  return {
    cookie: `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`,
    createdAt: new Date(session.createdAt),
    sessionId: session.id,
  };
}
