import { ControlPlaneAccountIdSchema } from "@opensteer/control-plane-protocol";
import { createId, type UserId } from "@opensteer/core";
import { createDatabase, migrateToLatest, OpensteerStore } from "@opensteer/database";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  IntegrationAccountBindingSchema,
  resolveIntegrationAccountBinding,
} from "./integration-account-binding.js";

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const issuer = "https://accounts.opensteer.test";
const providerId = "oidc.opensteer-account.test";

const database = createDatabase({
  applicationName: "opensteer-integration-account-binding-test",
  connectionString: databaseUrl ?? "postgres://unconfigured",
  maxConnections: 3,
});
const store = new OpensteerStore(database);

integration("integration Account binding resolution", () => {
  beforeAll(async () => migrateToLatest(database));
  beforeEach(async () => {
    await sql`
      truncate table
        personal_remote_account_link,
        account_directory_provider,
        auth_accounts,
        users
      restart identity cascade
    `.execute(database);
  });
  afterAll(async () => database.destroy());

  it("derives a stable server generation from the persisted Account binding lifecycle", async () => {
    const ownerUserId = await createUser("administrator");
    const subject = ControlPlaneAccountIdSchema.parse(`acct_${randomUUID()}`);
    const providerUpdatedAt = new Date("2026-09-18T12:00:00.000Z");
    await database
      .insertInto("accountDirectoryProvider")
      .values({
        createdAt: providerUpdatedAt,
        issuer,
        providerId,
        singletonKey: "opensteer-account",
        updatedAt: providerUpdatedAt,
      })
      .executeTakeFirstOrThrow();
    const originalBindingId = createId("authAccount");
    await insertAuthAccount({ id: originalBindingId, subject, userId: ownerUserId });

    const first = await resolveIntegrationAccountBinding({
      accountAttached: true,
      database,
      kind: "server",
      ownerUserId,
    });
    expect(IntegrationAccountBindingSchema.parse(first)).toEqual({
      issuer,
      linkGeneration: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      subject,
    });

    await database
      .updateTable("authAccounts")
      .set({
        accessToken: "replacement-access-token",
        refreshToken: "replacement-refresh-token",
        updatedAt: new Date("2026-09-18T13:00:00.000Z"),
      })
      .where("id", "=", originalBindingId)
      .executeTakeFirstOrThrow();
    await expect(
      resolveIntegrationAccountBinding({
        accountAttached: true,
        database,
        kind: "server",
        ownerUserId,
      }),
    ).resolves.toEqual(first);

    await database.deleteFrom("authAccounts").where("id", "=", originalBindingId).execute();
    await insertAuthAccount({ id: createId("authAccount"), subject, userId: ownerUserId });
    const recreated = await resolveIntegrationAccountBinding({
      accountAttached: true,
      database,
      kind: "server",
      ownerUserId,
    });
    expect(IntegrationAccountBindingSchema.parse(recreated)).toMatchObject({ issuer, subject });
    expect(recreated?.linkGeneration).not.toBe(first?.linkGeneration);
  });

  it("invalidates a server binding when its provider changes", async () => {
    const ownerUserId = await createUser("administrator");
    const subject = ControlPlaneAccountIdSchema.parse(`acct_${randomUUID()}`);
    const createdAt = new Date("2026-09-18T12:00:00.000Z");
    await database
      .insertInto("accountDirectoryProvider")
      .values({
        createdAt,
        issuer,
        providerId,
        singletonKey: "opensteer-account",
        updatedAt: createdAt,
      })
      .executeTakeFirstOrThrow();
    await insertAuthAccount({ id: createId("authAccount"), subject, userId: ownerUserId });
    const before = await resolveIntegrationAccountBinding({
      accountAttached: true,
      database,
      kind: "server",
      ownerUserId,
    });

    await database
      .updateTable("accountDirectoryProvider")
      .set({ updatedAt: new Date("2026-09-18T12:00:01.000Z") })
      .where("singletonKey", "=", "opensteer-account")
      .executeTakeFirstOrThrow();
    const after = await resolveIntegrationAccountBinding({
      accountAttached: true,
      database,
      kind: "server",
      ownerUserId,
    });

    expect(IntegrationAccountBindingSchema.parse(after)).toMatchObject({ issuer, subject });
    expect(after?.linkGeneration).not.toBe(before?.linkGeneration);
  });

  it("requires an attached Account and an enabled server owner", async () => {
    const ownerUserId = await createUser("administrator");
    const subject = ControlPlaneAccountIdSchema.parse(`acct_${randomUUID()}`);
    const now = new Date();
    await database
      .insertInto("accountDirectoryProvider")
      .values({
        createdAt: now,
        issuer,
        providerId,
        singletonKey: "opensteer-account",
        updatedAt: now,
      })
      .executeTakeFirstOrThrow();
    await insertAuthAccount({ id: createId("authAccount"), subject, userId: ownerUserId });

    await expect(
      resolveIntegrationAccountBinding({
        accountAttached: false,
        database,
        kind: "server",
        ownerUserId,
      }),
    ).resolves.toBeNull();
    await database
      .updateTable("users")
      .set({ disabledAt: new Date(), updatedAt: new Date() })
      .where("id", "=", ownerUserId)
      .executeTakeFirstOrThrow();
    await expect(
      resolveIntegrationAccountBinding({
        accountAttached: true,
        database,
        kind: "server",
        ownerUserId,
      }),
    ).resolves.toBeNull();
  });

  it("preserves the Personal Account link generation for an enabled administrator", async () => {
    const ownerUserId = await createUser("administrator");
    const subject = ControlPlaneAccountIdSchema.parse(`acct_${randomUUID()}`);
    const linkGeneration = "P".repeat(43);
    await insertPersonalLink({ linkGeneration, state: "active", subject });

    const binding = await resolveIntegrationAccountBinding({
      accountAttached: false,
      database,
      kind: "personal",
      ownerUserId,
    });
    expect(IntegrationAccountBindingSchema.parse(binding)).toEqual({
      issuer,
      linkGeneration,
      subject,
    });
  });

  it("rejects absent or inactive Personal links and ineligible owners", async () => {
    const ownerUserId = await createUser("administrator");
    const subject = ControlPlaneAccountIdSchema.parse(`acct_${randomUUID()}`);
    const input = {
      accountAttached: false,
      database,
      kind: "personal" as const,
      ownerUserId,
    };

    await expect(resolveIntegrationAccountBinding(input)).resolves.toBeNull();
    await insertPersonalLink({ linkGeneration: "P".repeat(43), state: "activating", subject });
    await expect(resolveIntegrationAccountBinding(input)).resolves.toBeNull();

    await database
      .updateTable("personalRemoteAccountLink")
      .set({ state: "active", updatedAt: new Date() })
      .where("singletonKey", "=", "opensteer-account")
      .executeTakeFirstOrThrow();
    const ordinaryUserId = await createUser("user");
    await expect(
      resolveIntegrationAccountBinding({ ...input, ownerUserId: ordinaryUserId }),
    ).resolves.toBeNull();
    await database
      .updateTable("users")
      .set({ disabledAt: new Date(), updatedAt: new Date() })
      .where("id", "=", ownerUserId)
      .executeTakeFirstOrThrow();
    await expect(resolveIntegrationAccountBinding(input)).resolves.toBeNull();
    await expect(
      resolveIntegrationAccountBinding({ ...input, ownerUserId: createId("user") }),
    ).resolves.toBeNull();
  });
});

async function createUser(instanceRole: "administrator" | "user"): Promise<UserId> {
  const userId = await store.createUser(`Binding ${instanceRole}`);
  if (instanceRole === "administrator") {
    await database
      .updateTable("users")
      .set({ instanceRole, updatedAt: new Date() })
      .where("id", "=", userId)
      .executeTakeFirstOrThrow();
  }
  return userId;
}

async function insertAuthAccount(input: {
  readonly id: ReturnType<typeof createId<"authAccount">>;
  readonly subject: string;
  readonly userId: UserId;
}): Promise<void> {
  const now = new Date("2026-09-18T12:00:00.000Z");
  await database
    .insertInto("authAccounts")
    .values({
      accessToken: "access-token",
      accessTokenExpiresAt: null,
      accountId: input.subject,
      createdAt: now,
      id: input.id,
      idToken: null,
      password: null,
      providerId,
      refreshToken: "refresh-token",
      refreshTokenExpiresAt: null,
      scope: "openid profile email",
      updatedAt: now,
      userId: input.userId,
    })
    .executeTakeFirstOrThrow();
}

async function insertPersonalLink(input: {
  readonly linkGeneration: string;
  readonly state: "activating" | "active";
  readonly subject: string;
}): Promise<void> {
  const now = new Date("2026-09-18T12:00:00.000Z");
  await database
    .insertInto("personalRemoteAccountLink")
    .values({
      challengeId: `phc_${randomUUID()}`,
      grantId: `phg_${randomUUID()}`,
      hostCredential: `osc_${"c".repeat(43)}`,
      issuer,
      linkGeneration: input.linkGeneration,
      linkedAt: now,
      singletonKey: "opensteer-account",
      state: input.state,
      subject: input.subject,
      updatedAt: now,
    })
    .executeTakeFirstOrThrow();
}
