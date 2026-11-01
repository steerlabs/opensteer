import { strongRowLockViolations } from "./strong-row-locks.test-support.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kysely } from "kysely";
import { Migrator } from "kysely/migration";
import { sql } from "kysely";
import { Pool } from "pg";
import { RequestSchema, RunIdSchema, UserIdSchema, type RunId } from "@opensteer/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BASELINE_SCHEMA_SQL } from "./baseline-schema.js";
import { createDatabase } from "./connection.js";
import type { DatabaseSchema } from "./schema.js";
import { OpensteerStore } from "./store.js";
import {
  advertisedAgentsCapacityMigration,
  betterAuth17Migration,
  agentPhoneOwnerAccessMigration,
  browserSourcesMigration,
  browserSourcesRetirementMigration,
  channelDurableAccessMigration,
  channelDeadConceptsMigration,
  computerAppIdentityMigration,
  computerAppPolicyMigration,
  computerAppsMigration,
  computerAppSetupRequestsMigration,
  computerUseApprovalKeysMigration,
  cursorModelIdentityMigration,
  defaultHarnessPerDriverMigration,
  harnessAccountSourcesMigration,
  harnessDefaultLifecycleMigration,
  environmentHarnessInstancesMigration,
  deploymentKindAndHostIdentityMigration,
  harnessExecutablesFromRuntimeMigration,
  harnessModelDefaultsFromEngineMigration,
  integrationAccessClassMigration,
  integrationReasonsMigration,
  integrationToolTargetsMigration,
  machineAccessMigration,
  runnerDeviceMigration,
  messagingSenderPullLinkingMigration,
  oneMachineIdentityMigration,
  ownedNativeOAuthCallbackMigration,
  compatibleEndpointModelIdentityMigration,
  positiveMachineLocalSessionsMigration,
  runUsageAccountingMigration,
  userExecutionPreferencesMigration,
  runnerEnrollmentNameMigration,
  runnerOwnedLocalWorkspacesMigration,
  triggerDownstreamRunLookupMigration,
  triggerOriginatedRequestsMigration,
  triggerAgentAuthorityMigration,
  threadReportQueueMigration,
  threadStateMigration,
  taskMarksMigration,
  migrateToLatest,
  MigrationLineageError,
  migrationProvider,
  unifiedIntegrationAccessMigration,
  watchTriggersMigration,
} from "./migrations.js";

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("migration lineage", () => {
  const databaseName = `opensteer_lineage_${randomUUID().replaceAll("-", "")}`;
  let maintenance: Pool;
  let database: Kysely<DatabaseSchema>;

  beforeAll(async () => {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = "/postgres";
    maintenance = new Pool({ connectionString: url.toString() });
    await maintenance.query(`create database ${databaseName}`);
    url.pathname = `/${databaseName}`;
    database = createDatabase({ connectionString: url.toString() });
  });

  afterAll(async () => {
    await database?.destroy();
    await maintenance?.query(`drop database if exists ${databaseName}`);
    await maintenance?.end();
  });

  it("names the migrations another lineage applied instead of failing without a reason", async () => {
    const provider = { getMigrations: async () => ({ "0001_shared": { up: async () => {} } }) };
    await migrateToLatest(database, provider);
    // A checkout from another lineage applied a migration this build never had.
    // Kysely orders this text column, so use its ISO timestamp format.
    await sql`insert into kysely_migration (name, timestamp) values ('0002_other_lineage', ${new Date().toISOString()})`.execute(
      database,
    );

    const failure = await migrateToLatest(database, provider).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MigrationLineageError);
    expect((failure as Error).message).toContain("0002_other_lineage");
    expect((failure as Error).message).toContain("different migration lineage");
  });

  it("says why a migration failed, whatever it threw", async () => {
    const provider = {
      getMigrations: async () => ({
        "0001_shared": { up: async () => {} },
        "0002_other_lineage": { up: async () => {} },
        "0003_throws": {
          up: async () => {
            throw "migration detail";
          },
        },
      }),
    };
    const failure = await migrateToLatest(database, provider).catch((error: unknown) => error);
    expect((failure as Error).message).toBe(
      "Database migration failed at 0003_throws: migration detail",
    );
  });
});

integration("Trigger agent authority migration", () => {
  const databaseName = `opensteer_trigger_auth_${randomUUID().replaceAll("-", "")}`;
  let maintenance: Pool;
  let database: Kysely<DatabaseSchema>;

  function urlFor(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlFor("postgres") });
    await maintenance.query(`create database ${databaseName}`);
    database = createDatabase({ connectionString: urlFor(databaseName) });
    await sql`
      create table public.threads (id text primary key);
      create table public.triggers (id text primary key, name text not null);
      create table public.trigger_revisions (id text primary key, program jsonb not null);
      insert into public.threads values ('author');
      insert into public.triggers values ('historical', 'Preserved');
      insert into public.trigger_revisions values ('historical-revision', '{"source":"preserved"}');
    `.execute(database);
  });

  afterAll(async () => {
    await database?.destroy();
    await maintenance?.query(`drop database if exists ${databaseName}`);
    await maintenance?.end();
  });

  it("preserves historical definitions, validates authors and clears deleted Thread attribution", async () => {
    await triggerAgentAuthorityMigration.up(database);
    const historical = await sql`
      select id, name, created_by_thread_id from public.triggers
    `.execute(database);
    const revisions = await sql`
      select id, program, created_by_thread_id from public.trigger_revisions
    `.execute(database);
    expect(historical.rows).toEqual([
      { id: "historical", name: "Preserved", createdByThreadId: null },
    ]);
    expect(revisions.rows).toEqual([
      { id: "historical-revision", program: { source: "preserved" }, createdByThreadId: null },
    ]);
    for (const table of ["triggers", "trigger_revisions"]) {
      await expect(
        sql`update ${sql.table(table)} set created_by_thread_id = 'missing'`.execute(database),
      ).rejects.toMatchObject({ code: "23503" });
      await sql`update ${sql.table(table)} set created_by_thread_id = 'author'`.execute(database);
    }
    await sql`delete from public.threads where id = 'author'`.execute(database);
    const after = await sql`
      select id, created_by_thread_id from public.triggers
      union all select id, created_by_thread_id from public.trigger_revisions
      order by id
    `.execute(database);
    expect(after.rows).toEqual([
      { id: "historical", createdByThreadId: null },
      { id: "historical-revision", createdByThreadId: null },
    ]);
    const directory = await mkdtemp(join(tmpdir(), "opensteer-trigger-authority-migration-"));
    const artifact = join(directory, "attribution.json");
    await writeFile(
      artifact,
      JSON.stringify(
        { historical: historical.rows, revisions: revisions.rows, after: after.rows },
        null,
        2,
      ),
    );
    console.info(`Trigger authority migration evidence: ${artifact}`);
  });
});

integration("task marks migration", () => {
  const databaseName = `opensteer_task_marks_${randomUUID().replaceAll("-", "")}`;
  let maintenance: Pool;
  let database: Kysely<DatabaseSchema>;

  function urlFor(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlFor("postgres") });
    await maintenance.query(`create database ${databaseName}`);
    database = createDatabase({ connectionString: urlFor(databaseName) });
    // NOT VALID accepts historical orphans but still rejects new invalid keys.
    // The earlier migration's UPDATE succeeds on their committed row versions.
    await sql`
      create table public.principals (id text primary key);
      create table public.users (id text primary key);
      insert into public.users values ('owner');
      create table public.workspaces (
        id text primary key, created_by text not null, created_at timestamptz not null,
        home_thread_id text, name text not null default 'Legacy'
      );
      create table public.threads (
        id text primary key, created_by text not null, created_at timestamptz not null,
        created_by_principal_id text not null, workspace_id text not null references public.workspaces(id),
        input_queue_paused boolean not null default false
      );
      create table public.requests (originating_thread_id text, status text);
      insert into public.workspaces (id, created_by, created_at, home_thread_id)
        select 'workspace-' || value, case when value < 8 then 'owner' else 'legacy-owner' end,
          '2026-01-01'::timestamptz, case when value = 0 then 'thread-0' else null end
        from generate_series(9, 0, -1) as value;
      insert into public.threads (id, created_by, created_at, created_by_principal_id, workspace_id)
        select 'thread-' || value, case when value < 8 then 'owner' else 'legacy-owner' end,
          '2026-01-01'::timestamptz, 'legacy-principal', 'workspace-' || value
        from generate_series(9, 0, -1) as value;
      alter table public.workspaces add constraint workspaces_creator_fk
        foreign key (created_by) references public.users(id) not valid;
      alter table public.threads add constraint threads_creator_fk
        foreign key (created_by) references public.users(id) not valid;
      alter table public.threads add constraint threads_principal_fk
        foreign key (created_by_principal_id) references public.principals(id) not valid;
    `.execute(database);
  });

  afterAll(async () => {
    await database?.destroy();
    await maintenance?.query(`drop database if exists ${databaseName}`);
    await maintenance?.end();
  });

  it("backfills every accepted legacy row after an earlier migration updates it in the same transaction", async () => {
    const foreignKeys = () =>
      sql`
      select conname, convalidated, condeferrable, condeferred, pg_get_constraintdef(oid) as definition
      from pg_constraint where contype = 'f' and connamespace = 'public'::regnamespace
      order by conname
    `.execute(database);
    const before = (await foreignKeys()).rows;
    const rowVersions = await database.transaction().execute(async (transaction) => {
      const currentTransactionRows = async () =>
        (
          await sql<{ count: number }>`select count(*)::int as count from public.threads
          where xmin::text = pg_current_xact_id()::text`.execute(transaction)
        ).rows[0]!.count;
      const committed = await currentTransactionRows();
      expect(committed).toBe(0);
      // Reproduce 0075's non-key UPDATE followed by 0103 in Kysely's one batch.
      await threadStateMigration.up(transaction);
      const updated = await currentTransactionRows();
      expect(updated).toBe(10);
      await sql`update public.workspaces set name = 'Preserved'`.execute(transaction);
      await taskMarksMigration.up(transaction);
      return { committed, updated };
    });

    const colors = [
      "blue",
      "lime",
      "magenta",
      "teal",
      "purple",
      "green",
      "sky",
      "blue",
      "blue",
      "lime",
    ];
    const threads = await sql`
      select id, color, icon, icon_source, created_by, created_by_principal_id, pending_request_count
      from public.threads order by id
    `.execute(database);
    expect(threads.rows).toEqual(
      colors.map((color, index) => ({
        id: `thread-${index}`,
        color,
        icon: null,
        iconSource: index === 0 ? "chosen" : "provisional",
        createdBy: index < 8 ? "owner" : "legacy-owner",
        createdByPrincipalId: "legacy-principal",
        pendingRequestCount: 0,
      })),
    );
    const workspaces = await sql`
      select id, color, name, created_by from public.workspaces order by id
    `.execute(database);
    expect(workspaces.rows).toEqual(
      colors.map((color, index) => ({
        id: `workspace-${index}`,
        color,
        name: "Preserved",
        createdBy: index < 8 ? "owner" : "legacy-owner",
      })),
    );
    expect((await foreignKeys()).rows).toEqual(before);
    await expect(
      sql`update public.threads set created_by_principal_id = 'new-missing' where id = 'thread-0'`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: "23503", constraint: "threads_principal_fk" });
    await expect(
      sql`update public.workspaces set created_by = 'new-missing' where id = 'workspace-0'`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: "23503", constraint: "workspaces_creator_fk" });
    await expect(
      sql`update public.threads set color = null where id = 'thread-0'`.execute(database),
    ).rejects.toMatchObject({ code: "23502" });
    await expect(
      sql`update public.workspaces set color = 'red' where id = 'workspace-0'`.execute(database),
    ).rejects.toMatchObject({ code: "23514" });
    const directory = await mkdtemp(join(tmpdir(), "opensteer-task-marks-migration-"));
    const artifact = join(directory, "legacy-backfill.json");
    await writeFile(
      artifact,
      JSON.stringify(
        {
          rowVersions,
          threads: threads.rows,
          workspaces: workspaces.rows,
          foreignKeys: before,
          foreignKeysAfter: (await foreignKeys()).rows,
        },
        null,
        2,
      ),
    );
    console.info(`Task marks migration artifact: ${artifact}`);
  });
});

integration.sequential("compatible endpoint model identity migration", () => {
  const databaseName = `opensteer_pi_model_identity_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let database: Kysely<DatabaseSchema>;

  function urlForDatabase(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlForDatabase("postgres") });
    await maintenance.query(`drop database if exists ${databaseName}`);
    await maintenance.query(`create database ${databaseName}`);
    database = createDatabase({ connectionString: urlForDatabase(databaseName) });
    await sql`
      create table public.harness_instances (
        id text primary key,
        driver_kind text not null,
        source_id text not null,
        config jsonb not null,
        runtime_revision integer not null default 1,
        updated_at timestamptz not null default now()
      );
      create table public.harness_catalogs (
        harness_instance_id text primary key references public.harness_instances(id),
        catalog jsonb not null
      );
      insert into public.harness_instances(id, driver_kind, source_id, config) values
        ('old-pi', 'pi', 'openai-compatible', '{"baseUrl":"http://localhost:1234/v1","runtime":"lmstudio","models":{"qwen3.5":{"contextWindow":32768}},"customSetting":"keep"}'),
        ('explicit-pi', 'pi', 'openai-compatible', '{"baseUrl":"http://localhost:1234/v1","modelIdentity":"canonical"}'),
        ('first-party-pi', 'pi', 'openai', '{}'),
        ('opencode-compatible', 'opencode', 'openai-compatible', '{"baseUrl":"http://localhost:1234/v1","runtime":"omlx","models":{"qwen3":{"contextWindow":8192}},"other":"keep"}'),
        ('codex-compatible', 'codex', 'openai-compatible', '{"baseUrl":"http://localhost:1234/v1"}');
      insert into public.harness_catalogs(harness_instance_id, catalog)
        select id, '{"status":"ready"}' from public.harness_instances;
    `.execute(database);
  });

  afterAll(async () => {
    await database?.destroy();
    if (maintenance) {
      await maintenance.query(`drop database if exists ${databaseName}`);
      await maintenance.end();
    }
  });

  it("preserves old compatible IDs without changing other accounts or rerun state", async () => {
    await compatibleEndpointModelIdentityMigration.up(database);
    const first = await sql<{
      id: string;
      config: Record<string, unknown>;
      runtimeRevision: number;
    }>`
      select id, config, runtime_revision from public.harness_instances order by id
    `.execute(database);
    expect(first.rows.find((row) => row.id === "old-pi")).toMatchObject({
      config: {
        baseUrl: "http://localhost:1234/v1",
        runtime: "lmstudio",
        models: { "qwen3.5": { contextWindow: 32768 } },
        customSetting: "keep",
        modelIdentity: "legacy",
      },
      runtimeRevision: 2,
    });
    expect(first.rows.find((row) => row.id === "opencode-compatible")).toMatchObject({
      config: {
        baseUrl: "http://localhost:1234/v1",
        runtime: "omlx",
        models: { qwen3: { contextWindow: 8192 } },
        other: "keep",
        modelIdentity: "legacy",
      },
      runtimeRevision: 2,
    });
    expect(
      first.rows
        .filter((row) => row.id !== "old-pi" && row.id !== "opencode-compatible")
        .every((row) => row.runtimeRevision === 1),
    ).toBe(true);
    expect(first.rows.find((row) => row.id === "explicit-pi")?.config.modelIdentity).toBe(
      "canonical",
    );
    const catalogs = await sql<{ harnessInstanceId: string }>`
      select harness_instance_id from public.harness_catalogs order by harness_instance_id
    `.execute(database);
    expect(catalogs.rows.map((row) => row.harnessInstanceId)).not.toContain("old-pi");
    expect(catalogs.rows.map((row) => row.harnessInstanceId)).not.toContain("opencode-compatible");
    expect(catalogs.rows).toHaveLength(3);

    await compatibleEndpointModelIdentityMigration.up(database);
    const second = await sql<{
      id: string;
      config: Record<string, unknown>;
      runtimeRevision: number;
    }>`
      select id, config, runtime_revision from public.harness_instances order by id
    `.execute(database);
    expect(second.rows).toEqual(first.rows);
  });
});

integration.sequential("browser sources retirement migration", () => {
  const databaseName = `opensteer_browser_sources_retirement_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let database: Kysely<DatabaseSchema>;

  function databaseUrlFor(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: databaseUrlFor("postgres") });
    await maintenance.query(`drop database if exists ${databaseName}`);
    await maintenance.query(`create database ${databaseName}`);
    database = createDatabase({
      connectionString: databaseUrlFor(databaseName),
      maxConnections: 1,
    });
    await sql.raw(BASELINE_SCHEMA_SQL).execute(database);
    await browserSourcesMigration.up(database);

    // The migration only operates on these rows; suppressing relationship
    // triggers keeps the fixture independent of unrelated Runner setup.
    await sql`set session_replication_role = replica`.execute(database);
    try {
      await sql`
        insert into public.execution_environments(id, name, kind)
        values ('env_99999999-9999-4999-8999-999999999999', 'Migration', 'managed');
        insert into public.users(id, display_name, email)
        values ('usr_owner', 'Owner', 'owner@example.com');
        insert into public.workspaces(
          id, name, status, created_by, kind, backing, capacity_policy
        ) values (
          'wsp_origin', 'Origin', 'ready', 'usr_owner', 'specialized',
          '{"kind":"portablefs","serviceId":"test","volumeId":"origin","generation":1}',
          '{"kind":"hard-quota","blockHardLimitBytes":1000000,"inodeHardLimit":1000}'
        ), (
          'wsp_target', 'Target', 'ready', 'usr_owner', 'specialized',
          '{"kind":"portablefs","serviceId":"test","volumeId":"target","generation":1}',
          '{"kind":"hard-quota","blockHardLimitBytes":1000000,"inodeHardLimit":1000}'
        );
        insert into public.threads(
          id, workspace_id, title, environment_id, harness_instance_id, created_by,
          capability_profile_id, created_by_principal_id, model_selection, lineage_root_thread_id
        ) values (
          'thr_origin', 'wsp_origin', 'Origin',
          'env_99999999-9999-4999-8999-999999999999', 'hai_fixture', 'usr_owner',
          'workspace', 'pri_fixture',
          '{"providerId":"openai","modelId":"test","options":{}}', 'thr_origin'
        );
        insert into public.trigger_occurrences(
          id, trigger_id, revision_id, command_id, environment_id, source_key, event, status
        ) values (
          'toc_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'trg_fixture', 'trv_fixture',
          'cmd_fixture', 'env_99999999-9999-4999-8999-999999999999', 'fixture', '{}', 'pending'
        );
        insert into public.browser_profiles(id, owner_id, name, revision)
        values ('bpf_11111111-1111-4111-8111-111111111111', 'usr_owner', 'Imported', 1);
        insert into public.browser_profile_revisions(profile_id, revision, ciphertext, ciphertext_sha256)
        values (
          'bpf_11111111-1111-4111-8111-111111111111', 1,
          decode(repeat('01', 30), 'hex'), repeat('a', 64)
        );
        insert into public.browser_profile_grants(id, workspace_id, created_by, profile_id, access)
        values (
          'bpg_22222222-2222-4222-8222-222222222222', 'wsp_target', 'usr_owner',
          'bpf_11111111-1111-4111-8111-111111111111', 'full-control'
        );
        insert into public.requests(
          id, kind, mode, status, originating_workspace_id, originating_thread_id,
          originating_occurrence_id, call_id, target_workspace_id, requested_by, required_actor,
          presentation, payload
        ) values
          (
            'req_33333333-3333-4333-8333-333333333333', 'browser.profile.import', 'durable',
            'pending', 'wsp_origin', 'thr_origin',
            'toc_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'import', 'wsp_target',
            'usr_owner', 'requester', '{}',
            '{"kind":"browser.profile.import","sourceId":"bsr_44444444-4444-4444-8444-444444444444","site":"https://example.com"}'
          ),
          (
            'req_55555555-5555-4555-8555-555555555555', 'browser.profile.save', 'durable',
            'pending', 'wsp_origin', 'thr_origin',
            'toc_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'save', 'wsp_target',
            'usr_owner', 'requester', '{}',
            '{"kind":"browser.profile.save","sessionId":"brs_66666666-6666-4666-8666-666666666666"}'
          );
        insert into public.browser_sources(id, owner_id, name, token_hash)
        values (
          'bsr_44444444-4444-4444-8444-444444444444', 'usr_owner', 'Chrome', repeat('b', 64)
        );
        insert into public.browser_source_pairings(code_hash, owner_id, expires_at)
        values (repeat('c', 64), 'usr_owner', now() + interval '5 minutes');
        insert into public.browser_source_grants(id, source_id, workspace_id, site, access, created_by)
        values (
          '77777777-7777-4777-8777-777777777777',
          'bsr_44444444-4444-4444-8444-444444444444', 'wsp_target',
          'https://example.com', 'import', 'usr_owner'
        );
        insert into public.browser_source_imports(
          id, source_id, workspace_id, owner_id, site, profile_id, request_id
        ) values (
          '88888888-8888-4888-8888-888888888888',
          'bsr_44444444-4444-4444-8444-444444444444', 'wsp_target', 'usr_owner',
          'https://example.com', 'bpf_11111111-1111-4111-8111-111111111111',
          'req_33333333-3333-4333-8333-333333333333'
        );
        insert into public.notification_outbox(
          id, workspace_id, sequence, event_id, thread_id, request_id, kind,
          recipient_account_ids, occurred_at, expires_at
        ) values (
          'not_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'wsp_origin', 1, 'evt_fixture',
          'thr_origin', 'req_33333333-3333-4333-8333-333333333333', 'request-opened',
          '["acct_fixture"]', now(), now() + interval '1 day'
        ), (
          'not_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'wsp_origin', 1,
          'evt_published_fixture', 'thr_origin',
          'req_33333333-3333-4333-8333-333333333333', 'request-opened',
          '["acct_fixture"]', now(), now() + interval '1 day'
        )
      `.execute(database);
      await sql`
        update public.notification_outbox set published_at = now()
        where id = 'not_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      `.execute(database);
    } finally {
      await sql`set session_replication_role = origin`.execute(database);
    }
    await browserSourcesRetirementMigration.up(database);
  });

  afterAll(async () => {
    await database?.destroy();
    await maintenance?.query(`drop database if exists ${databaseName}`);
    await maintenance?.end();
  });

  it("drops source authority while preserving profiles, grants, and unrelated Requests", async () => {
    const tables = await sql<{ name: string | null }>`
      select to_regclass('public.browser_sources')::text as name
    `.execute(database);
    expect(tables.rows).toEqual([{ name: null }]);
    await expect(
      sql`select 1 from public.browser_source_pairings`.execute(database),
    ).rejects.toMatchObject({ code: "42P01" });

    const preserved = await sql<{ profiles: string; revisions: string; grants: string }>`
      select
        (select count(*)::text from public.browser_profiles) as profiles,
        (select count(*)::text from public.browser_profile_revisions) as revisions,
        (select count(*)::text from public.browser_profile_grants) as grants
    `.execute(database);
    expect(preserved.rows).toEqual([{ profiles: "1", revisions: "1", grants: "1" }]);

    const requests = await sql<{
      cancellationReason: string | null;
      kind: string;
      status: string;
    }>`
      select kind, status, cancellation_reason as "cancellationReason"
      from public.requests order by kind
    `.execute(database);
    expect(requests.rows).toEqual([
      {
        cancellationReason: "authority-revoked",
        kind: "browser.profile.import",
        status: "cancelled",
      },
      { cancellationReason: null, kind: "browser.profile.save", status: "pending" },
    ]);
    const events = await sql<{ reason: string; requestId: string; type: string }>`
      select type, data->>'requestId' as "requestId", data->>'reason' as reason
      from public.workspace_events order by sequence
    `.execute(database);
    expect(events.rows).toEqual([
      {
        reason: "authority-revoked",
        requestId: "req_33333333-3333-4333-8333-333333333333",
        type: "request.cancelled",
      },
    ]);
    const notifications = await sql<{ count: string; published: string }>`
      select count(*)::text as count,
        count(*) filter (where published_at is not null)::text as published
      from public.notification_outbox
    `.execute(database);
    expect(notifications.rows).toEqual([{ count: "1", published: "1" }]);
  });
});

integration("desktop approval key upgrade", () => {
  const databaseName = `opensteer_approval_key_upgrade_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let database: Kysely<DatabaseSchema>;

  function urlFor(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlFor("postgres") });
    await maintenance.query(`drop database if exists ${databaseName}`);
    await maintenance.query(`create database ${databaseName}`);
    database = createDatabase({ connectionString: urlFor(databaseName) });
    // These are the 0050 columns the upgrade reads. Real PostgreSQL enforces
    // the old automatic-policy invariant while the migration resets it.
    await sql`
      create table public.users (id text primary key);
      create table public.runners (id text primary key);
      create table public.workspaces (id text primary key, name text not null);
      create table public.computer_app_setup_requests (
        id uuid primary key,
        workspace_id text references public.workspaces(id)
      );
      create table public.computer_use_policies (
        deployment_id text not null,
        runner_id text not null,
        owner_user_id text not null,
        app_approval text not null check (app_approval in ('ask', 'automatic')),
        approval jsonb,
        revision integer not null check (revision > 0),
        check ((app_approval = 'ask' and approval is null)
          or (app_approval = 'automatic' and approval is not null))
      );
      create table public.requests (
        id text primary key,
        kind text not null,
        status text not null,
        required_actor text not null
      );
      insert into public.workspaces(id, name) values ('wsp_main', 'Original workspace');
      insert into public.computer_app_setup_requests(id, workspace_id)
        values ('00000000-0000-4000-8000-000000000001', 'wsp_main');
      insert into public.computer_use_policies(
        deployment_id, runner_id, owner_user_id, app_approval, approval, revision
      ) values ('deployment', 'runner', 'owner', 'automatic', '{"legacy":"runner-key"}', 7);
      insert into public.requests(id, kind, status, required_actor) values
        ('pending', 'computer.app.access', 'pending', 'workspace-owner'),
        ('finished', 'computer.app.access', 'fulfilled', 'workspace-owner');
    `.execute(database);
    await computerUseApprovalKeysMigration.up(database);
  });

  afterAll(async () => {
    await database?.destroy();
    await maintenance?.query(`drop database if exists ${databaseName}`);
    await maintenance?.end();
  });

  it("requires a newly registered key, retains the task label, and moves pending asks to the requester", async () => {
    const policy = await sql<{
      appApproval: string;
      approval: unknown;
      revision: number;
    }>`select app_approval as "appApproval", approval, revision from public.computer_use_policies`.execute(
      database,
    );
    expect(policy.rows).toEqual([{ appApproval: "ask", approval: null, revision: 8 }]);
    const keys = await sql`select runner_id from public.computer_use_approval_keys`.execute(
      database,
    );
    expect(keys.rows).toEqual([]);
    const request = await sql<{ workspaceName: string }>`
      select workspace_name as "workspaceName" from public.computer_app_setup_requests
    `.execute(database);
    expect(request.rows).toEqual([{ workspaceName: "Original workspace" }]);
    const actors = await sql<{ id: string; requiredActor: string }>`
      select id, required_actor as "requiredActor" from public.requests order by id
    `.execute(database);
    expect(actors.rows).toEqual([
      { id: "finished", requiredActor: "workspace-owner" },
      { id: "pending", requiredActor: "requester" },
    ]);
  });
});

integration.sequential("computer apps migration", () => {
  const scratchName = `opensteer_computer_apps_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const baselineName = `${scratchName}_baseline`;
  let maintenance: Pool;
  let scratch: Kysely<DatabaseSchema>;
  let baseline: Kysely<DatabaseSchema>;

  function urlForDatabase(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlForDatabase("postgres") });
    for (const name of [scratchName, baselineName]) {
      await maintenance.query(`drop database if exists ${name}`);
      await maintenance.query(`create database ${name}`);
    }
    scratch = createDatabase({ connectionString: urlForDatabase(scratchName) });
    baseline = createDatabase({ connectionString: urlForDatabase(baselineName) });
    await sql.raw(BASELINE_SCHEMA_SQL).execute(scratch);
    await sql.raw(BASELINE_SCHEMA_SQL).execute(baseline);
    // Rebuild the released pre-computer-app shape from the current baseline.
    await sql`
      drop index public.integration_connections_computer_live_unique;
      alter table public.integration_connections
        drop constraint integration_connections_computer_access_check,
        drop constraint integration_connections_connection_method_check,
        drop constraint integration_connections_kind_check,
        drop constraint integration_connections_kind_shape,
        drop column computer_access,
        add constraint integration_connections_connection_method_check check (
          connection_method = any (array[
            'api-key'::text, 'managed-oauth'::text, 'bring-your-own'::text, 'device'::text
          ])
        ),
        add constraint integration_connections_kind_check check (
          connection_kind = any (array[
            'provider-account'::text, 'channel'::text, 'mcp-oauth'::text
          ])
        ),
        add constraint integration_connections_kind_shape check (
          (connection_kind = 'channel' and transport_kind is not null
            and integration_server_id is null and auth_method_id is null
            and integration_definition_id is null)
          or (connection_kind = 'provider-account' and transport_kind is null
            and runner_id is null and integration_server_id is null
            and auth_method_id is not null and integration_definition_id is not null)
          or (connection_kind = 'mcp-oauth' and transport_kind is null
            and runner_id is null and provider_application_id is null
            and integration_server_id is not null and auth_method_id is null
            and integration_definition_id is null)
        );
      alter table public.runners
        drop constraint runners_allowed_modules_check,
        add constraint runners_allowed_modules_check check (
          jsonb_typeof(allowed_modules) = 'array'
          and jsonb_array_length(allowed_modules) between 1 and 4
          and allowed_modules <@ '["agents", "browser", "messaging", "shell"]'::jsonb
        );
      alter table public.runner_enrollments
        drop constraint runner_enrollments_allowed_modules_check,
        add constraint runner_enrollments_allowed_modules_check check (
          jsonb_typeof(allowed_modules) = 'array'
          and jsonb_array_length(allowed_modules) between 1 and 4
          and allowed_modules <@ '["agents", "browser", "messaging", "shell"]'::jsonb
        );

      insert into public.users(id, display_name, email)
      values ('usr_11111111-1111-4111-8111-111111111111', 'Owner', 'owner@example.test');
      insert into public.runners(
        id, owner_kind, owner_user_id, name, kind, public_key_pem, public_key_fingerprint,
        enrollment_token_hash, allowed_modules, max_concurrent_runs
      ) values (
        'rnr_11111111-1111-4111-8111-111111111111', 'user',
        'usr_11111111-1111-4111-8111-111111111111', 'Mac mini', 'local', repeat('x', 70),
        'sha256:computer-apps', 'sha256:computer-apps-token', '["agents", "shell"]'::jsonb, 4
      );
      insert into public.runner_enrollments(
        id, name, token_hash, created_by, owner_kind, owner_user_id, idempotency_key,
        request_fingerprint, runner_kind, allowed_modules, expires_at, consumed_at, runner_id
      ) values (
        'ren_11111111-1111-4111-8111-111111111111', 'Mac mini', 'sha256:computer-apps-token',
        'usr_11111111-1111-4111-8111-111111111111', 'user',
        'usr_11111111-1111-4111-8111-111111111111', 'computer-apps',
        'sha256:computer-apps', 'local', '["shell"]'::jsonb, now() + interval '1 day', now(),
        'rnr_11111111-1111-4111-8111-111111111111'
      );
    `.execute(scratch);
    await computerAppsMigration.up(scratch);
  });

  afterAll(async () => {
    await scratch?.destroy();
    await baseline?.destroy();
    for (const name of [scratchName, baselineName]) {
      await maintenance?.query(`drop database if exists ${name}`);
    }
    await maintenance?.end();
  });

  it("unions integrations into existing Runner and enrollment grants idempotently", async () => {
    await computerAppsMigration.up(scratch);
    const runners = await sql<{ allowedModules: string[] }>`
      select allowed_modules as "allowedModules" from public.runners
    `.execute(scratch);
    expect(runners.rows).toEqual([{ allowedModules: ["agents", "shell", "integrations"] }]);
    const enrollments = await sql<{ allowedModules: string[] }>`
      select allowed_modules as "allowedModules" from public.runner_enrollments
    `.execute(scratch);
    expect(enrollments.rows).toEqual([{ allowedModules: ["shell", "integrations"] }]);
  });

  it("enforces the computer connection shape and live placement uniqueness", async () => {
    await sql`
      insert into public.integration_installations(
        id, name, title, description, source_kind, trust, manifest, provenance, status, revision
      ) values (
        'ins_11111111-1111-4111-8111-111111111111', 'apple-messages', 'Messages', '',
        'built-in', 'built-in', '{}'::jsonb, '{}'::jsonb, 'active', 1
      );
      insert into public.integration_servers(
        id, installation_id, name, transport, connection_requirement, status
      ) values (
        'isr_11111111-1111-4111-8111-111111111111',
        'ins_11111111-1111-4111-8111-111111111111', 'default',
        '{"type":"computer","definitionId":"apple-messages"}'::jsonb,
        '{"kind":"computer","definitionId":"apple-messages"}'::jsonb, 'active'
      );
    `.execute(scratch);
    const insertComputer = (id: string, access: string | null, externalIdentityId: string | null) =>
      sql`
        insert into public.integration_connections(
          id, owner_user_id, provider, connection_method, status, display_name, runner_id,
          connection_kind, integration_server_id, auth_method_id, integration_definition_id,
          computer_access, external_identity_id
        ) values (
          ${id}, 'usr_11111111-1111-4111-8111-111111111111', 'apple', 'computer', 'connected',
          'Mac mini', 'rnr_11111111-1111-4111-8111-111111111111', 'computer',
          'isr_11111111-1111-4111-8111-111111111111', 'computer', 'apple-messages',
          ${access}, ${externalIdentityId}
        )
      `.execute(scratch);
    await expect(
      insertComputer("icn_11111111-1111-4111-8111-111111111111", null, null),
    ).rejects.toThrow(/integration_connections_kind_shape/u);
    await expect(
      insertComputer("icn_22222222-2222-4222-8222-222222222222", "read", "identity"),
    ).rejects.toThrow(/integration_connections_kind_shape/u);
    await insertComputer("icn_33333333-3333-4333-8333-333333333333", "read", null);
    await expect(
      insertComputer("icn_44444444-4444-4444-8444-444444444444", "read-write", null),
    ).rejects.toThrow(/integration_connections_computer_live_unique/u);
    await expect(
      sql`
        insert into public.integration_connections(
          id, owner_user_id, provider, connection_method, status, display_name, transport_kind,
          connection_kind, computer_access
        ) values (
          'icn_55555555-5555-4555-8555-555555555555',
          'usr_11111111-1111-4111-8111-111111111111', 'slack', 'device', 'connected',
          'Slack', 'socket', 'channel', 'read'
        )
      `.execute(scratch),
    ).rejects.toThrow(/integration_connections_kind_shape/u);
  });

  it("matches the fresh baseline schema", async () => {
    const queries = [
      `select conrelid::regclass::text as table_name, conname, pg_get_constraintdef(oid) as definition
       from pg_constraint where connamespace = 'public'::regnamespace
         and conrelid in ('public.runners'::regclass, 'public.runner_enrollments'::regclass,
           'public.integration_connections'::regclass)
       order by table_name, conname`,
      `select table_name, column_name, data_type, is_nullable, coalesce(column_default, '') as column_default
       from information_schema.columns where table_schema = 'public'
         and table_name in ('runners', 'runner_enrollments', 'integration_connections')
       order by table_name, ordinal_position`,
      `select tablename, indexname, indexdef from pg_indexes where schemaname = 'public'
         and tablename in ('runners', 'runner_enrollments', 'integration_connections')
       order by tablename, indexname`,
    ];
    for (const query of queries) {
      expect((await sql.raw(query).execute(scratch)).rows).toEqual(
        (await sql.raw(query).execute(baseline)).rows,
      );
    }
  });
});

integration("Cursor model identity migration", () => {
  const databaseName = `opensteer_cursor_model_identity_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let database: Kysely<DatabaseSchema>;

  function urlForDatabase(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlForDatabase("postgres") });
    await maintenance.query(`drop database if exists ${databaseName}`);
    await maintenance.query(`create database ${databaseName}`);
    database = createDatabase({ connectionString: urlForDatabase(databaseName) });
    await sql`
      create table public.harness_instances (
        id text primary key,
        driver_kind text not null
      );
      create table public.threads (
        id text primary key,
        harness_instance_id text not null,
        model_selection jsonb not null
      );
      create table public.runs (
        id text primary key,
        harness_instance_id text not null,
        model_selection jsonb not null
      );
      create table public.harness_catalogs (
        harness_instance_id text primary key,
        catalog jsonb not null
      );

      insert into public.harness_instances(id, driver_kind) values
        ('cursor', 'cursor'),
        ('other', 'opencode');
      insert into public.threads(id, harness_instance_id, model_selection) values
        ('auto', 'cursor', '{"providerId":"cursor","modelId":"auto","nativeModelId":"auto","options":{}}'),
        ('case', 'cursor', '{"providerId":"cursor","modelId":"Composer-Preview","nativeModelId":"Composer-Preview","options":{}}'),
        ('composer', 'cursor', '{"providerId":"cursor","modelId":"composer-2.5","nativeModelId":"composer-2.5","options":{"fast":true}}'),
        ('muse', 'cursor', '{"providerId":"cursor","modelId":"muse-spark-1.3","nativeModelId":"muse-spark-1.3-high","options":{"effort":"high"}}'),
        ('muse-at', 'cursor', '{"providerId":"cursor","modelId":"muse@preview","nativeModelId":"muse@preview","options":{}}'),
        ('muse-underscore', 'cursor', '{"providerId":"cursor","modelId":"muse_preview","nativeModelId":"muse_preview","options":{}}'),
        ('third-party', 'cursor', '{"providerId":"anthropic","modelId":"claude-opus-5","nativeModelId":"claude-opus-5-high","options":{"effort":"high"}}'),
        ('unknown-cursor', 'cursor', '{"providerId":"cursor","modelId":"future-family","nativeModelId":"future-family","options":{}}'),
        ('other-engine', 'other', '{"providerId":"cursor","modelId":"composer-2.5","nativeModelId":"composer-2.5","options":{}}');
      insert into public.runs(id, harness_instance_id, model_selection) values
        ('grok', 'cursor', '{"providerId":"cursor","modelId":"cursor-grok-4.6","nativeModelId":"cursor-grok-4.6-high-fast","options":{"effort":"high","fast":true}}'),
        ('other-run', 'other', '{"providerId":"cursor","modelId":"auto","nativeModelId":"auto","options":{}}');
      insert into public.harness_catalogs(harness_instance_id, catalog) values
        ('cursor', '{"status":"ready"}'),
        ('other', '{"status":"ready"}');
    `.execute(database);
  });

  afterAll(async () => {
    await database?.destroy();
    if (maintenance) {
      await maintenance.query(`drop database if exists ${databaseName}`);
      await maintenance.end();
    }
  });

  it("moves only Cursor-owned families and invalidates only Cursor catalogs", async () => {
    await cursorModelIdentityMigration.up(database);

    const threads = await sql<{ id: string; modelSelection: Record<string, unknown> }>`
      select id, model_selection from public.threads order by id
    `.execute(database);
    expect(threads.rows).toEqual([
      {
        id: "auto",
        modelSelection: {
          modelId: "auto",
          nativeModelId: "auto",
          options: {},
          providerId: "xai",
        },
      },
      {
        id: "case",
        modelSelection: {
          modelId: "Composer-Preview",
          nativeModelId: "Composer-Preview",
          options: {},
          providerId: "xai",
        },
      },
      {
        id: "composer",
        modelSelection: {
          modelId: "composer-2.5",
          nativeModelId: "composer-2.5",
          options: { fast: true },
          providerId: "xai",
        },
      },
      {
        id: "muse",
        modelSelection: {
          modelId: "muse-spark-1.3",
          nativeModelId: "muse-spark-1.3-high",
          options: { effort: "high" },
          providerId: "meta",
        },
      },
      {
        id: "muse-at",
        modelSelection: {
          modelId: "muse@preview",
          nativeModelId: "muse@preview",
          options: {},
          providerId: "meta",
        },
      },
      {
        id: "muse-underscore",
        modelSelection: {
          modelId: "muse_preview",
          nativeModelId: "muse_preview",
          options: {},
          providerId: "cursor",
        },
      },
      {
        id: "other-engine",
        modelSelection: {
          modelId: "composer-2.5",
          nativeModelId: "composer-2.5",
          options: {},
          providerId: "cursor",
        },
      },
      {
        id: "third-party",
        modelSelection: {
          modelId: "claude-opus-5",
          nativeModelId: "claude-opus-5-high",
          options: { effort: "high" },
          providerId: "anthropic",
        },
      },
      {
        id: "unknown-cursor",
        modelSelection: {
          modelId: "future-family",
          nativeModelId: "future-family",
          options: {},
          providerId: "cursor",
        },
      },
    ]);

    const runs = await sql<{ id: string; modelSelection: Record<string, unknown> }>`
      select id, model_selection from public.runs order by id
    `.execute(database);
    expect(runs.rows).toEqual([
      {
        id: "grok",
        modelSelection: {
          modelId: "cursor-grok-4.6",
          nativeModelId: "cursor-grok-4.6-high-fast",
          options: { effort: "high", fast: true },
          providerId: "xai",
        },
      },
      {
        id: "other-run",
        modelSelection: {
          modelId: "auto",
          nativeModelId: "auto",
          options: {},
          providerId: "cursor",
        },
      },
    ]);
    expect(
      (
        await sql<{ harnessInstanceId: string }>`
        select harness_instance_id from public.harness_catalogs order by harness_instance_id
      `.execute(database)
      ).rows,
    ).toEqual([{ harnessInstanceId: "other" }]);
  });
});

integration("one machine identity migration", () => {
  const databaseName = `opensteer_one_machine_identity_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let database: Kysely<DatabaseSchema>;

  function urlForDatabase(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlForDatabase("postgres") });
    await maintenance.query(`drop database if exists ${databaseName}`);
    await maintenance.query(`create database ${databaseName}`);
    database = createDatabase({ connectionString: urlForDatabase(databaseName) });
    await sql.raw(BASELINE_SCHEMA_SQL).execute(database);
    // The baseline is the post-migration shape, so the pre-migration one has to
    // be rebuilt here: three identity stacks, a browser session pinned to a
    // Device, and a channel connection assigned to a Channel Runtime.
    await sql`
      alter table public.runners
        drop constraint runners_agents_capacity_check,
        drop constraint runners_allowed_modules_check,
        drop constraint runners_module_descriptors_check,
        drop constraint runners_max_concurrency_check,
        drop column allowed_modules,
        drop column module_descriptors,
        alter column max_concurrent_runs set not null,
        add constraint runners_max_concurrency_check check (max_concurrent_runs > 0);
      alter table public.runner_enrollments
        drop constraint runner_enrollments_allowed_modules_check,
        drop column allowed_modules;

      create table public.devices (
        id text primary key,
        owner_id text not null references public.users(id) on delete cascade,
        name text not null,
        kind text not null,
        public_key_pem text not null,
        public_key_fingerprint text not null unique,
        enrollment_token_hash text not null unique,
        capabilities jsonb default '[]'::jsonb not null,
        connection_generation bigint default 0 not null,
        enrolled_at timestamptz default now() not null,
        last_seen_at timestamptz,
        revoked_at timestamptz,
        created_at timestamptz default now() not null,
        updated_at timestamptz default now() not null,
        constraint devices_kind_check check (kind = 'local')
      );
      create table public.device_enrollments (
        id text primary key,
        token_hash text not null unique,
        created_by text not null references public.users(id) on delete cascade,
        idempotency_key text not null,
        request_fingerprint text not null,
        device_kind text not null,
        expires_at timestamptz not null,
        consumed_at timestamptz,
        device_id text references public.devices(id) on delete restrict,
        created_at timestamptz default now() not null
      );
      create table public.channel_runtimes (
        id text primary key,
        name text not null,
        public_key_pem text not null,
        public_key_fingerprint text not null unique,
        enrollment_token_hash text not null unique,
        capabilities jsonb default '[]'::jsonb not null,
        runtime_version text not null,
        connection_generation bigint default 0 not null,
        enrolled_at timestamptz default now() not null,
        last_seen_at timestamptz,
        revoked_at timestamptz,
        created_at timestamptz default now() not null,
        updated_at timestamptz default now() not null
      );
      create table public.channel_runtime_enrollments (
        id text primary key,
        token_hash text not null unique,
        created_by text references public.users(id) on delete restrict,
        idempotency_key text not null,
        request_fingerprint text not null,
        expires_at timestamptz not null,
        consumed_at timestamptz,
        runtime_id text references public.channel_runtimes(id) on delete restrict,
        created_at timestamptz default now() not null
      );

      drop index browser_sessions_runner;
      alter table public.browser_sessions
        drop constraint browser_sessions_runner_id_fkey,
        drop column runner_id,
        add column placement_kind text not null default 'hosted',
        add column device_id text references public.devices(id) on delete restrict,
        add constraint browser_sessions_placement_check check (
          (placement_kind = 'hosted' and device_id is null)
          or (placement_kind = 'device' and device_id is not null)
        );

      alter table public.credential_access_audit
        drop constraint credential_access_audit_runner_id_fkey,
        drop column runner_id,
        drop column actor_id,
        add column channel_runtime_id text not null
          references public.channel_runtimes(id) on delete restrict;

      drop index integration_connections_runtime_status;
      alter table public.integration_connections
        drop constraint integration_connections_runner_id_fkey,
        drop constraint integration_connections_kind_shape,
        drop column runner_id,
        add column channel_runtime_id text references public.channel_runtimes(id) on delete restrict,
        add constraint integration_connections_kind_shape check (
          (connection_kind = 'channel' and transport_kind is not null
            and integration_server_id is null and auth_method_id is null
            and integration_definition_id is null)
          or (connection_kind = 'provider-account' and transport_kind is null
            and channel_runtime_id is null and integration_server_id is null
            and auth_method_id is not null and integration_definition_id is not null)
          or (connection_kind = 'mcp-oauth' and transport_kind is null
            and channel_runtime_id is null and provider_application_id is null
            and integration_server_id is not null and auth_method_id is null
            and integration_definition_id is null)
        );
      create index integration_connections_runtime_status
        on public.integration_connections(channel_runtime_id, status, updated_at);
    `.execute(database);

    await sql`
      insert into public.users(id, display_name, email)
      values ('usr_11111111-1111-4111-8111-111111111111', 'Owner', 'owner@example.test');
      insert into public.runners(
        id, owner_kind, owner_user_id, name, kind, public_key_pem, public_key_fingerprint,
        enrollment_token_hash, max_concurrent_runs, connection_generation
      ) values (
        'run_11111111-1111-4111-8111-111111111111', 'user',
        'usr_11111111-1111-4111-8111-111111111111', 'Laptop', 'local',
        repeat('x', 70), 'sha256:runner', 'sha256:runner-token', 4, 7
      );
      insert into public.channel_runtimes(
        id, name, public_key_pem, public_key_fingerprint, enrollment_token_hash,
        runtime_version
      ) values (
        'chr_11111111-1111-4111-8111-111111111111', 'Messaging service',
        repeat('y', 70), 'sha256:messaging', 'sha256:messaging-token', '0.1.0'
      );
      insert into public.credentials(
        id, owner_id, name, provider, encrypted_payload, encryption_key_version
      ) values (
        'cred_11111111-1111-4111-8111-111111111111',
        'usr_11111111-1111-4111-8111-111111111111', 'Slack token', 'slack',
        decode('01', 'hex'), 1
      );
      insert into public.integration_connections(
        id, owner_user_id, credential_id, provider, connection_method, status,
        display_name, channel_runtime_id, transport_kind, connection_kind
      ) values (
        'con_11111111-1111-4111-8111-111111111111',
        'usr_11111111-1111-4111-8111-111111111111',
        'cred_11111111-1111-4111-8111-111111111111', 'slack', 'api-key',
        'connected', 'Slack', 'chr_11111111-1111-4111-8111-111111111111',
        'socket', 'channel'
      );
      insert into public.credential_access_audit(
        id, credential_id, connection_id, channel_runtime_id, purpose
      ) values (
        'evt_11111111-1111-4111-8111-111111111111',
        'cred_11111111-1111-4111-8111-111111111111',
        'con_11111111-1111-4111-8111-111111111111',
        'chr_11111111-1111-4111-8111-111111111111', 'channel-transport'
      );
      insert into public.devices(
        id, owner_id, name, kind, public_key_pem, public_key_fingerprint, enrollment_token_hash
      ) values (
        'dev_11111111-1111-4111-8111-111111111111',
        'usr_11111111-1111-4111-8111-111111111111', 'Laptop browser', 'local',
        repeat('x', 70), 'sha256:device', 'sha256:device-token'
      );
      insert into public.workspaces(
        id, name, kind, status, created_by, backing, capacity_policy
      ) values (
        'wsp_11111111-1111-4111-8111-111111111111', 'Workspace', 'specialized', 'ready',
        'usr_11111111-1111-4111-8111-111111111111',
        '{"kind": "portablefs", "serviceId": "svc", "volumeId": "vol", "generation": 1}'::jsonb,
        '{"kind": "hard-quota", "blockHardLimitBytes": 1024, "inodeHardLimit": 16}'::jsonb
      );
      insert into public.workspace_memberships(id, workspace_id, user_id, role, state)
      values (
        'wsm_11111111-1111-4111-8111-111111111111',
        'wsp_11111111-1111-4111-8111-111111111111',
        'usr_11111111-1111-4111-8111-111111111111', 'owner', 'active'
      );
      insert into public.browser_sessions(
        id, workspace_id, placement_key, placement_kind, device_id, runtime_id,
        state, lease_generation
      ) values (
        'bsn_11111111-1111-4111-8111-111111111111',
        'wsp_11111111-1111-4111-8111-111111111111', 'device:runtime', 'device',
        'dev_11111111-1111-4111-8111-111111111111', 'runtime', 'ready', 1
      )
    `.execute(database);
  });

  afterAll(async () => {
    await database?.destroy();
    await maintenance?.query(`drop database if exists ${databaseName}`);
    await maintenance?.end();
  });

  it("drops the extra identity stacks while preserving historical audit actors", async () => {
    await oneMachineIdentityMigration.up(database);

    const surviving = await sql<{ survivor: string }>`
      select table_name as survivor from information_schema.tables
      where table_schema = 'public' and table_name in (
        'devices', 'device_enrollments', 'channel_runtimes', 'channel_runtime_enrollments'
      )
    `.execute(database);
    expect(surviving.rows).toEqual([]);

    const columns = await sql<{ moved: string }>`
      select (table_name || '.' || column_name) as moved
      from information_schema.columns
      where table_schema = 'public'
        and (((column_name = 'runner_id' and table_name in (
            'browser_sessions', 'credential_access_audit', 'integration_connections'
          ))
          or (column_name = 'allowed_modules' and table_name in ('runner_enrollments', 'runners'))
          or (column_name = 'actor_id' and table_name = 'credential_access_audit')))
      order by moved
    `.execute(database);
    expect(columns.rows.map((row) => row.moved)).toEqual([
      "browser_sessions.runner_id",
      "credential_access_audit.actor_id",
      "credential_access_audit.runner_id",
      "integration_connections.runner_id",
      "runner_enrollments.allowed_modules",
      "runners.allowed_modules",
    ]);

    // A Device-pinned session cannot be resumed by any Runner, so it goes
    // rather than pointing at a placement that no longer exists.
    const sessions = await sql<{ count: string }>`
      select count(*)::text as count from public.browser_sessions
    `.execute(database);
    expect(sessions.rows[0]?.count).toBe("0");

    const audits = await sql<{ actorId: string; runnerId: string | null }>`
      select actor_id as "actorId", runner_id as "runnerId"
      from public.credential_access_audit
    `.execute(database);
    expect(audits.rows).toEqual([
      {
        actorId: "chr_11111111-1111-4111-8111-111111111111",
        runnerId: null,
      },
    ]);
    const connections = await sql<{ count: string; runnerId: string | null }>`
      select count(*)::text as count, min(runner_id) as "runnerId"
      from public.integration_connections
      where id = 'con_11111111-1111-4111-8111-111111111111'
    `.execute(database);
    expect(connections.rows).toEqual([{ count: "1", runnerId: null }]);

    const runner = await database
      .selectFrom("runners")
      .select(["allowedModules", "maxConcurrentRuns", "moduleDescriptors"])
      .where("id", "=", "run_11111111-1111-4111-8111-111111111111" as never)
      .executeTakeFirstOrThrow();
    expect(runner.allowedModules).toEqual(["agents"]);
    expect(runner.maxConcurrentRuns).toBe(4);
    expect(runner.moduleDescriptors).toEqual({});

    // A browser-only Runner declares no capacity, which the pre-migration
    // shape could not express.
    await expect(
      sql`
        update public.runners
        set allowed_modules = '["browser"]'::jsonb, max_concurrent_runs = null
        where id = 'run_11111111-1111-4111-8111-111111111111'
      `.execute(database),
    ).resolves.toBeDefined();
    await expect(
      sql`
        update public.runners set allowed_modules = '["agents"]'::jsonb
        where id = 'run_11111111-1111-4111-8111-111111111111'
      `.execute(database),
    ).rejects.toThrow(/runners_agents_capacity_check/u);
    await expect(
      sql`
        update public.runners
        set allowed_modules = '["agents"]'::jsonb, max_concurrent_runs = 1001
        where id = 'run_11111111-1111-4111-8111-111111111111'
      `.execute(database),
    ).rejects.toThrow(/runners_max_concurrency_check/u);
    await expect(
      sql`
        update public.runners set allowed_modules = '["telepathy"]'::jsonb
        where id = 'run_11111111-1111-4111-8111-111111111111'
      `.execute(database),
    ).rejects.toThrow(/runners_allowed_modules_check/u);
  });

  it("carries a pre-0022 machine into the shell module grant", async () => {
    // The baseline this fixture was carved out of already carries 0023, which
    // a database that stopped at 0022 never did.
    await sql`
      drop table public.machine_access_events;
      drop table public.machine_access_sessions;
      alter table public.runners
        drop column access_policy,
        drop column access_policy_revision,
        drop constraint runners_allowed_modules_check,
        add constraint runners_allowed_modules_check check (
          jsonb_typeof(allowed_modules) = 'array'
          and jsonb_array_length(allowed_modules) between 1 and 3
          and allowed_modules <@ '["agents", "browser", "messaging"]'::jsonb
        );
      alter table public.runner_enrollments
        drop constraint runner_enrollments_allowed_modules_check,
        add constraint runner_enrollments_allowed_modules_check check (
          jsonb_typeof(allowed_modules) = 'array'
          and jsonb_array_length(allowed_modules) between 1 and 3
          and allowed_modules <@ '["agents", "browser", "messaging"]'::jsonb
        );
    `.execute(database);

    await machineAccessMigration.up(database);

    const runner = await sql<{ allowedModules: string[]; reach: string; revision: number }>`
      select allowed_modules as "allowedModules",
             access_policy ->> 'reach' as "reach",
             access_policy_revision as "revision"
      from public.runners
      where id = 'run_11111111-1111-4111-8111-111111111111'
    `.execute(database);
    // The test above left this machine browser-only; the union keeps it so.
    expect(runner.rows[0]).toEqual({
      allowedModules: ["browser", "shell"],
      reach: "nobody",
      revision: 1,
    });
  });

  it("bumps the connection generation when a Runner is revoked", async () => {
    await computerAppSetupRequestsMigration.up(database);
    // Revocation reads a computer connection's app, so the fixture has to carry
    // the columns that name one.
    await computerAppIdentityMigration.up(database);
    await computerAppPolicyMigration.up(database);
    const before = await sql<{ generation: string }>`
      select connection_generation::text as generation from public.runners
      where id = 'run_11111111-1111-4111-8111-111111111111'
    `.execute(database);
    await new OpensteerStore(database).revokeRunner(
      "run_11111111-1111-4111-8111-111111111111" as never,
      UserIdSchema.parse("usr_11111111-1111-4111-8111-111111111111"),
    );
    const after = await sql<{ generation: string; revoked: Date | null }>`
      select connection_generation::text as generation, revoked_at as revoked from public.runners
      where id = 'run_11111111-1111-4111-8111-111111111111'
    `.execute(database);
    expect(Number(after.rows[0]?.generation)).toBe(Number(before.rows[0]?.generation) + 1);
    expect(after.rows[0]?.revoked).not.toBeNull();
  });
});

integration("channel durable access migration", () => {
  const scratchName = `opensteer_channel_access_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let scratch: Kysely<DatabaseSchema>;

  function urlForDatabase(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlForDatabase("postgres") });
    await maintenance.query(`drop database if exists ${scratchName}`);
    await maintenance.query(`create database ${scratchName}`);
    scratch = createDatabase({ connectionString: urlForDatabase(scratchName) });
    await sql.raw(BASELINE_SCHEMA_SQL).execute(scratch);
    await sql`
      drop table public.channel_conversation_contexts;
      drop table public.channel_access_grants;
      alter table public.channel_link_codes
        drop constraint channel_link_codes_request_ingress_id_fkey,
        drop column request_ingress_id;
      alter table public.channel_bindings drop constraint channel_bindings_id_account_id_key;

      insert into public.users(id, display_name, email) values
        ('usr_55555555-5555-4555-8555-555555555551', 'Route owner', 'access@opensteer.test');
      insert into public.workspaces(id, name, kind, status, created_by, backing, capacity_policy)
      values (
        'wsp_55555555-5555-4555-8555-555555555551', 'Routed', 'main', 'ready',
        'usr_55555555-5555-4555-8555-555555555551',
        '{"kind":"portablefs","generation":1,"serviceId":"test","volumeId":"vol_access"}'::jsonb,
        '{"kind":"hard-quota","blockHardLimitBytes":1000,"inodeHardLimit":100}'::jsonb
      );
      insert into public.workspace_memberships(id, workspace_id, user_id, role, state)
      values (
        'wsm_55555555-5555-4555-8555-555555555551',
        'wsp_55555555-5555-4555-8555-555555555551',
        'usr_55555555-5555-4555-8555-555555555551', 'owner', 'active'
      );
      insert into public.integration_connections(
        id, owner_user_id, provider, connection_method, status, display_name,
        connection_kind, transport_kind
      ) values (
        'ich_55555555-5555-4555-8555-555555555551',
        'usr_55555555-5555-4555-8555-555555555551',
        'slack', 'bring-your-own', 'connected', 'Socket bot', 'channel', 'socket'
      );
      insert into public.channel_accounts(
        id, connection_id, provider, external_account_id, display_name, status
      ) values (
        'cha_55555555-5555-4555-8555-555555555551',
        'ich_55555555-5555-4555-8555-555555555551', 'slack', 'T-ACCESS', 'Acme', 'connected'
      );
      insert into public.channel_bindings(
        id, account_id, workspace_id, created_by, selector, execution_policy,
        access_policy, revision, status
      ) values
        (
          'chb_55555555-5555-4555-8555-555555555551',
          'cha_55555555-5555-4555-8555-555555555551',
          'wsp_55555555-5555-4555-8555-555555555551',
          'usr_55555555-5555-4555-8555-555555555551',
          '{"conversationId":null,"conversationType":null,"scopeId":null,"threadId":null}'::jsonb,
          '{"harness":"default","harnessInstanceId":null}'::jsonb,
          '{"mode":"owner","allowedExternalUserIds":[]}'::jsonb, 1, 'active'
        ),
        (
          'chb_55555555-5555-4555-8555-555555555552',
          'cha_55555555-5555-4555-8555-555555555551',
          'wsp_55555555-5555-4555-8555-555555555551',
          'usr_55555555-5555-4555-8555-555555555551',
          '{"conversationId":"C-MEMBER","conversationType":"channel","scopeId":null,"threadId":null}'::jsonb,
          '{"harness":"default","harnessInstanceId":null}'::jsonb,
          '{"mode":"linked-members","allowedExternalUserIds":[]}'::jsonb, 1, 'active'
        ),
        (
          'chb_55555555-5555-4555-8555-555555555553',
          'cha_55555555-5555-4555-8555-555555555551',
          'wsp_55555555-5555-4555-8555-555555555551',
          'usr_55555555-5555-4555-8555-555555555551',
          '{"conversationId":"C-SELECT","conversationType":"channel","scopeId":null,"threadId":null}'::jsonb,
          '{"harness":"default","harnessInstanceId":null}'::jsonb,
          '{"mode":"selected","allowedExternalUserIds":["U-ONE"]}'::jsonb, 1, 'active'
        ),
        (
          'chb_55555555-5555-4555-8555-555555555554',
          'cha_55555555-5555-4555-8555-555555555551',
          'wsp_55555555-5555-4555-8555-555555555551',
          'usr_55555555-5555-4555-8555-555555555551',
          '{"conversationId":"C-ANY","conversationType":"channel","scopeId":null,"threadId":null}'::jsonb,
          '{"harness":"default","harnessInstanceId":null}'::jsonb,
          '{"mode":"anyone","allowedExternalUserIds":[]}'::jsonb, 1, 'active'
        );

      insert into public.execution_environments(id, name, kind)
      values ('env_55555555-5555-4555-8555-555555555551', 'Main', 'main');
      insert into public.harness_instances(
        id, environment_id, driver_kind, name, config, state_kind, source_id, is_default
      ) values (
        'hai_55555555-5555-4555-8555-555555555551',
        'env_55555555-5555-4555-8555-555555555551',
        'native', 'Native', '{"model":"test"}'::jsonb, 'isolated', 'native', true
      );
      alter table public.threads disable trigger threads_execution_authority;
      insert into public.threads(
        id, workspace_id, title, environment_id, harness_instance_id, created_by,
        capability_profile_id, created_by_principal_id, model_selection,
        lineage_root_thread_id, next_message_sequence
      ) values (
        'thr_55555555-5555-4555-8555-555555555551',
        'wsp_55555555-5555-4555-8555-555555555551', 'Legacy Main context',
        'env_55555555-5555-4555-8555-555555555551',
        'hai_55555555-5555-4555-8555-555555555551',
        'usr_55555555-5555-4555-8555-555555555551', 'main',
        (select id from public.principals
         where user_id = 'usr_55555555-5555-4555-8555-555555555551'),
        '{"providerId":"openai","modelId":"test","options":{}}'::jsonb,
        'thr_55555555-5555-4555-8555-555555555551', 1
      );
      alter table public.threads enable trigger threads_execution_authority;
      insert into public.messages(
        id, thread_id, content, actor_principal_id, sequence, kind, author
      ) values (
        'msg_55555555-5555-4555-8555-555555555551',
        'thr_55555555-5555-4555-8555-555555555551',
        '[{"type":"text","text":"legacy queued channel input"}]'::jsonb,
        (select id from public.principals
         where user_id = 'usr_55555555-5555-4555-8555-555555555551'), 0, 'input',
        '{"kind":"human","userId":"usr_55555555-5555-4555-8555-555555555551"}'::jsonb
      );
      insert into public.causal_chains(
        id, root_message_id, max_delegations, max_autonomous_runs
      ) values (
        'cch_55555555-5555-4555-8555-555555555551',
        'msg_55555555-5555-4555-8555-555555555551', 8, 8
      );
      insert into public.thread_inputs(
        message_id, thread_id, policy, requested_by, actor_principal_id,
        authority_source, membership_generation, causal_chain_id,
        idempotency_key, request_fingerprint
      ) values (
        'msg_55555555-5555-4555-8555-555555555551',
        'thr_55555555-5555-4555-8555-555555555551', 'trigger',
        'usr_55555555-5555-4555-8555-555555555551',
        (select id from public.principals
         where user_id = 'usr_55555555-5555-4555-8555-555555555551'),
        '{"kind":"channel-ingress","bindingRevision":1}'::jsonb, 1,
        'cch_55555555-5555-4555-8555-555555555551',
        'legacy-channel-input', 'legacy-channel-input-fingerprint'
      );
      insert into public.channel_conversations(
        id, account_id, binding_id, binding_revision, workspace_id,
        external_conversation_id, conversation_type, active_thread_id,
        provider, external_account_id
      ) values (
        'chv_55555555-5555-4555-8555-555555555551',
        'cha_55555555-5555-4555-8555-555555555551',
        'chb_55555555-5555-4555-8555-555555555551', 1,
        'wsp_55555555-5555-4555-8555-555555555551', 'C-LEGACY', 'channel',
        'thr_55555555-5555-4555-8555-555555555551', 'slack', 'T-ACCESS'
      );
    `.execute(scratch);

    await channelDurableAccessMigration.up(scratch);
  });

  afterAll(async () => {
    await scratch?.destroy();
    if (maintenance) {
      await maintenance.query(`drop database if exists ${scratchName}`);
      await maintenance.end();
    }
  });

  it("maps every historical mode without widening sender authority", async () => {
    const rows = await sql<{
      readonly accessPolicy: Readonly<Record<string, unknown>>;
      readonly id: string;
      readonly revision: number;
    }>`
      select id, access_policy as "accessPolicy", revision
      from public.channel_bindings order by id
    `.execute(scratch);

    expect(rows.rows).toEqual([
      {
        accessPolicy: {
          channels: {
            conversationIds: [],
            scope: "all",
            sender: { allowedExternalUserIds: [], mode: "owner" },
          },
          directMessages: { allowedExternalUserIds: [], mode: "owner" },
        },
        id: "chb_55555555-5555-4555-8555-555555555551",
        revision: 2,
      },
      {
        accessPolicy: {
          channels: {
            conversationIds: ["C-MEMBER"],
            scope: "selected",
            sender: { allowedExternalUserIds: [], mode: "linked-members" },
          },
          directMessages: { allowedExternalUserIds: [], mode: "linked-members" },
        },
        id: "chb_55555555-5555-4555-8555-555555555552",
        revision: 2,
      },
      {
        accessPolicy: {
          channels: {
            conversationIds: ["C-SELECT"],
            scope: "selected",
            sender: { allowedExternalUserIds: ["U-ONE"], mode: "linked-members" },
          },
          directMessages: { allowedExternalUserIds: ["U-ONE"], mode: "linked-members" },
        },
        id: "chb_55555555-5555-4555-8555-555555555553",
        revision: 2,
      },
      {
        accessPolicy: {
          channels: {
            conversationIds: ["C-ANY"],
            scope: "selected",
            sender: { allowedExternalUserIds: [], mode: "anyone" },
          },
          directMessages: { allowedExternalUserIds: [], mode: "anyone" },
        },
        id: "chb_55555555-5555-4555-8555-555555555554",
        revision: 2,
      },
    ]);
  });

  it("creates empty grant and context stores", async () => {
    const rows = await sql<{ readonly grants: string; readonly contexts: string }>`
      select
        (select count(*)::text from public.channel_access_grants) as grants,
        (select count(*)::text from public.channel_conversation_contexts) as contexts
    `.execute(scratch);
    expect(rows.rows).toEqual([{ contexts: "0", grants: "0" }]);
  });

  it("does not carry a legacy Main provider context or its queued input forward", async () => {
    const result = await sql<{
      readonly activeThreadId: string | null;
      readonly cancelReason: string | null;
      readonly capabilityProfileId: string;
      readonly state: string;
    }>`
      select c.active_thread_id as "activeThreadId",
             t.capability_profile_id as "capabilityProfileId",
             i.state,
             i.cancel_reason as "cancelReason"
      from public.channel_conversations c
      join public.threads t on t.id = c.active_thread_id
      join public.thread_inputs i on i.thread_id = t.id
      where c.id = 'chv_55555555-5555-4555-8555-555555555551'
    `.execute(scratch);
    expect(result.rows).toEqual([
      {
        activeThreadId: "thr_55555555-5555-4555-8555-555555555551",
        cancelReason: "channel-access-migrated",
        capabilityProfileId: "main",
        state: "cancelled",
      },
    ]);
    await expect(
      sql<{ readonly count: string }>`
        select count(*)::text as count from public.channel_conversation_contexts
        where conversation_id = 'chv_55555555-5555-4555-8555-555555555551'
      `.execute(scratch),
    ).resolves.toMatchObject({ rows: [{ count: "0" }] });
  });
});

integration("Runner enrollment name migration", () => {
  const databaseName = `opensteer_runner_enrollment_name_migration_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let database: Kysely<DatabaseSchema>;

  function urlForDatabase(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlForDatabase("postgres") });
    await maintenance.query(`drop database if exists ${databaseName}`);
    await maintenance.query(`create database ${databaseName}`);
    database = createDatabase({ connectionString: urlForDatabase(databaseName) });
    await sql.raw(BASELINE_SCHEMA_SQL).execute(database);
    await sql`
      alter table public.runner_enrollments
        drop constraint runner_enrollments_name_check,
        drop column name;
      insert into public.users(id, display_name, email)
      values ('usr_11111111-1111-4111-8111-111111111111', 'Owner', 'owner@example.test');
      insert into public.runner_enrollments(
        id, token_hash, created_by, owner_kind, owner_user_id, runner_kind,
        idempotency_key, request_fingerprint, expires_at
      ) values (
        'ren_pending', 'sha256:pending', 'usr_11111111-1111-4111-8111-111111111111',
        'user', 'usr_11111111-1111-4111-8111-111111111111', 'local',
        'pending', 'sha256:pending-request', now() + interval '1 hour'
      )
    `.execute(database);
  });

  afterAll(async () => {
    await database?.destroy();
    await maintenance?.query(`drop database if exists ${databaseName}`);
    await maintenance?.end();
  });

  it("backfills pending rows and requires bounded names", async () => {
    await runnerEnrollmentNameMigration.up(database);

    await expect(
      database
        .selectFrom("runnerEnrollments")
        .select("name")
        .where("id", "=", "ren_pending")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ name: "New computer" });
    await expect(
      database
        .updateTable("runnerEnrollments")
        .set({ name: " " })
        .where("id", "=", "ren_pending")
        .executeTakeFirstOrThrow(),
    ).rejects.toThrow(/runner_enrollments_name_check/u);
  });
});

integration("watch Trigger migration", () => {
  const scratchDatabaseName = `opensteer_watch_migration_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const baselineDatabaseName = `${scratchDatabaseName}_baseline`;
  let maintenance: Pool;
  let scratch: Kysely<DatabaseSchema>;
  let baseline: Kysely<DatabaseSchema>;

  function urlForDatabase(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlForDatabase("postgres") });
    for (const name of [scratchDatabaseName, baselineDatabaseName]) {
      await maintenance.query(`drop database if exists ${name}`);
      await maintenance.query(`create database ${name}`);
    }
    scratch = createDatabase({ connectionString: urlForDatabase(scratchDatabaseName) });
    baseline = createDatabase({ connectionString: urlForDatabase(baselineDatabaseName) });
    await sql.raw(BASELINE_SCHEMA_SQL).execute(scratch);
    await sql.raw(BASELINE_SCHEMA_SQL).execute(baseline);
    await sql`
      alter table public.causal_chains
        drop constraint causal_chains_root_watch_activation_id_fkey,
        drop constraint causal_chains_root_check,
        drop column root_watch_activation_id,
        drop column root_watch_observation_id,
        add constraint causal_chains_root_check
          check ((root_message_id is null) <> (root_occurrence_id is null));
      alter table public.delegations
        drop constraint delegations_parent_watch_activation_id_fkey,
        drop constraint delegations_parent_check,
        drop column parent_watch_activation_id,
        add constraint delegations_parent_check
          check ((parent_run_id is null) <> (parent_occurrence_id is null));
      drop table public.watch_control_requests;
      drop table public.trigger_watch_activations;
      drop sequence public.trigger_watch_reconcile_generation;
      alter table public.trigger_revisions
        drop constraint trigger_revisions_source_check,
        add constraint trigger_revisions_source_check
          check (jsonb_typeof(source) = 'object'
            and source ->> 'kind' = any (array['schedule'::text, 'webhook'::text]));
      alter table public.triggers
        drop constraint triggers_kind_check,
        drop constraint triggers_webhook_shape_check,
        add constraint triggers_kind_check
          check (kind = any (array['schedule'::text, 'webhook'::text])),
        add constraint triggers_webhook_shape_check check (
          (kind = 'webhook' and webhook_route_key is not null
            and webhook_secret_hash is not null and next_fire_at is null)
          or (kind = 'schedule' and webhook_route_key is null and webhook_secret_hash is null)
        );
      alter table public.messages
        drop constraint messages_kind_author_check,
        add constraint messages_kind_author_check check (
          (kind = 'input'
            and author ->> 'kind' = any (array['human'::text, 'agent'::text, 'trigger'::text]))
          or (kind = any (array['assistant'::text, 'run-result'::text])
            and author ->> 'kind' = 'agent')
          or (kind = 'continuation' and author ->> 'kind' = 'platform')
        )
    `.execute(scratch);
  });

  afterAll(async () => {
    await scratch?.destroy();
    await baseline?.destroy();
    for (const name of [scratchDatabaseName, baselineDatabaseName]) {
      await maintenance?.query(`drop database if exists ${name}`);
    }
    await maintenance?.end();
  });

  it("produces the same tables, constraints, indexes, and sequence as the baseline", async () => {
    await watchTriggersMigration.up(scratch);
    await watchTriggersMigration.up(baseline);
    const queries = [
      `select table_name, column_name, data_type, is_nullable, coalesce(column_default, '') as column_default
       from information_schema.columns
       where table_schema = 'public'
         and table_name in ('causal_chains', 'delegations', 'trigger_revisions', 'triggers',
           'trigger_watch_activations', 'watch_control_requests')
       order by table_name, ordinal_position`,
      `select conrelid::regclass::text as table_name, conname, pg_get_constraintdef(oid) as definition
       from pg_constraint
       where connamespace = 'public'::regnamespace
         and conrelid in ('public.causal_chains'::regclass, 'public.delegations'::regclass,
           'public.messages'::regclass,
           'public.trigger_revisions'::regclass, 'public.triggers'::regclass,
           'public.trigger_watch_activations'::regclass, 'public.watch_control_requests'::regclass)
       order by table_name, conname`,
      `select tablename, indexname, indexdef
       from pg_indexes
       where schemaname = 'public'
         and tablename in ('causal_chains', 'delegations', 'trigger_revisions', 'triggers',
           'trigger_watch_activations', 'watch_control_requests')
       order by tablename, indexname`,
      `select sequencename from pg_sequences
       where schemaname = 'public' and sequencename = 'trigger_watch_reconcile_generation'`,
    ];
    for (const query of queries) {
      expect((await sql.raw(query).execute(scratch)).rows).toEqual(
        (await sql.raw(query).execute(baseline)).rows,
      );
    }
  });
});

integration("Trigger downstream Run lookup migration", () => {
  const databaseName = `opensteer_trigger_lookup_migration_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let database: Kysely<DatabaseSchema>;

  function urlForDatabase(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlForDatabase("postgres") });
    await maintenance.query(`drop database if exists ${databaseName}`);
    await maintenance.query(`create database ${databaseName}`);
    database = createDatabase({ connectionString: urlForDatabase(databaseName) });
    await sql.raw(BASELINE_SCHEMA_SQL).execute(database);
  });

  afterAll(async () => {
    await database?.destroy();
    await maintenance?.query(`drop database if exists ${databaseName}`);
    await maintenance?.end();
  });

  it("indexes both causal paths used by Trigger detail", async () => {
    await triggerDownstreamRunLookupMigration.up(database);
    await triggerDownstreamRunLookupMigration.up(database);

    const indexes = await sql<{ readonly indexDefinition: string; readonly indexName: string }>`
      select indexname as "indexName", indexdef as "indexDefinition"
      from pg_indexes
      where schemaname = 'public'
        and indexname in ('runs_causal_chain_id_idx', 'thread_inputs_causal_run_idx')
      order by indexname
    `.execute(database);
    expect(indexes.rows).toEqual([
      {
        indexDefinition:
          "CREATE INDEX runs_causal_chain_id_idx ON public.runs USING btree (causal_chain_id)",
        indexName: "runs_causal_chain_id_idx",
      },
      {
        indexDefinition:
          "CREATE INDEX thread_inputs_causal_run_idx ON public.thread_inputs USING btree (causal_chain_id, run_id) WHERE (run_id IS NOT NULL)",
        indexName: "thread_inputs_causal_run_idx",
      },
    ]);
  });
});

integration("deployment kind and Host identity migration", () => {
  const databaseName = `opensteer_identity_migration_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let database: Kysely<DatabaseSchema>;

  function urlForDatabase(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlForDatabase("postgres") });
    await maintenance.query(`drop database if exists ${databaseName}`);
    await maintenance.query(`create database ${databaseName}`);
    database = createDatabase({ connectionString: urlForDatabase(databaseName) });
    await sql.raw(BASELINE_SCHEMA_SQL).execute(database);
  });

  afterAll(async () => {
    await database?.destroy();
    await maintenance?.query(`drop database if exists ${databaseName}`);
    await maintenance?.end();
  });

  it("converts the legacy Personal shape and removes every Host authority generation column", async () => {
    await sql`
      insert into public.deployments(
        id, active_host_instance_id, authority_epoch, canonical_origin, deployment_shape
      ) values
        (
          'dep_11111111-1111-4111-8111-111111111111',
          'hst_11111111-1111-4111-8111-111111111111',
          7,
          'http://127.0.0.1:4310',
          '{"backing":"local-directory","ownerEstablishment":"self-claim","tenancy":"single-user"}'::jsonb
        )
    `.execute(database);

    await deploymentKindAndHostIdentityMigration.up(database);

    const migrated = await sql<{ readonly deploymentShape: unknown }>`
      select deployment_shape as "deploymentShape" from public.deployments
    `.execute(database);
    expect(migrated.rows[0]?.deploymentShape).toEqual({
      backing: "local-directory",
      kind: "personal",
    });

    const columns = await sql<{ readonly columnName: string; readonly tableName: string }>`
      select table_name as "tableName", column_name as "columnName"
      from information_schema.columns
      where table_schema = 'public'
        and (
          (table_name = 'deployments' and column_name = 'authority_epoch')
          or (table_name = 'host_account_adoption_proofs' and column_name = 'authority_epoch')
          or (table_name = 'auth_sessions' and column_name = 'grant_authority_epoch')
        )
    `.execute(database);
    expect(columns.rows).toEqual([]);

    await expect(
      sql`
        update public.deployments
        set deployment_shape = '{"backing":"local-directory","kind":"server","tenancy":"multi-user"}'::jsonb
      `.execute(database),
    ).rejects.toThrow();
  });
});

/**
 * The one-time expansion of global harness instances into environment-scoped
 * profiles is exercised against the shape it will actually meet: a database
 * that still has the pre-profile tables and real cross-environment history. Only
 * the tables the migration touches are recreated, so what is under test is the
 * migration's own SQL rather than the rest of the baseline schema.
 */
integration("harness profile environment migration", () => {
  const scratchDatabaseName = `opensteer_migration_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const baselineDatabaseName = `${scratchDatabaseName}_baseline`;
  let maintenance: Pool;
  let scratch: Kysely<DatabaseSchema>;
  let baseline: Kysely<DatabaseSchema>;

  function urlForDatabase(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlForDatabase("postgres") });
    for (const name of [scratchDatabaseName, baselineDatabaseName]) {
      await maintenance.query(`drop database if exists ${name}`);
      await maintenance.query(`create database ${name}`);
    }
    scratch = createDatabase({ connectionString: urlForDatabase(scratchDatabaseName) });
    baseline = createDatabase({ connectionString: urlForDatabase(baselineDatabaseName) });
    await sql.raw(BASELINE_SCHEMA_SQL).execute(baseline);
  });

  afterAll(async () => {
    await scratch?.destroy();
    await baseline?.destroy();
    for (const name of [scratchDatabaseName, baselineDatabaseName]) {
      await maintenance?.query(`drop database if exists ${name}`);
    }
    await maintenance?.end();
  });

  beforeEach(async () => {
    await sql`drop schema public cascade`.execute(scratch);
    await sql`create schema public`.execute(scratch);
    await sql`
      create table public.execution_environments (
        id text primary key,
        kind text not null,
        name text not null,
        created_at timestamptz default now() not null
      )
    `.execute(scratch);
    await sql`
      create table public.harness_instances (
        id text primary key,
        driver_kind text not null,
        name text not null,
        config jsonb not null,
        enabled boolean default true not null,
        created_at timestamptz default now() not null,
        updated_at timestamptz default now() not null
      )
    `.execute(scratch);
    await sql`
      create table public.threads (
        id text primary key,
        environment_id text not null references public.execution_environments(id),
        harness_instance_id text not null,
        constraint threads_harness_instance_id_fkey
          foreign key (harness_instance_id) references public.harness_instances(id)
      )
    `.execute(scratch);
    await sql`
      create table public.runs (
        id text primary key,
        thread_id text not null references public.threads(id),
        environment_id text not null references public.execution_environments(id),
        harness_instance_id text not null,
        constraint runs_harness_instance_id_fkey
          foreign key (harness_instance_id) references public.harness_instances(id)
      )
    `.execute(scratch);
    await sql`
      create table public.harness_catalogs (
        environment_id text not null references public.execution_environments(id) on delete cascade,
        harness_instance_id text not null,
        catalog jsonb not null,
        captured_at timestamptz default now() not null,
        primary key (environment_id, harness_instance_id),
        constraint harness_catalogs_harness_instance_id_fkey
          foreign key (harness_instance_id) references public.harness_instances(id) on delete cascade
      )
    `.execute(scratch);
    await sql`
      create table public.provider_sessions (
        id text primary key,
        thread_id text not null references public.threads(id) on delete cascade,
        harness_instance_id text not null,
        status text not null
      )
    `.execute(scratch);
  });

  async function seedLegacyHistory(): Promise<void> {
    // Ordering is pinned so the assertions below can name which row keeps its
    // id and which pairing becomes the environment's existing-CLI profile.
    await sql`
      insert into public.execution_environments(id, kind, name, created_at) values
        ('env_a', 'local', 'Laptop', now() - interval '2 hours'),
        ('env_b', 'local', 'Desktop', now() - interval '1 hour')
    `.execute(scratch);
    await sql`
      insert into public.harness_instances(id, driver_kind, name, config, created_at, updated_at)
      values
        ('hin_first', 'codex', 'Codex', '{}'::jsonb, now() - interval '2 hours', now()),
        ('hin_second', 'codex', 'Codex Two', '{}'::jsonb, now() - interval '1 hour', now()),
        ('hin_orphan', 'claude', 'Never used', '{}'::jsonb, now(), now())
    `.execute(scratch);
    await sql`
      insert into public.threads(id, environment_id, harness_instance_id) values
        ('thr_a1', 'env_a', 'hin_first'),
        ('thr_b1', 'env_b', 'hin_first'),
        ('thr_a2', 'env_a', 'hin_second')
    `.execute(scratch);
    await sql`
      insert into public.runs(id, thread_id, environment_id, harness_instance_id) values
        ('run_a1', 'thr_a1', 'env_a', 'hin_first'),
        ('run_b1', 'thr_b1', 'env_b', 'hin_first')
    `.execute(scratch);
    await sql`
      insert into public.harness_catalogs(environment_id, harness_instance_id, catalog) values
        ('env_b', 'hin_second', '{"status":"ready"}'::jsonb)
    `.execute(scratch);
    // `ses_history` is the case a blanket rewrite destroys: its Thread now uses
    // the second profile, but the session was produced by the first one.
    await sql`
      insert into public.provider_sessions(id, thread_id, harness_instance_id, status) values
        ('ses_same', 'thr_a1', 'hin_first', 'stopped'),
        ('ses_history', 'thr_a2', 'hin_first', 'stopped'),
        ('ses_moved', 'thr_b1', 'hin_first', 'stopped')
    `.execute(scratch);
  }

  /**
   * The migration builds temporary tables that live for one transaction, which
   * is exactly how the Migrator runs it, so the test runs it the same way
   * rather than statement by statement on borrowed connections.
   */
  async function runMigration(): Promise<void> {
    await scratch
      .transaction()
      .execute(async (transaction) => environmentHarnessInstancesMigration.up(transaction));
  }

  async function rows<Row>(query: string): Promise<Row[]> {
    return (await sql.raw<Row>(query).execute(scratch)).rows;
  }

  it("pairs profiles only with the environments that used them", async () => {
    await seedLegacyHistory();
    await runMigration();

    const instances = await rows<{
      driverKind: string;
      environmentId: string;
      id: string;
      stateKind: string;
    }>(
      `select id, environment_id, driver_kind, state_kind
       from public.harness_instances order by environment_id, driver_kind, id`,
    );
    // Four observed pairings, and nothing invented: the never-used legacy row
    // and every unobserved (profile, environment) cross are gone.
    expect(instances).toHaveLength(4);
    expect(instances.every((row) => row.driverKind === "codex")).toBe(true);
    expect(instances.filter((row) => row.environmentId === "env_a")).toHaveLength(2);
    expect(instances.filter((row) => row.environmentId === "env_b")).toHaveLength(2);
    // The oldest legacy row keeps its id on the first environment it was seen
    // on, so existing references stay meaningful.
    expect(instances.find((row) => row.id === "hin_first")?.environmentId).toBe("env_a");
    expect(instances.find((row) => row.id === "hin_second")?.environmentId).toBe("env_a");
    expect(instances.some((row) => row.id === "hin_orphan")).toBe(false);

    const ambientPerDriver = await rows<{ ambient: string }>(
      `select count(*) filter (where state_kind = 'ambient')::text as ambient
       from public.harness_instances group by environment_id, driver_kind`,
    );
    expect(ambientPerDriver.map((row) => row.ambient)).toEqual(["1", "1"]);
    expect(instances.find((row) => row.id === "hin_first")?.stateKind).toBe("ambient");
    expect(instances.find((row) => row.id === "hin_second")?.stateKind).toBe("isolated");
  });

  it("remaps threads, runs, catalogs, and sessions through the same pairing", async () => {
    await seedLegacyHistory();
    await runMigration();

    const [envBFirst] = await rows<{ id: string }>(
      `select id from public.harness_instances
       where environment_id = 'env_b' and state_kind = 'ambient'`,
    );
    const [envBSecond] = await rows<{ id: string }>(
      `select id from public.harness_instances
       where environment_id = 'env_b' and state_kind = 'isolated'`,
    );
    expect(envBFirst?.id).toBeDefined();
    expect(envBFirst?.id).not.toBe("hin_first");

    const threads = await rows<{ harnessInstanceId: string; id: string }>(
      `select id, harness_instance_id from public.threads order by id`,
    );
    expect(threads).toEqual([
      { harnessInstanceId: "hin_first", id: "thr_a1" },
      { harnessInstanceId: "hin_second", id: "thr_a2" },
      { harnessInstanceId: envBFirst?.id, id: "thr_b1" },
    ]);

    const runs = await rows<{ harnessInstanceId: string; id: string }>(
      `select id, harness_instance_id from public.runs order by id`,
    );
    expect(runs).toEqual([
      { harnessInstanceId: "hin_first", id: "run_a1" },
      { harnessInstanceId: envBFirst?.id, id: "run_b1" },
    ]);

    const catalogs = await rows<{ environmentId: string; harnessInstanceId: string }>(
      `select environment_id, harness_instance_id from public.harness_catalogs`,
    );
    expect(catalogs).toEqual([{ environmentId: "env_b", harnessInstanceId: envBSecond?.id }]);

    const sessions = await rows<{ harnessInstanceId: string; id: string }>(
      `select id, harness_instance_id from public.provider_sessions order by id`,
    );
    // `ses_history` keeps the profile that produced it rather than adopting the
    // one its Thread now selects, and `ses_moved` follows its own profile onto
    // the environment its Thread runs on.
    expect(sessions).toEqual([
      { harnessInstanceId: "hin_first", id: "ses_history" },
      { harnessInstanceId: envBFirst?.id, id: "ses_moved" },
      { harnessInstanceId: "hin_first", id: "ses_same" },
    ]);
  });

  it("retires pristine legacy defaults when the deployment has no environments", async () => {
    await sql`
      insert into public.harness_instances(id, driver_kind, name, config)
      values
        (
          'hin_00000000-0000-4000-8000-000000000001',
          'codex',
          'Codex',
          '{"model":"gpt-5.6-sol","modelProviderId":"openai"}'::jsonb
        ),
        (
          'hin_00000000-0000-4000-8000-000000000002',
          'claude',
          'Claude Code',
          '{"model":"sonnet","modelProviderId":"anthropic"}'::jsonb
        )
    `.execute(scratch);

    await runMigration();

    expect(await rows(`select id from public.harness_instances`)).toEqual([]);
  });

  it("refuses to guess where a customized profile belongs when there are no environments", async () => {
    await sql`
      insert into public.harness_instances(id, driver_kind, name, config)
      values ('hin_alone', 'codex', 'Codex', '{}'::jsonb)
    `.execute(scratch);
    await expect(runMigration()).rejects.toThrow(/no execution environments/);
  });

  it("leaves harness_instances in the shape the baseline schema declares", async () => {
    await seedLegacyHistory();
    await runMigration();
    // The baseline is every migration's outcome, so the shape comparison has to
    // include the later one that also touches this table.
    await defaultHarnessPerDriverMigration.up(scratch);
    await harnessAccountSourcesMigration.up(scratch);

    const columnQuery = `
      select column_name, data_type, is_nullable, coalesce(column_default, '') as column_default
      from information_schema.columns
      where table_schema = 'public' and table_name = 'harness_instances'
      order by column_name`;
    const constraintQuery = `
      select conname, pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conrelid = 'public.harness_instances'::regclass
      order by conname`;
    const indexQuery = `
      select indexname, indexdef from pg_indexes
      where schemaname = 'public' and tablename = 'harness_instances'
      order by indexname`;
    const triggerQuery = `
      select tgname, pg_get_triggerdef(oid) as definition
      from pg_trigger
      where tgrelid = 'public.harness_instances'::regclass and not tgisinternal
      order by tgname`;

    for (const query of [columnQuery, constraintQuery, indexQuery, triggerQuery]) {
      const migrated = (await sql.raw(query).execute(scratch)).rows;
      const declared = (await sql.raw(query).execute(baseline)).rows;
      expect(migrated).toEqual(declared);
    }
  });
});

integration("owned native OAuth callback migration", () => {
  const databaseName = `opensteer_oauth_migration_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let database: Kysely<DatabaseSchema>;

  function urlForDatabase(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlForDatabase("postgres") });
    await maintenance.query(`drop database if exists ${databaseName}`);
    await maintenance.query(`create database ${databaseName}`);
    database = createDatabase({ connectionString: urlForDatabase(databaseName) });
  });

  afterAll(async () => {
    await database?.destroy();
    await maintenance?.query(`drop database if exists ${databaseName}`);
    await maintenance?.end();
  });

  beforeEach(async () => {
    await sql`drop schema public cascade`.execute(database);
    await sql`create schema public`.execute(database);
    await sql`
      create table public.host_oauth_clients (
        id text primary key,
        client_id text unique not null,
        redirect_uris jsonb not null,
        reference_id text unique
      )
    `.execute(database);
  });

  it("retires only application-managed native clients", async () => {
    await sql`
      insert into public.host_oauth_clients(id, client_id, redirect_uris, reference_id) values
        ('managed-legacy', 'opensteer-desktop', '["opensteer:/oauth/host-callback"]',
          'opensteer-native-client'),
        ('managed-beta', 'opensteer-desktop-beta', '["opensteer:/oauth/host-callback"]',
          'opensteer-native-client:opensteer-desktop-beta'),
        ('operator-client', 'operator-client', '["operator.example:/callback"]',
          'operator-owned')
    `.execute(database);

    await ownedNativeOAuthCallbackMigration.up(database);

    const remaining = await sql<{ clientId: string; referenceId: string }>`
      select client_id, reference_id from public.host_oauth_clients order by client_id
    `.execute(database);
    expect(remaining.rows).toEqual([
      { clientId: "operator-client", referenceId: "operator-owned" },
    ]);
  });
});

integration("integration account identifier baseline", () => {
  const databaseName = `opensteer_account_identifier_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let database: Kysely<DatabaseSchema>;

  function urlForDatabase(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlForDatabase("postgres") });
    await maintenance.query(`drop database if exists ${databaseName}`);
    await maintenance.query(`create database ${databaseName}`);
    database = createDatabase({ connectionString: urlForDatabase(databaseName) });
  });

  afterAll(async () => {
    await database?.destroy();
    await maintenance?.query(`drop database if exists ${databaseName}`);
    await maintenance?.end();
  });

  beforeEach(async () => {
    await sql`drop schema public cascade`.execute(database);
    await sql`create schema public`.execute(database);
    await sql.raw(BASELINE_SCHEMA_SQL).execute(database);
  });

  it("declares one optional, size-bounded provider-neutral identifier directly", async () => {
    const columns = await sql<{
      columnDefault: string | null;
      dataType: string;
      isNullable: "NO" | "YES";
    }>`
      select column_default, data_type, is_nullable
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'integration_connections'
        and column_name = 'account_identifier'
    `.execute(database);
    expect(columns.rows).toEqual([{ columnDefault: null, dataType: "text", isNullable: "YES" }]);
    const constraints = await sql<{ definition: string }>`
      select pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conrelid = 'public.integration_connections'::regclass
        and conname = 'integration_connections_account_identifier_check'
    `.execute(database);
    expect(constraints.rows).toHaveLength(1);
    expect(constraints.rows[0]?.definition).toContain("octet_length(account_identifier) >= 1");
    expect(constraints.rows[0]?.definition).toContain("octet_length(account_identifier) <= 1280");
  });
});

/**
 * A Request could not originate from a Trigger Occurrence while its Run origin
 * was mandatory. The migration is exercised against the shape it will actually
 * meet — the pre-migration `requests` table with real Run-originated rows — and
 * the result is compared against what the baseline declares for fresh installs.
 */
integration("trigger-originated request origin migration", () => {
  const scratchDatabaseName = `opensteer_request_origin_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const baselineDatabaseName = `${scratchDatabaseName}_baseline`;
  let maintenance: Pool;
  let scratch: Kysely<DatabaseSchema>;
  let baseline: Kysely<DatabaseSchema>;

  function urlForDatabase(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlForDatabase("postgres") });
    for (const name of [scratchDatabaseName, baselineDatabaseName]) {
      await maintenance.query(`drop database if exists ${name}`);
      await maintenance.query(`create database ${name}`);
    }
    scratch = createDatabase({ connectionString: urlForDatabase(scratchDatabaseName) });
    baseline = createDatabase({ connectionString: urlForDatabase(baselineDatabaseName) });
    await sql.raw(BASELINE_SCHEMA_SQL).execute(baseline);
  });

  afterAll(async () => {
    await scratch?.destroy();
    await baseline?.destroy();
    for (const name of [scratchDatabaseName, baselineDatabaseName]) {
      await maintenance?.query(`drop database if exists ${name}`);
    }
    await maintenance?.end();
  });

  beforeEach(async () => {
    await sql`drop schema public cascade`.execute(scratch);
    await sql`create schema public`.execute(scratch);
    await sql`create table public.trigger_occurrences (id text primary key)`.execute(scratch);
    await sql`
      create table public.requests (
        id text not null,
        kind text not null,
        mode text not null,
        status text not null,
        originating_workspace_id text not null,
        originating_thread_id text not null,
        originating_run_id text not null,
        call_id text not null,
        target_workspace_id text not null,
        requested_by text not null,
        required_actor text not null,
        presentation jsonb not null,
        payload jsonb not null,
        response jsonb,
        response_command_id text,
        cancellation_reason text,
        resolved_at timestamp with time zone,
        resolved_by text,
        created_at timestamp with time zone default now() not null,
        constraint requests_pkey primary key (id),
        constraint requests_call_identity_unique unique (originating_run_id, call_id)
      )
    `.execute(scratch);
  });

  async function seedRunOriginatedRequest(id: string, callId: string): Promise<void> {
    await sql`
      insert into public.requests(
        id, kind, mode, status, originating_workspace_id, originating_thread_id,
        originating_run_id, call_id, target_workspace_id, requested_by, required_actor,
        presentation, payload
      ) values (
        ${id}, 'integration.install', 'durable', 'pending', 'wsp_1', 'thr_1',
        'run_1', ${callId}, 'wsp_1', 'usr_1', 'administrator',
        '{"kind":"choice"}'::jsonb, '{"kind":"integration.install"}'::jsonb
      )
    `.execute(scratch);
  }

  function runMigration(): Promise<void> {
    return triggerOriginatedRequestsMigration.up(scratch);
  }

  it("leaves requests in the shape the baseline schema declares", async () => {
    await seedRunOriginatedRequest("req_existing", "existing-call");
    await runMigration();

    const columnQuery = `
      select column_name, data_type, is_nullable, coalesce(column_default, '') as column_default
      from information_schema.columns
      where table_schema = 'public' and table_name = 'requests'
      order by column_name`;
    const originConstraintQuery = `
      select conname, pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conrelid = 'public.requests'::regclass and conname = 'requests_origin_check'`;
    const identityIndexQuery = `
      select indexname, indexdef from pg_indexes
      where schemaname = 'public' and tablename = 'requests'
        and indexname like 'requests_%call_identity_unique'
      order by indexname`;

    for (const query of [columnQuery, originConstraintQuery, identityIndexQuery]) {
      const migrated = (await sql.raw(query).execute(scratch)).rows;
      const declared = (await sql.raw(query).execute(baseline)).rows;
      expect(migrated).toEqual(declared);
    }
    // The single UNIQUE it replaces would treat NULL occurrence ids as distinct.
    const replaced = await sql
      .raw(
        `
      select conname from pg_constraint
      where conrelid = 'public.requests'::regclass and conname = 'requests_call_identity_unique'
    `,
      )
      .execute(scratch);
    expect(replaced.rows).toEqual([]);
  });

  it("keeps existing Run-originated rows and their call identity", async () => {
    await seedRunOriginatedRequest("req_existing", "existing-call");
    await runMigration();

    const rows = await sql<{
      originatingOccurrenceId: string | null;
      originatingRunId: string | null;
    }>`
      select originating_occurrence_id, originating_run_id from public.requests
    `.execute(scratch);
    expect(rows.rows).toEqual([{ originatingOccurrenceId: null, originatingRunId: "run_1" }]);
    await expect(seedRunOriginatedRequest("req_duplicate", "existing-call")).rejects.toThrow(
      "requests_run_call_identity_unique",
    );
  });

  it("admits an Occurrence origin and refuses anything but exactly one", async () => {
    await runMigration();
    await sql`insert into public.trigger_occurrences(id) values ('toc_1')`.execute(scratch);
    const insertOccurrenceRequest = (id: string, callId: string, runId: string | null) =>
      sql`
      insert into public.requests(
        id, kind, mode, status, originating_workspace_id, originating_thread_id,
        originating_run_id, originating_occurrence_id, call_id, target_workspace_id,
        requested_by, required_actor, presentation, payload
      ) values (
        ${id}, 'integration.install', 'durable', 'pending', 'wsp_1', 'thr_1',
        ${runId}, 'toc_1', ${callId}, 'wsp_1', 'usr_1', 'administrator',
        '{"kind":"choice"}'::jsonb, '{"kind":"integration.install"}'::jsonb
      )
    `.execute(scratch);

    await insertOccurrenceRequest("req_trigger", "trigger-call", null);
    await expect(insertOccurrenceRequest("req_both", "both-call", "run_1")).rejects.toThrow(
      "requests_origin_check",
    );
    await expect(insertOccurrenceRequest("req_replay", "trigger-call", null)).rejects.toThrow(
      "requests_occurrence_call_identity_unique",
    );
  });
});

integration("integration access class migration", () => {
  const databaseName = `opensteer_access_class_migration_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let database: Kysely<DatabaseSchema>;

  function urlForDatabase(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlForDatabase("postgres") });
    await maintenance.query(`drop database if exists ${databaseName}`);
    await maintenance.query(`create database ${databaseName}`);
    database = createDatabase({ connectionString: urlForDatabase(databaseName) });
    await sql.raw(BASELINE_SCHEMA_SQL).execute(database);
  });

  afterAll(async () => {
    await database?.destroy();
    await maintenance?.query(`drop database if exists ${databaseName}`);
    await maintenance?.end();
  });

  it("converts bound tools to access classes and collapses duplicate pending asks", async () => {
    await database.transaction().execute(async (transaction) => {
      // This keeps the baseline's checks and indexes in play while isolating
      // the migration fixture from unrelated ownership foreign keys.
      await sql`set local session_replication_role = replica`.execute(transaction);
      await sql
        .raw(
          `
        insert into public.integration_installations(
          id, name, title, description, version, source_kind, trust, manifest,
          provenance, status, revision
        ) values (
          'iin_11111111-1111-4111-8111-111111111111', 'migration-fixture',
          'Migration fixture', '', '1', 'built-in', 'built-in', '{}', '{}', 'active', 1
        );
        insert into public.integration_servers(
          id, installation_id, name, transport, status, connection_requirement
        ) values (
          'isv_11111111-1111-4111-8111-111111111111',
          'iin_11111111-1111-4111-8111-111111111111', 'default',
          '{"type":"streamable-http","url":"https://example.test/mcp","headers":{}}',
          'active', '{"kind":"none"}'
        );
        insert into public.integration_tools(
          id, server_id, name, title, description, input_schema, output_schema,
          annotations, schema_digest, status
        ) values
          (
            'itl_11111111-1111-4111-8111-111111111111',
            'isv_11111111-1111-4111-8111-111111111111', 'list', 'List', '', '{}', null,
            '{"readOnlyHint":true}', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'active'
          ),
          (
            'itl_22222222-2222-4222-8222-222222222222',
            'isv_11111111-1111-4111-8111-111111111111', 'create', 'Create', '', '{}', null,
            '{}', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'active'
          );
        insert into public.integration_grants(
          id, workspace_id, owner_user_id, installation_id, connection_id, alias,
          granted_tools, granted_skills, is_default, created_by, status
        ) values
          (
            'igr_11111111-1111-4111-8111-111111111111',
            'wsp_11111111-1111-4111-8111-111111111111',
            'usr_11111111-1111-4111-8111-111111111111',
            'iin_11111111-1111-4111-8111-111111111111', null, 'Read account',
            '[{"toolId":"itl_11111111-1111-4111-8111-111111111111"}]', '[]', true,
            'usr_11111111-1111-4111-8111-111111111111', 'active'
          ),
          (
            'igr_22222222-2222-4222-8222-222222222222',
            'wsp_22222222-2222-4222-8222-222222222222',
            'usr_11111111-1111-4111-8111-111111111111',
            'iin_11111111-1111-4111-8111-111111111111', null, 'Write account',
            '[{"toolId":"itl_22222222-2222-4222-8222-222222222222"}]', '[]', true,
            'usr_11111111-1111-4111-8111-111111111111', 'needs-reapproval'
          );
      `,
        )
        .execute(transaction);

      const requests = [
        [
          "req_11111111-1111-4111-8111-111111111111",
          "read-older",
          "itl_11111111-1111-4111-8111-111111111111",
        ],
        [
          "req_22222222-2222-4222-8222-222222222222",
          "read-newer",
          "itl_11111111-1111-4111-8111-111111111111",
        ],
        [
          "req_33333333-3333-4333-8333-333333333333",
          "write",
          "itl_22222222-2222-4222-8222-222222222222",
        ],
      ] as const;
      for (const [requestId, callId, toolId] of requests) {
        const payload = JSON.stringify({
          installationId: "iin_11111111-1111-4111-8111-111111111111",
          kind: "integration.access",
          reason: "Migration test",
          requestedServerId: "isv_11111111-1111-4111-8111-111111111111",
          requiredSkills: [],
          requiredTools: [{ toolId }],
        });
        const bindings = JSON.stringify([{ toolId }]);
        await sql`
          insert into public.requests(
            id, kind, mode, status, originating_workspace_id, originating_thread_id,
            originating_run_id, call_id, target_workspace_id, requested_by,
            required_actor, presentation, payload
          ) values (
            ${requestId}, 'integration.access', 'durable', 'pending',
            'wsp_11111111-1111-4111-8111-111111111111',
            'thr_11111111-1111-4111-8111-111111111111',
            'run_11111111-1111-4111-8111-111111111111', ${callId},
            'wsp_11111111-1111-4111-8111-111111111111',
            'usr_11111111-1111-4111-8111-111111111111', 'workspace-owner',
            '{"kind":"choice"}'::jsonb, ${payload}::jsonb
          )
        `.execute(transaction);
        await sql`
          insert into public.integration_request_details(
            request_id, installation_id, requested_server_id, required_skills, required_tools
          ) values (
            ${requestId}, 'iin_11111111-1111-4111-8111-111111111111',
            'isv_11111111-1111-4111-8111-111111111111', '[]'::jsonb, ${bindings}::jsonb
          )
        `.execute(transaction);
        await sql`insert into public.request_continuations(request_id) values (${requestId})`.execute(
          transaction,
        );
      }
      // The duplicate is mid-response: the migration must clear the command
      // reference or the cancelled arm of requests_terminal_check rejects it.
      await sql`
        update public.requests set response_command_id = 'cmd_22222222-2222-4222-8222-222222222222'
        where id = 'req_22222222-2222-4222-8222-222222222222'
      `.execute(transaction);
      await integrationAccessClassMigration.up(transaction);
      await sql`set local session_replication_role = origin`.execute(transaction);

      const duplicate = await sql<{ readonly responseCommandId: string | null }>`
        select response_command_id as "responseCommandId" from public.requests
        where id = 'req_22222222-2222-4222-8222-222222222222'
      `.execute(transaction);
      expect(duplicate.rows[0]?.responseCommandId).toBeNull();

      const grants = await sql<{
        readonly access: string;
        readonly id: string;
        readonly status: string;
      }>`
        select id, access, status from public.integration_grants order by id
      `.execute(transaction);
      expect(grants.rows).toEqual([
        { access: "read", id: "igr_11111111-1111-4111-8111-111111111111", status: "active" },
        { access: "read-write", id: "igr_22222222-2222-4222-8222-222222222222", status: "active" },
      ]);

      const migratedRequests = await sql<{
        readonly access: string;
        readonly payload: Record<string, unknown>;
        readonly status: string;
      }>`
        select detail.access, request_row.payload, request_row.status
        from public.requests request_row
        join public.integration_request_details detail on detail.request_id = request_row.id
        order by request_row.id
      `.execute(transaction);
      // The oldest read ask is answered by the read grant that already covers
      // its Workspace; its duplicate is collapsed; the write ask stays open.
      expect(migratedRequests.rows.map(({ access, status }) => ({ access, status }))).toEqual([
        { access: "read", status: "fulfilled" },
        { access: "read", status: "cancelled" },
        { access: "read-write", status: "pending" },
      ]);
      const covered = await sql<{ readonly response: Record<string, unknown> }>`
        select response from public.requests
        where id = 'req_11111111-1111-4111-8111-111111111111'
      `.execute(transaction);
      expect(covered.rows[0]?.response).toEqual({
        kind: "external",
        value: {
          access: "read",
          alias: "Read account",
          connectionId: null,
          decision: "fulfilled",
          isDefault: true,
        },
      });
      for (const row of migratedRequests.rows) {
        expect(row.payload).toMatchObject({ access: row.access, kind: "integration.access" });
        expect(row.payload).not.toHaveProperty("requiredSkills");
        expect(row.payload).not.toHaveProperty("requiredTools");
      }

      const continuations = await sql<{ readonly requestId: string }>`
        select request_id as "requestId" from public.request_continuations order by request_id
      `.execute(transaction);
      expect(continuations.rows).toEqual([
        { requestId: "req_11111111-1111-4111-8111-111111111111" },
        { requestId: "req_33333333-3333-4333-8333-333333333333" },
      ]);

      const removedColumns = await sql<{ readonly columnName: string }>`
        select column_name as "columnName" from information_schema.columns
        where table_schema = 'public'
          and (
            (table_name = 'integration_grants' and column_name in ('granted_tools', 'granted_skills'))
            or (table_name = 'integration_request_details' and column_name in ('required_tools', 'required_skills'))
          )
      `.execute(transaction);
      expect(removedColumns.rows).toEqual([]);

      const retainedIndexes = await sql<{ readonly indexName: string }>`
        select indexname as "indexName" from pg_indexes
        where schemaname = 'public'
          and indexname in ('integration_grants_one_default', 'integration_grants_unique_alias')
        order by indexname
      `.execute(transaction);
      expect(retainedIndexes.rows).toEqual([
        { indexName: "integration_grants_one_default" },
        { indexName: "integration_grants_unique_alias" },
      ]);
    });
  });
});

/**
 * A local directory carried no disk identity and no enforced owning machine.
 * `0001_baseline` installs the current Workspace shape, so the pre-migration
 * shape is reconstructed here by reverting exactly what this migration adds —
 * in dependency order — and the migrated result is then compared against what
 * the baseline declares for fresh installs.
 */
integration("Runner-owned local Workspace migration", () => {
  const scratchDatabaseName = `opensteer_runner_owned_workspaces_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const baselineDatabaseName = `${scratchDatabaseName}_baseline`;
  let maintenance: Pool;
  let database: Kysely<DatabaseSchema>;
  let baseline: Kysely<DatabaseSchema>;

  function urlForDatabase(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  /** The inverse of the migration, innermost dependency first. */
  async function revertRunnerOwnedLocalWorkspaces(target: Kysely<DatabaseSchema>): Promise<void> {
    await sql`drop index public.workspaces_owner_environment_idx`.execute(target);
    await sql`
      alter table public.workspaces drop constraint workspaces_owner_environment_id_fkey
    `.execute(target);
    await sql`alter table public.workspaces drop column owner_environment_id`.execute(target);
    await sql`
      alter table public.workspaces
        drop constraint workspaces_backing_shape_check,
        add constraint workspaces_backing_shape_check check (
          jsonb_typeof(backing) = 'object'
          and jsonb_typeof(backing -> 'generation') = 'number'
          and (backing ->> 'generation') ~ '^[0-9]+$'
          and (backing ->> 'generation')::numeric >= 1
          and (backing ->> 'generation')::numeric <= 9007199254740991::bigint::numeric
          and (
            (
              backing ->> 'kind' = 'portablefs'
              and backing ?& array['kind', 'serviceId', 'volumeId', 'generation']
              and backing = jsonb_build_object(
                'kind', backing -> 'kind',
                'serviceId', backing -> 'serviceId',
                'volumeId', backing -> 'volumeId',
                'generation', backing -> 'generation'
              )
              and length(backing ->> 'serviceId') between 1 and 255
              and (backing ->> 'serviceId') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
              and length(backing ->> 'volumeId') between 1 and 220
              and (backing ->> 'volumeId') ~ '^[A-Za-z0-9_-]+$'
            )
            or (
              backing ->> 'kind' = 'local-directory'
              and backing ?& array['kind', 'bindingId', 'ownerEnvironmentId', 'generation']
              and backing = jsonb_build_object(
                'kind', backing -> 'kind',
                'bindingId', backing -> 'bindingId',
                'ownerEnvironmentId', backing -> 'ownerEnvironmentId',
                'generation', backing -> 'generation'
              )
              and (backing ->> 'bindingId') ~
                '^wbd_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
              and (backing ->> 'ownerEnvironmentId') ~
                '^env_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
            )
          )
        )
    `.execute(target);
    await sql`
      alter table public.workspaces
        drop constraint workspaces_storage_error_shape_check,
        add constraint workspaces_storage_error_shape_check check (
          (
            storage_error_code is null
            and storage_error_message is null
            and storage_error_at is null
            and storage_error_retryable = false
          )
          or (
            storage_error_code = any (array[
              'manager-allocation-rejected',
              'manager-configuration-invalid',
              'manager-identity-rejected',
              'manager-protocol-error',
              'manager-unavailable',
              'manager-unknown-volume-state',
              'local-directory-inaccessible',
              'local-directory-missing',
              'local-directory-replaced',
              'local-registry-invalid'
            ])
            and storage_error_message is not null
            and octet_length(storage_error_message) between 1 and 2000
            and storage_error_at is not null
          )
        )
    `.execute(target);
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlForDatabase("postgres") });
    for (const name of [scratchDatabaseName, baselineDatabaseName]) {
      await maintenance.query(`drop database if exists ${name}`);
      await maintenance.query(`create database ${name}`);
    }
    database = createDatabase({ connectionString: urlForDatabase(scratchDatabaseName) });
    baseline = createDatabase({ connectionString: urlForDatabase(baselineDatabaseName) });
    await sql.raw(BASELINE_SCHEMA_SQL).execute(baseline);
    await sql.raw(BASELINE_SCHEMA_SQL).execute(database);
    await revertRunnerOwnedLocalWorkspaces(database);
    await sql`
      insert into public.users(id, display_name, email) values
        ('usr_11111111-1111-4111-8111-111111111111', 'Owner', 'owner@example.test');
      insert into public.execution_environments(id, kind, name) values
        ('env_11111111-1111-4111-8111-111111111111', 'main', 'This computer');
      insert into public.deployments(
        id, active_host_instance_id, canonical_origin, deployment_shape
      ) values (
        'dep_11111111-1111-4111-8111-111111111111',
        'hst_11111111-1111-4111-8111-111111111111',
        'http://127.0.0.1:4310',
        '{"backing":"local-directory","ownerEstablishment":"self-claim","tenancy":"single-user"}'::jsonb
      )
    `.execute(database);
    await deploymentKindAndHostIdentityMigration.up(database);
    await sql`
      insert into public.workspaces(id, name, created_by, kind, backing, capacity_policy) values
        (
          'wsp_11111111-1111-4111-8111-111111111111',
          'Main',
          'usr_11111111-1111-4111-8111-111111111111',
          'main',
          '{"kind":"local-directory","bindingId":"wbd_11111111-1111-4111-8111-111111111111","ownerEnvironmentId":"env_11111111-1111-4111-8111-111111111111","generation":1}'::jsonb,
          '{"kind":"host-filesystem"}'::jsonb
        );
      insert into public.workspace_memberships(id, workspace_id, user_id, role, state) values
        (
          'wmb_11111111-1111-4111-8111-111111111111',
          'wsp_11111111-1111-4111-8111-111111111111',
          'usr_11111111-1111-4111-8111-111111111111',
          'owner',
          'active'
        )
    `.execute(database);
  });

  afterAll(async () => {
    await database?.destroy();
    await baseline?.destroy();
    for (const name of [scratchDatabaseName, baselineDatabaseName]) {
      await maintenance?.query(`drop database if exists ${name}`);
    }
    await maintenance?.end();
  });

  it("turns the Deployment backing into a default and leaves legacy local storage explicitly unowned", async () => {
    await runnerOwnedLocalWorkspacesMigration.up(database);

    const deployment = await sql<{ readonly deploymentShape: unknown }>`
      select deployment_shape as "deploymentShape" from public.deployments
    `.execute(database);
    expect(deployment.rows[0]?.deploymentShape).toEqual({
      defaultWorkspaceBacking: "local-directory",
      kind: "personal",
    });

    const workspace = await sql<{
      readonly backing: { readonly storageAuthorityId?: string | null };
      readonly ownerEnvironmentId: string | null;
      readonly status: string;
      readonly storageErrorCode: string | null;
      readonly storageErrorMessage: string | null;
      readonly storageErrorRetryable: boolean;
    }>`
      select backing,
             owner_environment_id as "ownerEnvironmentId",
             status,
             storage_error_code as "storageErrorCode",
             storage_error_message as "storageErrorMessage",
             storage_error_retryable as "storageErrorRetryable"
      from public.workspaces
    `.execute(database);
    expect(workspace.rows[0]?.ownerEnvironmentId).toBe("env_11111111-1111-4111-8111-111111111111");
    expect(workspace.rows[0]).toMatchObject({
      backing: { storageAuthorityId: null },
      status: "unavailable",
      storageErrorCode: "local-authority-mismatch",
      storageErrorMessage:
        "This Workspace predates machine-owned storage and must be recreated on the computer that holds its files.",
      storageErrorRetryable: false,
    });
  });

  it("leaves workspaces in the shape the baseline schema declares", async () => {
    const columnQuery = `
      select column_name, data_type, is_nullable, is_generated,
             coalesce(generation_expression, '') as generation_expression
      from information_schema.columns
      where table_schema = 'public' and table_name = 'workspaces'
      order by column_name`;
    const constraintQuery = `
      select conname, pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conrelid = 'public.workspaces'::regclass
        and conname in (
          'workspaces_backing_shape_check',
          'workspaces_storage_error_shape_check',
          'workspaces_owner_environment_id_fkey'
        )
      order by conname`;
    const indexQuery = `
      select indexname, indexdef from pg_indexes
      where schemaname = 'public' and tablename = 'workspaces'
      order by indexname`;
    const deploymentConstraintQuery = `
      select conname, pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conrelid = 'public.deployments'::regclass and conname = 'deployments_shape_check'`;

    for (const query of [columnQuery, constraintQuery, indexQuery]) {
      const migrated = (await sql.raw(query).execute(database)).rows;
      const declared = (await sql.raw(query).execute(baseline)).rows;
      expect(migrated).toEqual(declared);
    }
    // The baseline still declares the pre-0012 Deployment shape, which is why
    // this migration restates the constraint on every database rather than
    // skipping it with the Workspace work.
    const deploymentConstraint = (
      await sql.raw(deploymentConstraintQuery).execute(database)
    ).rows.at(0);
    expect(deploymentConstraint).toMatchObject({
      definition: expect.stringContaining("defaultWorkspaceBacking"),
    });
  });

  it("is inert against a database that already has the Runner-owned shape", async () => {
    const before = (
      await sql
        .raw(
          `select conname, pg_get_constraintdef(oid) as definition from pg_constraint
         where conrelid = 'public.workspaces'::regclass order by conname`,
        )
        .execute(database)
    ).rows;

    await runnerOwnedLocalWorkspacesMigration.up(database);

    const after = (
      await sql
        .raw(
          `select conname, pg_get_constraintdef(oid) as definition from pg_constraint
         where conrelid = 'public.workspaces'::regclass order by conname`,
        )
        .execute(database)
    ).rows;
    expect(after).toEqual(before);
  });

  it("refuses a local backing with no storage authority", async () => {
    await expect(
      sql`
        insert into public.workspaces(id, name, created_by, kind, backing, capacity_policy) values
          (
            'wsp_22222222-2222-4222-8222-222222222222',
            'Unfenced',
            'usr_11111111-1111-4111-8111-111111111111',
            'specialized',
            '{"kind":"local-directory","bindingId":"wbd_22222222-2222-4222-8222-222222222222","ownerEnvironmentId":"env_11111111-1111-4111-8111-111111111111","generation":1}'::jsonb,
            '{"kind":"host-filesystem"}'::jsonb
          )
      `.execute(database),
    ).rejects.toThrow(/workspaces_backing_shape_check/u);
  });

  it("refuses a local Workspace owned by a machine this Deployment does not have", async () => {
    await expect(
      sql`
        insert into public.workspaces(id, name, created_by, kind, backing, capacity_policy) values
          (
            'wsp_33333333-3333-4333-8333-333333333333',
            'Elsewhere',
            'usr_11111111-1111-4111-8111-111111111111',
            'specialized',
            '{"kind":"local-directory","bindingId":"wbd_33333333-3333-4333-8333-333333333333","ownerEnvironmentId":"env_99999999-9999-4999-8999-999999999999","storageAuthorityId":"sta_33333333-3333-4333-8333-333333333333","generation":1}'::jsonb,
            '{"kind":"host-filesystem"}'::jsonb
          )
      `.execute(database),
    ).rejects.toThrow(/workspaces_owner_environment_id_fkey/u);
  });

  it("refuses to delete a machine that still holds somebody's files", async () => {
    await expect(
      sql`
        delete from public.execution_environments
        where id = 'env_11111111-1111-4111-8111-111111111111'
      `.execute(database),
    ).rejects.toThrow(/workspaces_owner_environment_id_fkey/u);
  });

  it("leaves shared storage with no owning machine", async () => {
    await sql`
      insert into public.workspaces(id, name, created_by, kind, backing, capacity_policy) values
        (
          'wsp_44444444-4444-4444-8444-444444444444',
          'Shared',
          'usr_11111111-1111-4111-8111-111111111111',
          'specialized',
          '{"kind":"portablefs","serviceId":"svc","volumeId":"vol-1","generation":1}'::jsonb,
          '{"kind":"hard-quota","blockHardLimitBytes":1048576,"inodeHardLimit":1000}'::jsonb
        );
      insert into public.workspace_memberships(id, workspace_id, user_id, role, state) values
        (
          'wmb_44444444-4444-4444-8444-444444444444',
          'wsp_44444444-4444-4444-8444-444444444444',
          'usr_11111111-1111-4111-8111-111111111111',
          'owner',
          'active'
        )
    `.execute(database);

    const shared = await sql<{ readonly ownerEnvironmentId: string | null }>`
      select owner_environment_id as "ownerEnvironmentId" from public.workspaces
      where id = 'wsp_44444444-4444-4444-8444-444444444444'
    `.execute(database);
    expect(shared.rows[0]?.ownerEnvironmentId).toBeNull();
  });

  it("records the machine-authority storage failures the Host now writes", async () => {
    await sql`
      update public.workspaces
      set storage_error_code = 'local-authority-unavailable',
          storage_error_message = 'That computer is not connected right now.',
          storage_error_retryable = true,
          storage_error_at = now()
      where id = 'wsp_11111111-1111-4111-8111-111111111111'
    `.execute(database);

    await expect(
      sql`
        update public.workspaces
        set storage_error_code = 'not-a-storage-failure'
        where id = 'wsp_11111111-1111-4111-8111-111111111111'
      `.execute(database),
    ).rejects.toThrow(/workspaces_storage_error_shape_check/u);
  });
});

/**
 * A released post-0022 database has the module grant but nothing about access.
 * The fixture rebuilds exactly that shape from the baseline, because the
 * baseline is always the post-migration one.
 */
integration("machine access migration", () => {
  const scratchName = `opensteer_machine_access_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const baselineName = `${scratchName}_baseline`;
  let maintenance: Pool;
  let scratch: Kysely<DatabaseSchema>;
  let baseline: Kysely<DatabaseSchema>;

  function urlForDatabase(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlForDatabase("postgres") });
    for (const name of [scratchName, baselineName]) {
      await maintenance.query(`drop database if exists ${name}`);
      await maintenance.query(`create database ${name}`);
    }
    scratch = createDatabase({ connectionString: urlForDatabase(scratchName) });
    baseline = createDatabase({ connectionString: urlForDatabase(baselineName) });
    await sql.raw(BASELINE_SCHEMA_SQL).execute(scratch);
    await sql.raw(BASELINE_SCHEMA_SQL).execute(baseline);
    await sql`
      drop table public.machine_access_events;
      drop table public.machine_access_sessions;
      alter table public.runners
        drop column access_policy,
        drop column access_policy_revision,
        drop column device,
        drop constraint runners_allowed_modules_check,
        add constraint runners_allowed_modules_check check (
          jsonb_typeof(allowed_modules) = 'array'
          and jsonb_array_length(allowed_modules) between 1 and 3
          and allowed_modules <@ '["agents", "browser", "messaging"]'::jsonb
        );
      alter table public.runner_enrollments
        drop constraint runner_enrollments_allowed_modules_check,
        add constraint runner_enrollments_allowed_modules_check check (
          jsonb_typeof(allowed_modules) = 'array'
          and jsonb_array_length(allowed_modules) between 1 and 3
          and allowed_modules <@ '["agents", "browser", "messaging"]'::jsonb
        );
    `.execute(scratch);
    await sql`
      insert into public.users(id, display_name, email)
      values ('usr_11111111-1111-4111-8111-111111111111', 'Owner', 'owner@example.test');
      insert into public.runners(
        id, owner_kind, owner_user_id, name, kind, public_key_pem, public_key_fingerprint,
        enrollment_token_hash, allowed_modules, max_concurrent_runs
      ) values (
        'rnr_11111111-1111-4111-8111-111111111111', 'user',
        'usr_11111111-1111-4111-8111-111111111111', 'Laptop', 'local',
        repeat('x', 70), 'sha256:laptop', 'sha256:laptop-token', '["agents"]'::jsonb, 4
      ), (
        'rnr_22222222-2222-4222-8222-222222222222', 'deployment', null,
        'Messaging service', 'managed',
        repeat('y', 70), 'sha256:messaging', 'sha256:messaging-token',
        '["browser", "messaging"]'::jsonb, null
      );
      insert into public.runner_enrollments(
        id, name, token_hash, created_by, owner_kind, owner_user_id, idempotency_key,
        request_fingerprint, runner_kind, allowed_modules, expires_at, consumed_at, runner_id
      ) values (
        'ren_11111111-1111-4111-8111-111111111111', 'Laptop', 'sha256:laptop-token',
        'usr_11111111-1111-4111-8111-111111111111', 'user',
        'usr_11111111-1111-4111-8111-111111111111', 'laptop', 'sha256:laptop', 'local',
        '["agents"]'::jsonb, now() + interval '1 day', now(),
        'rnr_11111111-1111-4111-8111-111111111111'
      ), (
        'ren_22222222-2222-4222-8222-222222222222', 'Messaging service',
        'sha256:messaging-token', null, 'deployment', null, 'messaging', 'sha256:messaging',
        'managed', '["browser", "messaging"]'::jsonb, now() + interval '1 day', now(),
        'rnr_22222222-2222-4222-8222-222222222222'
      );
    `.execute(scratch);
  });

  afterAll(async () => {
    await scratch?.destroy();
    await baseline?.destroy();
    for (const name of [scratchName, baselineName]) {
      await maintenance?.query(`drop database if exists ${name}`);
    }
    await maintenance?.end();
  });

  it("adds shell to every grant by set union and leaves the rest alone", async () => {
    await machineAccessMigration.up(scratch);

    const grants = await sql<{ allowedModules: string[]; id: string }>`
      select id, allowed_modules as "allowedModules" from public.runners order by id
    `.execute(scratch);
    expect(grants.rows).toEqual([
      { allowedModules: ["agents", "shell"], id: "rnr_11111111-1111-4111-8111-111111111111" },
      {
        allowedModules: ["browser", "messaging", "shell"],
        id: "rnr_22222222-2222-4222-8222-222222222222",
      },
    ]);
    const enrollments = await sql<{ allowedModules: string[]; id: string }>`
      select id, allowed_modules as "allowedModules" from public.runner_enrollments order by id
    `.execute(scratch);
    expect(enrollments.rows).toEqual([
      { allowedModules: ["agents", "shell"], id: "ren_11111111-1111-4111-8111-111111111111" },
      {
        allowedModules: ["browser", "messaging", "shell"],
        id: "ren_22222222-2222-4222-8222-222222222222",
      },
    ]);
  });

  it("starts every computer closed, at revision one", async () => {
    const policies = await sql<{ policy: unknown; revision: number }>`
      select access_policy as "policy", access_policy_revision as "revision"
      from public.runners order by id
    `.execute(scratch);
    expect(policies.rows).toEqual([
      {
        policy: { commands: false, forwarding: false, reach: "nobody", shares: [] },
        revision: 1,
      },
      {
        policy: { commands: false, forwarding: false, reach: "nobody", shares: [] },
        revision: 1,
      },
    ]);
  });

  it("keeps the agents-capacity invariant and admits no fifth module", async () => {
    await expect(
      sql`
        update public.runners set allowed_modules = '["shell"]'::jsonb
        where id = 'rnr_11111111-1111-4111-8111-111111111111'
      `.execute(scratch),
    ).rejects.toThrow(/runners_agents_capacity_check/u);
    await expect(
      sql`
        update public.runners
        set allowed_modules = '["agents", "browser", "messaging", "shell", "telepathy"]'::jsonb
        where id = 'rnr_11111111-1111-4111-8111-111111111111'
      `.execute(scratch),
    ).rejects.toThrow(/runners_allowed_modules_check/u);
    await expect(
      sql`
        update public.runner_enrollments set allowed_modules = '["telepathy"]'::jsonb
        where id = 'ren_11111111-1111-4111-8111-111111111111'
      `.execute(scratch),
    ).rejects.toThrow(/runner_enrollments_allowed_modules_check/u);
  });

  it("cascades a computer's audited requests with its sessions", async () => {
    await sql`
      insert into public.machine_access_sessions(
        id, runner_id, run_id, thread_id, requested_by, caller_runner_id, caller_machine_name,
        thread_title, policy_revision, state, started_at
      ) values (
        'shs_11111111-1111-4111-8111-111111111111',
        'rnr_11111111-1111-4111-8111-111111111111', 'run_1', 'thr_1',
        'usr_11111111-1111-4111-8111-111111111111',
        'rnr_22222222-2222-4222-8222-222222222222', 'Messaging service', 'Fix the deploy',
        1, 'pending', now()
      );
      insert into public.machine_access_events(session_id, at, event) values
        ('shs_11111111-1111-4111-8111-111111111111', now(),
         '{"kind": "exec", "channel": 0, "command": "gh pr list"}'::jsonb);
    `.execute(scratch);
    await expect(
      sql`
        update public.machine_access_sessions set state = 'finished'
        where id = 'shs_11111111-1111-4111-8111-111111111111'
      `.execute(scratch),
    ).rejects.toThrow(/machine_access_sessions_state_check/u);
    await sql`
      delete from public.machine_access_sessions
      where id = 'shs_11111111-1111-4111-8111-111111111111'
    `.execute(scratch);
    const remaining = await sql<{ count: string }>`
      select count(*) as count from public.machine_access_events
    `.execute(scratch);
    expect(remaining.rows[0]?.count).toBe("0");
  });

  it("is inert against a fresh baseline and matches it exactly", async () => {
    const constraintQuery = `select conrelid::regclass::text as table_name, conname,
         pg_get_constraintdef(oid) as definition
       from pg_constraint
       where connamespace = 'public'::regnamespace
         and conrelid in ('public.runners'::regclass, 'public.runner_enrollments'::regclass,
           'public.machine_access_sessions'::regclass, 'public.machine_access_events'::regclass)
       order by table_name, conname`;
    const before = (await sql.raw(constraintQuery).execute(baseline)).rows;

    await machineAccessMigration.up(baseline);
    await runnerDeviceMigration.up(baseline);
    await computerAppsMigration.up(scratch);
    // The shape the Runner describes arrived after this migration; it is
    // applied last so the scratch database reaches today's column order.
    await runnerDeviceMigration.up(scratch);

    expect((await sql.raw(constraintQuery).execute(baseline)).rows).toEqual(before);
    const queries = [
      constraintQuery,
      `select table_name, column_name, data_type, is_nullable,
         coalesce(column_default, '') as column_default
       from information_schema.columns
       where table_schema = 'public'
         and table_name in ('runners', 'runner_enrollments', 'machine_access_sessions',
           'machine_access_events')
       order by table_name, ordinal_position`,
      `select tablename, indexname, indexdef
       from pg_indexes
       where schemaname = 'public'
         and tablename in ('machine_access_sessions', 'machine_access_events')
       order by tablename, indexname`,
      `select sequencename from pg_sequences
       where schemaname = 'public' and sequencename = 'machine_access_events_id_seq'`,
    ];
    for (const query of queries) {
      expect((await sql.raw(query).execute(scratch)).rows).toEqual(
        (await sql.raw(query).execute(baseline)).rows,
      );
    }
  });
});

integration("advertised agents capacity migration", () => {
  const scratchName = `opensteer_agents_capacity_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let scratch: Kysely<DatabaseSchema>;

  function urlForDatabase(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlForDatabase("postgres") });
    await maintenance.query(`drop database if exists ${scratchName}`);
    await maintenance.query(`create database ${scratchName}`);
    scratch = createDatabase({ connectionString: urlForDatabase(scratchName) });
    await sql.raw(BASELINE_SCHEMA_SQL).execute(scratch);
    // The baseline is the post-migration shape, so the released one has to be
    // rebuilt: a grant of agents used to require a concurrency number.
    await sql`
      alter table public.runners
        drop constraint runners_agents_capacity_check,
        add constraint runners_agents_capacity_check check (
          (allowed_modules ? 'agents') = (max_concurrent_runs is not null)
        );
      insert into public.users(id, display_name, email)
        values ('usr_11111111-1111-4111-8111-111111111111', 'Owner', 'owner@example.test');
    `.execute(scratch);
  });

  afterAll(async () => {
    await scratch?.destroy();
    await maintenance?.query(`drop database if exists ${scratchName}`);
    await maintenance?.end();
  });

  it("lets a computer granted agents connect without advertising them", async () => {
    const insertRunner = (id: string, maxConcurrentRuns: number | null) =>
      sql`
      insert into public.runners(
        id, name, kind, owner_kind, owner_user_id, enrollment_token_hash,
        public_key_fingerprint, public_key_pem, allowed_modules,
        module_descriptors, max_concurrent_runs
      ) values (
        ${id}, 'Studio Mac', 'local', 'user',
        'usr_11111111-1111-4111-8111-111111111111',
        ${`sha256:${id}`}, ${`sha256:key-${id}`}, ${`pem-${id}`},
        '["agents","shell"]'::jsonb, '{}'::jsonb, ${maxConcurrentRuns}
      )
    `.execute(scratch);

    // Before: the grant alone demanded a number.
    await expect(insertRunner("rnr_11111111-1111-4111-8111-111111111111", null)).rejects.toThrow(
      /runners_agents_capacity_check/u,
    );

    await advertisedAgentsCapacityMigration.up(scratch);

    // After: a reach-only boot of a computer that may run agents records no
    // capacity, and one that never may still cannot record any.
    await expect(
      insertRunner("rnr_11111111-1111-4111-8111-111111111111", null),
    ).resolves.toBeDefined();
    await expect(
      sql`
        insert into public.runners(
          id, name, kind, owner_kind, owner_user_id, enrollment_token_hash,
          public_key_fingerprint, public_key_pem, allowed_modules,
          module_descriptors, max_concurrent_runs
        ) values (
          'rnr_22222222-2222-4222-8222-222222222222', 'Reach only', 'local',
          'user', 'usr_11111111-1111-4111-8111-111111111111', 'sha256:reach',
          'sha256:key-reach', 'pem-reach', '["shell"]'::jsonb, '{}'::jsonb, 4
        )
      `.execute(scratch),
    ).rejects.toThrow(/runners_agents_capacity_check/u);
  });
});

/**
 * 0025: executable paths leave harness profile configuration. A profile that
 * had one written into it (by hand, before the distribution named the
 * executables) would otherwise be rejected by the driver's strict schema.
 */
integration("harness executables from runtime migration", () => {
  const scratchName = `opensteer_harness_executables_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let scratch: Kysely<DatabaseSchema>;

  function urlForDatabase(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlForDatabase("postgres") });
    await maintenance.query(`drop database if exists ${scratchName}`);
    await maintenance.query(`create database ${scratchName}`);
    scratch = createDatabase({ connectionString: urlForDatabase(scratchName) });
    await sql.raw(BASELINE_SCHEMA_SQL).execute(scratch);
    await sql`
      insert into public.execution_environments(id, name, kind)
      values ('env_11111111-1111-4111-8111-111111111111', 'Main', 'main');
      insert into public.harness_instances(
        id, environment_id, driver_kind, name, config, state_kind, source_id
      )
      values (
        'hin_11111111-1111-4111-8111-111111111111', 'env_11111111-1111-4111-8111-111111111111',
        'codex', 'Codex', '{"executable": "/opt/tools/codex", "executableArgs": ["--flag"], "model": "gpt-5.6-sol"}'::jsonb,
        'ambient', 'openai'
      ), (
        'hin_22222222-2222-4222-8222-222222222222', 'env_11111111-1111-4111-8111-111111111111',
        'claude', 'Claude', '{"pathToClaudeCodeExecutable": "/opt/tools/claude"}'::jsonb,
        'isolated', 'anthropic'
      ), (
        'hin_33333333-3333-4333-8333-333333333333', 'env_11111111-1111-4111-8111-111111111111',
        'codex', 'Codex kept', '{"model": "gpt-5.6-luna"}'::jsonb, 'isolated', 'openai'
      );
      insert into public.harness_catalogs(environment_id, harness_instance_id, catalog)
      values
        ('env_11111111-1111-4111-8111-111111111111', 'hin_11111111-1111-4111-8111-111111111111', '{}'::jsonb),
        ('env_11111111-1111-4111-8111-111111111111', 'hin_33333333-3333-4333-8333-333333333333', '{}'::jsonb);
    `.execute(scratch);
  });

  afterAll(async () => {
    await scratch?.destroy();
    await maintenance?.query(`drop database if exists ${scratchName}`);
    await maintenance?.end();
  });

  it("strips executable paths as a configuration change and leaves the rest alone", async () => {
    await harnessExecutablesFromRuntimeMigration.up(scratch);

    const profiles = await sql<{ config: unknown; id: string; revision: number; touched: boolean }>`
      select id, config, runtime_revision as revision, updated_at > created_at as touched
      from public.harness_instances order by id
    `.execute(scratch);
    expect(profiles.rows).toEqual([
      {
        config: { model: "gpt-5.6-sol" },
        id: "hin_11111111-1111-4111-8111-111111111111",
        revision: 2,
        touched: true,
      },
      { config: {}, id: "hin_22222222-2222-4222-8222-222222222222", revision: 2, touched: true },
      {
        config: { model: "gpt-5.6-luna" },
        id: "hin_33333333-3333-4333-8333-333333333333",
        revision: 1,
        touched: false,
      },
    ]);
    const catalogs = await sql<{ id: string }>`
      select harness_instance_id as id from public.harness_catalogs order by 1
    `.execute(scratch);
    expect(catalogs.rows).toEqual([{ id: "hin_33333333-3333-4333-8333-333333333333" }]);
  });
});

/**
 * 0052: an account's model and reasoning defaults come from its engine. A
 * Claude Code or Codex profile that stored its own would otherwise be rejected
 * by the driver's strict schema.
 */
integration("harness model defaults from engine migration", () => {
  const scratchName = `opensteer_harness_model_defaults_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let scratch: Kysely<DatabaseSchema>;

  function urlForDatabase(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlForDatabase("postgres") });
    await maintenance.query(`drop database if exists ${scratchName}`);
    await maintenance.query(`create database ${scratchName}`);
    scratch = createDatabase({ connectionString: urlForDatabase(scratchName) });
    await sql.raw(BASELINE_SCHEMA_SQL).execute(scratch);
    await sql`
      insert into public.execution_environments(id, name, kind)
      values ('env_11111111-1111-4111-8111-111111111111', 'Main', 'main');
      insert into public.harness_instances(
        id, environment_id, driver_kind, name, config, state_kind, source_id
      )
      values (
        'hin_11111111-1111-4111-8111-111111111111', 'env_11111111-1111-4111-8111-111111111111',
        'codex', 'Codex', '{"model": "gpt-5.6-sol", "reasoningEffort": "high", "baseUrl": "https://gateway.example"}'::jsonb,
        'isolated', 'openai-compatible'
      ), (
        'hin_22222222-2222-4222-8222-222222222222', 'env_11111111-1111-4111-8111-111111111111',
        'claude', 'Claude', '{"model": "sonnet", "effort": "medium", "provider": "anthropic"}'::jsonb,
        'isolated', 'anthropic'
      ), (
        'hin_33333333-3333-4333-8333-333333333333', 'env_11111111-1111-4111-8111-111111111111',
        'claude', 'Claude kept', '{"maxTurns": 12}'::jsonb, 'ambient', 'anthropic'
      ), (
        'hin_44444444-4444-4444-8444-444444444444', 'env_11111111-1111-4111-8111-111111111111',
        'opencode', 'OpenCode', '{"model": "left to its own schema"}'::jsonb, 'isolated', 'anthropic'
      );
      insert into public.harness_catalogs(environment_id, harness_instance_id, catalog)
      values
        ('env_11111111-1111-4111-8111-111111111111', 'hin_11111111-1111-4111-8111-111111111111', '{}'::jsonb),
        ('env_11111111-1111-4111-8111-111111111111', 'hin_22222222-2222-4222-8222-222222222222', '{}'::jsonb),
        ('env_11111111-1111-4111-8111-111111111111', 'hin_33333333-3333-4333-8333-333333333333', '{}'::jsonb);
    `.execute(scratch);
  });

  afterAll(async () => {
    await scratch?.destroy();
    await maintenance?.query(`drop database if exists ${scratchName}`);
    await maintenance?.end();
  });

  it("strips stored model defaults as a configuration change and leaves the rest alone", async () => {
    await harnessModelDefaultsFromEngineMigration.up(scratch);

    const profiles = await sql<{ config: unknown; id: string; revision: number; touched: boolean }>`
      select id, config, runtime_revision as revision, updated_at > created_at as touched
      from public.harness_instances order by id
    `.execute(scratch);
    expect(profiles.rows).toEqual([
      {
        config: { baseUrl: "https://gateway.example" },
        id: "hin_11111111-1111-4111-8111-111111111111",
        revision: 2,
        touched: true,
      },
      {
        config: { provider: "anthropic" },
        id: "hin_22222222-2222-4222-8222-222222222222",
        revision: 2,
        touched: true,
      },
      {
        config: { maxTurns: 12 },
        id: "hin_33333333-3333-4333-8333-333333333333",
        revision: 1,
        touched: false,
      },
      {
        config: { model: "left to its own schema" },
        id: "hin_44444444-4444-4444-8444-444444444444",
        revision: 1,
        touched: false,
      },
    ]);
    const catalogs = await sql<{ id: string }>`
      select harness_instance_id as id from public.harness_catalogs order by 1
    `.execute(scratch);
    expect(catalogs.rows).toEqual([{ id: "hin_33333333-3333-4333-8333-333333333333" }]);

    await harnessModelDefaultsFromEngineMigration.up(scratch);
    const repeated = await sql<{ config: unknown; id: string; revision: number; touched: boolean }>`
      select id, config, runtime_revision as revision, updated_at > created_at as touched
      from public.harness_instances order by id
    `.execute(scratch);
    expect(repeated.rows).toEqual(profiles.rows);
  });
});

/**
 * 0026 makes both sides of the local/remote session distinction positive. The
 * old shape is rebuilt from the current baseline so a real old remote session
 * proves the cookie backfill, while an unrelated session proves the migration
 * does not infer that absence from the remote table means local presence.
 */
integration("positive machine-local sessions migration", () => {
  const scratchName = `opensteer_positive_local_sessions_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let scratch: Kysely<DatabaseSchema>;

  function urlForDatabase(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlForDatabase("postgres") });
    await maintenance.query(`drop database if exists ${scratchName}`);
    await maintenance.query(`create database ${scratchName}`);
    scratch = createDatabase({ connectionString: urlForDatabase(scratchName) });
    await sql.raw(BASELINE_SCHEMA_SQL).execute(scratch);
    await sql`
      drop table public.machine_local_sessions;
      alter table public.personal_remote_sessions
        drop constraint personal_remote_sessions_delivery_check,
        drop column delivery;

      insert into public.users(id, display_name, email) values
        ('usr_11111111-1111-4111-8111-111111111111', 'Owner', 'owner@example.test');
      insert into public.auth_sessions(
        id, user_id, token, expires_at, absolute_expires_at, device_label, last_seen_at
      ) values
        (
          'session-remote', 'usr_11111111-1111-4111-8111-111111111111', 'token-remote',
          now() + interval '1 hour', now() + interval '1 day', 'Remote browser', now()
        ),
        (
          'session-unclassified', 'usr_11111111-1111-4111-8111-111111111111',
          'token-unclassified', now() + interval '1 hour', now() + interval '1 day',
          'Existing browser', now()
        );
      insert into public.personal_remote_sessions(
        auth_session_id, route_kind, route_generation, route_origin
      ) values ('session-remote', 'connect', 3, 'https://home.connect.test');
    `.execute(scratch);
  });

  afterAll(async () => {
    await scratch?.destroy();
    await maintenance?.query(`drop database if exists ${scratchName}`);
    await maintenance?.end();
  });

  it("backfills old remote sessions as cookies without inferring a local session", async () => {
    await positiveMachineLocalSessionsMigration.up(scratch);

    const remote = await sql<{ readonly delivery: string }>`
      select delivery from public.personal_remote_sessions
      where auth_session_id = 'session-remote'
    `.execute(scratch);
    expect(remote.rows).toEqual([{ delivery: "cookie" }]);

    const local = await sql<{ readonly authSessionId: string }>`
      select auth_session_id as "authSessionId" from public.machine_local_sessions
    `.execute(scratch);
    expect(local.rows).toEqual([]);

    const deliveryColumn = await sql<{ readonly columnDefault: string | null }>`
      select column_default as "columnDefault" from information_schema.columns
      where table_schema = 'public'
        and table_name = 'personal_remote_sessions'
        and column_name = 'delivery'
    `.execute(scratch);
    expect(deliveryColumn.rows).toEqual([{ columnDefault: null }]);

    await sql`
      insert into public.machine_local_sessions(auth_session_id)
      values ('session-unclassified')
    `.execute(scratch);
    const explicit = await sql<{ readonly authSessionId: string }>`
      select auth_session_id as "authSessionId" from public.machine_local_sessions
    `.execute(scratch);
    expect(explicit.rows).toEqual([{ authSessionId: "session-unclassified" }]);
  });
});

/**
 * 0027 starts old Workspaces at their committed head so historical events stay
 * behind the notification window. Workspaces created after the migration use
 * the store's zero checkpoint, putting their first event inside that window.
 */
integration("notification outbox migration", () => {
  const scratchName = `opensteer_notification_outbox_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let scratch: Kysely<DatabaseSchema>;

  function urlForDatabase(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlForDatabase("postgres") });
    await maintenance.query(`drop database if exists ${scratchName}`);
    await maintenance.query(`create database ${scratchName}`);
    scratch = createDatabase({ connectionString: urlForDatabase(scratchName) });
    const migrated = await new Migrator({ db: scratch, provider: migrationProvider() }).migrateTo(
      "0026_positive_machine_local_sessions",
    );
    if (migrated.error) throw migrated.error;
    await sql`
      drop table public.notification_outbox;
      drop table public.notification_checkpoints;

      insert into public.users(id, display_name, email) values
        ('usr_22222222-2222-4222-8222-222222222222', 'Owner', 'owner@example.test');
      insert into public.workspaces(
        id, name, status, event_sequence, created_by, kind, backing, capacity_policy
      ) values (
        'wsp_22222222-2222-4222-8222-222222222222', 'Existing', 'ready', 7,
        'usr_22222222-2222-4222-8222-222222222222', 'main',
        '{"kind":"portablefs","serviceId":"test-portablefs","volumeId":"existing","generation":1}'::jsonb,
        '{"kind":"hard-quota","blockHardLimitBytes":10000000,"inodeHardLimit":10000}'::jsonb
      );
      insert into public.workspace_memberships(id, workspace_id, user_id, role, state) values (
        'wsm_22222222-2222-4222-8222-222222222222',
        'wsp_22222222-2222-4222-8222-222222222222',
        'usr_22222222-2222-4222-8222-222222222222', 'owner', 'active'
      );
    `.execute(scratch);
  });

  afterAll(async () => {
    await scratch?.destroy();
    await maintenance?.query(`drop database if exists ${scratchName}`);
    await maintenance?.end();
  });

  it("suppresses history at the historical migration and creates Workspaces after checkpoint removal", async () => {
    const migrated = await new Migrator({ db: scratch, provider: migrationProvider() }).migrateTo(
      "0027_notification_outbox",
    );
    if (migrated.error) throw migrated.error;
    expect(
      (await sql`select sequence::text from public.notification_checkpoints`.execute(scratch)).rows,
    ).toEqual([{ sequence: "7" }]);
    const outbox = await sql<{ readonly count: string }>`
      select count(*)::text as count from public.notification_outbox
    `.execute(scratch);
    expect(outbox.rows).toEqual([{ count: "0" }]);
    // Exercise the current store only after the remaining schema upgrades.
    await migrateToLatest(scratch);

    const store = new OpensteerStore(scratch);
    const created = await store.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: "created-after-notifications",
      },
      capacityPolicy: {
        blockHardLimitBytes: 10_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota",
      },
      createdBy: UserIdSchema.parse("usr_22222222-2222-4222-8222-222222222222"),
      idempotencyKey: "notification-migration-new-workspace",
      name: "Created after notifications",
      status: "ready",
    });

    expect(await store.getWorkspace(created.id)).toMatchObject({ id: created.id });
    const tables =
      await sql`select to_regclass('public.notification_checkpoints') as checkpoints, to_regclass('public.notifications') as notifications`.execute(
        scratch,
      );
    expect(tables.rows).toEqual([{ checkpoints: null, notifications: null }]);
  });
});

/**
 * The default is the answer to "which account of this engine?", so the two
 * things worth proving are that every pair a Deployment already has gets
 * exactly one, and that a seeded profile's name loses a suffix only when doing
 * so cannot collide with a name somebody chose.
 */
integration("default harness per driver migration", () => {
  const scratchName = `opensteer_default_harness_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const baselineName = `${scratchName}_baseline`;
  let maintenance: Pool;
  let scratch: Kysely<DatabaseSchema>;
  let baseline: Kysely<DatabaseSchema>;

  function urlForDatabase(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlForDatabase("postgres") });
    for (const name of [scratchName, baselineName]) {
      await maintenance.query(`drop database if exists ${name}`);
      await maintenance.query(`create database ${name}`);
    }
    scratch = createDatabase({ connectionString: urlForDatabase(scratchName) });
    baseline = createDatabase({ connectionString: urlForDatabase(baselineName) });
    await sql.raw(BASELINE_SCHEMA_SQL).execute(scratch);
    await sql.raw(BASELINE_SCHEMA_SQL).execute(baseline);
    // The baseline is the post-migration shape, so the pre-migration one is
    // rebuilt here: no column, no index, and the names the old seeding wrote.
    await sql`
      drop index public.harness_instances_one_default_per_driver;
      alter table public.harness_instances
        drop constraint harness_instances_source_id_check,
        drop column source_id,
        drop column is_default;

      insert into public.execution_environments(id, kind, name) values
        ('env_11111111-1111-4111-8111-111111111111', 'local', 'Laptop'),
        ('env_22222222-2222-4222-8222-222222222222', 'local', 'Desktop');
      insert into public.harness_instances(
        id, environment_id, driver_kind, name, config, state_kind, runtime_revision, enabled,
        created_at, removed_at
      ) values
        ('hin_11111111-1111-4111-8111-111111111111',
         'env_11111111-1111-4111-8111-111111111111', 'codex', 'Zulu account',
         '{}'::jsonb, 'ambient', 1, true, now() - interval '3 hours', null),
        ('hin_22222222-2222-4222-8222-222222222222',
         'env_11111111-1111-4111-8111-111111111111', 'codex', 'Alpha account',
         '{}'::jsonb, 'isolated', 1, true, now() - interval '2 hours', null),
        ('hin_33333333-3333-4333-8333-333333333333',
         'env_11111111-1111-4111-8111-111111111111', 'claude', 'Claude — Existing CLI',
         '{}'::jsonb, 'ambient', 1, true, now() - interval '1 hour', null),
        -- A retirement is a decision, so a tombstone never becomes the default
        -- and never blocks the live row that follows it.
        ('hin_44444444-4444-4444-8444-444444444444',
         'env_22222222-2222-4222-8222-222222222222', 'codex', 'Codex — Existing CLI',
         '{}'::jsonb, 'ambient', 1, false, now() - interval '5 hours', now()),
        ('hin_55555555-5555-4555-8555-555555555555',
         'env_22222222-2222-4222-8222-222222222222', 'codex', 'Bravo account',
         '{}'::jsonb, 'isolated', 1, true, now() - interval '4 hours', null),
        ('hin_66666666-6666-4666-8666-666666666666',
         'env_22222222-2222-4222-8222-222222222222', 'codex', 'Alpha account',
         '{}'::jsonb, 'isolated', 1, true, now() - interval '3 hours', null),
        -- Matching the legacy seeded text is not enough to rename a custom
        -- isolated account; only the old ambient seed is recognizable.
        ('hin_77777777-7777-4777-8777-777777777777',
         'env_22222222-2222-4222-8222-222222222222', 'claude', 'Claude — Existing CLI',
         '{}'::jsonb, 'isolated', 1, true, now() - interval '2 hours', null),
        -- Disabled accounts never become the default, even when their name was
        -- the first account in the old ordering.
        ('hin_88888888-8888-4888-8888-888888888888',
         'env_22222222-2222-4222-8222-222222222222', 'native', 'Alpha disabled',
         '{}'::jsonb, 'isolated', 1, false, now() - interval '2 hours', null),
        ('hin_99999999-9999-4999-8999-999999999999',
         'env_22222222-2222-4222-8222-222222222222', 'native', 'Bravo enabled',
         '{}'::jsonb, 'isolated', 1, true, now() - interval '1 hour', null);
    `.execute(scratch);
  });

  afterAll(async () => {
    await scratch?.destroy();
    await baseline?.destroy();
    for (const name of [scratchName, baselineName]) {
      await maintenance?.query(`drop database if exists ${name}`);
    }
    await maintenance?.end();
  });

  it("names one default per pair and renames only the seeded profiles it can", async () => {
    await defaultHarnessPerDriverMigration.up(scratch);

    const rows = await sql<{
      readonly id: string;
      readonly isDefault: boolean;
      readonly name: string;
    }>`
      select id, is_default as "isDefault", name from public.harness_instances order by id
    `.execute(scratch);
    expect(rows.rows).toEqual([
      {
        id: "hin_11111111-1111-4111-8111-111111111111",
        isDefault: false,
        name: "Zulu account",
      },
      {
        id: "hin_22222222-2222-4222-8222-222222222222",
        isDefault: true,
        name: "Alpha account",
      },
      { id: "hin_33333333-3333-4333-8333-333333333333", isDefault: true, name: "Claude Code" },
      {
        id: "hin_44444444-4444-4444-8444-444444444444",
        isDefault: false,
        name: "Codex — Existing CLI",
      },
      {
        id: "hin_55555555-5555-4555-8555-555555555555",
        isDefault: false,
        name: "Bravo account",
      },
      {
        id: "hin_66666666-6666-4666-8666-666666666666",
        isDefault: true,
        name: "Alpha account",
      },
      {
        id: "hin_77777777-7777-4777-8777-777777777777",
        isDefault: true,
        name: "Claude — Existing CLI",
      },
      {
        id: "hin_88888888-8888-4888-8888-888888888888",
        isDefault: false,
        name: "Alpha disabled",
      },
      {
        id: "hin_99999999-9999-4999-8999-999999999999",
        isDefault: true,
        name: "Bravo enabled",
      },
    ]);

    // The index is the authority: a second live default for one pair is refused
    // by the database, not only by the store.
    await expect(
      sql`
        update public.harness_instances set is_default = true
        where id = 'hin_11111111-1111-4111-8111-111111111111'
      `.execute(scratch),
    ).rejects.toThrow(/harness_instances_one_default_per_driver/);
    await expect(
      sql`
        update public.harness_instances set is_default = true
        where id = 'hin_88888888-8888-4888-8888-888888888888'
      `.execute(scratch),
    ).rejects.toThrow(/harness_instances_default_enabled_check/);
  });

  it("is inert against a fresh baseline and matches it exactly", async () => {
    const queries = [
      `select column_name, data_type, is_nullable, coalesce(column_default, '') as column_default
       from information_schema.columns
       where table_schema = 'public' and table_name = 'harness_instances'
       order by ordinal_position`,
      `select conname, pg_get_constraintdef(oid) as definition from pg_constraint
       where conrelid = 'public.harness_instances'::regclass order by conname`,
      `select indexname, indexdef from pg_indexes
       where schemaname = 'public' and tablename = 'harness_instances' order by indexname`,
    ];
    const before = [];
    for (const query of queries) before.push((await sql.raw(query).execute(baseline)).rows);

    await defaultHarnessPerDriverMigration.up(baseline);
    await harnessAccountSourcesMigration.up(scratch);

    for (const [index, query] of queries.entries()) {
      expect((await sql.raw(query).execute(baseline)).rows).toEqual(before[index]);
      expect((await sql.raw(query).execute(scratch)).rows).toEqual(before[index]);
    }
  });
});

integration("harness default lifecycle repair migration", () => {
  const scratchName = `opensteer_default_repair_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let scratch: Kysely<DatabaseSchema>;

  function urlForDatabase(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlForDatabase("postgres") });
    await maintenance.query(`drop database if exists ${scratchName}`);
    await maintenance.query(`create database ${scratchName}`);
    scratch = createDatabase({ connectionString: urlForDatabase(scratchName) });
    await sql.raw(BASELINE_SCHEMA_SQL).execute(scratch);
    // Reconstruct a database that recorded the original 0029: the column and
    // unique index exist, but disabled defaults were still legal.
    await sql`
      alter table public.harness_instances
        drop constraint harness_instances_default_enabled_check;
      insert into public.execution_environments(id, kind, name) values
        ('env_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'local', 'Laptop');
      insert into public.harness_instances(
        id, environment_id, driver_kind, name, config, state_kind,
        source_id, runtime_revision, enabled, is_default, created_at
      ) values
        -- A usable explicit choice survives the repair even though another
        -- enabled account sorts ahead of it.
        ('hin_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
         'env_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'codex', 'Zulu chosen',
         '{}'::jsonb, 'isolated', 'openai', 1, true, true, now() - interval '4 hours'),
        ('hin_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
         'env_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'codex', 'Alpha alternative',
         '{}'::jsonb, 'isolated', 'openai', 1, true, false, now() - interval '3 hours'),
        -- An unusable old default is cleared and the name-ranked enabled
        -- survivor becomes the replacement.
        ('hin_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
         'env_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'claude', 'Alpha disabled',
         '{}'::jsonb, 'isolated', 'anthropic', 1, false, true, now() - interval '2 hours'),
        ('hin_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
         'env_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'claude', 'Bravo enabled',
         '{}'::jsonb, 'isolated', 'anthropic', 1, true, false, now() - interval '1 hour'),
        -- A pair with no enabled accounts ends with no default.
        ('hin_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5',
         'env_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'native', 'Native disabled',
         '{}'::jsonb, 'isolated', 'native', 1, false, true, now());
    `.execute(scratch);
  });

  afterAll(async () => {
    await scratch?.destroy();
    await maintenance?.query(`drop database if exists ${scratchName}`);
    await maintenance?.end();
  });

  it("preserves a usable choice and repairs unusable or empty pairs", async () => {
    await harnessDefaultLifecycleMigration.up(scratch);
    await harnessDefaultLifecycleMigration.up(scratch);

    const rows = await sql<{
      readonly driverKind: string;
      readonly enabled: boolean;
      readonly isDefault: boolean;
      readonly name: string;
    }>`
      select driver_kind as "driverKind", enabled, is_default as "isDefault", name
      from public.harness_instances
      order by driver_kind, name
    `.execute(scratch);
    expect(rows.rows).toEqual([
      { driverKind: "claude", enabled: false, isDefault: false, name: "Alpha disabled" },
      { driverKind: "claude", enabled: true, isDefault: true, name: "Bravo enabled" },
      { driverKind: "codex", enabled: true, isDefault: false, name: "Alpha alternative" },
      { driverKind: "codex", enabled: true, isDefault: true, name: "Zulu chosen" },
      { driverKind: "native", enabled: false, isDefault: false, name: "Native disabled" },
    ]);

    await expect(
      sql`
        update public.harness_instances set is_default = true
        where name = 'Native disabled'
      `.execute(scratch),
    ).rejects.toThrow(/harness_instances_default_enabled_check/);
  });
});

/**
 * Messaging's shape change touches five tables at once, so what matters is
 * that a database carrying the old shape comes out able to hold the new one:
 * every selector, event and conversation row the Host now parses strictly
 * parses, a delivery can be addressed by ingress instead of conversation, a
 * link code belongs to an identity, and a connection on a transport that no
 * longer exists is revoked rather than quietly re-pointed.
 */
integration("messaging sender-pull linking migration", () => {
  const scratchName = `opensteer_messaging_sender_pull_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let scratch: Kysely<DatabaseSchema>;

  function urlForDatabase(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlForDatabase("postgres") });
    await maintenance.query(`drop database if exists ${scratchName}`);
    await maintenance.query(`create database ${scratchName}`);
    scratch = createDatabase({ connectionString: urlForDatabase(scratchName) });
    await sql.raw(BASELINE_SCHEMA_SQL).execute(scratch);
    // The baseline is the post-migration shape, so the pre-migration one is
    // rebuilt here: conversations that could be threads, deliveries with no
    // audience or parts and a mandatory conversation, link codes owned by a
    // user, and the webhook and device transports.
    await sql`
      alter table public.channel_conversations
        drop constraint channel_conversations_conversation_type_check,
        add constraint channel_conversations_conversation_type_check
          check (conversation_type = any (array['dm', 'group', 'channel', 'thread']));

      drop index public.channel_deliveries_message_reply_unique;
      drop index public.channel_deliveries_claimable;
      drop index public.channel_deliveries_retention;
      drop index public.channel_ingress_retention;
      alter table public.channel_deliveries
        drop constraint channel_deliveries_audience_check,
        drop constraint channel_deliveries_destination_check,
        drop constraint channel_deliveries_part_check,
        drop constraint channel_deliveries_kind_check,
        drop column audience,
        drop column part,
        drop column part_count,
        alter column conversation_id set not null,
        add constraint channel_deliveries_kind_check
          check (kind = any (array['reply', 'proactive', 'status']));
      create unique index channel_deliveries_message_reply_unique
        on public.channel_deliveries using btree (message_id)
        where ((kind = 'reply') and (message_id is not null));
      create index channel_deliveries_claimable
        on public.channel_deliveries using btree (next_attempt_at, created_at)
        where (status = any (array['pending', 'leased', 'retryable-failed']));

      drop index public.channel_link_codes_identity_live;
      alter table public.channel_link_codes
        drop constraint channel_link_codes_consumption_check,
        alter column user_id set not null,
        alter column identity_id drop not null,
        add constraint channel_link_codes_consumption_check
          check ((consumed_at is null) = (identity_id is null));

      alter table public.integration_connections
        drop constraint integration_connections_transport_kind_check,
        add constraint integration_connections_transport_kind_check
          check (transport_kind = any (array['webhook', 'socket', 'polling', 'device']));
    `.execute(scratch);
    await sql`
      insert into public.users(id, display_name, email) values
        ('usr_33333333-3333-4333-8333-333333333333', 'Owner', 'owner@messaging.test');
      insert into public.workspaces(
        id, name, status, event_sequence, created_by, kind, backing, capacity_policy
      ) values (
        'wsp_33333333-3333-4333-8333-333333333333', 'Messaging', 'ready', 0,
        'usr_33333333-3333-4333-8333-333333333333', 'main',
        '{"kind":"portablefs","serviceId":"test-portablefs","volumeId":"messaging","generation":1}'::jsonb,
        '{"kind":"hard-quota","blockHardLimitBytes":10000000,"inodeHardLimit":10000}'::jsonb
      );
      insert into public.workspace_memberships(id, workspace_id, user_id, role, state) values (
        'wsm_33333333-3333-4333-8333-333333333333',
        'wsp_33333333-3333-4333-8333-333333333333',
        'usr_33333333-3333-4333-8333-333333333333', 'owner', 'active'
      );
      insert into public.integration_connections(
        id, owner_user_id, provider, connection_method, status, display_name,
        connection_kind, transport_kind
      ) values
        ('ich_33333333-3333-4333-8333-333333333331', 'usr_33333333-3333-4333-8333-333333333333',
         'slack', 'bring-your-own', 'connected', 'Socket bot', 'channel', 'socket'),
        ('ich_33333333-3333-4333-8333-333333333332', 'usr_33333333-3333-4333-8333-333333333333',
         'slack', 'bring-your-own', 'connected', 'Webhook bot', 'channel', 'webhook');
      insert into public.channel_accounts(
        id, connection_id, provider, external_account_id, display_name, status
      ) values (
        'cha_33333333-3333-4333-8333-333333333331',
        'ich_33333333-3333-4333-8333-333333333331', 'slack', 'T-MIGRATE', 'Acme', 'connected'
      );
      insert into public.channel_bindings(
        id, account_id, workspace_id, created_by, selector, execution_policy, access_policy, status
      ) values (
        'chb_33333333-3333-4333-8333-333333333331',
        'cha_33333333-3333-4333-8333-333333333331',
        'wsp_33333333-3333-4333-8333-333333333333',
        'usr_33333333-3333-4333-8333-333333333333',
        '{"channelId":"C-MIGRATE","conversationId":null,"conversationType":"thread","scopeId":"T-MIGRATE","threadId":null}'::jsonb,
        '{"harness":"default","harnessInstanceId":null,"placement":"main"}'::jsonb,
        '{"allowedExternalUserIds":[],"mode":"anyone"}'::jsonb,
        'active'
      );
      insert into public.principals(id, kind, user_id, display_name) values
        ('pri_33333333-3333-4333-8333-333333333331', 'channel-identity', null, 'Ada');
      insert into public.channel_identities(
        id, account_id, principal_id, external_user_id, display_name, status
      ) values (
        'chd_33333333-3333-4333-8333-333333333331',
        'cha_33333333-3333-4333-8333-333333333331',
        'pri_33333333-3333-4333-8333-333333333331', 'U-ADA', 'Ada', 'unlinked'
      );
      insert into public.channel_conversations(
        id, account_id, binding_id, binding_revision, workspace_id, external_scope_id,
        external_conversation_id, external_thread_id, conversation_type, provider,
        external_account_id
      ) values (
        'chc_33333333-3333-4333-8333-333333333331',
        'cha_33333333-3333-4333-8333-333333333331',
        'chb_33333333-3333-4333-8333-333333333331', 1,
        'wsp_33333333-3333-4333-8333-333333333333', 'T-MIGRATE', 'C-MIGRATE',
        '1786320000.000100', 'thread', 'slack', 'T-MIGRATE'
      );
      insert into public.channel_ingress_events(
        id, account_id, provider_event_id, lane_key, event, status, received_at
      ) values (
        'chi_33333333-3333-4333-8333-333333333331',
        'cha_33333333-3333-4333-8333-333333333331', 'Ev-MIGRATE-1', 'lane',
        '{"accountExternalId":"T-MIGRATE","actor":{"displayName":"Ada","externalUserId":"U-ADA"},"content":[{"type":"text","text":"hello"}],"conversation":{"channelId":"C-MIGRATE","displayName":"migrate","externalConversationId":"C-MIGRATE","externalScopeId":"T-MIGRATE","externalThreadId":"1786320000.000100","type":"thread"},"eventId":"Ev-MIGRATE-1","kind":"message-created","occurredAt":"2026-01-01T00:00:00.000Z","provider":"slack","providerMessageId":"1786320000.000100","trigger":"mention"}'::jsonb,
        'pending', now()
      ),
      (
        'chi_33333333-3333-4333-8333-333333333332',
        'cha_33333333-3333-4333-8333-333333333331', 'Ev-MIGRATE-2', 'lane',
        '{"kind":"reaction-added"}'::jsonb, 'pending', now()
      );
      insert into public.channel_deliveries(
        id, account_id, conversation_id, kind, content, status
      ) values (
        'chx_33333333-3333-4333-8333-333333333331',
        'cha_33333333-3333-4333-8333-333333333331',
        'chc_33333333-3333-4333-8333-333333333331', 'proactive',
        '[{"type":"text","text":"old"}]'::jsonb, 'sent'
      );
      insert into public.channel_link_codes(id, account_id, user_id, code_hash, expires_at) values (
        'link_33333333-3333-4333-8333-333333333331',
        'cha_33333333-3333-4333-8333-333333333331',
        'usr_33333333-3333-4333-8333-333333333333', 'stale-hash', now() + interval '1 hour'
      );
    `.execute(scratch);
  });

  afterAll(async () => {
    await scratch?.destroy();
    await maintenance?.query(`drop database if exists ${scratchName}`);
    await maintenance?.end();
  });

  it("moves every messaging row onto the shape the Host now parses", async () => {
    await messagingSenderPullLinkingMigration.up(scratch);

    const binding = await sql<{ readonly selector: Readonly<Record<string, unknown>> }>`
      select selector from public.channel_bindings
      where id = 'chb_33333333-3333-4333-8333-333333333331'
    `.execute(scratch);
    expect(binding.rows[0]?.selector).toEqual({
      conversationId: "C-MIGRATE",
      conversationType: "channel",
      scopeId: "T-MIGRATE",
      threadId: null,
    });

    const conversation = await sql<{ readonly conversationType: string }>`
      select conversation_type as "conversationType" from public.channel_conversations
    `.execute(scratch);
    expect(conversation.rows).toEqual([{ conversationType: "channel" }]);

    const ingress = await sql<{
      readonly event: Readonly<Record<string, unknown>>;
      readonly id: string;
      readonly status: string;
    }>`
      select event, id, status from public.channel_ingress_events order by id
    `.execute(scratch);
    expect(ingress.rows[0]?.status).toBe("pending");
    expect(ingress.rows[0]?.event).toMatchObject({
      conversation: { externalConversationId: "C-MIGRATE", type: "channel" },
    });
    expect(ingress.rows[0]?.event).not.toHaveProperty("kind");
    expect(ingress.rows[0]?.event.conversation).not.toHaveProperty("channelId");
    // An event kind the Host no longer ingests never becomes a Run.
    expect(ingress.rows[1]?.status).toBe("ignored");

    const delivery = await sql<{
      readonly audience: string;
      readonly kind: string;
      readonly part: number;
      readonly partCount: number;
    }>`
      select audience, kind, part, part_count as "partCount" from public.channel_deliveries
    `.execute(scratch);
    expect(delivery.rows).toEqual([
      { audience: "conversation", kind: "status", part: 0, partCount: 1 },
    ]);

    // A status delivery can now answer an ingress that never became a
    // conversation, and only one of the two may name it.
    await sql`
      insert into public.channel_deliveries(
        id, account_id, ingress_id, kind, audience, content, status
      ) values (
        'chx_33333333-3333-4333-8333-333333333332',
        'cha_33333333-3333-4333-8333-333333333331',
        'chi_33333333-3333-4333-8333-333333333331', 'status', 'actor',
        '[{"type":"text","text":"link code"}]'::jsonb, 'pending'
      )
    `.execute(scratch);
    await expect(
      sql`
        insert into public.channel_deliveries(
          id, account_id, conversation_id, ingress_id, kind, audience, content, status
        ) values (
          'chx_33333333-3333-4333-8333-333333333333',
          'cha_33333333-3333-4333-8333-333333333331',
          'chc_33333333-3333-4333-8333-333333333331',
          'chi_33333333-3333-4333-8333-333333333331', 'status', 'actor',
          '[{"type":"text","text":"both"}]'::jsonb, 'pending'
        )
      `.execute(scratch),
    ).rejects.toThrow(/channel_deliveries_destination_check/u);

    // Codes minted under the old flow were never redeemable, so none survive
    // and a new one belongs to an identity with no user until it is consumed.
    const codes = await sql<{ readonly count: string }>`
      select count(*)::text as count from public.channel_link_codes
    `.execute(scratch);
    expect(codes.rows).toEqual([{ count: "0" }]);
    await sql`
      insert into public.channel_link_codes(id, account_id, identity_id, code_hash, expires_at)
      values (
        'link_33333333-3333-4333-8333-333333333332',
        'cha_33333333-3333-4333-8333-333333333331',
        'chd_33333333-3333-4333-8333-333333333331', 'fresh-hash', now() + interval '1 hour'
      )
    `.execute(scratch);

    const connections = await sql<{
      readonly id: string;
      readonly status: string;
      readonly transportKind: string;
    }>`
      select id, status, transport_kind as "transportKind"
      from public.integration_connections order by id
    `.execute(scratch);
    expect(connections.rows).toEqual([
      {
        id: "ich_33333333-3333-4333-8333-333333333331",
        status: "connected",
        transportKind: "socket",
      },
      {
        id: "ich_33333333-3333-4333-8333-333333333332",
        status: "revoked",
        transportKind: "socket",
      },
    ]);
  });
});

/**
 * Three keys nothing ever wrote leave the messaging tables: an identity's
 * `aliases`, its `blocked` status, and a binding's one-valued `placement`. The
 * Host parses both shapes strictly now, so a row that still carries one of them
 * would fail to parse rather than be ignored.
 */
integration("channel dead concepts migration", () => {
  const scratchName = `opensteer_channel_dead_concepts_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const baselineName = `opensteer_channel_dead_concepts_baseline_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let scratch: Kysely<DatabaseSchema>;
  let baseline: Kysely<DatabaseSchema>;

  function urlForDatabase(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlForDatabase("postgres") });
    for (const name of [scratchName, baselineName]) {
      await maintenance.query(`drop database if exists ${name}`);
      await maintenance.query(`create database ${name}`);
    }
    scratch = createDatabase({ connectionString: urlForDatabase(scratchName) });
    baseline = createDatabase({ connectionString: urlForDatabase(baselineName) });
    for (const database of [scratch, baseline]) {
      await sql.raw(BASELINE_SCHEMA_SQL).execute(database);
    }
    // The baseline is the post-migration shape, so the pre-migration one is
    // rebuilt here: an identity with aliases that could be blocked.
    await sql`
      alter table public.channel_identities
        drop constraint channel_identities_status_check,
        drop constraint channel_identities_link_shape,
        add column aliases jsonb default '[]'::jsonb not null,
        add constraint channel_identities_link_shape
          check (((status = 'linked') and (linked_user_id is not null))
            or ((status = any (array['unlinked', 'blocked'])) and (linked_user_id is null))),
        add constraint channel_identities_status_check
          check (status = any (array['unlinked', 'linked', 'blocked']));
    `.execute(scratch);
    await sql`
      insert into public.users(id, display_name, email)
        values ('usr_44444444-4444-4444-8444-444444444441', 'Route owner', 'dead@opensteer.test');
      insert into public.workspaces(
        id, name, kind, status, created_by, backing, capacity_policy
      ) values (
        'wsp_44444444-4444-4444-8444-444444444441', 'Routed', 'specialized', 'ready',
        'usr_44444444-4444-4444-8444-444444444441',
        '{"kind":"portablefs","generation":1,"serviceId":"test","volumeId":"vol_dead"}'::jsonb,
        '{"kind":"hard-quota","blockHardLimitBytes":1000,"inodeHardLimit":100}'::jsonb);
      insert into public.workspace_memberships(id, workspace_id, user_id, role, state) values (
        'wsm_44444444-4444-4444-8444-444444444441',
        'wsp_44444444-4444-4444-8444-444444444441',
        'usr_44444444-4444-4444-8444-444444444441', 'owner', 'active');
      insert into public.integration_connections(
        id, owner_user_id, provider, connection_method, status, display_name,
        connection_kind, transport_kind
      ) values (
        'ich_44444444-4444-4444-8444-444444444441',
        'usr_44444444-4444-4444-8444-444444444441',
        'slack', 'bring-your-own', 'connected', 'Socket bot', 'channel', 'socket');
      insert into public.channel_accounts(
        id, connection_id, provider, external_account_id, display_name, status
      ) values (
        'cha_44444444-4444-4444-8444-444444444441',
        'ich_44444444-4444-4444-8444-444444444441', 'slack', 'T-DEAD', 'Acme', 'connected');
      insert into public.channel_bindings(
        id, account_id, workspace_id, created_by, selector, execution_policy, access_policy, status
      ) values (
        'chb_44444444-4444-4444-8444-444444444441',
        'cha_44444444-4444-4444-8444-444444444441',
        'wsp_44444444-4444-4444-8444-444444444441',
        'usr_44444444-4444-4444-8444-444444444441',
        '{"conversationId":null,"conversationType":null,"scopeId":null,"threadId":null}'::jsonb,
        '{"harness":"default","harnessInstanceId":null,"placement":"main"}'::jsonb,
        '{"mode":"linked-members","allowedExternalUserIds":[]}'::jsonb, 'active');
      insert into public.principals(id, kind, display_name)
        values ('pri_44444444-4444-4444-8444-444444444441', 'channel-identity', 'Ada');
      insert into public.channel_identities(
        id, account_id, principal_id, external_user_id, display_name, aliases, status
      ) values (
        'chd_44444444-4444-4444-8444-444444444441',
        'cha_44444444-4444-4444-8444-444444444441',
        'pri_44444444-4444-4444-8444-444444444441',
        'U-ADA', 'Ada', '["ada"]'::jsonb, 'blocked');
    `.execute(scratch);
  });

  afterAll(async () => {
    await scratch?.destroy();
    await baseline?.destroy();
    for (const name of [scratchName, baselineName]) {
      await maintenance?.query(`drop database if exists ${name}`);
    }
    await maintenance?.end();
  });

  it("narrows an identity to linked-or-not and strips the one-valued placement", async () => {
    await channelDeadConceptsMigration.up(scratch);

    const identity = await sql<{ readonly status: string }>`
      select status from public.channel_identities
    `.execute(scratch);
    // A blocked identity was never written by anything; it comes back as what
    // it actually is, an identity nobody has linked.
    expect(identity.rows).toEqual([{ status: "unlinked" }]);
    await expect(
      sql`
        update public.channel_identities set status = 'blocked'
        where id = 'chd_44444444-4444-4444-8444-444444444441'
      `.execute(scratch),
    ).rejects.toThrow(/channel_identities_(status_check|link_shape)/u);

    const binding = await sql<{
      readonly executionPolicy: Readonly<Record<string, unknown>>;
    }>`
      select execution_policy as "executionPolicy" from public.channel_bindings
    `.execute(scratch);
    expect(binding.rows[0]?.executionPolicy).toEqual({
      harness: "default",
      harnessInstanceId: null,
    });
  });

  it("is inert against a fresh baseline and matches it exactly", async () => {
    const queries = [
      `select column_name, data_type, is_nullable, coalesce(column_default, '') as column_default
       from information_schema.columns
       where table_schema = 'public' and table_name = 'channel_identities'
       order by ordinal_position`,
      `select conname, pg_get_constraintdef(oid) as definition from pg_constraint
       where conrelid = 'public.channel_identities'::regclass order by conname`,
    ];
    const before = [];
    for (const query of queries) before.push((await sql.raw(query).execute(baseline)).rows);

    await channelDeadConceptsMigration.up(baseline);

    for (const [index, query] of queries.entries()) {
      expect((await sql.raw(query).execute(baseline)).rows).toEqual(before[index]);
      expect((await sql.raw(query).execute(scratch)).rows).toEqual(before[index]);
    }
  });
});

/**
 * 0035: what a Run consumed becomes a durable fact on the Run. The columns are
 * nullable because usage is the engine's evidence, not a Run property: an
 * engine that reports none leaves them empty and nothing is ever backfilled.
 */
integration("run usage accounting migration", () => {
  const scratchName = `opensteer_run_usage_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const baselineName = `opensteer_run_usage_baseline_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let scratch: Kysely<DatabaseSchema>;
  let baseline: Kysely<DatabaseSchema>;

  function urlForDatabase(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlForDatabase("postgres") });
    for (const name of [scratchName, baselineName]) {
      await maintenance.query(`drop database if exists ${name}`);
      await maintenance.query(`create database ${name}`);
    }
    scratch = createDatabase({ connectionString: urlForDatabase(scratchName) });
    baseline = createDatabase({ connectionString: urlForDatabase(baselineName) });
    for (const database of [scratch, baseline]) {
      await sql.raw(BASELINE_SCHEMA_SQL).execute(database);
    }
    // The baseline is the post-migration shape, so the released one is rebuilt
    // here: a Run said nothing at all about what it consumed.
    await sql`
      alter table public.runs
        drop constraint runs_usage_tokens_check,
        drop constraint runs_cost_usd_check,
        drop column input_tokens,
        drop column output_tokens,
        drop column cached_input_tokens,
        drop column cache_write_tokens,
        drop column reasoning_tokens,
        drop column cost_usd;
    `.execute(scratch);
  });

  afterAll(async () => {
    await scratch?.destroy();
    await baseline?.destroy();
    for (const name of [scratchName, baselineName]) {
      await maintenance?.query(`drop database if exists ${name}`);
    }
    await maintenance?.end();
  });

  it("adds every usage column as nullable evidence", async () => {
    await runUsageAccountingMigration.up(scratch);

    const columns = await sql<{
      readonly columnName: string;
      readonly dataType: string;
      readonly isNullable: string;
    }>`
      select column_name as "columnName", data_type as "dataType",
             is_nullable as "isNullable"
      from information_schema.columns
      where table_schema = 'public' and table_name = 'runs'
        and column_name in (
          'input_tokens', 'output_tokens', 'cached_input_tokens',
          'cache_write_tokens', 'reasoning_tokens', 'cost_usd'
        )
      order by ordinal_position
    `.execute(scratch);
    expect(columns.rows).toEqual([
      { columnName: "input_tokens", dataType: "bigint", isNullable: "YES" },
      { columnName: "output_tokens", dataType: "bigint", isNullable: "YES" },
      { columnName: "cached_input_tokens", dataType: "bigint", isNullable: "YES" },
      { columnName: "cache_write_tokens", dataType: "bigint", isNullable: "YES" },
      { columnName: "reasoning_tokens", dataType: "bigint", isNullable: "YES" },
      { columnName: "cost_usd", dataType: "numeric", isNullable: "YES" },
    ]);
  });

  it("is inert against a fresh baseline and matches it exactly", async () => {
    const queries = [
      `select column_name, data_type, is_nullable, coalesce(column_default, '') as column_default
       from information_schema.columns
       where table_schema = 'public' and table_name = 'runs'
       order by ordinal_position`,
      `select conname, pg_get_constraintdef(oid) as definition from pg_constraint
       where conrelid = 'public.runs'::regclass order by conname`,
    ];
    const before = [];
    for (const query of queries) before.push((await sql.raw(query).execute(baseline)).rows);

    await runUsageAccountingMigration.up(baseline);

    for (const [index, query] of queries.entries()) {
      expect((await sql.raw(query).execute(baseline)).rows).toEqual(before[index]);
      expect((await sql.raw(query).execute(scratch)).rows).toEqual(before[index]);
    }
  });
});

integration("user execution preferences migration", () => {
  const scratchName = `opensteer_user_execution_preferences_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const baselineName = `opensteer_user_execution_preferences_baseline_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let scratch: Kysely<DatabaseSchema>;
  let baseline: Kysely<DatabaseSchema>;

  function urlForDatabase(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlForDatabase("postgres") });
    for (const name of [scratchName, baselineName]) {
      await maintenance.query(`drop database if exists ${name}`);
      await maintenance.query(`create database ${name}`);
    }
    scratch = createDatabase({ connectionString: urlForDatabase(scratchName) });
    baseline = createDatabase({ connectionString: urlForDatabase(baselineName) });
    for (const database of [scratch, baseline]) {
      await sql.raw(BASELINE_SCHEMA_SQL).execute(database);
    }
    // The baseline is the post-migration shape, so the released one is rebuilt
    // here: nobody's execution choices were the Host's to keep.
    await sql`drop table public.user_execution_preferences`.execute(scratch);
  });

  afterAll(async () => {
    await scratch?.destroy();
    await baseline?.destroy();
    for (const name of [scratchName, baselineName]) {
      await maintenance?.query(`drop database if exists ${name}`);
    }
    await maintenance?.end();
  });

  it("cascades a person's remembered choices away with their account", async () => {
    await userExecutionPreferencesMigration.up(scratch);

    const userId = UserIdSchema.parse(`usr_${randomUUID()}`);
    await sql`
      insert into public.users(id, display_name, email)
      values (${userId}, 'Alex', 'alex@example.com')
    `.execute(scratch);
    await sql`
      insert into public.user_execution_preferences(user_id, preferences)
      values (${userId}, '{"accessMode":"full-access","history":[]}'::jsonb)
    `.execute(scratch);
    // The principal mirror holds users back with RESTRICT, so it goes first;
    // what is being proved here is that the preference row does not.
    await sql`delete from public.principals where user_id = ${userId}`.execute(scratch);
    await sql`delete from public.users where id = ${userId}`.execute(scratch);

    const remaining = await sql<{ readonly count: string }>`
      select count(*)::text as count from public.user_execution_preferences
    `.execute(scratch);
    expect(remaining.rows).toEqual([{ count: "0" }]);
  });

  it("is inert against a fresh baseline and matches it exactly", async () => {
    const queries = [
      `select column_name, data_type, is_nullable, coalesce(column_default, '') as column_default
       from information_schema.columns
       where table_schema = 'public' and table_name = 'user_execution_preferences'
       order by ordinal_position`,
      `select conname, pg_get_constraintdef(oid) as definition from pg_constraint
       where conrelid = 'public.user_execution_preferences'::regclass order by conname`,
    ];
    const before = [];
    for (const query of queries) before.push((await sql.raw(query).execute(baseline)).rows);

    await userExecutionPreferencesMigration.up(baseline);

    for (const [index, query] of queries.entries()) {
      expect((await sql.raw(query).execute(baseline)).rows).toEqual(before[index]);
      expect((await sql.raw(query).execute(scratch)).rows).toEqual(before[index]);
    }
  });
});

integration("unified integration access migration", () => {
  const databaseName = `opensteer_unified_integration_access_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let database: Kysely<DatabaseSchema>;

  function urlForDatabase(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlForDatabase("postgres") });
    await maintenance.query(`drop database if exists ${databaseName}`);
    await maintenance.query(`create database ${databaseName}`);
    database = createDatabase({ connectionString: urlForDatabase(databaseName) });
    await sql`
      create table public.integration_connections (id text primary key);
      create table public.integration_installations (
        id text primary key, source_kind text not null, provenance jsonb not null,
        status text not null, revision integer not null, updated_at timestamptz not null
      );
      create table public.commands (
        id text primary key, type text not null, status text not null,
        updated_at timestamptz not null, last_error jsonb
      );
      create table public.requests (
        id text primary key, kind text not null, payload jsonb not null,
        status text not null default 'pending', cancellation_reason text,
        resolved_at timestamptz, resolved_by text, response jsonb, response_command_id text
      );
      create table public.request_continuations (request_id text primary key);
      create table public.integration_request_details (
        request_id text primary key,
        installation_id text,
        requested_server_id text,
        manifest jsonb,
        access text
      );
      create table public.workspace_events (id text primary key, type text not null, data jsonb not null);
      insert into public.integration_installations(
        id, source_kind, provenance, status, revision, updated_at
      ) values
        ('iin_slack_mcp', 'built-in', '{"definitionId":"slack-mcp"}', 'active', 4, now()),
        ('iin_slack', 'built-in', '{"definitionId":"slack"}', 'active', 2, now()),
        ('iin_custom', 'proposed', '{"artifactDigest":"custom"}', 'active', 3, now());
      insert into public.requests(id, kind, payload, status) values
        ('request-access', 'integration.access', '{"kind":"integration.access","installationId":"iin_existing","requestedServerId":null,"access":"read","reason":"Read records"}'::jsonb, 'pending'),
        ('request-other', 'browser.access', '{"kind":"browser.access","reason":"Browse"}'::jsonb, 'pending'),
        ('request-slack', 'integration.access', '{"kind":"integration.access","installationId":"iin_slack_mcp","requestedServerId":"isv_slack","access":"read","reason":"Read Slack"}'::jsonb, 'pending'),
        ('request-slack-history', 'integration.access', '{"kind":"integration.access","installationId":"iin_slack_mcp","requestedServerId":"isv_slack","access":"read","reason":"Read Slack"}'::jsonb, 'fulfilled'),
        ('request-custom', 'integration.access', '{"kind":"integration.access","installationId":"iin_custom","requestedServerId":null,"access":"read","reason":"Read custom"}'::jsonb, 'pending');
      insert into public.integration_request_details(
        request_id, installation_id, requested_server_id, manifest, access
      ) values
        ('request-access', 'iin_existing', null, null, 'read'),
        ('request-slack', 'iin_slack_mcp', 'isv_slack', '{"reviewed":true}', 'read'),
        ('request-slack-history', 'iin_slack_mcp', 'isv_slack', '{"reviewed":true}', 'read'),
        ('request-custom', 'iin_custom', null, '{"custom":true}', 'read');
      insert into public.request_continuations(request_id) values ('request-slack');
      insert into public.workspace_events(id, type, data) values
        ('opened', 'request.opened', '{"request":{"kind":"integration.access","payload":{"kind":"integration.access","installationId":"iin_existing","requestedServerId":null,"access":"read","reason":"Read records"}}}'::jsonb),
        ('resolved', 'request.resolved', '{"request":{"kind":"integration.access","payload":{"kind":"integration.access","installationId":"iin_existing","requestedServerId":null,"access":"read","reason":"Read records"}}}'::jsonb),
        ('other', 'request.opened', '{"request":{"kind":"browser.access","payload":{"kind":"browser.access","reason":"Browse"}}}'::jsonb);
    `.execute(database);
  });

  afterAll(async () => {
    await database?.destroy();
    await maintenance?.query(`drop database if exists ${databaseName}`);
    await maintenance?.end();
  });

  it("widens legacy access details and rewrites every durable Request snapshot", async () => {
    await unifiedIntegrationAccessMigration.up(database);
    const requests = await sql<{ readonly id: string; readonly payload: unknown }>`
      select id, payload from public.requests
      where id in ('request-access', 'request-other')
      order by id
    `.execute(database);
    expect(requests.rows).toEqual([
      {
        id: "request-access",
        payload: expect.objectContaining({ manifest: null, requestedConnectionId: null }),
      },
      { id: "request-other", payload: { kind: "browser.access", reason: "Browse" } },
    ]);
    const snapshots = await sql<{ readonly id: string; readonly payload: unknown }>`
      select id, data #> '{request,payload}' as payload
      from public.workspace_events order by id
    `.execute(database);
    expect(snapshots.rows).toEqual([
      {
        id: "opened",
        payload: expect.objectContaining({ manifest: null, requestedConnectionId: null }),
      },
      { id: "other", payload: { kind: "browser.access", reason: "Browse" } },
      {
        id: "resolved",
        payload: expect.objectContaining({ manifest: null, requestedConnectionId: null }),
      },
    ]);
    const columns = await sql<{ readonly columnName: string; readonly isNullable: string }>`
      select column_name as "columnName", is_nullable as "isNullable"
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'integration_request_details'
        and column_name = 'requested_connection_id'
    `.execute(database);
    expect(columns.rows).toEqual([{ columnName: "requested_connection_id", isNullable: "YES" }]);

    const installations = await sql<{
      readonly id: string;
      readonly revision: number;
      readonly status: string;
    }>`select id, revision, status from public.integration_installations order by id`.execute(
      database,
    );
    expect(installations.rows).toEqual([
      { id: "iin_custom", revision: 3, status: "active" },
      { id: "iin_slack", revision: 2, status: "active" },
      { id: "iin_slack_mcp", revision: 5, status: "disabled" },
    ]);
    const retiredRequests = await sql<{
      readonly cancellationReason: string | null;
      readonly id: string;
      readonly installationId: string | null;
      readonly manifest: unknown;
      readonly status: string;
    }>`
      select request_row.id, request_row.status,
        request_row.cancellation_reason as "cancellationReason",
        detail.installation_id as "installationId", detail.manifest
      from public.requests request_row
      join public.integration_request_details detail on detail.request_id = request_row.id
      where request_row.id in ('request-custom', 'request-slack', 'request-slack-history')
      order by request_row.id
    `.execute(database);
    expect(retiredRequests.rows).toEqual([
      {
        cancellationReason: null,
        id: "request-custom",
        installationId: "iin_custom",
        manifest: { custom: true },
        status: "pending",
      },
      {
        cancellationReason: "authority-revoked",
        id: "request-slack",
        installationId: "iin_slack_mcp",
        manifest: { reviewed: true },
        status: "cancelled",
      },
      {
        cancellationReason: null,
        id: "request-slack-history",
        installationId: "iin_slack_mcp",
        manifest: { reviewed: true },
        status: "fulfilled",
      },
    ]);
    await expect(
      sql`select request_id from public.request_continuations where request_id = 'request-slack'`.execute(
        database,
      ),
    ).resolves.toMatchObject({ rows: [] });
  });
});

integration("integration reasons migration", () => {
  const databaseName = `opensteer_integration_reasons_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const before = new Date("2026-10-01T00:00:00.000Z");
  const oldOAuthReason =
    "This OAuth API requires administrator-authored declarative identity configuration";
  const oldReconnectReason = "The integration authorization changed; reconnect this account.";
  let maintenance: Pool;
  let database: Kysely<DatabaseSchema>;

  function urlForDatabase(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  // As 0040 left a Deployment: Slack MCP turned off, its servers as they were.
  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlForDatabase("postgres") });
    await maintenance.query(`drop database if exists ${databaseName}`);
    await maintenance.query(`create database ${databaseName}`);
    database = createDatabase({ connectionString: urlForDatabase(databaseName) });
    await sql`
      create table public.integration_installations (
        id text primary key, source_kind text not null, provenance jsonb not null,
        status text not null
      );
      create table public.integration_servers (
        id text primary key, installation_id text not null, status text not null,
        status_detail text, updated_at timestamptz not null
      );
      create table public.integration_connections (
        id text primary key, status_detail text, updated_at timestamptz not null
      );
      insert into public.integration_installations(id, source_kind, provenance, status) values
        ('iin_slack_mcp', 'built-in', '{"definitionId":"slack-mcp"}', 'disabled'),
        ('iin_slack', 'built-in', '{"definitionId":"slack"}', 'active'),
        ('iin_gmail', 'proposed', '{"artifactDigest":"gmail"}', 'needs-attention'),
        ('iin_custom', 'proposed', '{"artifactDigest":"custom"}', 'active');
    `.execute(database);
    await sql`
      insert into public.integration_servers(
        id, installation_id, status, status_detail, updated_at
      ) values
        ('isv_slack', 'iin_slack_mcp', 'active', null, ${before}),
        ('isv_slack_dropped', 'iin_slack_mcp', 'disabled', null, ${before}),
        ('isv_slack_standard', 'iin_slack', 'active', null, ${before}),
        ('isv_gmail', 'iin_gmail', 'needs-attention', ${oldOAuthReason}, ${before}),
        ('isv_gmail_dropped', 'iin_gmail', 'disabled', ${oldOAuthReason}, ${before}),
        ('isv_custom', 'iin_custom', 'needs-attention',
          'Waiting for approval on the computer that runs it.', ${before})
    `.execute(database);
    await sql`
      insert into public.integration_connections(id, status_detail, updated_at) values
        ('con_changed', ${oldReconnectReason}, ${before}),
        ('con_expiry', 'The provider token expiry is invalid; reconnect this account.', ${before}),
        ('con_connected', null, ${before})
    `.execute(database);
  });

  afterAll(async () => {
    await database?.destroy();
    await maintenance?.query(`drop database if exists ${databaseName}`);
    await maintenance?.end();
  });

  async function reasons() {
    const servers = await sql<{
      readonly id: string;
      readonly status: string;
      readonly statusDetail: string | null;
      readonly updatedAt: Date;
    }>`
      select id, status, status_detail as "statusDetail", updated_at as "updatedAt"
      from public.integration_servers order by id
    `.execute(database);
    const connections = await sql<{
      readonly id: string;
      readonly statusDetail: string | null;
      readonly updatedAt: Date;
    }>`
      select id, status_detail as "statusDetail", updated_at as "updatedAt"
      from public.integration_connections order by id
    `.execute(database);
    return { connections: connections.rows, servers: servers.rows };
  }

  // The ways it could fail: the retired preset still giving no reason, or one
  // on a server nobody sees; its servers turned off, hiding the reason; a
  // reason written onto standard Slack; an old reason that names no way out
  // left as it was, or rewritten on a disabled server; any other stored
  // reason or status rewritten; a second run rewriting what the first did.
  it("gives the reasons it stored, or never stored, a cause and a next step", async () => {
    await integrationReasonsMigration.up(database);
    const first = await reasons();
    const changed = expect.any(Date);
    expect(first.servers).toEqual([
      {
        id: "isv_custom",
        status: "needs-attention",
        statusDetail: "Waiting for approval on the computer that runs it.",
        updatedAt: before,
      },
      {
        id: "isv_gmail",
        status: "needs-attention",
        statusDetail:
          "Opensteer can’t set up this service’s sign-in from an agent’s proposal. Uninstall it, then add the service from Add a service if it’s listed there.",
        updatedAt: changed,
      },
      {
        id: "isv_gmail_dropped",
        status: "disabled",
        statusDetail: oldOAuthReason,
        updatedAt: before,
      },
      {
        id: "isv_slack",
        status: "active",
        statusDetail: "Opensteer no longer supports Slack MCP. Uninstall it and use Slack instead.",
        updatedAt: changed,
      },
      { id: "isv_slack_dropped", status: "disabled", statusDetail: null, updatedAt: before },
      { id: "isv_slack_standard", status: "active", statusDetail: null, updatedAt: before },
    ]);
    expect(first.connections).toEqual([
      {
        id: "con_changed",
        statusDetail:
          "Opensteer changed how this service connects. Reconnect this account to keep using it.",
        updatedAt: changed,
      },
      { id: "con_connected", statusDetail: null, updatedAt: before },
      {
        id: "con_expiry",
        statusDetail: "The provider token expiry is invalid; reconnect this account.",
        updatedAt: before,
      },
    ]);
    expect(
      [...first.servers, ...first.connections]
        .filter(({ updatedAt }) => updatedAt > before)
        .map(({ id }) => id),
    ).toEqual(["isv_gmail", "isv_slack", "con_changed"]);

    await integrationReasonsMigration.up(database);
    expect(await reasons()).toEqual(first);
  });
  it("checks for a replacement before uninstalling, changing exact stored reasons only", async () => {
    await integrationReasonsMigration.up(database);
    const old =
      "Opensteer can’t set up this service’s sign-in from an agent’s proposal. Uninstall it, then add the service from Add a service if it’s listed there.";
    const replacement =
      "Opensteer can’t set up this service’s sign-in from an agent’s proposal. Add the service from Add a service if it’s listed there, then uninstall this one.";
    await sql`update public.integration_servers set status_detail = ${old + " Custom advice."} where id = 'isv_custom'`.execute(
      database,
    );
    const beforeRewrite = await reasons();
    const migration = (await migrationProvider().getMigrations())[
      "0094_integration_proposal_reason"
    ];
    expect(migration).toBeDefined();
    if (!migration) throw new Error("Missing proposal reason migration");
    await migration.up(database);
    const first = await reasons();
    expect(first.servers.find(({ id }) => id === "isv_gmail")).toMatchObject({
      statusDetail: replacement,
      status: "needs-attention",
    });
    expect(first.servers.filter(({ id }) => id !== "isv_gmail")).toEqual(
      beforeRewrite.servers.filter(({ id }) => id !== "isv_gmail"),
    );
    expect(first.connections).toEqual(beforeRewrite.connections);
    await migration.up(database);
    expect(await reasons()).toEqual(first);
  });
});

integration.sequential("integration tool targets migration", () => {
  const scratchName = `opensteer_tool_targets_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const baselineName = `${scratchName}_baseline`;
  let maintenance: Pool;
  let scratch: Kysely<DatabaseSchema>;
  let baseline: Kysely<DatabaseSchema>;

  function urlForDatabase(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  // As 0.1.131 left integration_tools: no target, and a name unique across every status.
  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlForDatabase("postgres") });
    for (const name of [scratchName, baselineName]) {
      await maintenance.query(`drop database if exists ${name}`);
      await maintenance.query(`create database ${name}`);
    }
    scratch = createDatabase({ connectionString: urlForDatabase(scratchName) });
    baseline = createDatabase({ connectionString: urlForDatabase(baselineName) });
    await sql.raw(BASELINE_SCHEMA_SQL).execute(scratch);
    await sql.raw(BASELINE_SCHEMA_SQL).execute(baseline);
    await sql`
      alter table public.integration_tools
        drop constraint integration_tools_target_check,
        drop column target;
      drop index public.integration_tools_server_connection_name;
      create unique index integration_tools_server_connection_name
        on public.integration_tools (server_id, connection_id, name) nulls not distinct;
    `.execute(scratch);
  });

  afterAll(async () => {
    await scratch?.destroy();
    await baseline?.destroy();
    for (const name of [scratchName, baselineName]) {
      await maintenance?.query(`drop database if exists ${name}`);
    }
    await maintenance?.end();
  });

  // The ways it could fail: a shape that differs from a fresh baseline; a
  // second run, or a run on a fresh baseline, that fails or changes it; a name
  // still held by a tool that is gone.
  it("adds the target and leaves a name to the active tool, matching a fresh baseline", async () => {
    const queries = [
      `select conname, pg_get_constraintdef(oid) as definition from pg_constraint
       where conrelid = 'public.integration_tools'::regclass order by conname`,
      `select column_name, data_type, is_nullable, coalesce(column_default, '') as column_default
       from information_schema.columns
       where table_schema = 'public' and table_name = 'integration_tools'
       order by ordinal_position`,
      `select indexname, indexdef from pg_indexes
       where schemaname = 'public' and tablename = 'integration_tools' order by indexname`,
    ];
    for (const migrated of [scratch, scratch, baseline]) {
      await integrationToolTargetsMigration.up(migrated);
      for (const query of queries) {
        expect((await sql.raw(query).execute(scratch)).rows).toEqual(
          (await sql.raw(query).execute(baseline)).rows,
        );
      }
    }
    const indexes = await sql<{ indexdef: string }>`
      select indexdef from pg_indexes where indexname = 'integration_tools_server_connection_name'
    `.execute(scratch);
    expect(indexes.rows[0]?.indexdef).toContain("WHERE (status = 'active'::text)");
  });
});

integration.sequential("thread report queue migration", () => {
  const databaseName = `opensteer_thread_report_queue_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let database: Kysely<DatabaseSchema>;

  function urlForDatabase(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlForDatabase("postgres") });
    await maintenance.query(`drop database if exists ${databaseName}`);
    await maintenance.query(`create database ${databaseName}`);
    database = createDatabase({ connectionString: urlForDatabase(databaseName) });
    await sql`
      create table public.thread_inputs (
        message_id text primary key, thread_id text not null, policy text not null,
        state text not null default 'pending', run_id text, steer_command_id text,
        delivered_at timestamptz, cancel_reason text, requested_by text,
        authority_source jsonb not null, request_fingerprint text not null,
        constraint thread_inputs_policy_check check (policy = any(array['queue', 'trigger'])),
        constraint thread_inputs_state_shape_check check (
          (state = 'pending' and run_id is null and steer_command_id is null and delivered_at is null and cancel_reason is null)
          or (state = 'claimed' and run_id is not null and delivered_at is null and cancel_reason is null)
          or (state = 'delivered' and run_id is not null and delivered_at is not null and cancel_reason is null)
          or (state = 'unknown' and run_id is not null and steer_command_id is not null and delivered_at is null and cancel_reason is null)
          or (state = 'cancelled' and delivered_at is null and cancel_reason is not null)
        )
      );
      create table public.messages (id text primary key, content jsonb not null);
      create table public.users (id text primary key);
      create table public.threads (id text primary key);
      create table public.runs (id text primary key, thread_id text not null, seed_input_id text not null);
      create table public.workspace_events (id text primary key, data jsonb not null);
      insert into public.users(id) values ('user');
      insert into public.threads(id) values ('thread-a');
      insert into public.messages(id, content) values
        ('platform', '[{"text":"platform","type":"text"}]'),
        ('report', '[{"type":"text","text":"report"}]'),
        ('steer', '[{"type":"text","text":"steer"}]'),
        ('work', '[{"type":"text","text":"work"}]');
      insert into public.thread_inputs(message_id, thread_id, policy, state, run_id, steer_command_id, authority_source, request_fingerprint) values
        ('platform', 'thread-a', 'queue', 'pending', null, null, '{"kind":"platform","cause":"delegation-completed","referenceId":"ref","sourceRunId":"source-run","userId":"user"}', 'old-platform'),
        ('report', 'thread-a', 'queue', 'pending', null, null, '{"kind":"workspace-membership","userId":"user"}', 'old-report'),
        ('steer', 'thread-a', 'queue', 'unknown', 'run-active', 'command-steer', '{"kind":"thread-agent","runId":"origin","threadId":"origin-thread","userId":"user"}', 'old-steer'),
        ('work', 'thread-a', 'trigger', 'pending', null, null, '{"kind":"trigger-occurrence","occurrenceId":"occurrence","userId":"user"}', 'old-work');
      insert into public.runs(id, thread_id, seed_input_id) values ('historical-report-run', 'thread-a', 'report');
      insert into public.workspace_events(id, data) values
        ('report-event', '{"input":{"messageId":"report","policy":"queue"}}'),
        ('steer-event', '{"input":{"messageId":"steer","policy":"queue"}}'),
        ('work-event', '{"input":{"messageId":"work","policy":"trigger"}}'),
        ('unrelated-event', '{"input":{"messageId":"missing","policy":"queue"}}'),
        ('thread-event', '{"thread":{"id":"thread-a"}}');
    `.execute(database);
    await threadReportQueueMigration.up(database);
  });

  afterAll(async () => {
    await database?.destroy();
    await maintenance?.query(`drop database if exists ${databaseName}`);
    await maintenance?.end();
  });

  it("maps legacy policy and rewrites durable snapshots", async () => {
    const inputs = await sql<{ messageId: string; policy: string; requestFingerprint: string }>`
      select message_id as "messageId", policy, request_fingerprint as "requestFingerprint"
      from public.thread_inputs order by message_id
    `.execute(database);
    expect(inputs.rows).toEqual([
      {
        messageId: "platform",
        policy: "report",
        requestFingerprint: createHash("sha256")
          .update(
            JSON.stringify({
              content: [{ type: "text", text: "platform" }],
              policy: "report",
              source: {
                kind: "platform",
                cause: "delegation-completed",
                referenceId: "ref",
                sourceRunId: "source-run",
              },
              threadId: "thread-a",
            }),
          )
          .digest("base64url"),
      },
      {
        messageId: "report",
        policy: "report",
        requestFingerprint: createHash("sha256")
          .update(
            JSON.stringify({
              content: [{ type: "text", text: "report" }],
              policy: "report",
              source: { kind: "human" },
              threadId: "thread-a",
            }),
          )
          .digest("base64url"),
      },
      { messageId: "steer", policy: "steer", requestFingerprint: expect.any(String) },
      { messageId: "work", policy: "queue", requestFingerprint: expect.any(String) },
    ]);
    const events = await sql<{ id: string; policy: string | null }>`
      select id, data #>> '{input,policy}' as policy from public.workspace_events order by id
    `.execute(database);
    expect(events.rows).toEqual([
      { id: "report-event", policy: "report" },
      { id: "steer-event", policy: "steer" },
      { id: "thread-event", policy: null },
      { id: "unrelated-event", policy: "queue" },
      { id: "work-event", policy: "queue" },
    ]);
    await expect(
      sql`select data #> '{thread,inputQueuePaused}' as paused
          from public.workspace_events where id = 'thread-event'`.execute(database),
    ).resolves.toMatchObject({ rows: [{ paused: false }] });
    const work = await sql<{ messageId: string }>`
      select message_id as "messageId" from public.thread_work_inputs
    `.execute(database);
    expect(work.rows).toEqual([{ messageId: "work" }]);
  });

  it("adds queue pause and validates report context", async () => {
    const threadResult = await sql<{ inputQueuePaused: boolean }>`
      select input_queue_paused as "inputQueuePaused" from public.threads where id = 'thread-a'
    `.execute(database);
    const thread = threadResult.rows[0]!;
    expect(thread.inputQueuePaused).toBe(false);
    await expect(
      sql`update public.runs set report_context = '{"messageIds":["report"],"omittedCount":2,"throughSequence":"42"}' where id = 'historical-report-run'`.execute(
        database,
      ),
    ).resolves.toBeDefined();
    await expect(
      sql`update public.runs set report_context = '{"messageIds":[],"omittedCount":-1,"throughSequence":null}' where id = 'historical-report-run'`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      sql`update public.thread_inputs set state = 'unknown', run_id = 'attempted-run'
          where message_id = 'report'`.execute(database),
    ).resolves.toBeDefined();
  });

  it("preserves historical runs and admits only queued work as a new seed", async () => {
    await expect(
      sql`insert into public.runs values ('new-report-run', 'thread-a', 'report')`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      sql`insert into public.runs values ('new-steer-run', 'thread-a', 'steer')`.execute(database),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      sql`insert into public.runs(id, thread_id, seed_input_id) values ('new-work-run', 'thread-a', 'work')`.execute(
        database,
      ),
    ).resolves.toBeDefined();
    const historicalResult = await sql<{
      count: string;
    }>`select count(*)::text as count from public.runs where id = 'historical-report-run'`.execute(
      database,
    );
    const historical = historicalResult.rows[0]!;
    expect(historical.count).toBe("1");
  });
});

integration.sequential("computer app identity migration", () => {
  const databaseName = `opensteer_computer_app_identity_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let database: Kysely<DatabaseSchema>;

  function urlForDatabase(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlForDatabase("postgres") });
    await maintenance.query(`drop database if exists ${databaseName}`);
    await maintenance.query(`create database ${databaseName}`);
    database = createDatabase({ connectionString: urlForDatabase(databaseName) });
    // A fresh Deployment: the whole released chain, then the app identity on
    // top of it, which is the shape every new database starts life in.
    await migrateToLatest(database);
    await sql`
      insert into public.users(id, display_name, email) values
        ('usr_90000000-0000-4000-8000-000000000001', 'Mac owner', 'apps@opensteer.test');
      insert into public.runners(
        id, name, kind, owner_kind, owner_user_id, public_key_pem, public_key_fingerprint,
        enrollment_token_hash, allowed_modules, capabilities, module_descriptors,
        access_policy, access_policy_revision, connection_generation, enrolled_at
      ) values (
        'rnr_90000000-0000-4000-8000-000000000001', 'Alex''s Mac', 'local', 'user',
        'usr_90000000-0000-4000-8000-000000000001', 'pem', 'sha256:key', 'sha256:token',
        '["integrations"]'::jsonb, '[]'::jsonb, '{}'::jsonb,
        '{"commands":false,"forwarding":false,"reach":"nobody","shares":[]}'::jsonb,
        1, 0, now()
      );
      insert into public.integration_installations(
        id, name, title, description, source_kind, trust, manifest, provenance, status, revision
      ) values (
        'ins_90000000-0000-4000-8000-000000000001', 'macos-app', 'Computer use',
        'One app on an enrolled Mac', 'built-in', 'built-in',
        '{"definition":{"id":"macos-app"}}'::jsonb,
        '{"definitionId":"macos-app","maintainedBy":"opensteer"}'::jsonb, 'active', 1
      );
      insert into public.integration_servers(
        id, installation_id, name, transport, status, connection_requirement
      ) values (
        'isv_90000000-0000-4000-8000-000000000001',
        'ins_90000000-0000-4000-8000-000000000001', 'default',
        '{"type":"computer","definitionId":"macos-app"}'::jsonb, 'active',
        '{"kind":"computer","definitionId":"macos-app"}'::jsonb
      );
    `.execute(database);
  });

  afterAll(async () => {
    await database.destroy();
    await maintenance.query(`drop database if exists ${databaseName}`);
    await maintenance.end();
  });

  function connectionValues(id: string, app: string | null, key: string | null): string {
    return `(
      '${id}', 'usr_90000000-0000-4000-8000-000000000001', 'apple', 'computer', 'connected',
      'Alex''s Mac', 'computer', 'read', 'macos-app', 'isv_90000000-0000-4000-8000-000000000001',
      'computer', 'rnr_90000000-0000-4000-8000-000000000001',
      ${app === null ? "null" : `'${app}'::jsonb`}, ${key === null ? "null" : `'${key}'`},
      '[]'::jsonb, '[]'::jsonb
    )`;
  }

  async function insertConnection(id: string, app: string | null, key: string | null) {
    return sql
      .raw(
        `insert into public.integration_connections(
          id, owner_user_id, provider, connection_method, status, display_name,
          connection_kind, computer_access, integration_definition_id, integration_server_id,
          auth_method_id, runner_id, computer_app, computer_app_key, capabilities, granted_scopes
        ) values ${connectionValues(id, app, key)}`,
      )
      .execute(database);
  }

  it("keys live computer connections by the app and leaves app-less ones their own slot", async () => {
    const indexes = await sql<{ definition: string; name: string }>`
      select indexname as name, indexdef as definition from pg_indexes
      where indexname in (
        'integration_connections_computer_live_unique',
        'computer_app_setup_requests_app_unique'
      )
      order by indexname
    `.execute(database);
    expect(indexes.rows.map(({ definition }) => definition)).toEqual([
      expect.stringContaining("(runner_id, definition_id, kind, COALESCE(app_key, ''::text))"),
      expect.stringContaining(
        "(integration_definition_id, runner_id, COALESCE(computer_app_key, ''::text))",
      ),
    ]);
    // The pre-computer-use unique constraint is gone with its narrower key.
    await expect(
      sql<{ count: string }>`
        select count(*)::text as count from pg_constraint
        where conrelid = 'public.computer_app_setup_requests'::regclass
          and conname = 'computer_app_setup_requests_runner_id_definition_id_key'
      `.execute(database),
    ).resolves.toMatchObject({ rows: [{ count: "0" }] });

    const notes = '{"bundleId":"com.apple.Notes","displayName":"Notes","teamId":null}';
    await expect(
      insertConnection("con_90000000-0000-4000-8000-000000000001", notes, "com.apple.notes"),
    ).resolves.toBeDefined();
    await expect(
      insertConnection(
        "con_90000000-0000-4000-8000-000000000002",
        '{"bundleId":"com.apple.iCal","displayName":"Calendar","teamId":null}',
        "com.apple.ical",
      ),
    ).resolves.toBeDefined();
    // One bundle id is one connection, whatever case the second spelling used.
    await expect(
      insertConnection(
        "con_90000000-0000-4000-8000-000000000003",
        '{"bundleId":"COM.APPLE.NOTES","displayName":"NOTES","teamId":null}',
        "com.apple.notes",
      ),
    ).rejects.toMatchObject({ code: "23505" });
    // An app-less computer connection still gets exactly one row per definition.
    await expect(
      insertConnection("con_90000000-0000-4000-8000-000000000004", null, null),
    ).resolves.toBeDefined();
    await expect(
      insertConnection("con_90000000-0000-4000-8000-000000000005", null, null),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("keeps the identity and its key together, and off every other kind of connection", async () => {
    const notes = '{"bundleId":"com.apple.Notes","displayName":"Notes","teamId":null}';
    await expect(
      insertConnection("con_90000000-0000-4000-8000-000000000011", notes, null),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      insertConnection("con_90000000-0000-4000-8000-000000000012", null, "com.apple.notes"),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      sql`
        insert into public.integration_connections(
          id, owner_user_id, provider, connection_method, status, display_name,
          connection_kind, transport_kind, computer_app, computer_app_key,
          capabilities, granted_scopes
        ) values (
          'con_90000000-0000-4000-8000-000000000013',
          'usr_90000000-0000-4000-8000-000000000001', 'slack', 'bring-your-own', 'connected',
          'Socket bot', 'channel', 'socket',
          '{"bundleId":"com.apple.Notes","displayName":"Notes","teamId":null}'::jsonb,
          'com.apple.notes', '[]'::jsonb, '[]'::jsonb
        )
      `.execute(database),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      sql`
        insert into public.computer_app_setup_requests(
          id, deployment_id, owner_user_id, runner_id, definition_id, definition_digest,
          access, app, app_key, created_at, expires_at
        ) values (
          '00000000-0000-4000-8000-000000000001', 'dep_pairing',
          'usr_90000000-0000-4000-8000-000000000001',
          'rnr_90000000-0000-4000-8000-000000000001', 'macos-app', 'digest', 'read',
          '{"bundleId":"com.apple.Notes","displayName":"Notes","teamId":null}'::jsonb,
          null, now(), now() + interval '7 days'
        )
      `.execute(database),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("admits computer.app.access as a durable Request kind and nothing else", async () => {
    const checks = await sql<{ definition: string; name: string }>`
      select conname as name, pg_get_constraintdef(oid) as definition from pg_constraint
      where conrelid = 'public.requests'::regclass and conname like 'requests_kind%check'
      order by conname
    `.execute(database);
    const kind = checks.rows.find(({ name }) => name === "requests_kind_check");
    const mode = checks.rows.find(({ name }) => name === "requests_kind_mode_check");
    expect(kind?.definition).toContain("'computer.app.access'::text");
    // Widening kept every kind that was already admitted.
    expect(kind?.definition).toContain("'browser.profile.import'::text");
    expect(kind?.definition).toContain("'integration.install'::text");
    expect(mode?.definition).toContain("'computer.app.access'::text");
    expect(mode?.definition).toMatch(
      /'computer\.app\.access'::text\]\)\) AND \(mode = 'durable'::text\)/u,
    );
  });
});

integration.sequential("browser sign-ins migration", () => {
  const databaseName = `opensteer_browser_sign_ins_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let database: Kysely<DatabaseSchema>;
  // The outbox as 0055 left it: 0084 later replaces the table altogether.
  let outboxAfterSignIns: readonly { readonly count: string }[] = [];
  const importRequest = {
    presentation: {
      detail: "Use my login",
      kind: "external",
      subject: { id: "bsr_44444444-4444-4444-8444-444444444444", kind: "browser-source" },
      title: "Use Chrome login",
    },
    payload: {
      kind: "browser.profile.import",
      reason: "Use my login",
      site: "https://example.com",
      sourceId: "bsr_44444444-4444-4444-8444-444444444444",
      sourceName: "Chrome",
    },
  };

  function urlFor(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlFor("postgres") });
    await maintenance.query(`drop database if exists ${databaseName}`);
    await maintenance.query(`create database ${databaseName}`);
    database = createDatabase({ connectionString: urlFor(databaseName), maxConnections: 1 });
    const migrated = await new Migrator({
      db: database,
      provider: migrationProvider(),
    }).migrateTo("0054_browser_sources_restoration");
    if (migrated.error) throw migrated.error;

    // v1 rows as a released 0.1.97 Host left them. Relationship triggers are
    // suppressed so the fixture needs no Runner or Trigger program.
    await sql`set session_replication_role = replica`.execute(database);
    try {
      await sql`
        insert into public.execution_environments(id, name, kind)
        values ('env_99999999-9999-4999-8999-999999999999', 'Migration', 'managed');
        insert into public.users(id, display_name, email)
        values ('usr_00000000-0000-4000-8000-000000000001', 'Owner', 'owner@example.com');
        insert into public.principals(id, kind, user_id, display_name)
        values ('pri_fixture', 'user', 'usr_00000000-0000-4000-8000-000000000001', 'Owner');
        insert into public.harness_instances(id, environment_id, driver_kind, name, config, state_kind, source_id)
        values ('hai_fixture', 'env_99999999-9999-4999-8999-999999999999', 'codex', 'Codex', '{}', 'isolated', 'openai');
        insert into public.workspaces(
          id, name, status, created_by, kind, backing, capacity_policy
        ) values (
          'wsp_00000000-0000-4000-8000-000000000002', 'Origin', 'ready', 'usr_00000000-0000-4000-8000-000000000001', 'specialized',
          '{"kind":"portablefs","serviceId":"test","volumeId":"origin","generation":1}',
          '{"kind":"hard-quota","blockHardLimitBytes":1000000,"inodeHardLimit":1000}'
        );
        insert into public.threads(
          id, workspace_id, title, environment_id, harness_instance_id, created_by,
          capability_profile_id, created_by_principal_id, model_selection, lineage_root_thread_id
        ) values (
          'thr_00000000-0000-4000-8000-000000000003', 'wsp_00000000-0000-4000-8000-000000000002', 'Origin',
          'env_99999999-9999-4999-8999-999999999999', 'hai_fixture', 'usr_00000000-0000-4000-8000-000000000001',
          'workspace', 'pri_fixture',
          '{"providerId":"openai","modelId":"test","options":{}}', 'thr_00000000-0000-4000-8000-000000000003'
        );
        insert into public.provider_sessions(
          id, thread_id, harness_instance_id, runner_id, runner_boot_id,
          binding_generation, lease_token_hash, lease_expires_at, status, active
        ) values (
          'psn_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          'thr_00000000-0000-4000-8000-000000000003', 'hai_fixture',
          'rnr_fixture', 'legacy-boot', 1, 'legacy-token', now() + interval '1 hour',
          'ready', true
        );
        insert into public.runs(
          id, thread_id, environment_id, harness_instance_id, requested_by,
          run_ordinal, status, started_at, completed_at, actor_principal_id,
          authority_source, model_selection, membership_generation, access_mode,
          activation_input_id, causal_chain_id, seed_input_id
        ) values (
          'run_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          'thr_00000000-0000-4000-8000-000000000003',
          'env_99999999-9999-4999-8999-999999999999', 'hai_other',
          'usr_00000000-0000-4000-8000-000000000001', 0, 'completed', now(), now(),
          'pri_fixture', '{}', '{"providerId":"openai","modelId":"test","options":{}}',
          1, 'full-access', 'msg_fixture', 'cch_fixture', 'msg_fixture'
        );
        insert into public.trigger_occurrences(
          id, trigger_id, revision_id, command_id, environment_id, source_key, event, status
        ) values (
          'toc_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'trg_fixture', 'trv_fixture',
          'cmd_fixture', 'env_99999999-9999-4999-8999-999999999999', 'fixture', '{}', 'pending'
        );
        insert into public.browser_sources(id, owner_id, name, token_hash)
        values ('bsr_44444444-4444-4444-8444-444444444444', 'usr_00000000-0000-4000-8000-000000000001', 'Chrome', repeat('b', 64));
        insert into public.browser_source_pairings(
          code_hash, owner_id, expires_at, canonical_origin
        ) values
          (repeat('c', 64), 'usr_00000000-0000-4000-8000-000000000001', now() + interval '5 minutes', 'https://host.test'),
          (repeat('d', 64), 'usr_00000000-0000-4000-8000-000000000001', now() + interval '5 minutes', 'https://host.test');
        update public.browser_source_pairings set consumed_at = now() where code_hash = repeat('d', 64);
        insert into public.browser_source_grants(id, source_id, workspace_id, site, access, created_by)
        values (
          '77777777-7777-4777-8777-777777777777', 'bsr_44444444-4444-4444-8444-444444444444',
          'wsp_00000000-0000-4000-8000-000000000002', 'https://example.com', 'import', 'usr_00000000-0000-4000-8000-000000000001'
        );
        insert into public.browser_profiles(id, owner_id, name, revision)
        values ('bpf_11111111-1111-4111-8111-111111111111', 'usr_00000000-0000-4000-8000-000000000001', 'Copied', 1);
      `.execute(database);
      await sql`
        insert into public.requests(
          id, kind, mode, status, originating_workspace_id, originating_thread_id,
          originating_occurrence_id, call_id, target_workspace_id, requested_by, required_actor,
          presentation, payload, response, resolved_at, resolved_by
        ) values
          (
            'req_33333333-3333-4333-8333-333333333333', 'browser.profile.import', 'durable',
            'pending', 'wsp_00000000-0000-4000-8000-000000000002', 'thr_00000000-0000-4000-8000-000000000003', 'toc_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'pending-import', 'wsp_00000000-0000-4000-8000-000000000002', 'usr_00000000-0000-4000-8000-000000000001', 'requester',
            ${JSON.stringify(importRequest.presentation)}::jsonb,
            ${JSON.stringify(importRequest.payload)}::jsonb, null, null, null
          ),
          (
            'req_55555555-5555-4555-8555-555555555555', 'browser.profile.import', 'durable',
            'fulfilled', 'wsp_00000000-0000-4000-8000-000000000002', 'thr_00000000-0000-4000-8000-000000000003', 'toc_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'finished-import', 'wsp_00000000-0000-4000-8000-000000000002', 'usr_00000000-0000-4000-8000-000000000001', 'requester',
            ${JSON.stringify(importRequest.presentation)}::jsonb,
            ${JSON.stringify(importRequest.payload)}::jsonb,
            '{"kind":"external","value":{"decision":"fulfilled","profileId":"bpf_11111111-1111-4111-8111-111111111111"}}'::jsonb,
            now(), 'usr_00000000-0000-4000-8000-000000000001'
          )
      `.execute(database);
      await sql`
        insert into public.browser_source_imports(
          id, source_id, workspace_id, owner_id, site, profile_name, remember, profile_id, request_id
        ) values (
          '88888888-8888-4888-8888-888888888888', 'bsr_44444444-4444-4444-8444-444444444444',
          'wsp_00000000-0000-4000-8000-000000000002', 'usr_00000000-0000-4000-8000-000000000001', 'https://example.com', 'Copied', false,
          'bpf_11111111-1111-4111-8111-111111111111', 'req_55555555-5555-4555-8555-555555555555'
        );
        insert into public.notification_outbox(
          id, workspace_id, sequence, event_id, thread_id, request_id, kind,
          recipient_account_ids, occurred_at, expires_at
        ) values (
          'not_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'wsp_00000000-0000-4000-8000-000000000002', 1, 'evt_fixture',
          'thr_00000000-0000-4000-8000-000000000003', 'req_33333333-3333-4333-8333-333333333333', 'request-opened',
          '["acct_fixture"]', now(), now() + interval '1 day'
        );
      `.execute(database);
    } finally {
      await sql`set session_replication_role = origin`.execute(database);
    }
    const signIns = await new Migrator({
      db: database,
      provider: migrationProvider(),
    }).migrateTo("0055_browser_sign_ins");
    if (signIns.error) throw signIns.error;
    outboxAfterSignIns = (
      await sql<{ count: string }>`
        select count(*)::text as count from public.notification_outbox
      `.execute(database)
    ).rows;
    await migrateToLatest(database);
  });

  afterAll(async () => {
    await database?.destroy();
    await maintenance?.query(`drop database if exists ${databaseName}`);
    await maintenance?.end();
  });

  it("retires v1 authority and answers a pending copy Request with a continuation", async () => {
    const legacyRun = await database
      .selectFrom("runs")
      .select("providerSessionId")
      .where("id", "=", "run_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as RunId)
      .executeTakeFirstOrThrow();
    expect(legacyRun.providerSessionId).toBeNull();
    const sources = await sql<{ generation: number; revoked: boolean; lastSeenAt: Date | null }>`
      select generation, revoked_at is not null as revoked, last_seen_at as "lastSeenAt"
      from public.browser_sources
    `.execute(database);
    expect(sources.rows).toEqual([{ generation: 2, revoked: true, lastSeenAt: null }]);
    expect(
      (
        await sql<{ name: string | null }>`
        select to_regclass('public.browser_source_grants')::text as name
      `.execute(database)
      ).rows,
    ).toEqual([{ name: null }]);
    expect(
      (
        await sql<{ codeHash: string }>`
        select code_hash as "codeHash" from public.browser_source_pairings
      `.execute(database)
      ).rows,
    ).toEqual([{ codeHash: "d".repeat(64) }]);

    const requests = await sql<{
      id: string;
      status: string;
      response: unknown;
      resolvedBy: string | null;
    }>`
      select id, status, response, resolved_by as "resolvedBy"
      from public.requests order by id
    `.execute(database);
    expect(requests.rows).toEqual([
      {
        id: "req_33333333-3333-4333-8333-333333333333",
        resolvedBy: "usr_00000000-0000-4000-8000-000000000001",
        response: {
          kind: "external",
          value: { decision: "declined", replacedBy: "browser.sign-in" },
        },
        status: "declined",
      },
      {
        id: "req_55555555-5555-4555-8555-555555555555",
        resolvedBy: "usr_00000000-0000-4000-8000-000000000001",
        response: {
          kind: "external",
          value: {
            decision: "fulfilled",
            profileId: "bpf_11111111-1111-4111-8111-111111111111",
          },
        },
        status: "fulfilled",
      },
    ]);
    const continuations = await sql<{ requestId: string; status: string }>`
      select request_id as "requestId", status from public.request_continuations
    `.execute(database);
    expect(continuations.rows).toEqual([
      { requestId: "req_33333333-3333-4333-8333-333333333333", status: "waiting" },
    ]);
    const events = await sql<{ type: string; data: { request: unknown } }>`
      select type, data from public.workspace_events order by sequence
    `.execute(database);
    expect(events.rows.map(({ type }) => type)).toEqual(["request.resolved"]);
    expect(RequestSchema.parse(events.rows[0]?.data.request)).toMatchObject({
      id: "req_33333333-3333-4333-8333-333333333333",
      status: "declined",
    });
    expect(outboxAfterSignIns).toEqual([{ count: "0" }]);
    expect(
      (
        await sql<{ count: string }>`
        select count(*)::text as count from public.browser_source_imports
      `.execute(database)
      ).rows,
    ).toEqual([{ count: "0" }]);
  });

  it("accepts the sign-in Request kind and agent action", async () => {
    await sql`
      insert into public.requests(
        id, kind, mode, status, originating_workspace_id, originating_thread_id,
        originating_occurrence_id, call_id, target_workspace_id, requested_by, required_actor,
        presentation, payload
      ) values (
        'req_66666666-6666-4666-8666-666666666666', 'browser.sign-in', 'durable', 'pending',
        'wsp_00000000-0000-4000-8000-000000000002', 'thr_00000000-0000-4000-8000-000000000003', 'toc_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'sign-in',
        'wsp_00000000-0000-4000-8000-000000000002', 'usr_00000000-0000-4000-8000-000000000001', 'requester', '{}', '{}'
      )
    `.execute(database);
    await expect(
      sql`
        insert into public.requests(
          id, kind, mode, status, originating_workspace_id, originating_thread_id,
          originating_occurrence_id, call_id, target_workspace_id, requested_by, required_actor,
          presentation, payload
        ) values (
          'req_77777777-7777-4777-8777-777777777777', 'browser.sign-in', 'live', 'pending',
          'wsp_00000000-0000-4000-8000-000000000002', 'thr_00000000-0000-4000-8000-000000000003', 'toc_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'live-sign-in',
          'wsp_00000000-0000-4000-8000-000000000002', 'usr_00000000-0000-4000-8000-000000000001', 'requester', '{}', '{}'
        )
      `.execute(database),
    ).rejects.toMatchObject({ code: "23514" });
    const checks = await sql<{ name: string; definition: string }>`
      select conname as name, pg_get_constraintdef(oid) as definition from pg_constraint
      where conname in (
        'agent_control_requests_action_check', 'agent_control_requests_action_class_check',
        'trigger_control_requests_action_check', 'trigger_control_requests_action_class_check'
      )
    `.execute(database);
    expect(checks.rows).toHaveLength(4);
    for (const check of checks.rows) expect(check.definition).toContain("'browser.sign-in'::text");
  });
});

integration.sequential("thread input queue order migration", () => {
  const databaseName = `opensteer_thread_input_queue_order_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let database: Kysely<DatabaseSchema>;

  function urlFor(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlFor("postgres") });
    await maintenance.query(`drop database if exists ${databaseName}`);
    await maintenance.query(`create database ${databaseName}`);
    database = createDatabase({ connectionString: urlFor(databaseName), maxConnections: 1 });
    const migrated = await new Migrator({
      db: database,
      provider: migrationProvider(),
    }).migrateTo("0055_browser_sign_ins");
    if (migrated.error) throw migrated.error;

    // Inputs as a released 0.1.98 Host left them, waiting in the order they
    // were sent. Relationship triggers are suppressed so the fixture needs no
    // Workspace, Run or principal.
    await sql`set session_replication_role = replica`.execute(database);
    try {
      await sql`
        insert into public.messages(id, thread_id, content, actor_principal_id, sequence, kind, author)
        values
          ('msg-first', 'thr-order', '[{"type":"text","text":"first"}]', 'pri', 4, 'input', '{"kind":"human"}'),
          ('msg-reply', 'thr-order', '[{"type":"text","text":"reply"}]', 'pri', 5, 'assistant', '{"kind":"agent"}'),
          ('msg-second', 'thr-order', '[{"type":"text","text":"second"}]', 'pri', 7, 'input', '{"kind":"human"}');
        insert into public.thread_inputs(
          message_id, thread_id, policy, state, requested_by, actor_principal_id,
          authority_source, membership_generation, causal_chain_id, idempotency_key,
          request_fingerprint
        ) values
          ('msg-second', 'thr-order', 'queue', 'pending', 'usr', 'pri',
            '{"kind":"workspace-membership","userId":"usr"}', 1, 'chain', 'second', 'second'),
          ('msg-first', 'thr-order', 'queue', 'pending', 'usr', 'pri',
            '{"kind":"workspace-membership","userId":"usr"}', 1, 'chain', 'first', 'first');
      `.execute(database);
    } finally {
      await sql`set session_replication_role = origin`.execute(database);
    }
    await migrateToLatest(database);
  });

  afterAll(async () => {
    await database?.destroy();
    await maintenance?.query(`drop database if exists ${databaseName}`);
    await maintenance?.end();
  });

  it("keeps waiting inputs in the order they were sent and exposes that order to admission", async () => {
    const inputs = await sql<{ messageId: string; queueRank: string }>`
      select message_id as "messageId", queue_rank::text as "queueRank"
      from public.thread_work_inputs order by queue_rank
    `.execute(database);
    expect(inputs.rows).toEqual([
      { messageId: "msg-first", queueRank: "4" },
      { messageId: "msg-second", queueRank: "7" },
    ]);
    await expect(
      sql`insert into public.thread_inputs(
          message_id, thread_id, policy, requested_by, actor_principal_id, authority_source,
          membership_generation, causal_chain_id, idempotency_key, request_fingerprint
        ) values ('msg-reply', 'thr-order', 'queue', 'usr', 'pri',
          '{"kind":"workspace-membership","userId":"usr"}', 1, 'chain', 'rankless', 'rankless')`.execute(
        database,
      ),
    ).rejects.toThrow(/queue_rank/);
  });
});

integration.sequential("assignments migration", () => {
  const databaseName = `opensteer_assignments_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let database: Kysely<DatabaseSchema>;
  const owner = "usr_00000000-0000-4000-8000-000000000001";
  const parentThread = "thr_00000000-0000-4000-8000-000000000003";
  const parentRun = "run_00000000-0000-4000-8000-000000000004";
  /** One legacy delegation per way its child Run could have been left. */
  const legacy = [
    { key: "1", resultStatus: "pending", runStatus: "completed" },
    { key: "2", resultStatus: "pending", runStatus: "failed" },
    { key: "3", resultStatus: "pending", runStatus: "interrupted" },
    { key: "4", resultStatus: "pending", runStatus: "running" },
    { key: "5", resultStatus: "delivered", runStatus: "completed" },
  ] as const;
  const delegationId = (key: string) => `dlg_00000000-0000-4000-8000-00000000010${key}`;
  const childThreadId = (key: string) => `thr_00000000-0000-4000-8000-00000000020${key}`;
  const childRunId = (key: string) =>
    RunIdSchema.parse(`run_00000000-0000-4000-8000-00000000030${key}`);

  function urlFor(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlFor("postgres") });
    await maintenance.query(`drop database if exists ${databaseName}`);
    await maintenance.query(`create database ${databaseName}`);
    database = createDatabase({ connectionString: urlFor(databaseName), maxConnections: 1 });
    const before = await new Migrator({
      db: database,
      provider: migrationProvider(),
    }).migrateTo("0064_workspace_notification_preference_revision");
    if (before.error) throw before.error;

    // Delegations as the released Host left them: one child Run each, settled
    // or not. Relationship triggers are suppressed so the rows need no Runner.
    await sql`set session_replication_role = replica`.execute(database);
    try {
      await sql`
        insert into public.execution_environments(id, name, kind)
        values ('env_99999999-9999-4999-8999-999999999999', 'Migration', 'managed')
      `.execute(database);
      await sql`
        insert into public.users(id, display_name, email)
        values (${owner}, 'Owner', 'owner@example.com')
      `.execute(database);
      await sql`
        insert into public.workspaces(
          id, name, status, created_by, kind, backing, capacity_policy
        ) values (
          'wsp_00000000-0000-4000-8000-000000000002', 'Origin', 'ready', ${owner}, 'specialized',
          '{"kind":"portablefs","serviceId":"test","volumeId":"origin","generation":1}',
          '{"kind":"hard-quota","blockHardLimitBytes":1000000,"inodeHardLimit":1000}'
        )
      `.execute(database);
      const insertThread = (id: string, title: string) => sql`
        insert into public.threads(
          id, workspace_id, title, environment_id, harness_instance_id, created_by,
          capability_profile_id, created_by_principal_id, model_selection,
          lineage_root_thread_id, parent_thread_id
        ) values (
          ${id}, 'wsp_00000000-0000-4000-8000-000000000002', ${title},
          'env_99999999-9999-4999-8999-999999999999', 'hai_fixture', ${owner},
          'workspace', 'pri_fixture', '{"providerId":"openai","modelId":"test","options":{}}',
          ${parentThread}, ${id === parentThread ? null : parentThread}
        )
      `;
      const insertRun = (id: string, threadId: string, status: string) => sql`
        insert into public.runs(
          id, thread_id, environment_id, harness_instance_id, requested_by,
          run_ordinal, status, started_at, completed_at, actor_principal_id,
          authority_source, model_selection, membership_generation, access_mode,
          activation_input_id, causal_chain_id, seed_input_id
        ) values (
          ${id}, ${threadId}, 'env_99999999-9999-4999-8999-999999999999', 'hai_fixture',
          ${owner}, 0, ${status}, now(),
          ${["completed", "failed", "interrupted"].includes(status) ? sql`now()` : sql`null`},
          'pri_fixture', '{}', '{"providerId":"openai","modelId":"test","options":{}}',
          1, 'full-access', ${`msg_seed_${id}`}, 'cch_fixture', ${`msg_seed_${id}`}
        )
      `;
      await insertThread(parentThread, "Coordinator").execute(database);
      await insertRun(parentRun, parentThread, "running").execute(database);
      for (const row of legacy) {
        await insertThread(childThreadId(row.key), `Legacy task ${row.key}`).execute(database);
        await insertRun(childRunId(row.key), childThreadId(row.key), row.runStatus).execute(
          database,
        );
        await sql`
          insert into public.delegations(
            id, parent_thread_id, parent_run_id, child_thread_id, child_run_id,
            result_status, result_message_id, completed_at
          ) values (
            ${delegationId(row.key)}, ${parentThread}, ${parentRun},
            ${childThreadId(row.key)}, ${childRunId(row.key)}, ${row.resultStatus},
            ${row.resultStatus === "delivered" ? `msg_result_${row.key}` : null},
            ${row.resultStatus === "delivered" ? sql`now()` : sql`null`}
          )
        `.execute(database);
      }
    } finally {
      await sql`set session_replication_role = origin`.execute(database);
    }
    const migrated = await new Migrator({
      db: database,
      provider: migrationProvider(),
    }).migrateTo("0065_assignments");
    if (migrated.error) throw migrated.error;
  });

  afterAll(async () => {
    await database?.destroy();
    await maintenance?.query(`drop database if exists ${databaseName}`);
    await maintenance?.end();
  });

  it("finishes settled-but-unreturned rows for one delivery and leaves running work open", async () => {
    const rows = await database
      .selectFrom("delegations")
      .select(["id", "finishedAt", "origin", "resultRunId", "resultStatus", "resultText", "status"])
      .orderBy("id", "asc")
      .execute();
    const note =
      "This task settled before the Assignment upgrade. Read its task Thread for the result.";
    expect(
      rows.map(({ finishedAt, ...row }) => ({ ...row, finished: finishedAt !== null })),
    ).toEqual([
      {
        finished: true,
        id: delegationId("1"),
        origin: "run",
        resultRunId: childRunId("1"),
        resultStatus: "pending",
        resultText: note,
        status: "completed",
      },
      {
        finished: true,
        id: delegationId("2"),
        origin: "run",
        resultRunId: childRunId("2"),
        resultStatus: "pending",
        resultText: note,
        status: "failed",
      },
      {
        finished: true,
        id: delegationId("3"),
        origin: "run",
        resultRunId: null,
        resultStatus: "pending",
        resultText: note,
        status: "cancelled",
      },
      {
        finished: false,
        id: delegationId("4"),
        origin: "run",
        resultRunId: null,
        resultStatus: "pending",
        resultText: null,
        status: "open",
      },
      {
        finished: true,
        id: delegationId("5"),
        origin: "run",
        resultRunId: childRunId("5"),
        resultStatus: "delivered",
        resultText: note,
        status: "completed",
      },
    ]);
    // Exactly the rows the return outbox drains: ended work whose parent was never told.
    const outbox = await database
      .selectFrom("delegations")
      .select("id")
      .where("status", "!=", "open")
      .where("resultStatus", "=", "pending")
      .orderBy("id", "asc")
      .execute();
    expect(outbox.map(({ id }) => id)).toEqual([
      delegationId("1"),
      delegationId("2"),
      delegationId("3"),
    ]);
    // The still-running child is bound, so its end is judged by the new rule.
    const bound = await database
      .selectFrom("runs")
      .select(["assignmentId", "id"])
      .where(
        "id",
        "in",
        legacy.map(({ key }) => childRunId(key)),
      )
      .orderBy("id", "asc")
      .execute();
    expect(bound).toEqual(
      legacy.map(({ key }) => ({ assignmentId: delegationId(key), id: childRunId(key) })),
    );
  });

  it("admits only returnable origins and consistent outcomes", async () => {
    const violations = [
      sql`update public.delegations set origin = 'human' where id = ${delegationId("4")}`,
      sql`update public.delegations set origin = 'trigger' where id = ${delegationId("4")}`,
      sql`update public.delegations set result_status = 'none' where id = ${delegationId("4")}`,
      sql`update public.delegations set status = 'completed', finished_at = now(),
        result_run_id = ${childRunId("4")}, result_text = '' where id = ${delegationId("4")}`,
      sql`update public.delegations set status = 'failed', finished_at = now(),
        result_text = 'failed' where id = ${delegationId("4")}`,
      sql`update public.delegations set result_status = 'delivered', completed_at = now(),
        result_message_id = 'msg_early' where id = ${delegationId("4")}`,
      sql`update public.delegations set parent_thread_id = null where id = ${delegationId("4")}`,
      sql`update public.delegations set child_run_id = null where id = ${delegationId("4")}`,
    ];
    for (const violation of violations) {
      await expect(violation.execute(database)).rejects.toThrow(/violates/u);
    }
    const actions = await sql<{ definition: string }>`
      select pg_get_constraintdef(oid) as definition from pg_constraint
      where conrelid = 'public.agent_control_requests'::regclass
        and conname = 'agent_control_requests_action_check'
    `.execute(database);
    expect(actions.rows[0]?.definition).toContain("'assignment.cancel'::text");
    expect(actions.rows[0]?.definition).toContain("'browser.source.inspect'::text");
    expect(actions.rows[0]?.definition).toContain("'browser.profile.import'::text");
    expect(actions.rows[0]?.definition).not.toContain("assignment.finish");
  });
});

integration.sequential("local MCP servers migration", () => {
  const databaseName = `opensteer_local_mcp_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let database: Kysely<DatabaseSchema>;
  const launches = {
    loopback: { headers: {}, type: "streamable-http", url: "http://127.0.0.1:3845/mcp" },
    remote: { headers: {}, type: "streamable-http", url: "https://mcp.example.com/mcp" },
    stdio: {
      args: ["/plugins/notes/server.cjs"],
      command: "node",
      cwd: "/plugins/notes",
      env: { PLUGIN_ROOT: "/plugins/notes" },
      type: "stdio",
    },
  } as const;

  function urlFor(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlFor("postgres") });
    await maintenance.query(`drop database if exists ${databaseName}`);
    await maintenance.query(`create database ${databaseName}`);
    database = createDatabase({ connectionString: urlFor(databaseName), maxConnections: 1 });
    const migrated = await new Migrator({
      db: database,
      provider: migrationProvider(),
    }).migrateTo("0066_computer_channels");
    if (migrated.error) throw migrated.error;
    // Servers as a Host that ran them itself left them. Relationship triggers
    // are suppressed so the fixture needs no enrollment or owner.
    await sql`set session_replication_role = replica`.execute(database);
    try {
      await sql`
        insert into public.runners(
          id, owner_kind, owner_user_id, name, kind, public_key_pem, public_key_fingerprint,
          enrollment_token_hash, allowed_modules, max_concurrent_runs
        ) values (
          'rnr_22222222-2222-4222-8222-222222222222', 'deployment', null, 'Main', 'main',
          repeat('x', 70), 'sha256:main', 'sha256:main-token', '["agents", "integrations"]'::jsonb, 4
        )
      `.execute(database);
      await sql`
        insert into public.integration_installations(
          id, name, title, description, source_kind, trust, manifest, provenance, status, revision
        ) values (
          'ins_22222222-2222-4222-8222-222222222222', 'notes', 'Notes', '',
          'agent-plugin', 'administrator-approved', '{}'::jsonb, '{}'::jsonb, 'active', 1
        )
      `.execute(database);
      for (const [id, name, transport] of [
        ["isv_22222222-2222-4222-8222-222222222221", "stdio", launches.stdio],
        ["isv_22222222-2222-4222-8222-222222222222", "loopback", launches.loopback],
        ["isv_22222222-2222-4222-8222-222222222223", "remote", launches.remote],
      ] as const) {
        await sql`
          insert into public.integration_servers(
            id, installation_id, name, transport, connection_requirement, status, tool_generation
          ) values (
            ${id}, 'ins_22222222-2222-4222-8222-222222222222', ${name},
            ${JSON.stringify(transport)}::jsonb, '{"kind":"none"}'::jsonb, 'active', 1
          )
        `.execute(database);
      }
    } finally {
      await sql`set session_replication_role = origin`.execute(database);
    }
    const latest = await new Migrator({
      db: database,
      provider: migrationProvider(),
    }).migrateTo("0067_local_mcp_servers");
    if (latest.error) throw latest.error;
  });

  afterAll(async () => {
    await database?.destroy();
    if (maintenance) {
      await maintenance.query(`drop database if exists ${databaseName}`);
      await maintenance.end();
    }
  });

  it("moves the servers the Host ran to its Main computer, to wait for approval there", async () => {
    const servers = await database
      .selectFrom("integrationServers")
      .select(["approvedLaunchDigest", "name", "status", "statusDetail", "transport"])
      .orderBy("name", "asc")
      .execute();
    const waiting = {
      approvedLaunchDigest: null,
      status: "needs-attention",
      statusDetail: "Waiting for approval on the computer that runs it.",
    };
    expect(servers).toEqual([
      {
        ...waiting,
        name: "loopback",
        transport: {
          launch: launches.loopback,
          runnerId: "rnr_22222222-2222-4222-8222-222222222222",
          type: "runner",
        },
      },
      {
        approvedLaunchDigest: null,
        name: "remote",
        status: "active",
        statusDetail: null,
        transport: launches.remote,
      },
      {
        ...waiting,
        name: "stdio",
        transport: {
          launch: launches.stdio,
          runnerId: "rnr_22222222-2222-4222-8222-222222222222",
          type: "runner",
        },
      },
    ]);
  });

  it("holds a server approval to the server it names and nothing else", async () => {
    const row = (kind: string, definitionId: string, server: unknown) => sql`
      insert into public.computer_app_setup_requests(
        id, deployment_id, owner_user_id, runner_id, definition_id, definition_digest, access,
        created_at, expires_at, kind, server
      ) values (
        ${randomUUID()}, 'dep_22222222-2222-4222-8222-222222222222',
        'usr_22222222-2222-4222-8222-222222222222', 'rnr_22222222-2222-4222-8222-222222222222',
        ${definitionId}, 'digest', 'read-write', now(), now() + interval '1 day', ${kind},
        ${server === null ? null : JSON.stringify(server)}::jsonb
      )
    `;
    await sql`set session_replication_role = replica`.execute(database);
    try {
      const serverId = "isv_22222222-2222-4222-8222-222222222221";
      const otherId = "isv_22222222-2222-4222-8222-222222222222";
      await expect(row("server", serverId, { serverId }).execute(database)).resolves.toBeDefined();
      for (const [kind, definitionId, server] of [
        ["server", otherId, { serverId }],
        ["server", otherId, null],
        ["server", otherId, {}],
        ["app", "apple-notes", { serverId }],
      ] as const) {
        await expect(row(kind, definitionId, server).execute(database)).rejects.toThrow(
          /computer_app_setup_requests_kind_shape/u,
        );
      }
    } finally {
      await sql`set session_replication_role = origin`.execute(database);
    }
  });
});

integration.sequential("listed threads migration", () => {
  const databaseName = `opensteer_listed_threads_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let database: Kysely<DatabaseSchema>;
  const owner = "usr_00000000-0000-4000-8000-000000000001";
  const workspace = "wsp_00000000-0000-4000-8000-000000000002";
  const environment = "env_99999999-9999-4999-8999-999999999999";
  const home = "thr_00000000-0000-4000-8000-000000000001";
  const task = "thr_00000000-0000-4000-8000-000000000002";
  const helper = "thr_00000000-0000-4000-8000-000000000003";
  const personal = "thr_00000000-0000-4000-8000-000000000004";

  function urlFor(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlFor("postgres") });
    await maintenance.query(`drop database if exists ${databaseName}`);
    await maintenance.query(`create database ${databaseName}`);
    database = createDatabase({ connectionString: urlFor(databaseName), maxConnections: 1 });
    const before = await new Migrator({
      db: database,
      provider: migrationProvider(),
    }).migrateTo("0068_assignment_work_view");
    if (before.error) throw before.error;

    // Home, the task it handed off, that task's own helper, and a task the
    // person started, as epoch 25 left them; the helper's event predates 0065
    // and has no role. Relationship triggers are suppressed so the rows need
    // no Runner or engine.
    await sql`set session_replication_role = replica`.execute(database);
    try {
      const insertThread = (id: string, parent: string | null, role: string) => sql`
        insert into public.threads(
          id, workspace_id, title, environment_id, harness_instance_id, created_by,
          capability_profile_id, created_by_principal_id, model_selection,
          lineage_root_thread_id, parent_thread_id, role
        ) values (
          ${id}, ${workspace}, ${id}, ${environment}, 'hai_fixture', ${owner},
          ${parent ? "delegated" : "main"}, 'pri_fixture',
          '{"providerId":"openai","modelId":"test","options":{}}',
          ${parent ? home : id}, ${parent}, ${role}
        )
      `;
      await insertThread(home, null, "conversation").execute(database);
      await insertThread(task, home, "work").execute(database);
      await insertThread(helper, task, "work").execute(database);
      await insertThread(personal, null, "work").execute(database);
      const insertCreated = (sequence: number, threadId: string, thread: object) => sql`
        insert into public.workspace_events(
          sequence, event_id, workspace_id, thread_id, environment_id, type, data, created_at
        ) values (
          ${sequence}, ${`evt_${sequence}`}, ${workspace}, ${threadId}, ${environment},
          'thread.created', ${JSON.stringify({ thread })}::jsonb, now()
        )
      `;
      await insertCreated(1, task, { id: task, parentThreadId: home, role: "work" }).execute(
        database,
      );
      await insertCreated(2, helper, { id: helper, parentThreadId: task }).execute(database);
    } finally {
      await sql`set session_replication_role = origin`.execute(database);
    }
    const latest = await new Migrator({
      db: database,
      provider: migrationProvider(),
    }).migrateTo("0069_listed_threads");
    if (latest.error) throw latest.error;
  });

  afterAll(async () => {
    await database?.destroy();
    if (maintenance) {
      await maintenance.query(`drop database if exists ${databaseName}`);
      await maintenance.end();
    }
  });

  it("lists roots and what a conversation handed off, and not a task's own helpers", async () => {
    const rows = await database
      .selectFrom("threads")
      .select(["id", "listed"])
      .orderBy("id", "asc")
      .execute();
    expect(rows).toEqual([
      { id: home, listed: true },
      { id: task, listed: true },
      { id: helper, listed: false },
      { id: personal, listed: true },
    ]);
  });

  it("rewrites durable Thread events to the Thread's current shape", async () => {
    const events = await database
      .selectFrom("workspaceEvents")
      .select(["data"])
      .orderBy("sequence", "asc")
      .execute();
    expect(events.map(({ data }) => data)).toEqual([
      { thread: { id: task, listed: true, parentThreadId: home, role: "work" } },
      { thread: { id: helper, listed: false, parentThreadId: task, role: "work" } },
    ]);
  });

  it("makes every new Thread decide", async () => {
    const column = await sql<{ columnDefault: string | null; isNullable: string }>`
      select column_default, is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'threads' and column_name = 'listed'
    `.execute(database);
    expect(column.rows).toEqual([{ columnDefault: null, isNullable: "NO" }]);
  });
});

integration.sequential("Chat thread title migration", () => {
  const databaseName = `opensteer_chat_thread_title_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let database: Kysely<DatabaseSchema>;
  const owner = "usr_00000000-0000-4000-8000-000000000001";
  const newcomer = "usr_00000000-0000-4000-8000-000000000002";
  const main = "wsp_00000000-0000-4000-8000-000000000001";
  const newcomerMain = "wsp_00000000-0000-4000-8000-000000000002";
  const environment = "env_99999999-9999-4999-8999-999999999999";
  const chat = "thr_00000000-0000-4000-8000-000000000001";
  const namedHome = "thr_00000000-0000-4000-8000-000000000002";

  function urlFor(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlFor("postgres") });
    await maintenance.query(`drop database if exists ${databaseName}`);
    await maintenance.query(`create database ${databaseName}`);
    database = createDatabase({ connectionString: urlFor(databaseName), maxConnections: 1 });
    const before = await new Migrator({
      db: database,
      provider: migrationProvider(),
    }).migrateTo("0069_listed_threads");
    if (before.error) throw before.error;

    // One person's Chat, created while clients still titled it Home, beside a
    // task that person happened to call Home, and someone who has not started
    // Chat yet. Relationship triggers are suppressed so the rows need no
    // Runner or engine.
    await sql`set session_replication_role = replica`.execute(database);
    try {
      const insertWorkspace = (id: string, createdBy: string, volumeId: string) => sql`
        insert into public.workspaces(id, name, kind, status, created_by, backing, capacity_policy)
        values (
          ${id}, 'Main', 'main', 'ready', ${createdBy},
          ${JSON.stringify({ generation: 1, kind: "portablefs", serviceId: "svc", volumeId })}::jsonb,
          '{"kind": "hard-quota", "blockHardLimitBytes": 1024, "inodeHardLimit": 16}'::jsonb
        )
      `;
      await insertWorkspace(main, owner, "owner").execute(database);
      await insertWorkspace(newcomerMain, newcomer, "newcomer").execute(database);
      const insertThread = (id: string, role: string) => sql`
        insert into public.threads(
          id, workspace_id, title, environment_id, harness_instance_id, created_by,
          capability_profile_id, created_by_principal_id, model_selection,
          lineage_root_thread_id, role, listed
        ) values (
          ${id}, ${main}, 'Home', ${environment}, 'hai_fixture', ${owner}, 'main', 'pri_fixture',
          '{"providerId":"openai","modelId":"test","options":{}}', ${id}, ${role}, true
        )
      `;
      await insertThread(chat, "conversation").execute(database);
      await insertThread(namedHome, "work").execute(database);
      await sql`update public.workspaces set home_thread_id = ${chat} where id = ${main}`.execute(
        database,
      );
      const insertEvent = (sequence: number, threadId: string, type: string, data: object) => sql`
        insert into public.workspace_events(
          sequence, event_id, workspace_id, thread_id, environment_id, type, data, created_at
        ) values (
          ${sequence}, ${`evt_${sequence}`}, ${main}, ${threadId}, ${environment},
          ${type}, ${JSON.stringify(data)}::jsonb, now()
        )
      `;
      await insertEvent(1, chat, "thread.created", {
        home: true,
        thread: { id: chat, role: "conversation", title: "Home" },
      }).execute(database);
      await insertEvent(2, namedHome, "thread.created", {
        thread: { id: namedHome, role: "work", title: "Home" },
      }).execute(database);
      await insertEvent(3, chat, "thread.state-changed", {
        inputQueuePaused: false,
        pendingRequests: 0,
        status: "idle",
        title: "Home",
      }).execute(database);
    } finally {
      await sql`set session_replication_role = origin`.execute(database);
    }
    const latest = await new Migrator({
      db: database,
      provider: migrationProvider(),
    }).migrateTo("0070_chat_thread_title");
    if (latest.error) throw latest.error;
  });

  afterAll(async () => {
    await database?.destroy();
    if (maintenance) {
      await maintenance.query(`drop database if exists ${databaseName}`);
      await maintenance.end();
    }
  });

  it("names each person's Chat and leaves a task they called Home alone", async () => {
    const rows = await database
      .selectFrom("threads")
      .select(["id", "title"])
      .orderBy("id", "asc")
      .execute();
    expect(rows).toEqual([
      { id: chat, title: "Chat" },
      { id: namedHome, title: "Home" },
    ]);
    const workspaces = await database
      .selectFrom("workspaces")
      .select(["id", "homeThreadId"])
      .orderBy("id", "asc")
      .execute();
    expect(workspaces).toEqual([
      { homeThreadId: chat, id: main },
      { homeThreadId: null, id: newcomerMain },
    ]);
  });

  it("rewrites only the Chat's durable Thread snapshots", async () => {
    const events = await database
      .selectFrom("workspaceEvents")
      .select(["data"])
      .orderBy("sequence", "asc")
      .execute();
    expect(events.map(({ data }) => data)).toEqual([
      { home: true, thread: { id: chat, role: "conversation", title: "Chat" } },
      { thread: { id: namedHome, role: "work", title: "Home" } },
      { status: "idle", title: "Home", inputQueuePaused: false, pendingRequests: 0 },
    ]);
  });
});

integration.sequential("run reply migration", () => {
  const databaseName = `opensteer_run_reply_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let database: Kysely<DatabaseSchema>;
  const main = "wsp_00000000-0000-4000-8000-000000000001";
  const environment = "env_99999999-9999-4999-8999-999999999999";
  const chat = "thr_00000000-0000-4000-8000-000000000001";
  const answered = "run_00000000-0000-4000-8000-000000000001";
  const silent = "run_00000000-0000-4000-8000-000000000002";
  const failed = "run_00000000-0000-4000-8000-000000000003";
  const recorded = "run_00000000-0000-4000-8000-000000000004";
  const narration = "msg_00000000-0000-4000-8000-000000000001";
  const steer = "msg_00000000-0000-4000-8000-000000000002";
  const reply = "msg_00000000-0000-4000-8000-000000000003";
  const blank = "msg_00000000-0000-4000-8000-000000000004";
  const failedNarration = "msg_00000000-0000-4000-8000-000000000005";
  const recordedReply = "msg_00000000-0000-4000-8000-000000000006";

  function urlFor(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlFor("postgres") });
    await maintenance.query(`drop database if exists ${databaseName}`);
    await maintenance.query(`create database ${databaseName}`);
    database = createDatabase({ connectionString: urlFor(databaseName), maxConnections: 1 });
    const before = await new Migrator({
      db: database,
      provider: migrationProvider(),
    }).migrateTo("0071_assignment_run_models");
    if (before.error) throw before.error;

    // One conversation's Runs as they were stored before the Host recorded a
    // reply: one that narrated, took a steer, answered and then sent an empty
    // result; one that wrote nothing; one that narrated and failed; and one
    // already recorded.
    // Relationship triggers are suppressed so the rows need no Runner or engine.
    await sql`set session_replication_role = replica`.execute(database);
    try {
      const agent = JSON.stringify({ displayName: "Opensteer", kind: "agent" });
      const human = JSON.stringify({ displayName: "Owner", kind: "human" });
      const insertMessage = (
        id: string,
        runId: string,
        sequence: number,
        kind: "assistant" | "input",
        text: string = id,
      ) => sql`
        insert into public.messages(
          id, thread_id, run_id, content, actor_principal_id, sequence, kind, author
        ) values (
          ${id}, ${chat}, ${runId}, ${JSON.stringify([{ text, type: "text" }])}::jsonb,
          'pri_fixture', ${sequence}, ${kind}, ${kind === "assistant" ? agent : human}::jsonb
        )
      `;
      await insertMessage(narration, answered, 1, "assistant").execute(database);
      await insertMessage(steer, answered, 2, "input").execute(database);
      await insertMessage(reply, answered, 3, "assistant").execute(database);
      // Blank as JavaScript trims it, including a space PostgreSQL's C locale
      // would not call one.
      await insertMessage(blank, answered, 4, "assistant", " \u2003\n ").execute(database);
      await insertMessage(failedNarration, failed, 5, "assistant").execute(database);
      await insertMessage(recordedReply, recorded, 6, "assistant").execute(database);
      const insertEvent = (sequence: number, runId: string, type: string, data: object) => sql`
        insert into public.workspace_events(
          sequence, event_id, workspace_id, thread_id, run_id, environment_id, type, data, created_at
        ) values (
          ${sequence}, ${`evt_${sequence}`}, ${main}, ${chat}, ${runId}, ${environment},
          ${type}, ${JSON.stringify(data)}::jsonb, now()
        )
      `;
      await insertEvent(1, answered, "run.completed", { status: "completed" }).execute(database);
      await insertEvent(2, silent, "run.completed", { status: "completed" }).execute(database);
      await insertEvent(3, failed, "run.failed", {
        code: "failed",
        message: "The engine stopped",
        retryable: false,
        status: "failed",
      }).execute(database);
      await insertEvent(4, recorded, "run.completed", {
        replyMessageId: recordedReply,
        status: "completed",
      }).execute(database);
    } finally {
      await sql`set session_replication_role = origin`.execute(database);
    }
    const latest = await new Migrator({
      db: database,
      provider: migrationProvider(),
    }).migrateTo("0072_run_reply");
    if (latest.error) throw latest.error;
  });

  afterAll(async () => {
    await database?.destroy();
    if (maintenance) {
      await maintenance.query(`drop database if exists ${databaseName}`);
      await maintenance.end();
    }
  });

  it("names each completed Run's last message as its reply, and nothing else", async () => {
    const events = await database
      .selectFrom("workspaceEvents")
      .select(["data", "runId", "type"])
      .orderBy("sequence", "asc")
      .execute();
    expect(events).toEqual([
      // Not the narration before it, the person's steer stamped with the Run,
      // or the empty result after it.
      {
        data: { replyMessageId: reply, status: "completed" },
        runId: answered,
        type: "run.completed",
      },
      // Wrote nothing, so there is no reply to show or send.
      { data: { replyMessageId: null, status: "completed" }, runId: silent, type: "run.completed" },
      // A failed Run's narration is never promoted to an answer.
      {
        data: {
          code: "failed",
          message: "The engine stopped",
          retryable: false,
          status: "failed",
        },
        runId: failed,
        type: "run.failed",
      },
      {
        data: { replyMessageId: recordedReply, status: "completed" },
        runId: recorded,
        type: "run.completed",
      },
    ]);
  });
});

integration.sequential("Thread pending count migration", () => {
  const databaseName = `opensteer_thread_count_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let database: Kysely<DatabaseSchema>;
  beforeAll(async () => {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = "/postgres";
    maintenance = new Pool({ connectionString: url.toString() });
    await maintenance.query(`create database ${databaseName}`);
    url.pathname = `/${databaseName}`;
    database = createDatabase({ connectionString: url.toString(), maxConnections: 1 });
    const result = await new Migrator({ db: database, provider: migrationProvider() }).migrateTo(
      "0074_run_binding_generation",
    );
    if (result.error) throw result.error;
    await sql`set session_replication_role = replica`.execute(database);
    try {
      await sql`insert into threads (id, workspace_id, title, environment_id, harness_instance_id, model_selection, created_by, lineage_root_thread_id, created_by_principal_id, capability_profile_id, listed)
        values ('thr_empty', 'wsp_fixture', 'Empty', 'env_fixture', 'hni_fixture', '{}'::jsonb, 'usr_fixture', 'thr_empty', 'pri_fixture', 'main', true),
               ('thr_requests', 'wsp_fixture', 'Requests', 'env_fixture', 'hni_fixture', '{}'::jsonb, 'usr_fixture', 'thr_requests', 'pri_fixture', 'main', true)`.execute(
        database,
      );
      await sql`insert into requests (id, call_id, originating_thread_id, originating_workspace_id, target_workspace_id, originating_run_id, requested_by, kind, mode, required_actor, payload, presentation, status, resolved_at, resolved_by, response, cancellation_reason)
        select 'req_00000000-0000-4000-8000-' || lpad(n::text, 12, '0'), 'call_' || n, 'thr_requests', 'wsp_fixture', 'wsp_other', 'run_fixture', 'usr_fixture', 'harness.approval', 'live', 'requester', '{}'::jsonb, '{}'::jsonb, s, case when s <> 'pending' then now() end, case when s = 'fulfilled' then 'usr_fixture' end, case when s = 'fulfilled' then '{}'::jsonb end, case when s = 'cancelled' then 'run-ended' end
        from (values (1, 'pending'), (2, 'pending'), (3, 'fulfilled'), (4, 'cancelled')) as fixture(n,s)`.execute(
        database,
      );
    } finally {
      await sql`set session_replication_role = origin`.execute(database);
    }
  });
  afterAll(async () => {
    await database?.destroy();
    if (maintenance) {
      await maintenance.query(`drop database if exists ${databaseName}`);
      await maintenance.end();
    }
  });
  it("backfills exactly pending Requests by originating Thread, including cross-Workspace Requests", async () => {
    const result = await new Migrator({ db: database, provider: migrationProvider() }).migrateTo(
      "0075_thread_state",
    );
    if (result.error) throw result.error;
    const rows = await sql<{
      id: string;
      pendingRequestCount: number;
    }>`select id, pending_request_count from threads order by id`.execute(database);
    expect(rows.rows).toEqual([
      { id: "thr_empty", pendingRequestCount: 0 },
      { id: "thr_requests", pendingRequestCount: 2 },
    ]);
  });
  it("creates a deduplicated pending marker with cascading Thread ownership", async () => {
    const result = await new Migrator({ db: database, provider: migrationProvider() }).migrateTo(
      "0076_thread_state_pending",
    );
    if (result.error) throw result.error;
    await sql`insert into thread_state_pending (thread_id, requested_at) values ('thr_empty', now()) on conflict do nothing`.execute(
      database,
    );
    await sql`insert into thread_state_pending (thread_id, requested_at) values ('thr_empty', now()) on conflict do nothing`.execute(
      database,
    );
    expect((await sql`select * from thread_state_pending`.execute(database)).rows).toHaveLength(1);
    await expect(
      sql`insert into thread_state_pending (thread_id, requested_at) values ('thr_missing', now())`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await sql`delete from threads where id = 'thr_empty'`.execute(database);
    expect((await sql`select * from thread_state_pending`.execute(database)).rows).toEqual([]);
  });
});

integration.sequential("live public function row-lock audit", () => {
  const database = createDatabase({ connectionString: databaseUrl ?? "postgres://unconfigured" });
  beforeAll(async () => {
    await migrateToLatest(database);
  });
  afterAll(async () => {
    await database.destroy();
  });
  const violations = async () => {
    const functions = await sql<{ name: string; definition: string }>`
      select p.oid::regprocedure::text as name, pg_get_functiondef(p.oid) as definition
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prokind in ('f', 'p')
      order by p.oid::regprocedure::text`.execute(database);
    return functions.rows
      .filter(({ definition }) => strongRowLockViolations(definition, "sql").length > 0)
      .map(({ name }) => name);
  };
  it("has no unreasoned strong locks in migrated public functions", async () => {
    expect(await violations()).toEqual([]);
  });
  it("detects a comment-separated strong lock in a live function", async () => {
    await sql`create function phase3l_guard_probe() returns void language plpgsql as $$
      begin perform id from users FOR /* row fence */ UPDATE; end $$`.execute(database);
    try {
      expect(await violations()).toContain("phase3l_guard_probe()");
    } finally {
      await sql`drop function phase3l_guard_probe()`.execute(database);
    }
  });
});

/*
 * The grant backfill must neither strand a live Run nor revive a finished one:
 * a Run holding its current binding keeps its tools across the upgrade, while a
 * finished Run, a stale binding or a Run that never started gains nothing.
 */
integration.sequential("Run attempts and grants migration", () => {
  const databaseName = `opensteer_run_grants_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let database: Kysely<DatabaseSchema>;
  beforeAll(async () => {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = "/postgres";
    maintenance = new Pool({ connectionString: url.toString() });
    await maintenance.query(`create database ${databaseName}`);
    url.pathname = `/${databaseName}`;
    database = createDatabase({ connectionString: url.toString(), maxConnections: 1 });
    const result = await new Migrator({ db: database, provider: migrationProvider() }).migrateTo(
      "0078_deferred_integration_authority",
    );
    if (result.error) throw result.error;
    await sql`set session_replication_role = replica`.execute(database);
    try {
      await sql`insert into provider_sessions (id, thread_id, harness_instance_id, status, active, binding_generation, runner_id, runner_boot_id, lease_token_hash, lease_expires_at)
        values ('psn_live', 'thr_fixture', 'hni_fixture', 'running', true, 3, 'rnr_fixture', 'boot-live', 'lease', now() + interval '1 hour'),
               ('psn_stale', 'thr_other', 'hni_fixture', 'running', true, 2, 'rnr_fixture', 'boot-stale', 'lease', now() + interval '1 hour')`.execute(
        database,
      );
      await sql`insert into runs (id, thread_id, environment_id, harness_instance_id, requested_by, run_ordinal, actor_principal_id, authority_source, model_selection, membership_generation, access_mode, activation_input_id, causal_chain_id, seed_input_id, status, started_at, completed_at, binding_generation, provider_session_id)
        select id, case when session = 'psn_stale' then 'thr_other' else 'thr_fixture' end, 'env_fixture', 'hni_fixture', 'usr_fixture', ordinal, 'pri_fixture', '{}'::jsonb, '{}'::jsonb, 1, 'auto', 'msg_' || ordinal, 'cch_fixture', 'msg_' || ordinal, status, started, completed, binding, session
        from (values
          ('run_live', 1, 'running', now(), null::timestamptz, 3, 'psn_live'),
          ('run_stale', 2, 'running', now(), null::timestamptz, 3, 'psn_stale'),
          ('run_done', 3, 'completed', now(), now(), 1, 'psn_live'),
          ('run_queued', 4, 'queued', null::timestamptz, null::timestamptz, null::integer, null::text),
          ('run_never_started', 5, 'interrupted', null::timestamptz, now(), null::integer, null::text),
          ('run_never_bound', 6, 'failed', null::timestamptz, now(), 0, null::text)
        ) as fixture(id, ordinal, status, started, completed, binding, session)`.execute(database);
    } finally {
      await sql`set session_replication_role = origin`.execute(database);
    }
    const migrated = await new Migrator({ db: database, provider: migrationProvider() }).migrateTo(
      "0079_run_attempts_and_grants",
    );
    if (migrated.error) throw migrated.error;
  });
  afterAll(async () => {
    await database?.destroy();
    if (maintenance) {
      await maintenance.query(`drop database if exists ${databaseName}`);
      await maintenance.end();
    }
  });

  it("gives every started Run its first attempt and nothing to one that never started", async () => {
    const attempts = await sql<{ runId: string; ordinal: number; status: string }>`
      select run_id, ordinal, status from run_attempts order by run_id`.execute(database);
    expect(attempts.rows).toEqual([
      { ordinal: 1, runId: "run_done", status: "current" },
      { ordinal: 1, runId: "run_live", status: "current" },
      { ordinal: 1, runId: "run_stale", status: "current" },
    ]);
  });

  it("grants only a live Run holding its current binding", async () => {
    const grants = await sql<{
      bindingGeneration: number;
      runId: string;
      runnerBootId: string;
      status: string;
    }>`select run_id, binding_generation, runner_boot_id, status from grants`.execute(database);
    expect(grants.rows).toEqual([
      { bindingGeneration: 3, runId: "run_live", runnerBootId: "boot-live", status: "active" },
    ]);
  });

  it("keeps one current attempt and one active grant per attempt", async () => {
    await expect(
      sql`insert into run_attempts (id, run_id, ordinal, reason, status) values ('rat_second', 'run_live', 2, 'recovery', 'current')`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      sql`update grants set status = 'revoked' where run_id = 'run_live'`.execute(database),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("records each earlier attempt's binding and end", async () => {
    const migrated = await new Migrator({ db: database, provider: migrationProvider() }).migrateTo(
      "0080_run_attempt_facts",
    );
    if (migrated.error) throw migrated.error;
    const attempts = await sql<{
      bindingGeneration: number | null;
      dispatched: boolean;
      outcome: string | null;
      runId: string;
    }>`select run_id, binding_generation, dispatched_at is not null as dispatched, outcome
      from run_attempts order by run_id`.execute(database);
    expect(attempts.rows).toEqual([
      { bindingGeneration: 1, dispatched: true, outcome: "completed", runId: "run_done" },
      { bindingGeneration: 3, dispatched: true, outcome: null, runId: "run_live" },
      { bindingGeneration: 3, dispatched: true, outcome: null, runId: "run_stale" },
    ]);
  });
});

/**
 * 0084 replaces the push-only outbox with the Host's own notification record,
 * which every Deployment now projects. A Host that never had an Account never
 * ran the projector, so its checkpoints are stale or missing: the migration
 * must start every existing Workspace at its head, or the first projection
 * after the upgrade would replay every reply and failure it ever had.
 */
integration.sequential("notifications migration", () => {
  const databaseName = `opensteer_notifications_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let database: Kysely<DatabaseSchema>;
  const owner = "usr_00000000-0000-4000-8000-0000000000a1";
  const environment = "env_00000000-0000-4000-8000-0000000000a1";
  // A Main Workspace whose stale checkpoint trails its head, and one with none.
  const stale = "wsp_00000000-0000-4000-8000-0000000000a1";
  const missing = "wsp_00000000-0000-4000-8000-0000000000a2";
  const chat = "thr_00000000-0000-4000-8000-0000000000a1";
  const work = "thr_00000000-0000-4000-8000-0000000000a2";
  const chatRun = "run_00000000-0000-4000-8000-0000000000a1";
  const workRun = "run_00000000-0000-4000-8000-0000000000a2";
  const chatReply = "msg_00000000-0000-4000-8000-0000000000a1";
  const workReply = "msg_00000000-0000-4000-8000-0000000000a2";

  function urlFor(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlFor("postgres") });
    await maintenance.query(`drop database if exists ${databaseName}`);
    await maintenance.query(`create database ${databaseName}`);
    database = createDatabase({ connectionString: urlFor(databaseName), maxConnections: 1 });
    const before = await new Migrator({
      db: database,
      provider: migrationProvider(),
    }).migrateTo("0083_run_attempt_engine_start");
    if (before.error) throw before.error;

    // History a released Host left behind: a reply and a failure in Chat, a
    // reply in another Workspace, and an outbox row still owed to push.
    // Relationship triggers are suppressed so the rows need no Runner or engine.
    await sql`set session_replication_role = replica`.execute(database);
    try {
      await sql`
        insert into public.users(id, display_name, email)
        values (${owner}, 'Owner', 'owner@example.test')
      `.execute(database);
      await sql`
        insert into public.principals(id, kind, user_id, display_name)
        values ('pri_fixture', 'user', ${owner}, 'Owner')
      `.execute(database);
      await sql`
        insert into public.execution_environments(id, name, kind) values (${environment}, 'Main', 'main')
      `.execute(database);
      await sql`
        insert into public.harness_instances(id, environment_id, driver_kind, name, config, state_kind, source_id)
        values ('hai_fixture', ${environment}, 'codex', 'Codex', '{}', 'isolated', 'openai')
      `.execute(database);
      await sql`
        insert into public.workspaces(
          id, name, status, event_sequence, created_by, kind, backing, capacity_policy,
          home_thread_id
        ) values
          (
            ${stale}, 'Main', 'ready', 3, ${owner}, 'main',
            '{"kind":"portablefs","serviceId":"test","volumeId":"main","generation":1}',
            '{"kind":"hard-quota","blockHardLimitBytes":1000000,"inodeHardLimit":1000}',
            ${chat}
          ),
          (
            ${missing}, 'Research', 'ready', 1, ${owner}, 'specialized',
            '{"kind":"portablefs","serviceId":"test","volumeId":"research","generation":1}',
            '{"kind":"hard-quota","blockHardLimitBytes":1000000,"inodeHardLimit":1000}',
            null
          )
      `.execute(database);
      await sql`
        insert into public.workspace_memberships(id, workspace_id, user_id, role, state) values
          ('wsm_00000000-0000-4000-8000-0000000000a1', ${stale}, ${owner}, 'owner', 'active'),
          ('wsm_00000000-0000-4000-8000-0000000000a2', ${missing}, ${owner}, 'owner', 'active')
      `.execute(database);
      await sql`
        insert into public.threads(
          id, workspace_id, title, environment_id, harness_instance_id, model_selection,
          created_by, lineage_root_thread_id, created_by_principal_id, capability_profile_id,
          listed
        ) values
          (
            ${chat}, ${stale}, 'Chat', ${environment}, 'hai_fixture',
            '{"providerId":"openai","modelId":"test","options":{}}', ${owner}, ${chat},
            'pri_fixture', 'main', true
          ),
          (
            ${work}, ${missing}, 'Sources', ${environment}, 'hai_fixture',
            '{"providerId":"openai","modelId":"test","options":{}}', ${owner}, ${work},
            'pri_fixture', 'main', true
          )
      `.execute(database);
      await sql`
        insert into public.runs(
          id, thread_id, environment_id, harness_instance_id, requested_by, run_ordinal,
          status, started_at, completed_at, actor_principal_id, authority_source,
          model_selection, membership_generation, access_mode, activation_input_id,
          causal_chain_id, seed_input_id
        ) values
          (
            ${chatRun}, ${chat}, ${environment}, 'hai_fixture', ${owner}, 1, 'failed', now(),
            now(), 'pri_fixture', '{}', '{"providerId":"openai","modelId":"test","options":{}}',
            1, 'auto', 'msg_seed_chat', 'cch_fixture', 'msg_seed_chat'
          ),
          (
            ${workRun}, ${work}, ${environment}, 'hai_fixture', ${owner}, 1, 'completed', now(),
            now(), 'pri_fixture', '{}', '{"providerId":"openai","modelId":"test","options":{}}',
            1, 'auto', 'msg_seed_work', 'cch_fixture', 'msg_seed_work'
          )
      `.execute(database);
      await sql`
        insert into public.messages(
          id, thread_id, run_id, content, actor_principal_id, sequence, kind, author
        ) values
          (
            ${chatReply}, ${chat}, ${chatRun}, '[{"type":"text","text":"Old reply"}]',
            'pri_fixture', 1, 'assistant', '{"displayName":"Opensteer","kind":"agent"}'
          ),
          (
            ${workReply}, ${work}, ${workRun}, '[{"type":"text","text":"Old sources"}]',
            'pri_fixture', 1, 'assistant', '{"displayName":"Opensteer","kind":"agent"}'
          )
      `.execute(database);
      await sql`
        insert into public.workspace_events(
          sequence, event_id, workspace_id, thread_id, run_id, environment_id, type, data,
          created_at
        ) values
          (
            2, 'evt_00000000-0000-4000-8000-0000000000a2', ${stale}, ${chat}, ${chatRun},
            ${environment}, 'run.completed',
            ${JSON.stringify({ replyMessageId: chatReply, status: "completed" })}::jsonb, now()
          ),
          (
            3, 'evt_00000000-0000-4000-8000-0000000000a3', ${stale}, ${chat}, ${chatRun},
            ${environment}, 'run.failed',
            '{"code":"failed","message":"The engine stopped","retryable":false,"status":"failed"}',
            now()
          ),
          (
            1, 'evt_00000000-0000-4000-8000-0000000000b1', ${missing}, ${work}, ${workRun},
            ${environment}, 'run.completed',
            ${JSON.stringify({ replyMessageId: workReply, status: "completed" })}::jsonb, now()
          )
      `.execute(database);
      await sql`
        insert into public.notification_checkpoints(workspace_id, sequence, created_at, updated_at)
        values (${stale}, 1, now(), now())
      `.execute(database);
      await sql`
        insert into public.notification_outbox(
          id, workspace_id, sequence, event_id, thread_id, run_id, kind,
          recipient_account_ids, occurred_at, expires_at
        ) values (
          'ntf_00000000-0000-4000-8000-0000000000a1', ${stale}, 3,
          'evt_00000000-0000-4000-8000-0000000000a3', ${chat}, ${chatRun}, 'run-failed',
          '["acct_fixture"]', now(), now() + interval '2 minutes'
        )
      `.execute(database);
    } finally {
      await sql`set session_replication_role = origin`.execute(database);
    }
    const after = await new Migrator({
      db: database,
      provider: migrationProvider(),
    }).migrateTo("0084_notifications");
    if (after.error) throw after.error;
  });

  afterAll(async () => {
    await database?.destroy();
    if (maintenance) {
      await maintenance.query(`drop database if exists ${databaseName}`);
      await maintenance.end();
    }
  });

  it("starts every existing Workspace at its head and drops the outbox", async () => {
    const checkpoints = await sql<{ sequence: string; workspaceId: string }>`
      select workspace_id, sequence::text as sequence from public.notification_checkpoints
    `.execute(database);
    expect(
      Object.fromEntries(checkpoints.rows.map((row) => [row.workspaceId, row.sequence])),
    ).toEqual({ [missing]: "1", [stale]: "3" });
    const tables = await sql<{ notifications: string | null; outbox: string | null }>`
      select to_regclass('public.notification_outbox')::text as outbox,
        to_regclass('public.notifications')::text as notifications
    `.execute(database);
    expect(tables.rows).toEqual([{ notifications: "notifications", outbox: null }]);
    expect(
      (
        await sql<{
          count: string;
        }>`select count(*)::text as count from public.notifications`.execute(database)
      ).rows,
    ).toEqual([{ count: "0" }]);
  });

  it("adds an unset, bounded time zone to every person", async () => {
    const zones = await sql<{ timeZone: string | null }>`
      select time_zone from public.users
    `.execute(database);
    expect(zones.rows).toEqual([{ timeZone: null }]);
    await expect(
      sql`update public.users set time_zone = '' where id = ${owner}`.execute(database),
    ).rejects.toMatchObject({ code: "23514" });
    await sql`update public.users set time_zone = 'Europe/Paris' where id = ${owner}`.execute(
      database,
    );
    await sql`update public.users set time_zone = null where id = ${owner}`.execute(database);
  });

  it("H9 drops both populated Host notification tables", async () => {
    await sql`insert into public.notifications (id, user_id, workspace_id, thread_id, kind, subject_id, message_id, run_id, event_id, sequence, title, body, occurred_at, expires_at, next_attempt_at)
      values ('ntf_00000000-0000-8000-8000-000000000001', ${owner}, ${stale}, ${chat}, 'reply-published', ${chatReply}, ${chatReply}, ${chatRun}, 'evt_00000000-0000-4000-8000-0000000000a2', 2, 'Opensteer', 'Old reply', now(), now() + interval '15 minutes', now())`.execute(
      database,
    );
    const before = await sql<{
      notifications: string;
      checkpoints: string;
    }>`select (select count(*) from public.notifications)::text as notifications, (select count(*) from public.notification_checkpoints)::text as checkpoints`.execute(
      database,
    );
    expect(before.rows).toEqual([{ notifications: "1", checkpoints: "2" }]);
    await migrateToLatest(database);
    const after = await sql<{
      notifications: string | null;
      checkpoints: string | null;
    }>`select to_regclass('public.notifications')::text as notifications, to_regclass('public.notification_checkpoints')::text as checkpoints`.execute(
      database,
    );
    expect(after.rows).toEqual([{ notifications: null, checkpoints: null }]);
  });
});

/**
 * 0085 archives the one-time Triggers that finished before a successful run
 * finished them on its own: a run succeeded after the instant, and nothing is
 * scheduled. One that failed, ran early, or was missed while paused is still
 * its owner's to fix or wait for, and a repeating schedule never finishes.
 */
integration.sequential("finished one-time Triggers migration", () => {
  const databaseName = `opensteer_finished_triggers_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let database: Kysely<DatabaseSchema>;
  const owner = "usr_00000000-0000-4000-8000-0000000000c1";
  const workspace = "wsp_00000000-0000-4000-8000-0000000000c1";
  const chat = "thr_00000000-0000-4000-8000-0000000000c1";
  const environment = "env_00000000-0000-4000-8000-0000000000c1";
  const past = new Date(Date.now() - 2 * 3_600_000);
  const later = new Date(past.getTime() + 60_000);
  const earlier = new Date(past.getTime() - 3_600_000);
  const future = new Date(Date.now() + 86_400_000);
  const fixtures = [
    { at: past, id: "finished", next: null, ran: [["succeeded", later]], status: "active" },
    { at: past, id: "failed", next: null, ran: [["failed", later]], status: "active" },
    { at: future, id: "early", next: future, ran: [["succeeded", earlier]], status: "active" },
    { at: past, id: "missed", next: null, ran: [["succeeded", earlier]], status: "paused" },
    { at: null, id: "repeating", next: future, ran: [["succeeded", later]], status: "active" },
  ] as const;

  function urlFor(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlFor("postgres") });
    await maintenance.query(`drop database if exists ${databaseName}`);
    await maintenance.query(`create database ${databaseName}`);
    database = createDatabase({ connectionString: urlFor(databaseName), maxConnections: 1 });
    const before = await new Migrator({
      db: database,
      provider: migrationProvider(),
    }).migrateTo("0084_notifications");
    if (before.error) throw before.error;

    // Relationship triggers are suppressed so the rows need no Workspace,
    // Runner or command around them.
    await sql`set session_replication_role = replica`.execute(database);
    try {
      for (const fixture of fixtures) {
        const triggerId = `trg_${fixture.id}`;
        const revisionId = `trv_${fixture.id}`;
        const source =
          fixture.at === null
            ? {
                kind: "schedule",
                schedule: { expression: "0 9 * * *", kind: "cron", timezone: "UTC" },
              }
            : { kind: "schedule", schedule: { at: fixture.at.toISOString(), kind: "at" } };
        await sql`
          insert into public.triggers(
            id, workspace_id, anchor_thread_id, created_by, idempotency_key, request_fingerprint,
            name, kind, status, next_fire_at, current_revision_id
          ) values (
            ${triggerId}, ${workspace}, ${chat}, ${owner}, ${fixture.id}, ${fixture.id},
            ${fixture.id}, 'schedule', ${fixture.status}, ${fixture.next}, ${revisionId}
          )
        `.execute(database);
        await sql`
          insert into public.trigger_revisions(id, trigger_id, ordinal, source, program, created_by)
          values (
            ${revisionId}, ${triggerId}, 1, ${JSON.stringify(source)}::jsonb,
            '{"language":"javascript","source":"export default () => null","toolContractVersion":2}',
            ${owner}
          )
        `.execute(database);
        for (const [index, [status, completedAt]] of fixture.ran.entries()) {
          await sql`
            insert into public.trigger_occurrences(
              id, trigger_id, revision_id, command_id, environment_id, source_key, event, status,
              started_at, completed_at, created_at
            ) values (
              ${`toc_${fixture.id}_${index}`}, ${triggerId}, ${revisionId},
              ${`cmd_${fixture.id}_${index}`}, ${environment}, ${`key_${index}`}, '{}', ${status},
              ${completedAt}, ${completedAt}, ${completedAt}
            )
          `.execute(database);
        }
      }
    } finally {
      await sql`set session_replication_role = origin`.execute(database);
    }
    const after = await new Migrator({
      db: database,
      provider: migrationProvider(),
    }).migrateTo("0085_finished_one_time_triggers");
    if (after.error) throw after.error;
  });

  afterAll(async () => {
    await database?.destroy();
    if (maintenance) {
      await maintenance.query(`drop database if exists ${databaseName}`);
      await maintenance.end();
    }
  });

  it("archives only the one-time Triggers a successful run already finished", async () => {
    const rows = await sql<{ id: string; pauseReason: string | null; status: string }>`
      select id, status, pause_reason from public.triggers order by id
    `.execute(database);
    expect(Object.fromEntries(rows.rows.map(({ id, status }) => [id, status]))).toEqual({
      trg_early: "active",
      trg_failed: "active",
      trg_finished: "archived",
      trg_missed: "paused",
      trg_repeating: "active",
    });
  });
});

// Phone keys can belong to offline or revoked Runners; only device identity
// classifies them. Pending presentation changes must leave historical rows alone.
integration.sequential("Agent Phone owner access migration", () => {
  const databaseName = `opensteer_phone_owner_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let database: Kysely<DatabaseSchema>;
  function urlFor(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }
  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlFor("postgres") });
    await maintenance.query(`create database ${databaseName}`);
    database = createDatabase({ connectionString: urlFor(databaseName) });
    await sql`
      create table runners(id text primary key, name text not null, device jsonb, revoked_at timestamptz);
      create table computer_use_approval_keys(runner_id text primary key, key_id text);
      create table requests(id text primary key, kind text, status text, presentation jsonb, payload jsonb, origin jsonb, settlement_id text);
      insert into runners values
        ('phone', 'Pixel', '{"form":"phone","platform":"android"}', null),
        ('revoked', 'Retired Pixel', '{"form":"phone","platform":"android"}', now()),
        ('mac', 'Mac', null, null),
        ('android', 'Android computer', '{"form":"computer","platform":"android"}', null),
        ('ios', 'iPhone', '{"form":"phone","platform":"ios"}', null);
      insert into computer_use_approval_keys values ('phone','p'), ('revoked','r'), ('mac','m'), ('android','a'), ('ios','i');
      insert into requests values
        ('pending', 'computer.app.access', 'pending', '{"title":"Wants to see Pixel","detail":"Old copy","subject":{"id":"setup","kind":"computer-app-setup"}}', '{"definitionId":"android-phone","runnerId":"phone","reason":"Read delivery.","access":"read","setupRequestId":"setup"}', '{"run":"run"}', 'setup'),
        ('terminal', 'computer.app.access', 'declined', '{"detail":"Historical copy"}', '{"definitionId":"android-phone","runnerId":"phone","reason":"Read delivery.","access":"read"}', '{"run":"old"}', 'old-setup'),
        ('mac', 'computer.app.access', 'pending', '{"detail":"Approve on Mac"}', '{"definitionId":"macos-app","runnerId":"mac"}', '{}', 'mac-setup');
    `.execute(database);
  });
  afterAll(async () => {
    await database?.destroy();
    if (maintenance) {
      await maintenance.query(`drop database if exists ${databaseName}`);
      await maintenance.end();
    }
  });
  it("deletes Android phone keys only and rewrites only pending phone presentation", async () => {
    const before = await sql<Record<string, unknown>>`select * from requests order by id`.execute(
      database,
    );
    await agentPhoneOwnerAccessMigration.up(database);
    const keys = await sql<{
      runnerId: string;
    }>`select runner_id from computer_use_approval_keys order by runner_id`.execute(database);
    expect(keys.rows.map(({ runnerId }) => runnerId)).toEqual(["android", "ios", "mac"]);
    const after = await sql<Record<string, unknown>>`select * from requests order by id`.execute(
      database,
    );
    expect(after.rows).toEqual(
      before.rows.map((row) =>
        row.id === "pending"
          ? {
              ...row,
              presentation: {
                ...(row.presentation as Record<string, unknown>),
                detail: "Read delivery. Pixel — can see. Allow or decline from any Opensteer app.",
              },
            }
          : row,
      ),
    );
    await agentPhoneOwnerAccessMigration.up(database);
    expect(
      (await sql<Record<string, unknown>>`select * from requests order by id`.execute(database))
        .rows,
    ).toEqual(after.rows);
  });
});

integration("Better Auth 1.7 migration", () => {
  const databaseName = `opensteer_auth17_${randomUUID().replaceAll("-", "")}`;
  let maintenance: Pool;
  let database: Kysely<DatabaseSchema>;
  beforeAll(async () => {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = "/postgres";
    maintenance = new Pool({ connectionString: url.toString() });
    await maintenance.query(`create database ${databaseName}`);
    url.pathname = `/${databaseName}`;
    database = createDatabase({ connectionString: url.toString() });
  });
  afterAll(async () => {
    await database?.destroy();
    await maintenance?.query(`drop database if exists ${databaseName}`);
    await maintenance?.end();
  });
  it("preserves pre-upgrade clients, refresh grants, sessions and signing keys", async () => {
    await sql`
      create table auth_sessions (id text primary key, token text not null);
      create table auth_jwks (id text primary key, public_key text, private_key text);
      create table host_oauth_clients (id text primary key, client_id text unique, public boolean,
        type text, require_pkce boolean, token_endpoint_auth_method text,
        constraint host_oauth_public_client_check check (not coalesce(public, false) or (
          token_endpoint_auth_method = 'none' and coalesce(require_pkce, false)
          and type in ('native', 'user-agent-based'))));
      create table host_oauth_refresh_tokens (id text primary key, token text unique,
        client_id text references host_oauth_clients(client_id), session_id text references auth_sessions(id), scopes jsonb);
      create table host_oauth_access_tokens (id text primary key);
      create table host_oauth_consents (id text primary key);
      insert into auth_sessions values ('session-before', 'signed-cookie-token-before');
      insert into auth_jwks values ('key-before', 'public-key-before', 'encrypted-private-key-before');
      insert into host_oauth_clients values ('client-before', 'opensteer-desktop', true, 'native', true, 'none');
      insert into host_oauth_refresh_tokens values ('refresh-before', 'token-hash-before',
        'opensteer-desktop', 'session-before', '["openid", "offline_access", "host:access"]');
    `.execute(database);
    await betterAuth17Migration.up(database);
    const client = await database
      .selectFrom("hostOAuthClients")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(client).toMatchObject({
      id: "client-before",
      clientId: "opensteer-desktop",
      applicationType: "native",
      tokenEndpointAuthMethod: "none",
      requirePkce: true,
      clientCredentialsScopes: [],
      clientDiscoveryId: null,
    });
    expect(client).not.toHaveProperty("public");
    expect(client).not.toHaveProperty("type");
    await expect(
      database.selectFrom("hostOAuthRefreshTokens").selectAll().execute(),
    ).resolves.toEqual([
      expect.objectContaining({
        token: "token-hash-before",
        sessionId: "session-before",
        resources: null,
        authorizationCodeId: null,
        rotatedAt: null,
        scopes: ["openid", "offline_access", "host:access"],
      }),
    ]);
    const sessions = await sql`select * from auth_sessions`.execute(database);
    expect(sessions.rows).toEqual([{ id: "session-before", token: "signed-cookie-token-before" }]);
    await expect(database.selectFrom("authJwks").selectAll().execute()).resolves.toEqual([
      {
        id: "key-before",
        publicKey: "public-key-before",
        privateKey: "encrypted-private-key-before",
        alg: null,
        crv: null,
      },
    ]);
    await expect(
      sql`insert into host_oauth_clients (id, client_id, application_type, token_endpoint_auth_method, require_pkce)
      values ('unsafe', 'unsafe', 'native', 'none', false)`.execute(database),
    ).rejects.toThrow(/host_oauth_public_client_check/);
  });
});

integration.sequential("screen presentation removal migration", () => {
  const databaseName = `opensteer_screen_show_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let database: Kysely<DatabaseSchema>;

  function urlFor(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlFor("postgres") });
    await maintenance.query(`drop database if exists ${databaseName}`);
    await maintenance.query(`create database ${databaseName}`);
    database = createDatabase({ connectionString: urlFor(databaseName), maxConnections: 1 });
  });

  afterAll(async () => {
    await database?.destroy();
    await maintenance?.query(`drop database if exists ${databaseName}`);
    await maintenance?.end();
  });

  it("drops a Host's screen.show admissions and refuses new ones", async () => {
    const migrated = await new Migrator({
      db: database,
      provider: migrationProvider(),
    }).migrateTo("0116_screen_show");
    if (migrated.error) throw migrated.error;
    // A Beta Host admitted these before presentation moved onto the voice call.
    await sql`set session_replication_role = replica`.execute(database);
    try {
      for (const action of ["screen.show", "thread.read"])
        await sql`
          insert into public.agent_control_requests(
            run_id, request_id, source_thread_id, action, action_class, request_fingerprint
          ) values ('run_1', ${randomUUID()}, 'thr_1', ${action}, ${action}, ${"a".repeat(64)})
        `.execute(database);
    } finally {
      await sql`set session_replication_role = origin`.execute(database);
    }
    await migrateToLatest(database);
    const remaining = await sql<{ action: string }>`
      select action from public.agent_control_requests
    `.execute(database);
    expect(remaining.rows.map((row) => row.action)).toEqual(["thread.read"]);
    await expect(
      sql`
        insert into public.agent_control_requests(
          run_id, request_id, source_thread_id, action, action_class, request_fingerprint
        ) values ('run_1', ${randomUUID()}, 'thr_1', 'screen.show', 'screen.show', ${"b".repeat(64)})
      `.execute(database),
    ).rejects.toThrow(/violates check constraint "agent_control_requests_action/u);
  });
});
