import { delay } from "@opensteer/shared/delay";
import { createHash, createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createId,
  NativeOAuthRegistrationMetadataSchema,
  opensteerHostNativeOAuthClients,
  type AuthenticatedSession,
  type NativeOAuthClient,
} from "@opensteer/core";
import { OpensteerStore, createDatabase, migrateToLatest } from "@opensteer/database";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { IdentityService } from "./identity-service.js";
import { issueLocalAdministratorPasswordRecovery } from "./operator-password-reset.js";
import type { VerifiedAccountAdoptionGrant } from "./types.js";

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const database = createDatabase({
  applicationName: "opensteer-identity-integration-test",
  connectionString: databaseUrl ?? "postgres://unconfigured",
  maxConnections: 4,
});
const hostKeyFingerprint = `sha256:${"A".repeat(43)}`;

integration("IdentityService", () => {
  beforeAll(async () => {
    await migrateToLatest(database);
  });

  beforeEach(async () => {
    await sql`
      truncate table
        personal_remote_session_grant_uses,
        personal_remote_sessions,
        personal_remote_pairing_codes,
        personal_remote_account_link,
        account_directory_projections,
        account_directory_provider,
        host_account_adoption_proofs,
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
        users,
        deployments
      restart identity cascade
    `.execute(database);
    await database
      .updateTable("personalRemoteAccess")
      .set({ generation: 0, mode: "off", routeOrigin: null, updatedAt: new Date() })
      .where("singletonKey", "=", "personal")
      .executeTakeFirstOrThrow();
    await sql`
      insert into principals(id, kind, user_id, display_name)
      values ('pri_00000000-0000-4000-8000-000000000001', 'system', null, 'Opensteer')
      on conflict (id) do nothing
    `.execute(database);
  });

  afterAll(async () => {
    await database.destroy();
  });

  it("creates a token-free password session with idle and absolute policy", async () => {
    const identity = new IdentityService(database, {
      deployment: { cloud: false, kind: "self-hosted", name: null },
      localPasswordEnabled: true,
      oidcProviders: [],
      publicOrigin: new URL("http://127.0.0.1:4310"),
      secret: "identity-test-secret-that-is-at-least-thirty-two-bytes",
      exposure: "networked",
      signupPolicy: "open",
    });
    const requestHeaders = new Headers({
      origin: "http://127.0.0.1:4310",
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    });
    const result = await identity.signUpPassword(
      {
        displayName: "Alice",
        email: "ALICE@example.com",
        password: "correct horse battery staple",
      },
      requestHeaders,
    );

    expect(result.data.session.user.email).toBe("alice@example.com");
    expect(JSON.stringify(result.data)).not.toMatch(/token/i);
    const setCookie = result.headers
      .getSetCookie()
      .find((value) => value.includes("opensteer.session"));
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");

    for (const email of ["alice@example.com", "missing@example.com"]) {
      await expect(
        identity.signInPassword({ email, password: "definitely not the password" }, requestHeaders),
      ).rejects.toMatchObject({
        code: "unauthorized",
        message: "Email or password is incorrect",
      });
    }

    const cookieHeaders = new Headers(requestHeaders);
    cookieHeaders.set("cookie", setCookie!.split(";", 1)[0]!);
    const authenticated = await identity.authenticate(cookieHeaders);
    expect(authenticated?.user.id).toBe(result.data.session.user.id);

    const stored = await database
      .selectFrom("authSessions")
      .selectAll()
      .where("id", "=", result.data.session.id)
      .executeTakeFirstOrThrow();
    expect(stored.absoluteExpiresAt.getTime() - stored.createdAt.getTime()).toBe(
      30 * 24 * 60 * 60 * 1_000,
    );
    // Frozen 1.6 cookie format: URL-encoded token + base64 HMAC-SHA256.
    const signature = createHmac("sha256", "identity-test-secret-that-is-at-least-thirty-two-bytes")
      .update(stored.token)
      .digest("base64");
    const upgraded = identityService({ publicOrigin: new URL("https://host.example.com") });
    await expect(
      upgraded.authenticate(
        new Headers({
          cookie: `__Host-opensteer.session=${encodeURIComponent(`${stored.token}.${signature}`)}`,
          origin: "https://host.example.com",
        }),
      ),
    ).resolves.toMatchObject({ id: stored.id, user: { id: stored.userId } });
    // The stored label is what a person would call the device, not the header.
    expect(stored.deviceLabel).toBe("Chrome on Mac");
    expect(stored).toMatchObject({
      accountIssuer: null,
      accountSubject: null,
      createdVia: null,
      grantId: null,
    });

    expect(await identity.listSessions(result.data.session)).toEqual([
      expect.objectContaining({
        current: true,
        deviceLabel: "Chrome on Mac",
        form: "computer",
        id: result.data.session.id,
        machineLocal: false,
      }),
    ]);
  });

  it("lets the local operator issue one-use browser recovery and revokes every session", async () => {
    const endedSessions: string[] = [];
    const identity = new IdentityService(database, {
      deployment: { cloud: false, kind: "self-hosted", name: null },
      localPasswordEnabled: true,
      onSessionEnded: (sessionId) => endedSessions.push(sessionId),
      oidcProviders: [],
      publicOrigin: new URL("http://127.0.0.1:4310"),
      secret: "identity-test-secret-that-is-at-least-thirty-two-bytes",
      exposure: "loopback",
      signupPolicy: "open",
    });
    const requestHeaders = new Headers({
      origin: "http://127.0.0.1:4310",
      "user-agent": "Opensteer recovery integration test",
    });
    const first = await identity.signUpPassword(
      {
        displayName: "Local Owner",
        email: "owner@example.com",
        password: "forgotten local password",
      },
      requestHeaders,
    );
    await database
      .updateTable("users")
      .set({ instanceRole: "administrator" })
      .where("id", "=", first.data.session.user.id)
      .executeTakeFirstOrThrow();
    const second = await identity.signInPassword(
      { email: "owner@example.com", password: "forgotten local password" },
      requestHeaders,
    );

    const recovery = await issueLocalAdministratorPasswordRecovery(database, {
      publicOrigin: new URL("http://127.0.0.1:4310"),
    });
    expect(recovery).toMatchObject({ email: "owner@example.com" });
    expect(recovery.url.pathname).toBe("/recover");
    expect(recovery.url.search).toBe("");
    const token = new URLSearchParams(recovery.url.hash.slice(1)).get("token");
    expect(token).toMatch(/^olpr_[A-Za-z0-9_-]{43}$/u);

    await identity.resetPasswordWithOperatorRecovery(token!, "replacement local password");
    expect(new Set(endedSessions)).toEqual(
      new Set([first.data.session.id, second.data.session.id]),
    );
    await expect(
      identity.signInPassword(
        { email: "owner@example.com", password: "forgotten local password" },
        requestHeaders,
      ),
    ).rejects.toMatchObject({ code: "unauthorized" });
    await expect(
      identity.signInPassword(
        { email: "owner@example.com", password: "replacement local password" },
        requestHeaders,
      ),
    ).resolves.toMatchObject({ data: { session: { user: { email: "owner@example.com" } } } });
    await expect(
      database
        .selectFrom("authSessions")
        .select("id")
        .where("id", "in", [first.data.session.id, second.data.session.id])
        .execute(),
    ).resolves.toEqual([]);
    await expect(
      identity.resetPasswordWithOperatorRecovery(token!, "another replacement password"),
    ).rejects.toMatchObject({ code: "unauthorized" });
    await expect(
      database
        .selectFrom("securityAudit")
        .select("action")
        .where("targetId", "=", first.data.session.user.id)
        .where("action", "in", [
          "auth.password-recovery-issued-by-local-operator",
          "auth.password-reset-by-local-operator",
        ])
        .orderBy("createdAt", "asc")
        .execute(),
    ).resolves.toEqual([
      { action: "auth.password-recovery-issued-by-local-operator" },
      { action: "auth.password-reset-by-local-operator" },
    ]);
  });

  it("requires a browser-bound admission when signup is invite-only", async () => {
    const identity = new IdentityService(database, {
      deployment: { cloud: false, kind: "self-hosted", name: null },
      localPasswordEnabled: true,
      oidcProviders: [],
      publicOrigin: new URL("http://127.0.0.1:4310"),
      secret: "identity-test-secret-that-is-at-least-thirty-two-bytes",
      exposure: "networked",
      signupPolicy: "invite-only",
    });
    await expect(
      identity.signUpPassword(
        {
          displayName: "Mallory",
          email: "mallory@example.com",
          password: "correct horse battery staple",
        },
        new Headers({ origin: "http://127.0.0.1:4310" }),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(await database.selectFrom("users").select("id").execute()).toEqual([]);
  });

  it("completes OIDC discovery, PKCE, token exchange, userinfo, and an encrypted account session", async () => {
    const accessToken = "fixture-access-token-that-must-not-be-stored-in-plaintext";
    let expectedCodeChallenge: string | null = null;
    let tokenRequest:
      | {
          readonly authorization: string | undefined;
          readonly body: URLSearchParams;
        }
      | undefined;
    let userinfoAuthorization: string | undefined;
    const handleIssuerRequest = async (
      request: IncomingMessage,
      response: ServerResponse,
    ): Promise<void> => {
      const origin = `http://127.0.0.1:${(issuer.address() as AddressInfo).port}`;
      if (request.method === "GET" && request.url === "/.well-known/openid-configuration") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            authorization_endpoint: `${origin}/authorize`,
            issuer: origin,
            jwks_uri: `${origin}/jwks`,
            token_endpoint: `${origin}/token`,
            userinfo_endpoint: `${origin}/userinfo`,
          }),
        );
        return;
      }
      if (request.method === "POST" && request.url === "/token") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        tokenRequest = { authorization: request.headers.authorization, body };
        const challenge = createHash("sha256")
          .update(body.get("code_verifier") ?? "")
          .digest("base64url");
        if (
          expectedCodeChallenge === null ||
          challenge !== expectedCodeChallenge ||
          body.get("code") !== "fixture-code"
        ) {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            access_token: accessToken,
            expires_in: 3_600,
            token_type: "Bearer",
          }),
        );
        return;
      }
      if (request.method === "GET" && request.url === "/userinfo") {
        userinfoAuthorization = request.headers.authorization;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            email: "oidc-user@example.com",
            email_verified: true,
            name: "OIDC User",
            sub: "fixture-oidc-subject",
          }),
        );
        return;
      }
      response.statusCode = 404;
      response.end();
    };
    const issuer = createServer((request, response) => {
      void handleIssuerRequest(request, response).catch((error: unknown) =>
        response.destroy(error instanceof Error ? error : new Error("OIDC issuer failed")),
      );
    });
    await new Promise<void>((resolve, reject) => {
      issuer.once("error", reject);
      issuer.listen(0, "127.0.0.1", resolve);
    });
    try {
      const issuerOrigin = `http://127.0.0.1:${(issuer.address() as AddressInfo).port}`;
      const publicOrigin = "http://127.0.0.1:4310";
      const configuredIssuerIdentity = identityService({
        localPasswordEnabled: false,
        oidcProviders: [
          {
            allowPrivateNetwork: false,
            clientId: "opensteer-test-client",
            clientSecret: "opensteer-test-client-secret",
            issuer: issuerOrigin,
            label: "Configured private SSO",
            providerId: "configured",
            trustedOrigins: [],
          },
        ],
        exposure: "networked",
        signupPolicy: "open",
      });
      const configuredIssuer = await configuredIssuerIdentity.beginOidcSignIn({
        headers: new Headers({ origin: publicOrigin }),
        providerId: "configured",
        returnPath: "/",
      });
      expect(configuredIssuer.status).toBe(200);
      expect(new URL(configuredIssuer.data.redirectUrl).origin).toBe(issuerOrigin);

      const managedProviderId = `oidc.enterprise.${createHash("sha256")
        .update(issuerOrigin)
        .digest("base64url")
        .slice(0, 22)}`;
      const identity = identityService({
        localPasswordEnabled: false,
        managedOwner: {
          accountId: "fixture-oidc-subject",
          displayName: "OIDC User",
          email: "oidc-user@example.com",
          providerId: managedProviderId,
        },
        oidcProviders: [
          {
            allowPrivateNetwork: true,
            clientId: "opensteer-test-client",
            clientSecret: "opensteer-test-client-secret",
            issuer: issuerOrigin,
            label: "Company SSO",
            providerId: "enterprise",
            trustedOrigins: [],
          },
        ],
        nativeOAuth: {
          clients: [
            nativeClient({
              clientId: "opensteer-desktop-beta",
              redirectUris: ["com.steerlabs.opensteer.beta:/oauth/host-callback"],
            }),
          ],
        },
        exposure: "networked",
        signupPolicy: "invite-only",
      });
      await identity.initialize();
      const nativeAuthorization = new URL("/v1/auth/native/oauth2/authorize", publicOrigin);
      nativeAuthorization.searchParams.set("client_id", "opensteer-desktop-beta");
      nativeAuthorization.searchParams.set(
        "code_challenge",
        createHash("sha256")
          .update("oidc-native-pkce-verifier-with-at-least-forty-three-characters")
          .digest("base64url"),
      );
      nativeAuthorization.searchParams.set("code_challenge_method", "S256");
      nativeAuthorization.searchParams.set(
        "redirect_uri",
        "com.steerlabs.opensteer.beta:/oauth/host-callback",
      );
      nativeAuthorization.searchParams.set("response_type", "code");
      nativeAuthorization.searchParams.set(
        "scope",
        "openid profile email offline_access host:access",
      );
      nativeAuthorization.searchParams.set("state", "oidc-native-state");
      const nativePrompt = await identity.handleNativeOAuthRequest(
        new Request(nativeAuthorization, { headers: { accept: "application/json" } }),
      );
      expect(nativePrompt.status).toBe(200);
      const nativePromptBody = (await nativePrompt.json()) as { url?: unknown };
      const nativeLoginUrl = new URL(String(nativePromptBody.url), publicOrigin);
      expect(nativeLoginUrl.pathname).toBe("/");
      const nativeOAuthQuery = nativeLoginUrl.search.slice(1);
      expect(nativeOAuthQuery).toContain("sig=");
      const started = await identity.beginOidcSignIn({
        headers: new Headers({ origin: publicOrigin, "user-agent": "OIDC integration test" }),
        oauthQuery: nativeOAuthQuery,
        providerId: "enterprise",
        returnPath: "/",
      });
      const authorizationUrl = new URL(started.data.redirectUrl);
      expect(authorizationUrl.origin).toBe(issuerOrigin);
      expect(authorizationUrl.pathname).toBe("/authorize");
      expect(authorizationUrl.searchParams.get("client_id")).toBe("opensteer-test-client");
      expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
        `${publicOrigin}/v1/auth/oidc/callback`,
      );
      expectedCodeChallenge = authorizationUrl.searchParams.get("code_challenge");
      const state = authorizationUrl.searchParams.get("state");
      expect(expectedCodeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(state).toBeTruthy();

      const callback = await identity.handleOidcCallback(
        new Request(
          `${publicOrigin}/v1/auth/oidc/callback?code=fixture-code&state=${encodeURIComponent(state ?? "")}`,
          {
            headers: {
              accept: "text/html",
              cookie: cookieHeader(started.headers),
              "sec-fetch-mode": "navigate",
              "user-agent": "OIDC integration test",
            },
          },
        ),
      );
      expect(callback.status).toBe(302);
      const nativeConsentUrl = new URL(callback.headers.get("location") ?? "");
      expect(nativeConsentUrl.origin).toBe(publicOrigin);
      expect(nativeConsentUrl.pathname).toBe("/");
      expect(nativeConsentUrl.searchParams.get("sig")).toBeTruthy();
      expect(nativeConsentUrl.searchParams.get("client_id")).toBe("opensteer-desktop-beta");
      expect(tokenRequest?.authorization).toBe(
        `Basic ${Buffer.from("opensteer-test-client:opensteer-test-client-secret").toString("base64")}`,
      );
      expect(tokenRequest?.body.get("grant_type")).toBe("authorization_code");
      expect(tokenRequest?.body.get("redirect_uri")).toBe(`${publicOrigin}/v1/auth/oidc/callback`);
      expect(userinfoAuthorization).toBe(`Bearer ${accessToken}`);

      const authenticated = await identity.authenticate(
        new Headers({ cookie: sessionCookieHeader(callback.headers) }),
      );
      expect(authenticated).toMatchObject({
        user: {
          displayName: "OIDC User",
          email: "oidc-user@example.com",
          instanceRole: "administrator",
        },
      });
      const account = await database
        .selectFrom("authAccounts")
        .select(["accessToken", "accountId", "providerId", "refreshToken"])
        .executeTakeFirstOrThrow();
      expect(account).toMatchObject({
        accountId: "fixture-oidc-subject",
        providerId: managedProviderId,
        refreshToken: null,
      });
      expect(account.accessToken).toMatch(/^(?:\$ba\$|[a-f0-9]{96,})/u);
      expect(account.accessToken).not.toContain(accessToken);
    } finally {
      await new Promise<void>((resolve, reject) => {
        issuer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("declares a machine owner only for a seeded owner nobody can sign in as", async () => {
    await expect(identityService().configuration()).resolves.toMatchObject({
      machineOwner: false,
    });
    const localMachineOwner = {
      displayName: "You",
      email: "owner@personal.opensteer.invalid",
    } as const;
    await expect(
      identityService({
        exposure: "loopback",
        localMachineOwner,
        localPasswordEnabled: false,
      }).configuration(),
    ).resolves.toMatchObject({ machineOwner: true });
    // Password sign-in turns the seeded owner into an account a person holds,
    // so the Deployment has a real identity to name again.
    await expect(
      identityService({
        exposure: "loopback",
        localMachineOwner,
        localPasswordEnabled: true,
      }).configuration(),
    ).resolves.toMatchObject({ machineOwner: false });
  });

  it("publishes the apex portal origin only when the Deployment declares one", async () => {
    await expect(identityService().configuration()).resolves.toMatchObject({
      deployment: { cloud: false, kind: "self-hosted", name: null },
      portalOrigin: null,
    });
    await expect(
      identityService({ portalOrigin: new URL("https://beta.opensteer.com") }).configuration(),
    ).resolves.toMatchObject({ portalOrigin: "https://beta.opensteer.com" });
  });

  it("pins managed owner bootstrap to the durable upstream account", async () => {
    const managedOwner = {
      accountId: "acct_00000000-0000-4000-8000-000000000001",
      displayName: "Managed Owner",
      email: "managed-owner@example.com",
      providerId: "oidc.opensteer-account.fixture",
    } as const;
    const identity = identityService({ managedOwner });
    await identity.initialize();
    await expect(identity.initialize()).resolves.toBeUndefined();

    await expect(identity.configuration()).resolves.toMatchObject({ setupState: "complete" });
    await expect(
      database
        .selectFrom("authAccounts")
        .innerJoin("users", "users.id", "authAccounts.userId")
        .select([
          "authAccounts.accountId",
          "authAccounts.providerId",
          "users.email",
          "users.instanceRole",
        ])
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      accountId: managedOwner.accountId,
      email: managedOwner.email,
      instanceRole: "administrator",
      providerId: managedOwner.providerId,
    });
    await expect(
      database
        .selectFrom("securityAudit")
        .select("action")
        .where("action", "=", "instance.managed-owner-provisioned")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ action: "instance.managed-owner-provisioned" });

    await expect(
      identityService({
        managedOwner: { ...managedOwner, accountId: "acct_other-durable-owner" },
      }).initialize(),
    ).rejects.toThrow(/does not match durable Host authority/u);
    await expect(
      identityService({
        initialOwnerEnrollment: {
          expiresAt: new Date(Date.now() + 60_000),
          token: "managed-owner-must-not-also-have-a-setup-token",
        },
        managedOwner,
      }).initialize(),
    ).rejects.toThrow(/cannot be combined/u);
  });

  it("issues and consumes one Account adoption proof bound to live Host authority", async () => {
    const origin = "http://127.0.0.1:4310";
    const store = new OpensteerStore(database);
    const deployment = await store.ensureDeployment({
      canonicalOrigin: origin,
      deploymentId: createId("deployment"),
      hostInstanceId: createId("hostInstance"),
      deploymentShape: {
        defaultWorkspaceBacking: "local-directory",
        kind: "server" as const,
      },
    });
    const identity = identityService({ signupPolicy: "open" });
    const signedUp = await identity.signUpPassword(
      {
        displayName: "Local Administrator",
        email: "local-admin@example.com",
        password: "correct horse battery staple",
      },
      new Headers({ origin }),
    );
    await database
      .updateTable("users")
      .set({ instanceRole: "administrator" })
      .where("id", "=", signedUp.data.session.user.id)
      .executeTakeFirstOrThrow();
    const headers = new Headers({ cookie: cookieHeader(signedUp.headers), origin });
    const session = await identity.requireSession(headers);
    const account = {
      issuer: "https://account.opensteer.example",
      subject: "acct_00000000-0000-4000-8000-000000000001",
    };

    const issued = await identity.issueAccountAdoptionProof(session, account);
    expect(issued).toMatchObject({
      account,
      deployment: {
        canonicalOrigin: origin,
        deploymentId: deployment.id,
        hostInstanceId: deployment.activeHostInstanceId,
      },
    });
    expect(issued.proofId).toMatch(/^hap_/u);
    expect(issued.proofCredential).toMatch(/^oap_/u);
    const stored = await database
      .selectFrom("hostAccountAdoptionProofs")
      .select(["credentialHash", "expectedIssuer", "expectedSubject"])
      .where("id", "=", issued.proofId)
      .executeTakeFirstOrThrow();
    expect(stored.credentialHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(stored.credentialHash).not.toContain(issued.proofCredential);
    expect(stored).toMatchObject({
      expectedIssuer: account.issuer,
      expectedSubject: account.subject,
    });

    const expectedDeployment = issued.deployment;
    await expect(
      identity.consumeAccountAdoptionProof({
        expectedAccount: { ...account, subject: "acct_00000000-0000-4000-8000-000000000002" },
        expectedDeployment,
        proofCredential: issued.proofCredential,
        proofId: issued.proofId,
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    const consumed = await identity.consumeAccountAdoptionProof({
      expectedAccount: account,
      expectedDeployment,
      proofCredential: issued.proofCredential,
      proofId: issued.proofId,
    });
    expect(consumed).toMatchObject({
      account,
      authorizedBy: { sessionId: session.id, userId: session.user.id },
      deployment: expectedDeployment,
      proofId: issued.proofId,
    });
    await expect(
      identity.consumeAccountAdoptionProof({
        expectedAccount: account,
        expectedDeployment,
        proofCredential: issued.proofCredential,
        proofId: issued.proofId,
      }),
    ).resolves.toEqual(consumed);
    await expect(
      identity.consumeAccountAdoptionProof({
        expectedAccount: account,
        expectedDeployment: {
          ...expectedDeployment,
          hostInstanceId: createId("hostInstance"),
        },
        proofCredential: issued.proofCredential,
        proofId: issued.proofId,
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    await expect(identity.completeAccountAdoption(consumed, session)).rejects.toMatchObject({
      code: "not_found",
      message: "Account attachment completion is not configured",
    });

    const stale = await identity.issueAccountAdoptionProof(session, account);
    await database
      .updateTable("deployments")
      .set({ activeHostInstanceId: createId("hostInstance") })
      .where("id", "=", deployment.id)
      .executeTakeFirstOrThrow();
    await expect(
      identity.consumeAccountAdoptionProof({
        expectedAccount: account,
        expectedDeployment: stale.deployment,
        proofCredential: stale.proofCredential,
        proofId: stale.proofId,
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("atomically binds only a verified Account grant to the existing administrator", async () => {
    const origin = "http://127.0.0.1:4310";
    const store = new OpensteerStore(database);
    await store.ensureDeployment({
      canonicalOrigin: origin,
      deploymentId: createId("deployment"),
      hostInstanceId: createId("hostInstance"),
      deploymentShape: {
        defaultWorkspaceBacking: "local-directory",
        kind: "server" as const,
      },
    });
    let verifiedGrant: VerifiedAccountAdoptionGrant | undefined;
    const identity = identityService({
      accountAdoption: {
        grantVerifier: {
          async verify() {
            if (!verifiedGrant) throw new Error("Missing fixture grant");
            return verifiedGrant;
          },
        },
        logicalProviderId: "opensteer-account",
      },
      signupPolicy: "open",
    });
    const signedUp = await identity.signUpPassword(
      {
        displayName: "Existing Administrator",
        email: "existing-local-email@example.com",
        password: "correct horse battery staple",
      },
      new Headers({ origin }),
    );
    await database
      .updateTable("users")
      .set({ instanceRole: "administrator" })
      .where("id", "=", signedUp.data.session.user.id)
      .executeTakeFirstOrThrow();
    const session = await identity.requireSession(
      new Headers({ cookie: cookieHeader(signedUp.headers), origin }),
    );
    const account = {
      issuer: "https://account.opensteer.example",
      subject: "acct_00000000-0000-4000-8000-000000000001",
    };
    const issued = await identity.issueAccountAdoptionProof(session, account);
    const consumed = await identity.consumeAccountAdoptionProof({
      expectedAccount: account,
      expectedDeployment: issued.deployment,
      proofCredential: issued.proofCredential,
      proofId: issued.proofId,
    });
    verifiedGrant = {
      ...consumed,
      expiresAt: new Date(Date.now() + 5 * 60_000),
      grantId: `hag_${crypto.randomUUID()}`,
      issuedAt: new Date(),
    };

    const attached = await identity.completeAccountAdoption("signed-control-plane-grant", session);
    expect(attached).toMatchObject({ account, userId: session.user.id });
    expect(attached.providerId).toMatch(/^oidc\.opensteer-account\./u);
    await expect(
      database
        .selectFrom("authAccounts")
        .select(["accountId", "providerId", "userId"])
        .where("providerId", "=", attached.providerId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      accountId: account.subject,
      providerId: attached.providerId,
      userId: session.user.id,
    });
    await expect(
      database
        .selectFrom("users")
        .select("email")
        .where("id", "=", session.user.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ email: "existing-local-email@example.com" });
    await expect(
      identity.completeAccountAdoption("replayed-control-plane-grant", session),
    ).resolves.toEqual(attached);
    verifiedGrant = {
      ...verifiedGrant,
      account: { ...verifiedGrant.account, subject: "acct_00000000-0000-4000-8000-000000000002" },
    };
    await expect(
      identity.completeAccountAdoption("altered-control-plane-grant", session),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("replaces stale browser session cookies when signing in again", async () => {
    const identity = new IdentityService(database, {
      deployment: { cloud: false, kind: "self-hosted", name: null },
      localPasswordEnabled: true,
      oidcProviders: [],
      publicOrigin: new URL("http://127.0.0.1:4310"),
      secret: "identity-test-secret-that-is-at-least-thirty-two-bytes",
      exposure: "networked",
      signupPolicy: "open",
    });
    const requestHeaders = new Headers({
      origin: "http://127.0.0.1:4310",
      "user-agent": "Opensteer identity integration test",
    });
    await identity.signUpPassword(
      {
        displayName: "Alice",
        email: "alice@example.com",
        password: "correct horse battery staple",
      },
      requestHeaders,
    );
    const staleCookieHeaders = new Headers(requestHeaders);
    staleCookieHeaders.set(
      "cookie",
      "opensteer.session=invalid.stale.token%3D; opensteer.admission=old.admission",
    );
    const signedIn = await identity.signInPassword(
      { email: "alice@example.com", password: "correct horse battery staple" },
      staleCookieHeaders,
    );
    expect(signedIn.data.session.user.email).toBe("alice@example.com");
  });

  it("reports the exact browser session after sign-out commits", async () => {
    const endedSessions: string[] = [];
    const identity = identityService({
      onSessionEnded: (sessionId) => endedSessions.push(sessionId),
      signupPolicy: "open",
    });
    const signedUp = await identity.signUpPassword(
      {
        displayName: "Signed Out User",
        email: "signed-out@example.com",
        password: "correct horse battery staple",
      },
      new Headers({ origin: "http://127.0.0.1:4310" }),
    );

    await identity.signOut(new Headers({ cookie: cookieHeader(signedUp.headers) }));

    expect(endedSessions).toEqual([signedUp.data.session.id]);
  });

  it("completes native authorization-code login with S256 PKCE and session-bound tokens", async () => {
    const origin = "http://127.0.0.1:4310";
    const clientId = "opensteer-desktop-test";
    const redirectUri = "com.opensteer.opensteer:/oauth/callback";
    const endedSessions: string[] = [];
    const identity = identityService({
      nativeOAuth: { clients: [nativeClient({ clientId, redirectUris: [redirectUri] })] },
      onSessionEnded: (sessionId) => endedSessions.push(sessionId),
      signupPolicy: "open",
    });
    await identity.initialize();
    await identity.signUpPassword(
      {
        displayName: "Native User",
        email: "native@example.com",
        password: "correct horse battery staple",
      },
      new Headers({ origin }),
    );

    for (const metadata of [
      identity.nativeOpenIdConfiguration(),
      identity.nativeOAuthAuthorizationServerMetadata(),
    ]) {
      expect(metadata).not.toBeNull();
      const response = await metadata!(new Request(`${origin}/.well-known/openid-configuration`));
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.issuer).toBe(origin);
      expect(body.authorization_endpoint).toBe(`${origin}/v1/auth/native/oauth2/authorize`);
      expect(body.token_endpoint).toBe(`${origin}/v1/auth/native/oauth2/token`);
      expect(body.jwks_uri).toBe(`${origin}/v1/auth/native/jwks`);
      expect(JSON.stringify(body)).not.toContain("/internal/better-auth");
    }

    const login = await nativeOAuthLogin(identity, {
      clientId,
      email: "native@example.com",
      origin,
      redirectUri,
      state: "native-state",
    });
    expect(login.consentPage.origin).toBe(origin);
    expect(login.callback.origin).toBe("null");
    expect(login.callback.protocol).toBe("com.opensteer.opensteer:");
    expect(login.callback.searchParams.get("state")).toBe("native-state");
    expect(login.tokens.token_type).toBe("Bearer");
    expect(login.tokens.refresh_token).toEqual(expect.any(String));
    await expect(
      identity.authenticateNativeAccessToken(login.tokens.access_token),
    ).resolves.toMatchObject({
      application: "desktop",
      clientId,
      sessionId: login.session.id,
      subject: login.session.user.id,
    });

    // A 1.6 refresh row has no resource/code binding or rotation metadata.
    const legacyRefreshToken = "legacy-refresh-token-created-before-upgrade";
    await database
      .updateTable("hostOAuthRefreshTokens")
      .set({
        token: createHash("sha256").update(legacyRefreshToken).digest("base64url"),
        resources: null,
        authorizationCodeId: null,
        requestedUserInfoClaims: null,
      })
      .where("sessionId", "=", login.session.id)
      .execute();
    const refreshed = await identity.handleNativeOAuthRequest(
      new Request(`${origin}/v1/auth/native/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          grant_type: "refresh_token",
          refresh_token: legacyRefreshToken,
          resource: origin,
          scope: "openid profile email offline_access host:access",
        }),
      }),
    );
    expect(refreshed.status, await refreshed.clone().text()).toBe(200);
    const refreshedTokens = (await refreshed.json()) as {
      access_token: string;
      refresh_token: string;
      id_token: string;
    };
    await expect(
      identity.authenticateNativeAccessToken(refreshedTokens.access_token),
    ).resolves.toMatchObject({ sessionId: login.session.id });
    const claims = JSON.parse(
      Buffer.from(refreshedTokens.id_token.split(".")[1]!, "base64url").toString(),
    );
    expect(claims).toMatchObject({
      sub: login.session.user.id,
      sid: login.session.id,
      aud: clientId,
    });
    expect(claims).not.toHaveProperty("email");
    expect(claims).not.toHaveProperty("name");
    const userinfo = await identity.handleNativeOAuthRequest(
      new Request(`${origin}/v1/auth/native/oauth2/userinfo`, {
        headers: { authorization: `Bearer ${refreshedTokens.access_token}` },
      }),
    );
    expect(userinfo.status, await userinfo.clone().text()).toBe(200);
    expect(await userinfo.json()).toMatchObject({
      sub: login.session.user.id,
      email: "native@example.com",
      name: "Native User",
    });
    const revokeJwt = await identity.handleNativeOAuthRequest(
      new Request(`${origin}/v1/auth/native/oauth2/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          token: refreshedTokens.access_token,
          token_type_hint: "access_token",
        }),
      }),
    );
    expect(revokeJwt.status).toBe(400);
    expect(await revokeJwt.json()).toMatchObject({ error: "unsupported_token_type" });
    await expect(
      identity.authenticateNativeAccessToken(refreshedTokens.access_token),
    ).resolves.toMatchObject({ sessionId: login.session.id });

    await identity.revokeSession(login.session, login.session.id);
    expect(endedSessions).toEqual([login.session.id]);
    await expect(
      identity.authenticateNativeAccessToken(login.tokens.access_token),
    ).rejects.toMatchObject({
      code: "unauthorized",
    });
    await expect(
      database.selectFrom("hostOAuthRefreshTokens").select("id").execute(),
    ).resolves.toHaveLength(0);
  });

  it("registers every configured application and names the one a token belongs to", async () => {
    const origin = "http://127.0.0.1:4310";
    const identity = identityService({
      nativeOAuth: { clients: opensteerHostNativeOAuthClients },
      signupPolicy: "open",
    });
    await identity.initialize();
    await expect(
      database
        .selectFrom("hostOAuthClients")
        .select(["clientId", "disabled", "name", "redirectUris", "referenceId", "softwareId"])
        .orderBy("clientId")
        .execute(),
    ).resolves.toEqual(
      [...opensteerHostNativeOAuthClients]
        .sort((left, right) => left.clientId.localeCompare(right.clientId))
        .map((client) => ({
          clientId: client.clientId,
          disabled: false,
          name: client.displayName,
          redirectUris: client.redirectUris,
          referenceId: `opensteer-native-client:${client.clientId}`,
          softwareId: client.softwareId,
        })),
    );

    await identity.signUpPassword(
      {
        displayName: "Phone User",
        email: "phone@example.com",
        password: "correct horse battery staple",
      },
      new Headers({ origin }),
    );
    const mobile = opensteerHostNativeOAuthClients.find(
      (client) => client.application === "mobile",
    )!;
    const login = await nativeOAuthLogin(identity, {
      clientId: mobile.clientId,
      email: "phone@example.com",
      origin,
      redirectUri: mobile.redirectUris[0]!,
      state: "mobile-state",
    });
    await expect(
      identity.authenticateNativeAccessToken(login.tokens.access_token),
    ).resolves.toMatchObject({ application: "mobile", clientId: mobile.clientId });
  });

  it("adds an application on restart without disturbing the registration already in use", async () => {
    const origin = "http://127.0.0.1:4310";
    const desktop = opensteerHostNativeOAuthClients.find(
      (client) => client.application === "desktop",
    )!;
    const before = identityService({ nativeOAuth: { clients: [desktop] }, signupPolicy: "open" });
    await before.initialize();
    await before.signUpPassword(
      {
        displayName: "Desk User",
        email: "desk@example.com",
        password: "correct horse battery staple",
      },
      new Headers({ origin }),
    );
    const login = await nativeOAuthLogin(before, {
      clientId: desktop.clientId,
      email: "desk@example.com",
      origin,
      redirectUri: desktop.redirectUris[0]!,
      state: "desktop-state",
    });
    const registration = await database
      .selectFrom("hostOAuthClients")
      .select(["id", "createdAt"])
      .where("clientId", "=", desktop.clientId)
      .executeTakeFirstOrThrow();
    const grants = await database
      .selectFrom("hostOAuthRefreshTokens")
      .select(["id", "clientId"])
      .execute();
    expect(grants).toHaveLength(1);

    const after = identityService({
      nativeOAuth: { clients: opensteerHostNativeOAuthClients },
      signupPolicy: "open",
    });
    await after.initialize();

    await expect(
      database
        .selectFrom("hostOAuthClients")
        .select(["clientId", "createdAt", "disabled", "id"])
        .where("clientId", "=", desktop.clientId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      clientId: desktop.clientId,
      createdAt: registration.createdAt,
      disabled: false,
      id: registration.id,
    });
    await expect(
      database.selectFrom("hostOAuthRefreshTokens").select(["id", "clientId"]).execute(),
    ).resolves.toEqual(grants);
    await expect(
      after.authenticateNativeAccessToken(login.tokens.access_token),
    ).resolves.toMatchObject({
      application: "desktop",
      clientId: desktop.clientId,
      sessionId: login.session.id,
    });
  });

  it("keeps the signed Beta desktop registration active across the mobile registry upgrade", async () => {
    const origin = "http://127.0.0.1:4310";
    const beta: NativeOAuthClient = {
      application: "desktop",
      clientId: "opensteer-desktop-beta",
      displayName: "Opensteer Beta",
      redirectUris: ["com.steerlabs.opensteer.beta:/oauth/host-callback"],
      softwareId: "opensteer-native",
    };
    const before = identityService({ nativeOAuth: { clients: [beta] }, signupPolicy: "open" });
    await before.initialize();
    await before.signUpPassword(
      {
        displayName: "Beta User",
        email: "beta@example.com",
        password: "correct horse battery staple",
      },
      new Headers({ origin }),
    );
    const login = await nativeOAuthLogin(before, {
      clientId: beta.clientId,
      email: "beta@example.com",
      origin,
      redirectUri: beta.redirectUris[0]!,
      state: "beta-state",
    });

    const after = identityService({
      nativeOAuth: { clients: opensteerHostNativeOAuthClients },
      signupPolicy: "open",
    });
    await after.initialize();

    await expect(
      after.authenticateNativeAccessToken(login.tokens.access_token),
    ).resolves.toMatchObject({ application: "desktop", clientId: beta.clientId });
    await expect(
      database
        .selectFrom("hostOAuthClients")
        .select(["clientId", "disabled"])
        .where("clientId", "=", beta.clientId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ clientId: beta.clientId, disabled: false });
  });

  it("retires an application that leaves configuration and revokes what it still holds", async () => {
    const origin = "http://127.0.0.1:4310";
    const desktop = opensteerHostNativeOAuthClients.find(
      (client) => client.application === "desktop",
    )!;
    const beta = opensteerHostNativeOAuthClients.find(
      (client) => client.clientId === "opensteer-desktop-beta",
    )!;
    const mobile = opensteerHostNativeOAuthClients.find(
      (client) => client.application === "mobile",
    )!;
    const before = identityService({
      nativeOAuth: { clients: opensteerHostNativeOAuthClients },
      signupPolicy: "open",
    });
    await before.initialize();
    await before.signUpPassword(
      {
        displayName: "Retired Phone",
        email: "retired@example.com",
        password: "correct horse battery staple",
      },
      new Headers({ origin }),
    );
    const login = await nativeOAuthLogin(before, {
      clientId: mobile.clientId,
      email: "retired@example.com",
      origin,
      redirectUri: mobile.redirectUris[0]!,
      state: "retired-state",
    });
    await expect(
      before.authenticateNativeAccessToken(login.tokens.access_token),
    ).resolves.toMatchObject({ application: "mobile" });

    const after = identityService({ nativeOAuth: { clients: [desktop] }, signupPolicy: "open" });
    await after.initialize();

    await expect(
      database
        .selectFrom("hostOAuthClients")
        .select(["clientId", "disabled"])
        .orderBy("clientId")
        .execute(),
    ).resolves.toEqual([
      { clientId: desktop.clientId, disabled: false },
      { clientId: beta.clientId, disabled: true },
      { clientId: mobile.clientId, disabled: true },
    ]);
    await expect(
      database.selectFrom("hostOAuthAccessTokens").select("id").execute(),
    ).resolves.toEqual([]);
    await expect(
      database.selectFrom("hostOAuthRefreshTokens").select("revoked").execute(),
    ).resolves.toEqual([{ revoked: expect.any(Date) }]);
    await expect(database.selectFrom("hostOAuthConsents").select("id").execute()).resolves.toEqual(
      [],
    );
    await expect(
      after.authenticateNativeAccessToken(login.tokens.access_token),
    ).rejects.toMatchObject({ code: "unauthorized" });
    // The person is still signed in; only the application they retired lost
    // its credential.
    await expect(
      database.selectFrom("authSessions").select("id").where("id", "=", login.session.id).execute(),
    ).resolves.toEqual([{ id: login.session.id }]);
  });

  it("does not resurrect a retired application's tokens when it is registered again", async () => {
    const origin = "http://127.0.0.1:4310";
    const desktop = opensteerHostNativeOAuthClients.find(
      (client) => client.application === "desktop",
    )!;
    const mobile = opensteerHostNativeOAuthClients.find(
      (client) => client.application === "mobile",
    )!;
    const before = identityService({
      nativeOAuth: { clients: opensteerHostNativeOAuthClients },
      signupPolicy: "open",
    });
    await before.initialize();
    await before.signUpPassword(
      {
        displayName: "Lost Phone",
        email: "lost@example.com",
        password: "correct horse battery staple",
      },
      new Headers({ origin }),
    );
    const retired = await nativeOAuthLogin(before, {
      clientId: mobile.clientId,
      email: "lost@example.com",
      origin,
      redirectUri: mobile.redirectUris[0]!,
      state: "lost-state",
    });

    await identityService({
      nativeOAuth: { clients: [desktop] },
      signupPolicy: "open",
    }).initialize();
    const readded = identityService({
      nativeOAuth: { clients: opensteerHostNativeOAuthClients },
      signupPolicy: "open",
    });
    await readded.initialize();

    // The registration is live again, so nothing but the durable revocation
    // line separates the token minted before retirement from a fresh one.
    await expect(
      database
        .selectFrom("hostOAuthClients")
        .select("disabled")
        .where("clientId", "=", mobile.clientId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ disabled: false });
    await expect(
      readded.authenticateNativeAccessToken(retired.tokens.access_token),
    ).rejects.toMatchObject({ code: "unauthorized", message: "Native access token is revoked" });

    await waitPastRevocationLine(mobile.clientId);
    const fresh = await nativeOAuthLogin(readded, {
      clientId: mobile.clientId,
      email: "lost@example.com",
      origin,
      redirectUri: mobile.redirectUris[0]!,
      state: "regained-state",
    });
    await expect(
      readded.authenticateNativeAccessToken(fresh.tokens.access_token),
    ).resolves.toMatchObject({ application: "mobile", clientId: mobile.clientId });
  });

  it("binds a client ID to the application it was registered as", async () => {
    const desktop = opensteerHostNativeOAuthClients.find(
      (client) => client.application === "desktop",
    )!;
    await identityService({ nativeOAuth: { clients: [desktop] } }).initialize();
    await expect(
      database
        .selectFrom("hostOAuthClients")
        .select("metadata")
        .where("clientId", "=", desktop.clientId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ metadata: { application: "desktop" } });

    await expect(
      identityService({
        nativeOAuth: {
          clients: [
            {
              ...desktop,
              application: "mobile",
              redirectUris: ["com.opensteer.mobile:/oauth/host-callback"],
            },
          ],
        },
      }).initialize(),
    ).rejects.toThrow(/registered to the desktop application/u);
  });

  it("reads a pre-allowlist registration as the desktop client it was", async () => {
    const origin = "http://127.0.0.1:4310";
    const desktop = opensteerHostNativeOAuthClients.find(
      (client) => client.application === "desktop",
    )!;
    const identity = identityService({
      nativeOAuth: { clients: [desktop] },
      signupPolicy: "open",
    });
    await identity.initialize();
    // The shape a Host wrote before applications were distinguished: the bare
    // managed reference and no binding of its own.
    await database
      .updateTable("hostOAuthClients")
      .set({ metadata: null, referenceId: "opensteer-native-client" })
      .where("clientId", "=", desktop.clientId)
      .executeTakeFirstOrThrow();

    const migrated = identityService({
      nativeOAuth: { clients: opensteerHostNativeOAuthClients },
      signupPolicy: "open",
    });
    await migrated.initialize();
    await migrated.signUpPassword(
      {
        displayName: "Legacy Desk",
        email: "legacy@example.com",
        password: "correct horse battery staple",
      },
      new Headers({ origin }),
    );
    const login = await nativeOAuthLogin(migrated, {
      clientId: desktop.clientId,
      email: "legacy@example.com",
      origin,
      redirectUri: desktop.redirectUris[0]!,
      state: "legacy-state",
    });
    await expect(
      migrated.authenticateNativeAccessToken(login.tokens.access_token),
    ).resolves.toMatchObject({ application: "desktop", clientId: desktop.clientId });
  });

  it("registers a release-isolated reverse-domain native OAuth callback", async () => {
    const stableIdentity = identityService({
      nativeOAuth: {
        clients: [
          nativeClient({
            clientId: "opensteer-desktop",
            redirectUris: ["com.opensteer.opensteer:/oauth/host-callback"],
          }),
        ],
      },
      signupPolicy: "open",
    });
    await stableIdentity.initialize();

    const redirectUri = "com.steerlabs.opensteer.beta:/oauth/host-callback";
    const betaIdentity = identityService({
      nativeOAuth: {
        clients: [
          nativeClient({ clientId: "opensteer-desktop-beta", redirectUris: [redirectUri] }),
        ],
      },
      signupPolicy: "open",
    });
    await betaIdentity.initialize();

    await expect(
      database
        .selectFrom("hostOAuthClients")
        .select(["clientId", "disabled", "redirectUris", "referenceId"])
        .where("clientId", "in", ["opensteer-desktop", "opensteer-desktop-beta"])
        .orderBy("clientId")
        .execute(),
    ).resolves.toEqual([
      expect.objectContaining({
        clientId: "opensteer-desktop",
        disabled: true,
      }),
      expect.objectContaining({
        clientId: "opensteer-desktop-beta",
        disabled: false,
        redirectUris: [redirectUri],
        referenceId: "opensteer-native-client:opensteer-desktop-beta",
      }),
    ]);
  });

  it("keeps initial-owner enrollment fixed, rotates only after expiry, and rejects stale config", async () => {
    const originalExpiry = new Date(Date.now() + 3_600_000);
    const original = identityService({
      initialOwnerEnrollment: {
        expiresAt: originalExpiry,
        token: "original-owner-token-with-entropy",
      },
    });
    await original.initialize();
    const first = await database
      .selectFrom("ownerEnrollments")
      .selectAll()
      .executeTakeFirstOrThrow();

    await identityService({
      initialOwnerEnrollment: {
        expiresAt: new Date(Date.now() + 7_200_000),
        token: "original-owner-token-with-entropy",
      },
    }).initialize();
    const replay = await database
      .selectFrom("ownerEnrollments")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(replay.expiresAt).toEqual(first.expiresAt);
    expect(replay.tokenHash).toBe(first.tokenHash);

    await expect(
      identityService({
        initialOwnerEnrollment: {
          expiresAt: new Date(Date.now() + 7_200_000),
          token: "different-live-owner-token-with-entropy",
        },
      }).initialize(),
    ).rejects.toThrow("does not match durable Host state");

    await database
      .updateTable("ownerEnrollments")
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .executeTakeFirstOrThrow();
    const rotatedToken = "rotated-owner-token-with-enough-entropy";
    const rotatedExpiry = new Date(Date.now() + 3_600_000);
    await identityService({
      initialOwnerEnrollment: { expiresAt: rotatedExpiry, token: rotatedToken },
    }).initialize();
    const rotated = await database
      .selectFrom("ownerEnrollments")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(rotated.id).toBe(first.id);
    expect(rotated.expiresAt).toEqual(rotatedExpiry);
    expect(rotated.tokenHash).toBe(createHash("sha256").update(rotatedToken).digest("hex"));
    await expect(
      database
        .selectFrom("securityAudit")
        .select("action")
        .where("action", "=", "instance.initial-owner-enrollment-rotated")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ action: "instance.initial-owner-enrollment-rotated" });

    const administratorId = await new OpensteerStore(database).createUser("Administrator");
    await database
      .updateTable("users")
      .set({ instanceRole: "administrator" })
      .where("id", "=", administratorId)
      .executeTakeFirstOrThrow();
    const completedIdentity = identityService({
      initialOwnerEnrollment: { expiresAt: rotatedExpiry, token: rotatedToken },
    });
    await expect(completedIdentity.initialize()).resolves.toBeUndefined();
    await expect(
      completedIdentity.exchangeInitialOwnerEnrollment(rotatedToken),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: expect.stringContaining("incorrect or expired"),
    });
  });

  it("creates and restores one passwordless loopback machine owner", async () => {
    const origin = "http://127.0.0.1:4310";
    const token = "local-machine-owner-token-with-enough-entropy";
    const identity = identityService({
      exposure: "loopback",
      initialOwnerEnrollment: {
        expiresAt: new Date(Date.now() + 3_600_000),
        renewable: true,
        token,
      },
      localMachineOwner: {
        displayName: "You",
        email: "owner@personal.opensteer.invalid",
      },
      localPasswordEnabled: false,
    });
    await identity.initialize();
    await expect(identity.configuration()).resolves.toMatchObject({
      localPasswordEnabled: false,
      // Nobody can sign in as this owner, so it is a machine, not a person.
      machineOwner: true,
      setupState: "required",
    });

    const enrollmentBeforeClaim = await database
      .selectFrom("ownerEnrollments")
      .selectAll()
      .executeTakeFirstOrThrow();
    await expect(
      identity.claimLocalMachineOwner(
        "wrong-local-machine-owner-token-with-entropy",
        new Headers({ origin }),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(database.selectFrom("users").select("id").execute()).resolves.toEqual([]);
    await expect(
      database.selectFrom("ownerEnrollments").selectAll().executeTakeFirstOrThrow(),
    ).resolves.toEqual(enrollmentBeforeClaim);

    const first = await identity.claimLocalMachineOwner(
      token,
      new Headers({ origin, "user-agent": "Opensteer Desktop" }),
    );
    expect(first.data.session.user).toMatchObject({
      displayName: "You",
      email: "owner@personal.opensteer.invalid",
      instanceRole: "administrator",
    });
    await expect(identity.configuration()).resolves.toMatchObject({ setupState: "complete" });
    await expect(
      identity.signInPassword(
        { email: "owner@personal.opensteer.invalid", password: "not exposed" },
        new Headers({ origin }),
      ),
    ).rejects.toMatchObject({ code: "not_found" });

    const enrollmentBeforeRecovery = await database
      .selectFrom("ownerEnrollments")
      .selectAll()
      .executeTakeFirstOrThrow();
    const restored = await identity.claimLocalMachineOwner(token, new Headers({ origin }));
    expect(restored.data.session.user.id).toBe(first.data.session.user.id);
    expect(restored.data.session.id).not.toBe(first.data.session.id);
    // Machine-local is a marker the owner claim writes, not the absence of
    // something else: both the initial claim and every later sign-in record it.
    await expect(
      database.selectFrom("machineLocalSessions").select("authSessionId").execute(),
    ).resolves.toEqual(
      expect.arrayContaining([
        { authSessionId: first.data.session.id },
        { authSessionId: restored.data.session.id },
      ]),
    );
    await expect(database.selectFrom("users").select("id").execute()).resolves.toHaveLength(1);
    await expect(
      database.selectFrom("ownerEnrollments").selectAll().executeTakeFirstOrThrow(),
    ).resolves.toEqual(enrollmentBeforeRecovery);
  });

  it("issues a Secure Host-only Personal remote cookie and fences it to the signed route generation", async () => {
    const localOrigin = "http://127.0.0.1:4310";
    const routeOrigin = "https://personal-route.example.test";
    const token = "local-machine-owner-token-with-enough-entropy";
    const identity = identityService({
      exposure: "loopback",
      initialOwnerEnrollment: {
        expiresAt: new Date(Date.now() + 3_600_000),
        renewable: true,
        token,
      },
      localMachineOwner: {
        displayName: "You",
        email: "owner@personal.opensteer.invalid",
      },
      localPasswordEnabled: false,
    });
    await identity.initialize();
    await identity.claimLocalMachineOwner(token, new Headers({ origin: localOrigin }));
    const now = new Date();
    await database
      .updateTable("personalRemoteAccess")
      .set({ generation: 7, mode: "connect", routeOrigin, updatedAt: now })
      .where("singletonKey", "=", "personal")
      .executeTakeFirstOrThrow();

    const issued = await database.transaction().execute((transaction) =>
      identity.issuePersonalRemoteSession(transaction, {
        delivery: "cookie",
        now,
        routeGeneration: 7,
        routeKind: "connect",
        routeOrigin,
        userAgent: null,
      }),
    );
    const setCookie = issued.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Host-opensteer.session="));
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).not.toContain("Domain=");

    const cookie = setCookie!.split(";", 1)[0]!;
    await expect(
      identity.authenticatePersonalRemoteSession(new Headers({ cookie, origin: routeOrigin }), {
        mutation: true,
      }),
    ).resolves.toMatchObject({ id: issued.data.session.id });

    // An Origin the request did not send is a refusal, not a fence violation:
    // the legitimate client still holds a session fenced to the live route.
    await expect(
      identity.authenticatePersonalRemoteSession(
        new Headers({ cookie, origin: "https://elsewhere.example.test" }),
        { mutation: true },
      ),
    ).resolves.toBeNull();
    await expect(
      identity.authenticatePersonalRemoteSession(new Headers({ cookie, origin: routeOrigin })),
    ).resolves.toMatchObject({ id: issued.data.session.id });

    const cookieCredential = decodeURIComponent(cookie.split("=", 2)[1]!);
    // A cookie session is not a header credential, whatever it is presented as.
    await expect(
      identity.authenticatePersonalRemoteCredential(cookieCredential),
    ).resolves.toBeNull();
    // Nor is it this Deployment's own canonical session. The remote row is the
    // fence, so renaming the cookie cannot turn a routed session into one that
    // passes the origin check and the canonical-surface check.
    await expect(
      identity.authenticate(
        new Headers({
          cookie: `opensteer.session=${encodeURIComponent(cookieCredential)}`,
          origin: localOrigin,
        }),
      ),
    ).resolves.toBeNull();

    await database
      .updateTable("personalRemoteAccess")
      .set({ generation: 8, updatedAt: new Date(now.getTime() + 1) })
      .where("singletonKey", "=", "personal")
      .executeTakeFirstOrThrow();
    await expect(
      identity.authenticatePersonalRemoteSession(new Headers({ cookie, origin: routeOrigin })),
    ).resolves.toBeNull();
    await expect(
      database
        .selectFrom("authSessions")
        .select("id")
        .where("id", "=", issued.data.session.id)
        .executeTakeFirst(),
    ).resolves.toBeUndefined();
  });

  it("delivers a Personal remote session in a header without ever setting a cookie", async () => {
    const localOrigin = "http://127.0.0.1:4310";
    const routeOrigin = "https://personal-route.example.test";
    const token = "local-machine-owner-token-with-enough-entropy";
    const identity = identityService({
      exposure: "loopback",
      initialOwnerEnrollment: {
        expiresAt: new Date(Date.now() + 3_600_000),
        renewable: true,
        token,
      },
      localMachineOwner: {
        displayName: "You",
        email: "owner@personal.opensteer.invalid",
      },
      localPasswordEnabled: false,
    });
    await identity.initialize();
    const owner = await identity.claimLocalMachineOwner(
      token,
      new Headers({ origin: localOrigin }),
    );
    const now = new Date();
    await database
      .updateTable("personalRemoteAccess")
      .set({ generation: 3, mode: "connect", routeOrigin, updatedAt: now })
      .where("singletonKey", "=", "personal")
      .executeTakeFirstOrThrow();

    const issued = await database.transaction().execute((transaction) =>
      identity.issuePersonalRemoteSession(transaction, {
        delivery: "header",
        now,
        routeGeneration: 3,
        routeKind: "connect",
        routeOrigin,
        userAgent: "Opensteer/42 CFNetwork/1568.100.1 Darwin/24.0.0",
      }),
    );
    // The phone is named from its own request, and the owner's session on
    // this computer is marked as this computer's rather than listed as a device.
    expect(await identity.listSessions(owner.data.session)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ current: true, machineLocal: true }),
        expect.objectContaining({
          current: false,
          deviceLabel: "Opensteer app on iOS",
          form: "mobile",
          id: issued.data.session.id,
          machineLocal: false,
        }),
      ]),
    );
    expect(issued.headers.getSetCookie()).toEqual([]);
    expect(issued.headers.get("cache-control")).toBe("no-store");
    if (issued.data.delivery !== "header") throw new Error("Expected header delivery");
    const credential = issued.data.credential.token;

    // No ambient credential, so no Origin is demanded of a mutation either.
    await expect(identity.authenticatePersonalRemoteCredential(credential)).resolves.toMatchObject({
      id: issued.data.session.id,
    });

    // The same token offered as a cookie is not this session — under the remote
    // cookie name, where the delivery fence refuses it, and under the canonical
    // one, where being a remote session at all refuses it.
    await expect(
      identity.authenticatePersonalRemoteSession(
        new Headers({
          cookie: `__Host-opensteer.session=${encodeURIComponent(credential)}`,
          origin: routeOrigin,
        }),
      ),
    ).resolves.toBeNull();
    for (const name of ["opensteer.session", "__Host-opensteer.session"]) {
      await expect(
        identity.authenticate(
          new Headers({
            cookie: `${name}=${encodeURIComponent(credential)}`,
            origin: localOrigin,
          }),
        ),
      ).resolves.toBeNull();
    }
    // Refusing a presentation never ends the session it named.
    await expect(identity.authenticatePersonalRemoteCredential(credential)).resolves.toMatchObject({
      id: issued.data.session.id,
    });

    // The ordinary session-revoke path reaches a header session like any other.
    await identity.revokeSession(issued.data.session, issued.data.session.id);
    await expect(identity.authenticatePersonalRemoteCredential(credential)).resolves.toBeNull();
  });

  it("revokes a header-delivered session when the signed route generation moves", async () => {
    const localOrigin = "http://127.0.0.1:4310";
    const routeOrigin = "https://personal-route.example.test";
    const token = "local-machine-owner-token-with-enough-entropy";
    const identity = identityService({
      exposure: "loopback",
      initialOwnerEnrollment: {
        expiresAt: new Date(Date.now() + 3_600_000),
        renewable: true,
        token,
      },
      localMachineOwner: {
        displayName: "You",
        email: "owner@personal.opensteer.invalid",
      },
      localPasswordEnabled: false,
    });
    await identity.initialize();
    await identity.claimLocalMachineOwner(token, new Headers({ origin: localOrigin }));
    const now = new Date();
    await database
      .updateTable("personalRemoteAccess")
      .set({ generation: 4, mode: "connect", routeOrigin, updatedAt: now })
      .where("singletonKey", "=", "personal")
      .executeTakeFirstOrThrow();
    const issued = await database.transaction().execute((transaction) =>
      identity.issuePersonalRemoteSession(transaction, {
        delivery: "header",
        now,
        routeGeneration: 4,
        routeKind: "connect",
        routeOrigin,
        userAgent: null,
      }),
    );
    if (issued.data.delivery !== "header") throw new Error("Expected header delivery");

    await database
      .updateTable("personalRemoteAccess")
      .set({ generation: 5, updatedAt: new Date(now.getTime() + 1) })
      .where("singletonKey", "=", "personal")
      .executeTakeFirstOrThrow();

    await expect(
      identity.authenticatePersonalRemoteCredential(issued.data.credential.token),
    ).resolves.toBeNull();
    await expect(
      database
        .selectFrom("authSessions")
        .select("id")
        .where("id", "=", issued.data.session.id)
        .executeTakeFirst(),
    ).resolves.toBeUndefined();
  });

  it("re-seeds initial owner enrollment after durable rows were truncated", async () => {
    const token = "reseed-owner-token-with-enough-entropy";
    const identity = identityService({
      initialOwnerEnrollment: {
        expiresAt: new Date(Date.now() + 3_600_000),
        token,
      },
    });
    await identity.initialize();
    await sql`truncate table owner_enrollments restart identity cascade`.execute(database);
    await expect(identity.exchangeInitialOwnerEnrollment(token)).resolves.toMatchObject({
      data: { admitted: true },
    });
  });

  it("rotates an unfinished setup admission instead of locking out a valid setup retry", async () => {
    const origin = "http://127.0.0.1:4310";
    const token = "initial-owner-token-with-enough-entropy";
    const identity = identityService({
      initialOwnerEnrollment: {
        expiresAt: new Date(Date.now() + 3_600_000),
        token,
      },
    });
    await identity.initialize();

    const firstExchange = await identity.exchangeInitialOwnerEnrollment(`  ${token}\n`);
    const firstAdmissionCookie = cookieHeader(firstExchange.headers);

    // Invalid credentials are rejected before the admission is reserved.
    await expect(
      identity.signUpPassword(
        {
          displayName: "Owner",
          email: "owner@example.com",
          password: "short",
        },
        new Headers({ cookie: firstAdmissionCookie, origin }),
      ),
    ).rejects.toMatchObject({ code: "bad_request" });
    const unreservedAdmission = await database
      .selectFrom("authAdmissions")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(unreservedAdmission.reservedEmail).toBeNull();

    // Model an interrupted signup after the admission was reserved but before setup completed.
    await database
      .updateTable("authAdmissions")
      .set({ reservedAt: new Date(), reservedEmail: "owner@example.com" })
      .where("id", "=", unreservedAdmission.id)
      .executeTakeFirstOrThrow();
    const firstAdmission = await database
      .selectFrom("authAdmissions")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(firstAdmission.reservedEmail).toBe("owner@example.com");

    const secondExchange = await identity.exchangeInitialOwnerEnrollment(token);
    const secondAdmissionCookie = cookieHeader(secondExchange.headers);
    expect(secondAdmissionCookie).not.toBe(firstAdmissionCookie);

    const admissions = await database.selectFrom("authAdmissions").selectAll().execute();
    expect(admissions).toHaveLength(1);
    expect(admissions[0]).toMatchObject({
      consumedAt: null,
      purpose: "setup",
      reservedAt: null,
      reservedEmail: null,
    });
    expect(admissions[0]?.id).not.toBe(firstAdmission.id);

    await expect(
      identity.signUpPassword(
        {
          displayName: "Stale Owner",
          email: "stale-owner@example.com",
          password: "correct horse battery staple",
        },
        new Headers({ cookie: firstAdmissionCookie, origin }),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });

    const signup = await identity.signUpPassword(
      {
        displayName: "Owner",
        email: "owner@example.com",
        password: "correct horse battery staple",
      },
      new Headers({ cookie: secondAdmissionCookie, origin }),
    );
    const completed = await identity.completeInitialOwnerSetup(
      new Headers({
        cookie: `${secondAdmissionCookie}; ${cookieHeader(signup.headers)}`,
        origin,
      }),
    );

    expect(completed.userId).toBe(signup.data.session.user.id);
    await expect(identity.configuration()).resolves.toMatchObject({ setupState: "complete" });
    await expect(
      database
        .selectFrom("users")
        .select("instanceRole")
        .where("id", "=", completed.userId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ instanceRole: "administrator" });
  });

  it("admits an invite-only signup into the whole Workspace with a single-use link", async () => {
    const origin = "http://127.0.0.1:4310";
    const openIdentity = identityService({ signupPolicy: "open" });
    const ownerSignup = await openIdentity.signUpPassword(
      {
        displayName: "Owner",
        email: "owner@example.com",
        password: "correct horse battery staple",
      },
      new Headers({ origin }),
    );
    const ownerId = ownerSignup.data.session.user.id;
    const store = new OpensteerStore(database);
    await store.ensureDeployment({
      canonicalOrigin: origin,
      deploymentId: createId("deployment"),
      hostInstanceId: createId("hostInstance"),
      deploymentShape: {
        defaultWorkspaceBacking: "portablefs",
        kind: "server" as const,
      },
    });
    const workspace = await store.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: "wsp_identity_invitation",
      },
      capacityPolicy: {
        blockHardLimitBytes: 10_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota",
      },
      createdBy: ownerId,
      idempotencyKey: "identity-invitation-workspace",
      name: "Shared client Workspace",
      status: "ready",
    });
    const inviteOnlyIdentity = identityService();
    const issued = await inviteOnlyIdentity.createWorkspaceInvitation({
      createdBy: ownerId,
      idempotencyKey: "identity-invitation-link",
      lifetimeSeconds: 600,
      role: "collaborator",
      type: "link",
      workspaceId: workspace.id,
    });
    await expect(
      inviteOnlyIdentity.createWorkspaceInvitation({
        createdBy: ownerId,
        idempotencyKey: "identity-email-invitation-without-delivery",
        intendedEmail: "client@example.com",
        lifetimeSeconds: 600,
        role: "collaborator",
        type: "email",
        workspaceId: workspace.id,
      }),
    ).rejects.toMatchObject({
      code: "bad_request",
      message: "Email invitations are unavailable on this Host",
    });
    const revokedInvite = await inviteOnlyIdentity.createWorkspaceInvitation({
      createdBy: ownerId,
      idempotencyKey: "identity-revoked-invitation",
      lifetimeSeconds: 600,
      role: "collaborator",
      type: "link",
      workspaceId: workspace.id,
    });
    const revokedExchange = await inviteOnlyIdentity.exchangeInvitation(
      revokedInvite.invitation.selector,
      revokedInvite.verifier,
    );
    await store.revokeWorkspaceInvitation({
      actorId: ownerId,
      invitationId: revokedInvite.invitation.id,
      workspaceId: workspace.id,
    });
    await expect(
      inviteOnlyIdentity.signUpPassword(
        {
          displayName: "Revoked Client",
          email: "revoked@example.com",
          password: "revoked invitation password",
        },
        new Headers({ cookie: cookieHeader(revokedExchange.headers), origin }),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    const exchanged = await inviteOnlyIdentity.exchangeInvitation(
      issued.invitation.selector,
      issued.verifier,
    );
    expect(exchanged.data.preview).toMatchObject({
      role: "collaborator",
      workspaceName: workspace.name,
    });
    const admissionCookie = cookieHeader(exchanged.headers);
    await expect(
      inviteOnlyIdentity.exchangeInvitation(issued.invitation.selector, issued.verifier),
    ).rejects.toMatchObject({ code: "timeout", retryable: true });
    await expect(
      inviteOnlyIdentity.exchangeInvitation(
        issued.invitation.selector,
        issued.verifier,
        new Headers({ cookie: admissionCookie }),
      ),
    ).resolves.toMatchObject({ status: 200 });
    const clientSignup = await inviteOnlyIdentity.signUpPassword(
      {
        displayName: "Client",
        email: "client@example.com",
        password: "another correct horse battery staple",
      },
      new Headers({ cookie: admissionCookie, origin }),
    );
    const sessionCookie = cookieHeader(clientSignup.headers);
    const accepted = await inviteOnlyIdentity.acceptInvitation(
      new Headers({ cookie: `${admissionCookie}; ${sessionCookie}`, origin }),
    );
    expect(accepted.membership).toMatchObject({
      role: "collaborator",
      state: "active",
      userId: clientSignup.data.session.user.id,
      workspaceId: workspace.id,
    });
    expect((await store.listWorkspacesForOwner(clientSignup.data.session.user.id))[0]?.id).toBe(
      workspace.id,
    );
    await expect(
      inviteOnlyIdentity.exchangeInvitation(issued.invitation.selector, issued.verifier),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(
      JSON.stringify(await store.listActiveWorkspaceInvitations(workspace.id, ownerId)),
    ).not.toContain(issued.verifier);
  });
});

/**
 * A retired registration's revocation line is second-granular, so a token the
 * test mints immediately after re-registration would land on the wrong side of
 * it. Waiting for the clock to pass the line is what a real client's next
 * sign-in does on its own.
 */
async function waitPastRevocationLine(clientId: string): Promise<void> {
  const registration = await database
    .selectFrom("hostOAuthClients")
    .select("metadata")
    .where("clientId", "=", clientId)
    .executeTakeFirstOrThrow();
  const notBefore = NativeOAuthRegistrationMetadataSchema.parse(
    registration.metadata,
  ).credentialsNotBefore;
  if (!notBefore) throw new Error("The registration has no revocation line to wait for");
  const line = Math.floor(new Date(notBefore).getTime() / 1_000);
  while (Math.floor(Date.now() / 1_000) <= line) await delay(25);
}

/**
 * Drives one native client all the way from the authorization request to a
 * redeemed token, so a test can say which application signed in rather than
 * restating the PKCE exchange.
 */
async function nativeOAuthLogin(
  identity: IdentityService,
  input: {
    readonly clientId: string;
    readonly email: string;
    readonly origin: string;
    readonly redirectUri: string;
    readonly state: string;
  },
): Promise<{
  readonly callback: URL;
  readonly consentPage: URL;
  readonly session: AuthenticatedSession;
  readonly tokens: {
    readonly access_token: string;
    readonly refresh_token: string;
    readonly token_type: string;
  };
}> {
  const verifier = "native-pkce-verifier-with-at-least-forty-three-characters-0123456789";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorization = new URL(`${input.origin}/v1/auth/native/oauth2/authorize`);
  authorization.searchParams.set("client_id", input.clientId);
  authorization.searchParams.set("code_challenge", challenge);
  authorization.searchParams.set("code_challenge_method", "S256");
  authorization.searchParams.set("redirect_uri", input.redirectUri);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("scope", "openid profile email offline_access host:access");
  authorization.searchParams.set("state", input.state);
  const loginPrompt = await identity.handleNativeOAuthRequest(
    new Request(authorization, { headers: { accept: "application/json" } }),
  );
  expect(loginPrompt.status).toBe(200);
  const promptBody = (await loginPrompt.json()) as { redirect?: unknown; url?: unknown };
  expect(promptBody.redirect).toBe(true);
  const loginUrl = new URL(String(promptBody.url), input.origin);
  expect(loginUrl.pathname).toBe("/");
  expect(loginUrl.searchParams.get("sig")).toBeTruthy();

  const signedIn = await identity.signInPassword(
    { email: input.email, password: "correct horse battery staple" },
    new Headers({ origin: input.origin }),
    loginUrl.search.slice(1),
  );
  const consentPage = new URL(signedIn.data.redirectUrl ?? "");
  const consentResponse = await identity.handleNativeOAuthRequest(
    new Request(`${input.origin}/v1/auth/native/oauth2/consent`, {
      body: JSON.stringify({ accept: true, oauth_query: consentPage.search.slice(1) }),
      headers: {
        "content-type": "application/json",
        cookie: cookieHeader(signedIn.headers),
        origin: input.origin,
      },
      method: "POST",
    }),
  );
  expect(consentResponse.status).toBe(200);
  const consent = (await consentResponse.json()) as { redirect?: unknown; url?: unknown };
  expect(consent).toMatchObject({ redirect: true, url: expect.any(String) });
  const callback = new URL(String(consent.url));
  const code = callback.searchParams.get("code");
  expect(code).toBeTruthy();

  const tokenResponse = await identity.handleNativeOAuthRequest(
    new Request(`${input.origin}/v1/auth/native/oauth2/token`, {
      body: new URLSearchParams({
        client_id: input.clientId,
        code: code ?? "",
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: input.redirectUri,
        resource: input.origin,
      }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    }),
  );
  expect(tokenResponse.status).toBe(200);
  const tokens = (await tokenResponse.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    token_type?: unknown;
  };
  expect(tokens.access_token).toEqual(expect.any(String));
  return {
    callback,
    consentPage,
    session: signedIn.data.session,
    tokens: {
      access_token: String(tokens.access_token),
      refresh_token: String(tokens.refresh_token),
      token_type: String(tokens.token_type),
    },
  };
}

/**
 * A native client registration with everything but its identity defaulted, so
 * a test says only the part it is about.
 */
function nativeClient(
  overrides: Partial<NativeOAuthClient> & Pick<NativeOAuthClient, "clientId" | "redirectUris">,
): NativeOAuthClient {
  return {
    application: "desktop",
    displayName: "Opensteer Desktop",
    softwareId: "opensteer-desktop",
    ...overrides,
  };
}

function identityService(
  overrides: Partial<ConstructorParameters<typeof IdentityService>[1]> = {},
): IdentityService {
  return new IdentityService(database, {
    deployment: { cloud: false, kind: "self-hosted", name: null },
    hostKeyFingerprint,
    localPasswordEnabled: true,
    oidcProviders: [],
    publicOrigin: new URL("http://127.0.0.1:4310"),
    secret: "identity-test-secret-that-is-at-least-thirty-two-bytes",
    exposure: "networked",
    signupPolicy: "invite-only",
    ...overrides,
  });
}

function cookieHeader(headers: Headers): string {
  const cookies = headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .filter((value): value is string => Boolean(value));
  if (cookies.length === 0) throw new Error("Identity response did not include a cookie");
  return cookies.join("; ");
}

function sessionCookieHeader(headers: Headers): string {
  const cookie = headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .find((value) => /(?:^|\s)(?:__Host-)?opensteer\.session=.+/u.test(value ?? ""));
  if (!cookie) throw new Error("OIDC callback did not include a session cookie");
  return cookie;
}
