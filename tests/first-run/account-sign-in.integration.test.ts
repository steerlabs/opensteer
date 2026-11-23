import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql } from "kysely";
import {
  opensteerAccountOAuthScopes,
  opensteerDesktopAccountOAuthCallback,
  opensteerDesktopOAuthClientId,
} from "../../packages/core/src/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlPlaneDatabase } from "../../apps/control-plane/src/database/database.js";
import { migrateControlPlaneToLatest } from "../../apps/control-plane/src/database/migrations.js";
import {
  journeyAccount,
  startJourneyAccountService,
  type JourneyAccountService,
} from "./account-service.js";
import { signInAtAccount } from "./browser.js";

/*
 * The first-run journey's account half outside the VM: the account service as the journey starts
 * it (the real code, configured from an environment, its tunnel provider handed in), and the
 * browser stand-in signing in through the account service's own pages with the authorization
 * request the Mac app makes, to a code the account service then exchanges for tokens.
 */

const databaseUrl = process.env.OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL;
// It needs the account service's PostgreSQL, which only pnpm test:integration provides.
const integration = databaseUrl ? describe : describe.skip;

integration("the first-run journey's account service", () => {
  let account: JourneyAccountService;

  async function clearAuthTables(): Promise<void> {
    const database = createControlPlaneDatabase({ connectionString: databaseUrl! });
    try {
      await migrateControlPlaneToLatest(database);
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
    } finally {
      await database.destroy();
    }
  }

  beforeAll(async () => {
    await clearAuthTables();
    account = await startJourneyAccountService({ databaseUrl: databaseUrl! });
  });

  afterAll(async () => {
    await account?.close();
    await clearAuthTables();
  });

  it("signs in through its own sign-in and consent pages and issues the Mac app its tokens", async () => {
    // The Mac app's account authorization, as its native OAuth manager builds one.
    const verifier = randomBytes(48).toString("base64url");
    const state = randomUUID();
    const authorize = new URL("/api/auth/oauth2/authorize", account.origin);
    authorize.searchParams.set("client_id", opensteerDesktopOAuthClientId);
    authorize.searchParams.set(
      "code_challenge",
      createHash("sha256").update(verifier).digest("base64url"),
    );
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("prompt", "login");
    authorize.searchParams.set("redirect_uri", opensteerDesktopAccountOAuthCallback);
    authorize.searchParams.set("resource", account.origin);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("scope", opensteerAccountOAuthScopes.join(" "));
    authorize.searchParams.set("state", state);

    const signedIn = await signInAtAccount({
      authorizeUrl: authorize.toString(),
      email: journeyAccount.email,
      password: journeyAccount.password,
    });
    expect(signedIn.visited).toEqual(
      expect.arrayContaining(["GET /sign-in", "POST /sign-in/app-review", "POST /consent"]),
    );
    const callback = new URL(signedIn.callback);
    expect(`${callback.protocol}${callback.pathname}`).toBe(opensteerDesktopAccountOAuthCallback);
    expect(callback.searchParams.get("state")).toBe(state);
    expect(callback.searchParams.get("iss")).toBe(account.origin);
    const code = callback.searchParams.get("code");
    expect(code).toBeTruthy();

    const token = await fetch(new URL("/api/auth/oauth2/token", account.origin), {
      body: new URLSearchParams({
        client_id: opensteerDesktopOAuthClientId,
        code: code!,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: opensteerDesktopAccountOAuthCallback,
        resource: account.origin,
      }),
      method: "POST",
    });
    expect(token.status, await token.clone().text()).toBe(200);
    await expect(token.json()).resolves.toMatchObject({
      access_token: expect.any(String),
      refresh_token: expect.any(String),
    });
  });

  it("refuses a wrong password on its own page, as it does for a person", async () => {
    const authorize = new URL("/api/auth/oauth2/authorize", account.origin);
    authorize.searchParams.set("client_id", opensteerDesktopOAuthClientId);
    authorize.searchParams.set("code_challenge", "c".repeat(43));
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("prompt", "login");
    authorize.searchParams.set("redirect_uri", opensteerDesktopAccountOAuthCallback);
    authorize.searchParams.set("resource", account.origin);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("scope", opensteerAccountOAuthScopes.join(" "));
    authorize.searchParams.set("state", randomUUID());
    await expect(
      signInAtAccount({
        authorizeUrl: authorize.toString(),
        email: journeyAccount.email,
        password: "not-the-password-at-all-not-at-all",
      }),
    ).rejects.toThrow(/answered 401/u);
  });

  it("is handed the stand-in tunnel provider, which nothing has called yet", () => {
    expect(account.provider.calls).toEqual([]);
  });
});
