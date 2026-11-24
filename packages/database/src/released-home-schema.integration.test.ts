import { sql, type Kysely } from "kysely";
import { afterEach, expect, it } from "vitest";
import { createDatabase } from "./connection.js";
import { createId } from "@opensteer/core";
import { migrateToLatest } from "./migrations.js";
import {
  emptyPublicSchema,
  loadReleasedHome,
  seedReleasedHomeTask,
} from "./released-home.test-support.js";
import type { DatabaseSchema } from "./schema.js";
import { cloneTestDatabase, type TestDatabase } from "./test-database.test-support.js";

const owned: { clone: TestDatabase; database: Kysely<DatabaseSchema> }[] = [];
afterEach(async () => {
  for (const { clone, database } of owned.splice(0)) {
    try {
      await database.destroy();
    } finally {
      await clone.drop();
    }
  }
});

async function emptyDatabase() {
  const clone = await cloneTestDatabase("host");
  const database = createDatabase({ connectionString: clone.url });
  owned.push({ clone, database });
  return { clone, database };
}

/** Every object of the public schema, one line each, as PostgreSQL itself prints it. */
async function catalog(database: Kysely<DatabaseSchema>): Promise<string[]> {
  const { rows } = await sql<{ line: string }>`
    select 'relation ' || c.relname || ' ' || c.relkind::text as line
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p','v','m','S','f')
    union all
    select 'column ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
      || case when a.attnotnull then ' not null' else '' end
      || coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), '')
      || case when a.attgenerated <> '' then ' generated' else '' end
    from pg_attribute a join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where n.nspname = 'public' and c.relkind in ('r','p','v','m','f') and a.attnum > 0
      and not a.attisdropped
    union all
    select 'constraint ' || c.relname || '.' || k.conname || ' ' || pg_get_constraintdef(k.oid)
    from pg_constraint k join pg_class c on c.oid = k.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
    union all
    select 'index ' || indexname || ' ' || indexdef from pg_indexes where schemaname = 'public'
    union all
    select 'trigger ' || c.relname || '.' || t.tgname || ' ' || pg_get_triggerdef(t.oid)
    from pg_trigger t join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and not t.tgisinternal
    union all
    select 'function ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') '
      || pg_get_functiondef(p.oid)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind in ('f','p')
    union all
    select 'view ' || viewname || ' ' || definition from pg_views where schemaname = 'public'
    union all
    select 'ledger ' || name from kysely_migration
  `.execute(database);
  return rows.map(({ line }) => line).sort();
}

/**
 * What a released Home keeps that a fresh install holds in another form, by name, each with why.
 * Anything else that differs is a released body this branch changed, or a branch migration that
 * does not converge, and fails here.
 */
const readBack = new Map([
  [
    // main's team_blobs CHECK is two BETWEENs; pg_dump prints them as ANDs and PostgreSQL reads
    // those back flat. The same condition, on a team table nothing reads.
    "constraint team_blobs.team_blobs_check CHECK (((size_bytes >= 1) AND (size_bytes <= 104857600) AND ((received_bytes >= 0) AND (received_bytes <= size_bytes))))",
    "constraint team_blobs.team_blobs_check CHECK ((((size_bytes >= 1) AND (size_bytes <= 104857600)) AND ((received_bytes >= 0) AND (received_bytes <= size_bytes))))",
  ],
]);

/** Main-era rows that make this release's migrations do real work on main's real schema. */
async function seedMainEra(database: Kysely<DatabaseSchema>) {
  const home = await seedReleasedHomeTask(database, "Released Home");
  const row = async (state: string, team: boolean, connection: string | null) => {
    const message = createId("message");
    const chain = createId("causalChain");
    const request = createId("teamAgentRequest");
    const sequence = (
      await sql<{ next: string }>`
      update threads set next_message_sequence = next_message_sequence + 1 where id = ${home.thread}
      returning next_message_sequence - 1 as next`.execute(database)
    ).rows[0]!.next;
    const author = connection
      ? { kind: "connection", connectionId: connection, displayName: "Research agent" }
      : team
        ? {
            kind: "team-member",
            actor: "human",
            teamId: home.deploymentId,
            teamUserId: createId("user"),
            displayName: "Sam",
          }
        : { kind: "human", userId: home.userId, principalId: home.principal, displayName: "Alex" };
    const authority = connection
      ? { kind: "connection", connectionId: connection, userId: home.userId }
      : team
        ? { kind: "team-request", teamId: home.deploymentId, requestId: request }
        : { kind: "user-session", userId: home.userId };
    await sql`insert into causal_chains (id, max_delegations, max_autonomous_runs, used_delegations, used_autonomous_runs)
      values (${chain}, 100, 100, 0, 0)`.execute(database);
    await sql`insert into messages (id, thread_id, sequence, kind, actor_principal_id, author, content)
      values (${message}, ${home.thread}, ${sequence}, 'input', ${home.principal},
        ${JSON.stringify(author)}::jsonb, '[{"type":"text","text":"From before the update"}]')`.execute(
      database,
    );
    await sql`insert into thread_inputs
      (message_id, thread_id, actor_principal_id, authority_source, causal_chain_id, idempotency_key,
        policy, queue_rank, request_fingerprint, requested_by, state, delivered_at, team_request_id,
        team_source, reply_target)
      values (${message}, ${home.thread}, ${home.principal}, ${JSON.stringify(authority)}::jsonb,
        ${chain}, ${`released:${message}`}, 'queue', ${sequence}, 'fixture', ${home.userId}, ${state},
        ${state === "delivered" ? sql`now()` : null}, ${team ? request : null},
        ${team ? JSON.stringify({ teamId: home.deploymentId, channelId: createId("teamChannel"), threadRootId: "1", messageId: null, audience: { teamName: "Design", channelName: "launch", channelKind: "public", memberCount: 3, peopleOnly: false } }) : null}::jsonb,
        ${team ? JSON.stringify({ kind: "team-thread", teamId: home.deploymentId, channelId: createId("teamChannel"), threadRootId: "1", requestId: request }) : null}::jsonb)`.execute(
      database,
    );
    return message;
  };
  const ask = await row("awaiting-approval", true, null);
  const connection = `mcn_${crypto.randomUUID()}`;
  await sql`insert into agent_connections (id, user_id, label, client_name, access_mode, resource, token_hash, expires_at)
    values (${connection}, ${home.userId}, 'Agent', 'Agent', 'auto', 'https://home.invalid/mcp',
      'synthetic-test-hash', now() + interval '1 day')`.execute(database);
  const written = await row("delivered", false, connection);
  const trigger = createId("trigger");
  const revision = `trv_${crypto.randomUUID()}`;
  // Inserted together: a trigger's current revision is checked at commit.
  await database.transaction().execute(async (tx) => {
    await sql`insert into triggers
    (id, anchor_thread_id, created_by, idempotency_key, request_fingerprint, name, kind, status,
     current_revision_id, consecutive_failures, webhook_route_key, webhook_secret_hash)
    values (${trigger}, ${home.thread}, ${home.userId}, 'released-webhook', 'fp-released',
      'Released webhook', 'webhook', 'active', ${revision}, 0,
      'wh_legacy0123456789abcdef0123456789ab', 'synthetic-main-secret-hash')`.execute(tx);
    await sql`insert into trigger_revisions(id, trigger_id, ordinal, source, program, created_by)
    values (${revision}, ${trigger}, 1, '{"kind":"webhook"}'::jsonb,
      '{"language":"typescript","source":"export default async () => null","toolContractVersion":5}'::jsonb,
      ${home.userId})`.execute(tx);
  });
  return { ask, written, connection, trigger };
}

it("takes a released Home, with main-era work in it, to exactly what a fresh install of this release is", async () => {
  const released = await emptyDatabase();
  await loadReleasedHome(released.clone.url);
  const seeded = await seedMainEra(released.database);
  await migrateToLatest(released.database);
  const fresh = await emptyDatabase();
  await sql.raw(emptyPublicSchema()).execute(fresh.database);
  await migrateToLatest(fresh.database);

  const upgraded = new Set(await catalog(released.database));
  const installed = new Set(await catalog(fresh.database));
  for (const [kept, made] of readBack) {
    expect(upgraded.delete(kept), kept).toBe(true);
    expect(installed.delete(made), made).toBe(true);
  }
  expect({
    onlyOnReleasedHome: [...upgraded].filter((line) => !installed.has(line)),
    onlyOnFreshInstall: [...installed].filter((line) => !upgraded.has(line)),
  }).toEqual({ onlyOnReleasedHome: [], onlyOnFreshInstall: [] });

  // And the work in it came through as this release reads it.
  expect(
    await released.database
      .selectFrom("threadInputs")
      .select(["messageId", "state", "cancelReason", "replyTarget", "connectionId"])
      .where("messageId", "in", [seeded.ask, seeded.written])
      .orderBy(sql`message_id = ${seeded.ask}`, "desc")
      .execute(),
  ).toEqual([
    {
      messageId: seeded.ask,
      state: "cancelled",
      cancelReason: "team-work-ended",
      replyTarget: null,
      connectionId: null,
    },
    {
      messageId: seeded.written,
      state: "delivered",
      cancelReason: null,
      replyTarget: null,
      connectionId: seeded.connection,
    },
  ]);
  const webhook = (
    await sql<{ status: string; routeKey: string }>`
      select status, webhook_route_key as route_key from triggers where id = ${seeded.trigger}`.execute(
      released.database,
    )
  ).rows[0]!;
  expect(webhook.status).toBe("paused");
  expect(webhook.routeKey).not.toBe("wh_legacy0123456789abcdef0123456789ab");
});
