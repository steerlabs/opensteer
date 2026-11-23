import { createId, type UserId } from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import { expect } from "vitest";
import { AgentConnectionStore } from "./agent-connection-store.js";
import { migrateToLatest } from "./migrations.js";
import { removeOrganizationsMigrationName } from "./one-person-home-migration.js";
import { applyWorkHome, enableWorkHomeTriggers } from "./one-person-home-migration.test-support.js";
import { admitExecution } from "./resource-access.js";
import type { DatabaseSchema } from "./schema.js";
import { describeStore } from "./store.integration.test-support.js";

/**
 * A database at the release before this one, that a work Home was opened on: the work Home's
 * tables, gates, audit triggers and columns exist, the chat end reasons still allow its two, and
 * the contracting migration has not run.
 */
async function workHomeDatabase(
  database: Kysely<DatabaseSchema>,
  deploymentId: string,
  state: "active" | "offboarding",
) {
  await applyWorkHome(database as Kysely<unknown>);
  await sql`
    alter table agent_connections
      drop constraint agent_connections_bridge_ended_by_check,
      add constraint agent_connections_bridge_ended_by_check check (bridge_ended_by in
        ('you', 'organization', 'account', 'computer', 'work-home'));
    insert into work_home_policy (assignment_id, deployment_id, organization_name, state,
        revision, policy)
      values (${`was_${crypto.randomUUID()}`}, ${deploymentId}, 'Workshop', ${state}, 3,
        '{"externalMaxMode":"approval-required","allowEverything":false,"allowTasks":false,"devices":"cloud-computer-only"}');
    insert into work_audit_head default values;
  `.execute(database);
  await enableWorkHomeTriggers(database);
  await sql`delete from kysely_migration where name = ${removeOrganizationsMigrationName}`.execute(
    database,
  );
}

/** What the person chose for a connected agent: Tasks, and Auto, above what the policy allowed. */
async function personsChoice(database: Kysely<DatabaseSchema>, userId: UserId) {
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
    .set({
      accessMode: "auto",
      grant: sql`'{"scope":"selected","tasks":true,"resources":[]}'::jsonb` as never,
    })
    .where("id", "=", agent.id)
    .execute();
  return agent.id;
}

function connection(database: Kysely<DatabaseSchema>, id: string) {
  return database
    .selectFrom("agentConnections")
    .select(["grant", "accessMode", "grantRevision", "revokedAt", "tokenHash", "cleanupReason"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
}

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

describeStore("a Home that was a work Home becomes an ordinary Home of its one person", (it) => {
  it("drops the work Home and admits its connection with the grant and mode the person chose", async ({
    storeFixture,
  }) => {
    const { database } = storeFixture;
    const { bridgeId, fixture } = await storeFixture.createChannelDeliveryFixture("former-work");
    await workHomeDatabase(database, fixture.deploymentId, "active");
    const agent = await personsChoice(database, fixture.userId);
    // A chat the organization had ended, with the reason it gave.
    await database
      .updateTable("agentConnections")
      .set({
        revokedAt: new Date(),
        cleanupReason: "revoked",
        bridgeEndedBy: "organization" as never,
      })
      .where("id", "=", bridgeId!)
      .execute();
    const before = await connection(database, agent);
    // The audit triggers wrote what happened to the outbox the organization read.
    const { rows } = await sql<{ count: number }>`
      select count(*)::integer as count from work_audit_outbox`.execute(database);
    expect(rows[0]!.count).toBeGreaterThan(0);

    await migrateToLatest(database);

    expect(await leftovers(database)).toEqual([]);
    // Exactly what the person chose, uncapped: nothing narrows it any more.
    expect(await connection(database, agent)).toEqual(before);
    const admitted = await admitExecution(database, {
      ownerUserId: fixture.userId,
      subject: { kind: "connection", agentConnectionId: agent },
    });
    expect(admitted).toMatchObject({
      actor: "agent",
      mode: "auto",
      agentConnection: {
        agentConnectionId: agent,
        accessMode: "auto",
        grant: { scope: "selected", tasks: true, resources: [] },
      },
    });
    // The chat ended for a reason that no longer exists: it keeps none, and reads as ended.
    expect(
      await database
        .selectFrom("agentConnections")
        .select("bridgeEndedBy")
        .where("id", "=", bridgeId!)
        .executeTakeFirstOrThrow(),
    ).toEqual({ bridgeEndedBy: null });
    await expect(
      sql`update agent_connections set bridge_ended_by = 'organization' where id = ${bridgeId!}`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: "23514" });
    const listed = (
      await new AgentConnectionStore(database).list(fixture.userId, { includeRevoked: true })
    ).find(({ id }) => id === bridgeId);
    expect(listed?.bridge?.endedBy).not.toBe("organization");
  });

  it("keeps ended what a closing work Home had ended: its connections are revoked, as Disconnect revokes them", async ({
    storeFixture,
  }) => {
    const { database } = storeFixture;
    const { fixture } = await storeFixture.createChannelDeliveryFixture("former-work-closing");
    await workHomeDatabase(database, fixture.deploymentId, "offboarding");
    const agent = await personsChoice(database, fixture.userId);
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
    await expect(
      admitExecution(database, {
        ownerUserId: fixture.userId,
        subject: { kind: "connection", agentConnectionId: agent },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("touches nothing on a database that never had a work Home", async ({ storeFixture }) => {
    const { database } = storeFixture;
    const { fixture } = await storeFixture.createChannelDeliveryFixture("never-work");
    const agent = await personsChoice(database, fixture.userId);
    const before = await connection(database, agent);
    await sql`delete from kysely_migration where name = ${removeOrganizationsMigrationName}`.execute(
      database,
    );
    await migrateToLatest(database);
    expect(await connection(database, agent)).toEqual(before);
    expect(await leftovers(database)).toEqual([]);
    expect(createId("deployment")).toMatch(/^dep_/u);
  });
});
