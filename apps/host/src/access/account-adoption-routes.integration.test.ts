import {
  ConsumeHostAccountAdoptionProofResponseSchema,
  IssueHostAccountAdoptionProofResponseSchema,
} from "@opensteer/control-plane-protocol";
import { createId } from "@opensteer/core";
import {
  createDatabase,
  migrateToLatest,
  OpensteerStore,
  requirePersonalOwner,
} from "@opensteer/database";
import { IdentityService } from "@opensteer/identity";
import Fastify from "fastify";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HostAuthenticator } from "../identity/auth.js";
import { registerIdentityRoutes } from "../identity/identity-routes.js";

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
        kind: "personal" as const,
      },
    });
    const identity = new IdentityService(database, {
      deployment: { kind: "personal", name: null },
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
    await (
      await import("@opensteer/database/test-support/personal")
    ).seedPersonalOwnerResources(database, {
      deploymentId: (await store.getDeployment())!.id,
      userId: signup.data.session.user.id,
      path: "/tmp/adoption-personal-home",
    });

    const app = Fastify();
    registerIdentityRoutes(app, new HostAuthenticator({ identity, publicUrl: new URL(origin) }), {
      assertOwner: (id) => requirePersonalOwner(database, id),
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
      // Nothing on a Home completes an attachment of the whole Home to an Account.
      const complete = await app.inject({
        headers: { cookie: cookieHeader(signup.headers), origin },
        method: "POST",
        payload: { completionGrant: "unused" },
        url: "/v1/auth/account-adoption/complete",
      });
      expect(complete.statusCode).toBe(404);
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
