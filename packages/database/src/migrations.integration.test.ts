import { createId } from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "./connection.js";
import {
  MigrationLineageError,
  migrateToLatest,
  personalTeamBaselineName,
  migrationProvider,
} from "./migrations.js";
import type { DatabaseSchema } from "./schema.js";
import { cloneTestDatabase, type TestDatabase } from "./test-database.test-support.js";
import { seedPersonalFixture } from "./personal-fixture.test-support.js";
import { AccountDirectoryStore } from "./account-directory-store.js";

let clone: TestDatabase;
let database: Kysely<DatabaseSchema>;
beforeEach(async () => {
  clone = await cloneTestDatabase("host");
  database = createDatabase({ connectionString: clone.url });
  await sql`drop schema public cascade; create schema public`.execute(database);
});
afterEach(async () => {
  try {
    await database?.destroy();
  } finally {
    await clone?.drop();
  }
});

async function catalog() {
  return (
    await sql<{ name: string; kind: string; definition: string | null }>`
    select c.relname as name,c.relkind as kind,case when c.relkind='i' then pg_get_indexdef(c.oid) else null end as definition
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' order by c.relname
  `.execute(database)
  ).rows;
}
async function team() {
  const owner = createId("user");
  const channel = createId("teamChannel");
  const other = createId("teamChannel");
  await sql`insert into users(id,display_name,email,email_verified,created_at,updated_at) values(${owner},'Maya','maya@example.invalid',true,now(),now());
  `.execute(database);
  await sql`insert into team_members(user_id,handle,role,state,joined_at,changed_at) values(${owner},'maya','owner','active',now(),now())`.execute(
    database,
  );
  for (const [id, name] of [
    [channel, "support"],
    [other, "private"],
  ] as const)
    await sql`
   insert into team_channels(id,kind,name,normalized_name,created_by,people_only,instructions_markdown) values(${id},'public',${name},${name},${owner},false,'')
  `.execute(database);
  return { owner, channel, other };
}
async function message(channel: string, owner: string, clientId = crypto.randomUUID()) {
  return (
    await sql<{
      id: string;
    }>`insert into team_messages(channel_id,author_user_id,author_kind,client_message_id,body_markdown,plain_text,change_seq)
    values(${channel},${owner},'human',${clientId},'Support fox','Support fox',1) returning id`.execute(
      database,
    )
  ).rows[0]!.id;
}

describe("fresh personal/team lineage", () => {
  it("projects Account ownership changes and fences an acknowledgement from before revocation", async () => {
    await migrateToLatest(database);
    const { userId } = await seedPersonalFixture(database, "/tmp/fixture-agent-home");
    const directory = new AccountDirectoryStore(database);
    await directory.configureProvider({
      issuer: "https://accounts.invalid",
      providerId: "oidc:account",
    });
    const accountId = "account-owner";
    const id = createId("authAccount");
    await database
      .insertInto("authAccounts")
      .values({ id, userId, providerId: "oidc:account", accountId })
      .execute();
    const [pending] = await directory.claimPending();
    expect(pending).toMatchObject({ userId, present: true, generation: 1 });
    if (!pending) throw new Error("Owner directory projection was not queued");
    await directory.refreshUser(userId);
    await database
      .updateTable("users")
      .set({ disabledAt: new Date() })
      .where("id", "=", userId)
      .execute();
    await expect(directory.complete(pending)).resolves.toBe(false);
    const [removed] = await directory.claimPending();
    expect(removed).toMatchObject({ userId, present: false, generation: 2 });
    await database
      .updateTable("users")
      .set({ disabledAt: null })
      .where("id", "=", userId)
      .execute();
    const [restored] = await directory.claimPending();
    expect(restored).toMatchObject({ userId, present: true, generation: 3 });
    await database.deleteFrom("authAccounts").where("id", "=", id).execute();
    expect(await directory.claimPending()).toEqual([
      expect.objectContaining({ userId, present: false, generation: 4 }),
    ]);
  });
  it("preserves personal operation journals and production upsert identities", async () => {
    await migrateToLatest(database);
    const operation = (
      await sql<{
        dataType: string;
      }>`select data_type from information_schema.columns where table_schema='public' and table_name='personal_remote_account_link' and column_name='account_operation'`.execute(
        database,
      )
    ).rows;
    expect(operation).toEqual([{ dataType: "jsonb" }]);
    const revision = (
      await sql<{
        columnDefault: string;
      }>`select column_default from information_schema.columns where table_schema='public' and table_name='delegations' and column_name='revision'`.execute(
        database,
      )
    ).rows;
    expect(revision).toEqual([{ columnDefault: "1" }]);
    expect(
      (
        await sql`select table_name,column_name,data_type,is_nullable from information_schema.columns where table_schema='public' and ((table_name='plugin_owner_settings' and column_name='revision') or (table_name='personal_desktop_update' and column_name='detail')) order by table_name`.execute(
          database,
        )
      ).rows,
    ).toEqual([
      {
        tableName: "personal_desktop_update",
        columnName: "detail",
        dataType: "text",
        isNullable: "YES",
      },
      {
        tableName: "plugin_owner_settings",
        columnName: "revision",
        dataType: "integer",
        isNullable: "NO",
      },
    ]);
    const constraints = (
      await sql<{
        name: string;
        definition: string;
      }>`select conname as name,pg_get_constraintdef(oid) as definition from pg_constraint where conrelid in ('specialists'::regclass,'browser_session_uses'::regclass) and contype='u' order by conname`.execute(
        database,
      )
    ).rows;
    expect(constraints).toEqual([
      {
        name: "browser_session_uses_identity",
        definition: "UNIQUE NULLS NOT DISTINCT (session_id, thread_id, run_id, tab_id)",
      },
      { name: "specialists_plugin_owner", definition: "UNIQUE (plugin_id, owner_user_id)" },
    ]);
    const indexes = await catalog();
    expect(indexes.find(({ name }) => name === "delegations_result_message")?.definition).toMatch(
      /^CREATE INDEX .*\(result_message_id\)/u,
    );
    expect(
      indexes.find(({ name }) => name === "automation_failure_notices_occurrence_id_key")
        ?.definition,
    ).toContain("UNIQUE INDEX");
    expect(indexes.find(({ name }) => name === "threads_creator_created")?.definition).toContain(
      "created_by, created_at DESC, id DESC",
    );
  });
  it("migrates existing device policies without widening shell access or binding sessions", async () => {
    const all = await migrationProvider().getMigrations();
    await migrateToLatest(database, {
      async getMigrations() {
        return { [personalTeamBaselineName]: all[personalTeamBaselineName]! };
      },
    });
    const fixture = await seedPersonalFixture(database, "/tmp/pre-devices-home");
    const original = { reach: "nobody", commands: false, forwarding: true, shares: [] };
    await sql`update runners set access_policy = ${JSON.stringify(original)}::jsonb`.execute(
      database,
    );
    await migrateToLatest(database);
    const runner = await database
      .selectFrom("runners")
      .select("accessPolicy")
      .where("id", "=", fixture.runnerId)
      .executeTakeFirstOrThrow();
    expect(runner.accessPolicy).toEqual({ ...original, browser: true, apps: true });
    const columns = await sql<{
      name: string;
    }>`select column_name as name from information_schema.columns where table_name='auth_sessions' and column_name='device_id'`.execute(
      database,
    );
    expect(columns.rows).toEqual([{ name: "device_id" }]);
  });
  it("applies both kinds' tables once and survives restart", async () => {
    await migrateToLatest(database);
    const before = await catalog();
    expect(before.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "personal_settings",
        "threads",
        "deployment_events",
        "team_messages",
        "team_agent_requests",
        "personal_team_requests",
      ]),
    );
    expect(
      before.filter((row) =>
        /workspace|project_runtime|effective_membership|team_run_tickets|team_channel_changes|team_reactions|team_command_receipts|team_message_search|knowledge/.test(
          row.name,
        ),
      ),
    ).toEqual([]);
    await database.destroy();
    database = createDatabase({ connectionString: clone.url });
    await migrateToLatest(database);
    expect(await catalog()).toEqual(before);
    expect(
      (await sql<{ name: string }>`select name from kysely_migration`.execute(database)).rows,
    ).toEqual([
      { name: personalTeamBaselineName },
      { name: "0003_devices" },
      { name: "0004_device_access_requests" },
    ]);
  });
  it.each([
    ["app_versions", "size_bytes", "integer", "NO"],
    ["computer_app_setup_requests", "app", "jsonb", "NO"],
    ["computer_app_setup_requests", "server", "jsonb", "NO"],
    ["integration_connections", "computer_app", "jsonb", "NO"],
    ["plugin_owner_settings", "revision", "integer", "NO"],
    ["delegations", "revision", "integer", "NO"],
    ["browser_tab_layouts", "tab_order", "jsonb", "NO"],
    ["machine_access_events", "id", "bigint", "YES"],
    ["mcp_oauth_credentials", "encrypted_state", "bytea", "NO"],
  ])("preserves the private storage contract for %s.%s", async (table, column, type, identity) => {
    await migrateToLatest(database);
    const result = await sql<{ dataType: string; isIdentity: string }>`
      select data_type, is_identity from information_schema.columns
      where table_schema='public' and table_name=${table} and column_name=${column}
    `.execute(database);
    expect(result.rows).toEqual([{ dataType: type, isIdentity: identity }]);
  });
  it("starts credentials at a positive generation and keys browser attachments by session and binding", async () => {
    await migrateToLatest(database);
    const generation = await sql<{ columnDefault: string }>`
      select column_default from information_schema.columns
      where table_schema='public' and table_name='integration_connections' and column_name='credential_generation'
    `.execute(database);
    expect(generation.rows).toEqual([{ columnDefault: "1" }]);
    const key = await sql<{ columns: string[] }>`
      select array_agg(a.attname::text order by k.ordinality) as columns
      from pg_constraint c cross join lateral unnest(c.conkey) with ordinality k(attnum, ordinality)
      join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum
      where c.conrelid='browser_session_attachments'::regclass and c.contype='p'
    `.execute(database);
    expect(key.rows[0]?.columns).toEqual(["session_id", "agent_binding_id"]);
  });
  it("publishes one authority generation per owner at commit and rolls invalidations back", async () => {
    await migrateToLatest(database);
    const { owner } = await team();
    const generation = () =>
      database
        .selectFrom("integrationAuthorityGenerations")
        .select("generation")
        .where("ownerUserId", "=", owner)
        .executeTakeFirst();
    await database.transaction().execute(async (tx) => {
      await tx
        .insertInto("pluginOwnerSettings")
        .values({
          ownerUserId: owner,
          targetKey: '["service","records"]',
          target: { kind: "service", definitionId: "records" },
          enabled: true,
          revision: 1,
        })
        .execute();
      await tx
        .updateTable("pluginOwnerSettings")
        .set({ enabled: false })
        .where("ownerUserId", "=", owner)
        .execute();
      expect(await generation()).toBeUndefined();
      expect(
        await tx.selectFrom("integrationAuthorityPending").select("ownerUserId").execute(),
      ).toEqual([{ ownerUserId: owner }]);
    });
    expect(await generation()).toEqual({ generation: 1 });
    const rejection = new Error("rejected mutation");
    await expect(
      database.transaction().execute(async (tx) => {
        await tx
          .updateTable("pluginOwnerSettings")
          .set({ enabled: true })
          .where("ownerUserId", "=", owner)
          .execute();
        throw rejection;
      }),
    ).rejects.toBe(rejection);
    expect(await generation()).toEqual({ generation: 1 });
    expect(await database.selectFrom("integrationAuthorityPending").selectAll().execute()).toEqual(
      [],
    );
  });
  it("rejects a legacy ledger before changing its schema or data", async () => {
    await sql`create table kysely_migration(name varchar(255) primary key,timestamp varchar(255) not null); insert into kysely_migration values('0001_baseline','old'); create table retained(value text); insert into retained values('untouched')`.execute(
      database,
    );
    const before = await catalog();
    await expect(migrateToLatest(database)).rejects.toBeInstanceOf(MigrationLineageError);
    expect(await catalog()).toEqual(before);
    expect((await sql`select * from retained`.execute(database)).rows).toEqual([
      { value: "untouched" },
    ]);
    expect((await sql`select * from kysely_migration`.execute(database)).rows).toEqual([
      { name: "0001_baseline", timestamp: "old" },
    ]);
  });
  it.each([false, true])(
    "refuses unversioned data with an empty ledger present: %s",
    async (emptyLedger) => {
      await sql`create table retained(value text)`.execute(database);
      if (emptyLedger)
        await sql`create table kysely_migration(name varchar(255) primary key,timestamp varchar(255) not null)`.execute(
          database,
        );
      const before = await catalog();
      await expect(migrateToLatest(database)).rejects.toBeInstanceOf(MigrationLineageError);
      expect(await catalog()).toEqual(before);
    },
  );
  it("refuses an unknown forward lineage before writing", async () => {
    await migrateToLatest(database);
    await sql`insert into kysely_migration values('9999_future','future')`.execute(database);
    const before = await catalog();
    await expect(migrateToLatest(database)).rejects.toBeInstanceOf(MigrationLineageError);
    expect(await catalog()).toEqual(before);
  });
  it("keeps generated FTS current within the message transaction and on edits", async () => {
    await migrateToLatest(database);
    const { owner, channel } = await team();
    const id = await message(channel, owner);
    expect(
      (
        await sql`select id from team_messages where search_document @@ websearch_to_tsquery('simple','fox')`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ id }]);
    await sql`update team_messages set plain_text='Fresh owl',body_markdown='Fresh owl',change_seq=2 where id=${id}`.execute(
      database,
    );
    expect(
      (
        await sql`select id from team_messages where search_document @@ websearch_to_tsquery('simple','fox')`.execute(
          database,
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await sql`select id from team_messages where search_document @@ websearch_to_tsquery('simple','owl')`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ id }]);
    expect(
      (await catalog()).find((row) => row.name === "team_messages_search")?.definition,
    ).toContain("USING gin");
  });
  it("enforces same-channel references and preserves tombstone send identity", async () => {
    await migrateToLatest(database);
    const { owner, channel, other } = await team();
    const clientId = crypto.randomUUID();
    const root = await message(channel, owner, clientId);
    await expect(
      sql`insert into team_messages(channel_id,thread_root_id,author_user_id,author_kind,client_message_id,body_markdown,plain_text,change_seq) values(${other},${root},${owner},'human',${crypto.randomUUID()},'bad','bad',1)`.execute(
        database,
      ),
    ).rejects.toThrow(/foreign key/);
    await sql`update team_messages set deleted_at=now(),body_markdown='',plain_text='' where id=${root}`.execute(
      database,
    );
    await expect(message(channel, owner, clientId)).rejects.toThrow(/unique/);
    expect(
      (await sql`select id from team_messages where id=${root}`.execute(database)).rows,
    ).toEqual([{ id: root }]);
  });
  it("makes requests row-resumable and fixes expiry at first accept", async () => {
    await migrateToLatest(database);
    const { owner, channel } = await team();
    const root = await message(channel, owner);
    const link = createId("teamLink");
    const request = createId("teamAgentRequest");
    await sql`insert into team_links(id,owner_user_id,state,code_hash,code_expires_at) values(${link},${owner},'pending','hash',now()+interval '10 minutes')`.execute(
      database,
    );
    await sql`insert into team_agent_requests(id,owner_user_id,channel_id,thread_root_id,trigger_message_id,link_id,state,steps,change_seq) values(${request},${owner},${channel},${root},${root},${link},'queued','[]',2)`.execute(
      database,
    );
    await expect(
      sql`update team_agent_requests set accepted_at=now(),expires_at=now()+interval '8 days' where id=${request}`.execute(
        database,
      ),
    ).rejects.toThrow(/check constraint/);
    await sql`update team_agent_requests set accepted_at=now(),expires_at=now()+interval '7 days',state='working',change_seq=3 where id=${request}`.execute(
      database,
    );
    expect(
      (
        await sql`select id from team_agent_requests where channel_id=${channel} and change_seq>2`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ id: request }]);
    expect(
      (await catalog()).find((row) => row.name === "team_requests_resume")?.definition,
    ).toContain("channel_id, change_seq");
  });
});
