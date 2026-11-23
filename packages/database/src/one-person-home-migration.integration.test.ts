import type { AgentGrant, ThreadAccessMode, UserId } from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import { expect } from "vitest";
import { AgentConnectionStore } from "./agent-connection-store.js";
import { migrateToLatest } from "./migrations.js";
import { removeOrganizationsMigrationName } from "./one-person-home-migration.js";
import { applyWorkHome, enableWorkHomeTriggers } from "./one-person-home-migration.test-support.js";
import { withLockOrderMode } from "./lock-order-checker.test-support.js";
import { admitExecution } from "./resource-access.js";
import type { DatabaseSchema } from "./schema.js";
import { describeStore } from "./store.integration.test-support.js";

interface Policy {
  readonly externalMaxMode: ThreadAccessMode;
  readonly allowEverything: boolean;
  readonly allowTasks: boolean;
  readonly devices: "cloud-computer-only" | "assignee-may-enroll";
}
/** A policy that caps nothing, so each test turns one field on. */
const open: Policy = {
  externalMaxMode: "full-access",
  allowEverything: true,
  allowTasks: true,
  devices: "assignee-may-enroll",
};

/**
 * A database at the release before this one, that a work Home was opened on: the work Home's
 * tables, gates, audit triggers and columns exist, the chat end reasons still allow its two, and
 * the contracting migration has not run. `seed` writes what that Home held while its audit
 * triggers ran; the lock order of that release is not this one's, so the checker sits it out.
 */
async function workHomeDatabase<T>(
  database: Kysely<DatabaseSchema>,
  deploymentId: string,
  state: "active" | "offboarding",
  policy: Policy,
  seed: () => Promise<T>,
): Promise<T> {
  await applyWorkHome(database as Kysely<unknown>);
  await sql`
    alter table agent_connections
      drop constraint agent_connections_bridge_ended_by_check,
      add constraint agent_connections_bridge_ended_by_check check (bridge_ended_by in
        ('you', 'organization', 'account', 'computer', 'work-home'));
    insert into work_audit_head default values;
  `.execute(database);
  await sql`
    insert into work_home_policy (assignment_id, deployment_id, organization_name, state,
        revision, policy)
      values (${`was_${crypto.randomUUID()}`}, ${deploymentId}, 'Workshop', ${state}, 3,
        ${JSON.stringify(policy)}::jsonb)
  `.execute(database);
  const seeded = await withLockOrderMode("off", async () => {
    await enableWorkHomeTriggers(database);
    return seed();
  });
  await sql`delete from kysely_migration where name >= ${removeOrganizationsMigrationName}`.execute(
    database,
  );
  return seeded;
}

/** A live connected agent with this grant and mode on its row. */
async function connected(
  database: Kysely<DatabaseSchema>,
  userId: UserId,
  grant: AgentGrant,
  accessMode: ThreadAccessMode,
) {
  const connections = new AgentConnectionStore(database);
  const agent = await connections.create({
    userId,
    label: "Agent",
    clientName: "Agent",
    accessMode: "approval-required",
    resource: "http://localhost/mcp",
    expiresAt: new Date(Date.now() + 60 * 60_000),
    grant: { scope: "selected", tasks: false, resources: [] },
  });
  await connections.activate(agent.id, `hash-${agent.id}`);
  await database
    .updateTable("agentConnections")
    .set({ accessMode, grant: sql`${JSON.stringify(grant)}::jsonb` as never })
    .where("id", "=", agent.id)
    .execute();
  return agent.id;
}

const tasks: AgentGrant = { scope: "selected", tasks: true, resources: [] };
const noTasks: AgentGrant = { scope: "selected", tasks: false, resources: [] };
const everything: AgentGrant = { scope: "everything" };

function connection(database: Kysely<DatabaseSchema>, id: string) {
  return database
    .selectFrom("agentConnections")
    .select([
      "grant",
      "accessMode",
      "grantRevision",
      "revokedAt",
      "tokenHash",
      "cleanupReason",
      "cleanupMaximumMode",
    ])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
}

const admit = (database: Kysely<DatabaseSchema>, ownerUserId: UserId, agentConnectionId: string) =>
  admitExecution(database, {
    ownerUserId,
    subject: { kind: "connection", agentConnectionId },
  });

async function leftovers(database: Kysely<DatabaseSchema>) {
  const { rows } = await sql<{ name: string }>`
    select relname as name from pg_class
      where relnamespace = 'public'::regnamespace and relname like 'work\\_%'
    union all select tgname from pg_trigger where tgname like 'work\\_%'
    union all select proname from pg_proc
      where pronamespace = 'public'::regnamespace and proname like 'work\\_%'
    union all select table_name || '.' || column_name from information_schema.columns
      where table_schema = 'public' and column_name like 'work\\_%'
    order by 1`.execute(database);
  return rows.map(({ name }) => name);
}

/**
 * After the migration, each connection can do no more than it could the moment before it: what
 * the organization's policy let through is what it keeps, and a grant the policy refused, which
 * could do nothing, is ended the way Disconnect ends one, for the person to grant again.
 */
describeStore("a Home that was a work Home becomes an ordinary Home of its one person", (it) => {
  it("externalMaxMode: a mode above the organization's cap becomes the cap", async ({
    storeFixture,
  }) => {
    const { database } = storeFixture;
    const { bridgeId, fixture } = await storeFixture.createChannelDeliveryFixture("work-mode");
    const [above, within] = await workHomeDatabase(
      database,
      fixture.deploymentId,
      "active",
      { ...open, externalMaxMode: "auto-accept-edits" },
      async () => {
        const ids = [
          await connected(database, fixture.userId, tasks, "full-access"),
          await connected(database, fixture.userId, tasks, "approval-required"),
        ] as const;
        // A chat the organization had ended, with the reason it gave.
        await database
          .updateTable("agentConnections")
          .set({
            revokedAt: new Date(),
            cleanupReason: "revoked",
            cleanupRequestedAt: new Date(),
            bridgeEndedBy: "organization" as never,
          })
          .where("id", "=", bridgeId!)
          .execute();
        return ids;
      },
    );
    const [aboveBefore, withinBefore] = [
      await connection(database, above),
      await connection(database, within),
    ];
    const { rows } = await sql<{ count: number }>`
      select count(*)::integer as count from work_audit_outbox`.execute(database);
    expect(rows[0]!.count).toBeGreaterThan(0);

    await migrateToLatest(database);

    expect(await leftovers(database)).toEqual([]);
    expect(await connection(database, above)).toEqual({
      ...aboveBefore,
      accessMode: "auto-accept-edits",
      grantRevision: aboveBefore.grantRevision + 1,
      cleanupReason: "narrowed",
      cleanupMaximumMode: "auto-accept-edits",
    });
    expect(await admit(database, fixture.userId, above)).toMatchObject({
      mode: "auto-accept-edits",
      agentConnection: { grant: tasks, accessMode: "auto-accept-edits" },
    });
    expect(await connection(database, within)).toEqual(withinBefore);
    expect(await admit(database, fixture.userId, within)).toMatchObject({
      mode: "approval-required",
      agentConnection: { grant: tasks },
    });
    // The chat ended for a reason that no longer exists: it keeps none, and reads as ended
    // through the person's list (never "you").
    expect(
      await database
        .selectFrom("agentConnections")
        .select("bridgeEndedBy")
        .where("id", "=", bridgeId!)
        .executeTakeFirstOrThrow(),
    ).toEqual({ bridgeEndedBy: null });
    const listedEnded = (
      await new AgentConnectionStore(database).list(fixture.userId, { includeRevoked: true })
    ).find(({ id }) => id === bridgeId);
    expect(listedEnded).toMatchObject({ state: "stopped", revokedAt: expect.any(String) });
    expect(listedEnded?.bridge?.endedBy).toBeUndefined();
    await expect(
      sql`update agent_connections set bridge_ended_by = 'organization' where id = ${bridgeId!}`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("allowTasks: a grant holding Tasks the policy refused is ended; one without Tasks is kept", async ({
    storeFixture,
  }) => {
    const { database } = storeFixture;
    const { bridgeId, fixture } = await storeFixture.createChannelDeliveryFixture("work-tasks");
    const [refused, kept] = await workHomeDatabase(
      database,
      fixture.deploymentId,
      "active",
      { ...open, allowTasks: false },
      async () => [
        await connected(database, fixture.userId, tasks, "auto"),
        await connected(database, fixture.userId, noTasks, "auto"),
      ],
    );
    const [refusedBefore, keptBefore] = [
      await connection(database, refused),
      await connection(database, kept),
    ];

    await migrateToLatest(database);

    expect(await connection(database, refused)).toEqual({
      ...refusedBefore,
      revokedAt: expect.any(Date),
      tokenHash: null,
      grantRevision: refusedBefore.grantRevision + 1,
      cleanupReason: "revoked",
    });
    await expect(admit(database, fixture.userId, refused)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(await connection(database, kept)).toEqual(keptBefore);
    expect(await admit(database, fixture.userId, kept)).toMatchObject({ mode: "auto" });
    // The open chat revoked by the migration reads as ended with no reason, never "you".
    const listedBridge = (
      await new AgentConnectionStore(database).list(fixture.userId, { includeRevoked: true })
    ).find(({ id }) => id === bridgeId);
    expect(listedBridge).toMatchObject({ state: "stopped", revokedAt: expect.any(String) });
    expect(listedBridge?.bridge?.endedBy).toBeUndefined();
  });

  it("allowEverything: an everything grant the policy refused is ended; a selected one is kept", async ({
    storeFixture,
  }) => {
    const { database } = storeFixture;
    const { fixture } = await storeFixture.createChannelDeliveryFixture("work-everything");
    const [refused, kept] = await workHomeDatabase(
      database,
      fixture.deploymentId,
      "active",
      { ...open, allowEverything: false },
      async () => [
        await connected(database, fixture.userId, everything, "full-access"),
        await connected(database, fixture.userId, tasks, "full-access"),
      ],
    );
    const keptBefore = await connection(database, kept);

    await migrateToLatest(database);

    expect(await connection(database, refused)).toMatchObject({
      revokedAt: expect.any(Date),
      tokenHash: null,
      cleanupReason: "revoked",
    });
    await expect(admit(database, fixture.userId, refused)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(await connection(database, kept)).toEqual(keptBefore);
  });

  it("allowEverything needs allowTasks: everything under a policy without Tasks is ended", async ({
    storeFixture,
  }) => {
    const { database } = storeFixture;
    const { fixture } = await storeFixture.createChannelDeliveryFixture("work-everything-tasks");
    const refused = await workHomeDatabase(
      database,
      fixture.deploymentId,
      "active",
      { ...open, allowTasks: false },
      () => connected(database, fixture.userId, everything, "approval-required"),
    );

    await migrateToLatest(database);

    expect(await connection(database, refused)).toMatchObject({
      revokedAt: expect.any(Date),
      cleanupReason: "revoked",
    });
  });

  it("devices: what the policy said about enrolling devices leaves every connection as it was", async ({
    storeFixture,
  }) => {
    const { database } = storeFixture;
    const { fixture } = await storeFixture.createChannelDeliveryFixture("work-devices");
    const agent = await workHomeDatabase(
      database,
      fixture.deploymentId,
      "active",
      { ...open, devices: "cloud-computer-only" },
      () => connected(database, fixture.userId, everything, "full-access"),
    );
    const before = await connection(database, agent);

    await migrateToLatest(database);

    expect(await connection(database, agent)).toEqual(before);
    expect(await admit(database, fixture.userId, agent)).toMatchObject({ mode: "full-access" });
  });

  it("keeps ended what a closing work Home had ended: its connections are revoked, as Disconnect revokes them", async ({
    storeFixture,
  }) => {
    const { database } = storeFixture;
    const { bridgeId, configured, fixture } =
      await storeFixture.createChannelDeliveryFixture("work-closing");
    const connections = new AgentConnectionStore(database);
    const workHomeEndedChat = await connections.createBridge({
      userId: fixture.userId,
      accountId: configured.account.id,
      conversation: { id: "C-work-home-ended", name: "#ops" },
      senders: "owner",
      accessMode: "auto",
      grant: tasks,
    });
    const personEndedChat = await connections.createBridge({
      userId: fixture.userId,
      accountId: configured.account.id,
      conversation: { id: "C-person-ended", name: "#mine" },
      senders: "owner",
      accessMode: "auto",
      grant: tasks,
    });
    await connections.revoke(fixture.userId, personEndedChat.id);
    const agent = await workHomeDatabase(
      database,
      fixture.deploymentId,
      "offboarding",
      open,
      async () => {
        await database
          .updateTable("agentConnections")
          .set({
            revokedAt: new Date(),
            cleanupReason: "revoked",
            cleanupRequestedAt: new Date(),
            bridgeEndedBy: "work-home" as never,
          })
          .where("id", "=", workHomeEndedChat.id)
          .execute();
        return connected(database, fixture.userId, tasks, "auto");
      },
    );
    const before = await connection(database, agent);

    await migrateToLatest(database);

    expect(await leftovers(database)).toEqual([]);
    expect(await connection(database, agent)).toEqual({
      ...before,
      grantRevision: before.grantRevision + 1,
      revokedAt: expect.any(Date),
      tokenHash: null,
      cleanupReason: "revoked",
    });
    await expect(admit(database, fixture.userId, agent)).rejects.toMatchObject({
      code: "forbidden",
    });
    const listed = await connections.list(fixture.userId, { includeRevoked: true });
    for (const id of [bridgeId!, workHomeEndedChat.id]) {
      const chat = listed.find((row) => row.id === id);
      expect(chat).toMatchObject({ state: "stopped", revokedAt: expect.any(String) });
      expect(chat?.bridge?.endedBy).toBeUndefined();
    }
    expect(listed.find((row) => row.id === personEndedChat.id)).toMatchObject({
      state: "stopped",
      bridge: { endedBy: "you" },
    });
  });

  it("touches nothing on a database that never had a work Home", async ({ storeFixture }) => {
    const { database } = storeFixture;
    const { fixture } = await storeFixture.createChannelDeliveryFixture("never-work");
    const agent = await connected(database, fixture.userId, tasks, "auto");
    const before = await connection(database, agent);
    await sql`delete from kysely_migration where name >= ${removeOrganizationsMigrationName}`.execute(
      database,
    );
    await migrateToLatest(database);
    expect(await connection(database, agent)).toEqual(before);
    expect(await leftovers(database)).toEqual([]);
  });

  it("leaves connections that had already expired exactly as they are", async ({
    storeFixture,
  }) => {
    const { database } = storeFixture;
    const { fixture } = await storeFixture.createChannelDeliveryFixture("work-expired");
    const expiredAt = new Date(Date.now() - 60 * 60_000);
    const cleanedAt = new Date(Date.now() - 30 * 60_000);
    const expired = async (grant: AgentGrant, accessMode: ThreadAccessMode) => {
      const id = await connected(database, fixture.userId, grant, accessMode);
      await database
        .updateTable("agentConnections")
        .set({
          expiresAt: expiredAt,
          cleanupReason: "expired",
          cleanupRequestedAt: expiredAt,
          cleanupCompletedAt: cleanedAt,
        })
        .where("id", "=", id)
        .execute();
      return id;
    };
    const [aboveCap, refusedGrant] = await workHomeDatabase(
      database,
      fixture.deploymentId,
      "active",
      { ...open, externalMaxMode: "approval-required", allowEverything: false },
      async () =>
        [await expired(tasks, "full-access"), await expired(everything, "full-access")] as const,
    );
    const snapshot = (id: string) =>
      database
        .selectFrom("agentConnections")
        .select([
          "grant",
          "accessMode",
          "grantRevision",
          "revokedAt",
          "tokenHash",
          "expiresAt",
          "cleanupReason",
          "cleanupRequestedAt",
          "cleanupCompletedAt",
          "cleanupMinimumGrantRevision",
          "cleanupMaximumMode",
        ])
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
    const [aboveCapBefore, refusedGrantBefore] = [
      await snapshot(aboveCap),
      await snapshot(refusedGrant),
    ];

    await migrateToLatest(database);

    expect(await snapshot(aboveCap)).toEqual(aboveCapBefore);
    expect(await snapshot(refusedGrant)).toEqual(refusedGrantBefore);
    await expect(admit(database, fixture.userId, aboveCap)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(admit(database, fixture.userId, refusedGrant)).rejects.toMatchObject({
      code: "forbidden",
    });
  });
});
