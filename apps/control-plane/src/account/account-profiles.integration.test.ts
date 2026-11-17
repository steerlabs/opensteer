import {
  PersonProfileReceiptClaimsSchema,
  type ControlPlaneAccountId,
} from "@opensteer/control-plane-protocol";
import { createId, type DeploymentId, type HostInstanceId, type PersonName } from "@opensteer/core";
import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createControlPlaneDatabase } from "../database/database.js";
import { migrateControlPlaneToLatest } from "../database/migrations.js";
import type { HostAuthority } from "../database/store.js";
import { AccountProfiles } from "./account-profiles.js";

const databaseUrl = process.env.OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL;
// Skipped outside the PostgreSQL launcher, which provides the database URL.
const integration = databaseUrl ? describe : describe.skip;
const issuer = new URL("https://account.profiles.test.invalid");
const token = `${"a".repeat(24)}.${"b".repeat(24)}.${"c".repeat(24)}`;

integration("Account profiles", () => {
  const database = createControlPlaneDatabase({
    connectionString: databaseUrl ?? "postgresql://unconfigured",
    maxConnections: 2,
  });
  const signed: unknown[] = [];
  const profiles = new AccountProfiles({
    database,
    issuer,
    sign: async (payload) => {
      signed.push(payload);
      return token;
    },
  });
  const ada = `acct_${crypto.randomUUID()}` as ControlPlaneAccountId;
  const bea = `acct_${crypto.randomUUID()}` as ControlPlaneAccountId;
  const name = (value: string) => value as PersonName;

  beforeAll(async () => migrateControlPlaneToLatest(database));
  beforeEach(async () => {
    signed.length = 0;
    await sql`truncate table deployments, users cascade`.execute(database);
    const now = new Date();
    await database
      .insertInto("users")
      .values(
        [
          // Stored before names had one canonical form: shown in it, never refused.
          { id: ada, displayName: "  Ada   Lovelace ", email: "ada@example.test" },
          { id: bea, displayName: "Bea", email: "bea@example.test" },
        ].map((row) => ({
          ...row,
          createdAt: now,
          emailVerified: true,
          image: null,
          updatedAt: now,
        })),
      )
      .execute();
  });
  afterAll(async () => database.destroy());

  it("numbers each change, refuses a stale one, and signs a receipt of the current name", async () => {
    expect(await profiles.read(ada)).toMatchObject({
      name: "Ada Lovelace",
      revision: 1,
      receipt: token,
    });
    expect(PersonProfileReceiptClaimsSchema.parse(signed.at(-1))).toMatchObject({
      tokenUse: "opensteer-person-profile",
      aud: "opensteer-person-profile",
      iss: issuer.origin,
      sub: ada,
      name: "Ada Lovelace",
      revision: 1,
    });

    expect(await profiles.update(ada, { name: name("Ada"), expectedRevision: 1 })).toMatchObject({
      applied: true,
      profile: { name: "Ada", revision: 2 },
    });
    // Saved on another device in between: nothing is overwritten, and the newer name comes back.
    expect(await profiles.update(ada, { name: name("Old"), expectedRevision: 1 })).toMatchObject({
      applied: false,
      profile: { name: "Ada", revision: 2 },
    });
    // Asking for the name that is already current is done, and moves nothing.
    expect(await profiles.update(ada, { name: name("Ada"), expectedRevision: 1 })).toMatchObject({
      applied: true,
      profile: { name: "Ada", revision: 2 },
    });
    expect(await profiles.read(bea)).toMatchObject({ name: "Bea", revision: 1 });
  });

  it("lets only an active personal Host linked to its owner read or change that owner's name", async () => {
    const personal = await deployment({
      owner: ada,
      linked: { issuer: issuer.origin, subject: ada },
    });
    expect(await profiles.readHostOwner(personal)).toMatchObject({ name: "Ada Lovelace" });
    expect(
      await profiles.updateHostOwner(personal, { name: name("Ada L."), expectedRevision: 1 }),
    ).toMatchObject({ applied: true, profile: { name: "Ada L.", revision: 2 } });

    const team = await deployment({ owner: bea, linked: null });
    await expect(profiles.readHostOwner(team)).rejects.toMatchObject({ code: "forbidden" });
    const foreign = await deployment({
      owner: bea,
      linked: { issuer: issuer.origin, subject: ada },
    });
    await expect(
      profiles.updateHostOwner(foreign, { name: name("Mallory"), expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const stale = { ...personal, credentialHash: "rotated" };
    await expect(profiles.readHostOwner(stale)).rejects.toMatchObject({ code: "forbidden" });
    expect(await profiles.read(bea)).toMatchObject({ name: "Bea", revision: 1 });
  });

  async function deployment(input: {
    readonly owner: ControlPlaneAccountId;
    readonly linked: { readonly issuer: string; readonly subject: string } | null;
  }): Promise<HostAuthority> {
    const deploymentId = createId("deployment") as DeploymentId;
    const hostInstanceId = createId("hostInstance") as HostInstanceId;
    const credentialHash = `hash-${crypto.randomUUID()}`;
    const now = new Date();
    await database
      .insertInto("deployments")
      .values({
        id: deploymentId,
        ownerAccountId: input.owner,
        name: "Computer",
        reachability: input.linked ? "routed" : "canonical",
        activeHostInstanceId: hostInstanceId,
        hostKeyFingerprint: `sha256:${randomBytes(32).toString("base64url")}` as never,
        canonicalOrigin: "https://host.profiles.test.invalid",
        lifecycle: "active",
        oidcClientId: null,
        authorityEnvelope: null,
        accountLink: input.linked ? { generation: "g".repeat(43), ...input.linked } : null,
        createdAt: now,
        updatedAt: now,
      })
      .execute();
    await database
      .insertInto("deploymentCredentials")
      .values({ deploymentId, tokenHash: credentialHash, createdAt: now, rotatedAt: now } as never)
      .execute();
    return { deploymentId, credentialHash, hostInstanceId };
  }
});
