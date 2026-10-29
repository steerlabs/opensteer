import {
  CompleteHostAccountAdoptionResponseSchema,
  ConsumeHostAccountAdoptionProofResponseSchema,
  HostAccountAdoptionCompletionGrantClaimsSchema,
  IssueHostAccountAdoptionProofResponseSchema,
} from "@opensteer/control-plane-protocol";
import { createId } from "@opensteer/core";
import { createDatabase, migrateToLatest, OpensteerStore } from "@opensteer/database";
import { IdentityService } from "@opensteer/identity";
import Fastify from "fastify";
import { sql } from "kysely";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HostAuthenticator } from "../identity/auth.js";
import { registerIdentityRoutes } from "../identity/identity-routes.js";
import { RemoteAccountAdoptionGrantVerifier } from "./account-adoption-grant-verifier.js";

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const origin = "http://127.0.0.1:4310";
const hostKeyFingerprint = `sha256:${"A".repeat(43)}`;
const database = createDatabase({
  applicationName: "opensteer-account-adoption-route-integration-test",
  connectionString: databaseUrl ?? "postgres://unconfigured",
  maxConnections: 4,
});

integration("Host Account adoption routes", () => {
  beforeAll(async () => migrateToLatest(database));
  beforeEach(async () => {
    await sql`
      truncate table
        account_directory_projections,
        account_directory_provider,
        host_account_adoption_proofs,
        security_audit,
        auth_accounts,
        auth_sessions,
        users,
        deployments
      restart identity cascade
    `.execute(database);
  });
  afterAll(async () => database.destroy());

  it("issues through a local administrator session and consumes by one-use proof", async () => {
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
    const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    const publicJwk = {
      ...(await exportJWK(publicKey)),
      alg: "EdDSA",
      kid: "account-adoption-test-v1",
      use: "sig",
    };
    const identity = new IdentityService(database, {
      deployment: { cloud: false, kind: "self-hosted", name: null },
      accountAdoption: {
        grantVerifier: new RemoteAccountAdoptionGrantVerifier({
          audience: origin,
          fetch: async () =>
            Response.json(
              { keys: [publicJwk] },
              { headers: { "content-type": "application/json" } },
            ),
          issuer: new URL("https://account.opensteer.example"),
        }),
        logicalProviderId: "opensteer-account",
      },
      hostKeyFingerprint,
      localPasswordEnabled: true,
      oidcProviders: [],
      publicOrigin: new URL(origin),
      secret: "host-account-adoption-route-secret-at-least-thirty-two-bytes",
      exposure: "networked",
      signupPolicy: "open",
    });
    const signup = await identity.signUpPassword(
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
      .where("id", "=", signup.data.session.user.id)
      .executeTakeFirstOrThrow();

    const app = Fastify();
    const acknowledgeAccountAdoption = vi.fn(async () => undefined);
    registerIdentityRoutes(app, new HostAuthenticator({ identity, publicUrl: new URL(origin) }), {
      acknowledgeAccountAdoption,
    });
    try {
      const account = {
        issuer: "https://account.opensteer.example",
        subject: "acct_00000000-0000-4000-8000-000000000001",
      };
      const unauthenticated = await app.inject({
        headers: { origin },
        method: "POST",
        payload: { account },
        url: "/v1/auth/account-adoption/proofs",
      });
      expect(unauthenticated.statusCode).not.toBe(200);
      const wrongOrigin = await app.inject({
        headers: { cookie: cookieHeader(signup.headers), origin: "https://evil.example" },
        method: "POST",
        payload: { account },
        url: "/v1/auth/account-adoption/proofs",
      });
      expect(wrongOrigin.statusCode).not.toBe(200);
      const issue = await app.inject({
        headers: { cookie: cookieHeader(signup.headers), origin },
        method: "POST",
        payload: { account },
        url: "/v1/auth/account-adoption/proofs",
      });
      expect(issue.statusCode, issue.body).toBe(200);
      expect(issue.headers["cache-control"]).toBe("no-store");
      const issued = IssueHostAccountAdoptionProofResponseSchema.parse(issue.json());

      const consume = await app.inject({
        method: "POST",
        payload: {
          expectedAccount: account,
          expectedAuthority: issued.authority,
          proofCredential: issued.proofCredential,
        },
        url: `/v1/auth/account-adoption/proofs/${issued.proofId}/consume`,
      });
      expect(consume.statusCode, consume.body).toBe(200);
      expect(consume.headers["cache-control"]).toBe("no-store");
      const consumed = ConsumeHostAccountAdoptionProofResponseSchema.parse(consume.json());
      expect(consumed).toMatchObject({
        account,
        authority: issued.authority,
        authorizedBy: {
          sessionId: signup.data.session.id,
          userId: signup.data.session.user.id,
        },
        proofId: issued.proofId,
      });

      const replay = await app.inject({
        method: "POST",
        payload: {
          expectedAccount: account,
          expectedAuthority: issued.authority,
          proofCredential: issued.proofCredential,
        },
        url: `/v1/auth/account-adoption/proofs/${issued.proofId}/consume`,
      });
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json()).toEqual(consume.json());

      const alteredReplay = await app.inject({
        method: "POST",
        payload: {
          expectedAccount: account,
          expectedAuthority: {
            ...issued.authority,
            hostInstanceId: createId("hostInstance"),
          },
          proofCredential: issued.proofCredential,
        },
        url: `/v1/auth/account-adoption/proofs/${issued.proofId}/consume`,
      });
      expect(alteredReplay.statusCode).not.toBe(200);

      const now = Math.floor(Date.now() / 1_000);
      const grantClaims = HostAccountAdoptionCompletionGrantClaimsSchema.parse({
        account,
        aud: origin,
        authority: issued.authority,
        exp: now + 300,
        iat: now,
        iss: account.issuer,
        jti: `hag_${crypto.randomUUID()}`,
        proof: {
          authorizedBy: consumed.authorizedBy,
          consumedAt: consumed.consumedAt,
          id: consumed.proofId,
        },
        sub: account.subject,
        tokenUse: "opensteer-host-account-adoption",
      });
      const completionGrant = await new SignJWT(grantClaims)
        .setProtectedHeader({ alg: "EdDSA", kid: publicJwk.kid, typ: "JWT" })
        .sign(privateKey);
      const rejectedOrigin = await app.inject({
        headers: { cookie: cookieHeader(signup.headers), origin: "https://evil.example" },
        method: "POST",
        payload: { completionGrant },
        url: "/v1/auth/account-adoption/complete",
      });
      expect(rejectedOrigin.statusCode).not.toBe(200);

      const completeRequest = {
        headers: { cookie: cookieHeader(signup.headers), origin },
        method: "POST" as const,
        payload: { completionGrant },
        url: "/v1/auth/account-adoption/complete",
      };
      const completed = await app.inject(completeRequest);
      expect(completed.statusCode, completed.body).toBe(200);
      expect(CompleteHostAccountAdoptionResponseSchema.parse(completed.json())).toMatchObject({
        account,
        proofId: issued.proofId,
        userId: signup.data.session.user.id,
      });
      expect(acknowledgeAccountAdoption).toHaveBeenLastCalledWith(issued.proofId);
      const exactRetry = await app.inject(completeRequest);
      expect(exactRetry.statusCode, exactRetry.body).toBe(200);
      expect(exactRetry.json()).toEqual(completed.json());
      expect(acknowledgeAccountAdoption).toHaveBeenCalledTimes(2);

      const alteredClaims = HostAccountAdoptionCompletionGrantClaimsSchema.parse({
        ...grantClaims,
        account: {
          ...account,
          subject: "acct_00000000-0000-4000-8000-000000000002",
        },
        jti: `hag_${crypto.randomUUID()}`,
        sub: "acct_00000000-0000-4000-8000-000000000002",
      });
      const alteredGrant = await new SignJWT(alteredClaims)
        .setProtectedHeader({ alg: "EdDSA", kid: publicJwk.kid, typ: "JWT" })
        .sign(privateKey);
      const alteredCompletion = await app.inject({
        ...completeRequest,
        payload: { completionGrant: alteredGrant },
      });
      expect(alteredCompletion.statusCode).not.toBe(200);
    } finally {
      await app.close();
    }
  });
});

function cookieHeader(headers: Headers): string {
  return headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .filter((value): value is string => Boolean(value))
    .join("; ");
}
