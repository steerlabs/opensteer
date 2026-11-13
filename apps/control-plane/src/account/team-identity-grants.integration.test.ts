import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  TeamIdentityAssertionClaimsSchema,
  type ControlPlaneAccountId,
  type HostAccountAdoptionAuthority,
} from "@opensteer/control-plane-protocol";
import {
  DeploymentIdSchema,
  HostInstanceIdSchema,
  HostKeyFingerprintSchema,
  type DeploymentId,
} from "@opensteer/core";
import {
  HostDiscoveryEnvelopeSchema,
  hostDiscoverySigningBytes,
} from "@opensteer/deployment-authority";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ControlPlaneAuth } from "../auth/auth.js";
import { createControlPlaneDatabase } from "../database/database.js";
import { migrateControlPlaneToLatest } from "../database/migrations.js";
import { TeamIdentityGrantService } from "./team-identity-grants.js";

const databaseUrl = process.env.OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL;
// Skipped outside the PostgreSQL launcher, which provides the database URL.
const integration = databaseUrl ? describe : describe.skip;
const issuer = new URL("https://account.team-identity.test.invalid");

integration("Account team identity grants", () => {
  const database = createControlPlaneDatabase({
    connectionString: databaseUrl ?? "postgresql://unconfigured",
    maxConnections: 2,
  });
  const signed: unknown[] = [];
  const service = new TeamIdentityGrantService({
    auth: {
      api: {
        signJWT: async ({ body }: { body: { payload: unknown } }) => {
          signed.push(body.payload);
          return { token: `${"a".repeat(24)}.${"b".repeat(24)}.${"c".repeat(24)}` };
        },
      },
    } as unknown as ControlPlaneAuth,
    database,
    issuer,
  });
  const owner = `acct_${crypto.randomUUID()}` as ControlPlaneAccountId;
  const invitee = `acct_${crypto.randomUUID()}` as ControlPlaneAccountId;

  beforeAll(async () => migrateControlPlaneToLatest(database));
  beforeEach(async () => {
    signed.length = 0;
    await sql`truncate table deployments, users cascade`.execute(database);
    const now = new Date();
    await database
      .insertInto("users")
      .values(
        [owner, invitee].map((id) => ({
          createdAt: now,
          displayName: `Person ${id.slice(5, 9)}`,
          email: `${id}@example.test`,
          emailVerified: true,
          id,
          image: null,
          updatedAt: now,
        })),
      )
      .execute();
  });
  afterAll(async () => database.destroy());

  it("proves any Account's identity to the exact adopted team, never more", async () => {
    const team = await registerDeployment("team");
    const issued = await service.issue(invitee, team.deploymentId, {
      surface: "mobile",
      expectedAuthority: team,
    });
    const claims = TeamIdentityAssertionClaimsSchema.parse(signed[0]);
    expect(claims).toMatchObject({
      tokenUse: "opensteer-team-identity",
      iss: issuer.origin,
      aud: team.canonicalOrigin,
      sub: invitee,
      account: { issuer: issuer.origin, subject: invitee },
      email: `${invitee}@example.test`,
      authority: team,
      surface: "mobile",
    });
    expect(claims.exp - claims.iat).toBe(60);
    expect(Date.parse(issued.expiresAt)).toBe(claims.exp * 1_000);

    for (const stale of [
      { ...team, hostInstanceId: HostInstanceIdSchema.parse(`hst_${crypto.randomUUID()}`) },
      { ...team, canonicalOrigin: "https://other.team.test.invalid" },
      { ...team, hostKeyFingerprint: HostKeyFingerprintSchema.parse(`sha256:${"B".repeat(43)}`) },
    ]) {
      await expect(
        service.issue(invitee, team.deploymentId, { surface: "desktop", expectedAuthority: stale }),
      ).rejects.toMatchObject({ code: "conflict" });
    }
    const other = await registerDeployment("team");
    await expect(
      service.issue(invitee, other.deploymentId, { surface: "desktop", expectedAuthority: team }),
    ).rejects.toMatchObject({ code: "conflict" });
    const personal = await registerDeployment("personal");
    await expect(
      service.issue(owner, personal.deploymentId, {
        surface: "desktop",
        expectedAuthority: personal,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(signed).toHaveLength(1);
  });

  async function registerDeployment(
    kind: "personal" | "team",
  ): Promise<HostAccountAdoptionAuthority & { deploymentId: DeploymentId }> {
    const deploymentId = DeploymentIdSchema.parse(`dep_${crypto.randomUUID()}`);
    const hostInstanceId = HostInstanceIdSchema.parse(`hst_${crypto.randomUUID()}`);
    const keys = generateKeyPairSync("ed25519");
    const spki = keys.publicKey.export({ format: "der", type: "spki" });
    const hostKeyFingerprint = HostKeyFingerprintSchema.parse(
      `sha256:${createHash("sha256").update(spki).digest("base64url")}`,
    );
    const canonicalOrigin = `https://${deploymentId.slice(4, 12)}.team.test.invalid`;
    const document = {
      canonicalOrigin,
      deploymentId,
      hostInstanceId,
      hostKey: { algorithm: "Ed25519" as const },
      deploymentShape: { kind },
    };
    const now = new Date();
    await database
      .insertInto("deployments")
      .values({
        id: deploymentId,
        ownerAccountId: owner,
        canonicalOrigin,
        name: kind,
        activeHostInstanceId: hostInstanceId,
        hostKeyFingerprint,
        reachability: "canonical",
        lifecycle: "active",
        oidcClientId: null,
        authorityEnvelope: HostDiscoveryEnvelopeSchema.parse({
          document,
          publicKey: { algorithm: "Ed25519", spki: spki.toString("base64url") },
          signature: sign(null, hostDiscoverySigningBytes(document), keys.privateKey).toString(
            "base64url",
          ),
        }),
        directoryGeneration: 1,
        accountLink: null,
        createdAt: now,
        updatedAt: now,
      })
      .executeTakeFirstOrThrow();
    return { canonicalOrigin, deploymentId, hostInstanceId, hostKeyFingerprint };
  }
});
