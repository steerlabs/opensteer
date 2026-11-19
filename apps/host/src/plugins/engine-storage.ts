import { createHash } from "node:crypto";
// Direct engine-schema dependencies: re-qualify this adapter on every import.
import { Effect, Stream } from "effect";
import type { SqlClient } from "effect/sql";
import type { ReactiveStore } from "@opensteer/plugin-engine-reactivity";
import { z } from "zod";
import pg from "pg";
import { sql, type Kysely } from "kysely";
import type { DatabaseSchema } from "@opensteer/database";
import { PluginResourceCategorySchema, type PluginResourceCategory } from "@opensteer/protocol";
import { pluginOwnerId } from "./engine-protocol.js";

export type EngineDemand = { busy: boolean; dueInMs: number | null };

const present =
  "SELECT to_regclass('plugin_engine.plugin_engine_workflow_runs') IS NOT NULL AS present";
// The engine's own wake sources (`scheduler.nextWake`, `events.nextWake`, webhook source retries)
// plus work that needs a live process: open workflows keep their timers in workerd, and claimed
// scheduled runs finish only in the process that claimed them. Timestamps are naive UTC.
const demand = `SELECT
  EXISTS (SELECT 1 FROM plugin_engine.plugin_engine_workflow_runs WHERE status IN ('queued', 'running'))
  OR EXISTS (SELECT 1 FROM plugin_engine.plugin_engine_schedules WHERE active_run IS NOT NULL)
  OR EXISTS (SELECT 1 FROM plugin_engine.plugin_engine_scheduled_runs WHERE status IN ('running', 'ready'))
  AS busy,
  EXTRACT(EPOCH FROM LEAST(
    (SELECT min(next_at) FROM plugin_engine.plugin_engine_schedules WHERE enabled AND active_run IS NULL),
    (SELECT min(expires_at) FROM plugin_engine.plugin_engine_scheduled_runs WHERE status = 'awaiting-approval'),
    (SELECT min(next_at) FROM plugin_engine.plugin_engine_event_deliveries WHERE status = 'pending'),
    (SELECT min(lease_until) FROM plugin_engine.plugin_engine_webhook_sources WHERE status <> 'ready')
  ) - (now() AT TIME ZONE 'UTC')) * 1000 AS due_in_ms`;

/** Background work the engine has saved, read without the engine running. */
async function readEngineState<T>(
  databaseUrl: string,
  read: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await read(client);
  } finally {
    await client.end();
  }
}
export async function engineDemand(databaseUrl: string): Promise<EngineDemand> {
  return readEngineState(databaseUrl, async (client) => {
    if (!(await client.query<{ present: boolean }>(present)).rows[0]?.present)
      return { busy: false, dueInMs: null };
    const row = (await client.query<{ busy: boolean; due_in_ms: string | null }>(demand)).rows[0];
    return {
      busy: row?.busy ?? true,
      dueInMs: row?.due_in_ms == null ? null : Number(row.due_in_ms),
    };
  });
}

/** The database, rather than a cache commit, decides which skill version a Run may pin. */
export async function engineActiveVersions(
  databaseUrl: string,
): Promise<ReadonlyMap<string, string>> {
  return readEngineState(databaseUrl, async (client) => {
    if (!(await client.query<{ present: boolean }>(present)).rows[0]?.present) return new Map();
    const rows = await client.query<{ id: string; active_deployment: string | null }>(
      "SELECT id, active_deployment FROM plugin_engine.plugin_engine_apps WHERE active_deployment IS NOT NULL",
    );
    return new Map(
      rows.rows.flatMap((row) => (row.active_deployment ? [[row.id, row.active_deployment]] : [])),
    );
  });
}

/** A completed install's saved result for this key, or null; read before any source is gathered. */
export async function engineInstallReceipt(database: Kysely<DatabaseSchema>, key: string) {
  const present = await sql<{
    present: boolean;
  }>`select to_regclass('plugin_engine.opensteer_resource_creations') is not null as present`.execute(
    database,
  );
  if (!present.rows[0]?.present) return null;
  const { rows } = await sql<{
    result: unknown;
  }>`select result from plugin_engine.opensteer_resource_creations where owner = ${pluginOwnerId} and key = ${key} and kind = 'plugin'`.execute(
    database,
  );
  return rows[0]?.result ?? null;
}

export const engineOAuthAttempt = (sql: SqlClient.SqlClient, connection: string) =>
  sql<{
    id: string;
    encrypted: Uint8Array;
  }>`select attempt.id, attempt.encrypted from plugin_engine_oauth_attempts attempt join plugin_engine_account_connections connection on connection.oauth_attempt = attempt.id where connection.id = ${connection}`;

export const lockEngineApp = (sql: SqlClient.SqlClient, app: string) =>
  sql`select id from plugin_engine_apps where id = ${app} for no key update`;

export const readEngineLinks = (sql: SqlClient.SqlClient, app: string) =>
  sql`select requirement, scope, account, consent from opensteer_account_links where app = ${app} order by created_at, account`;

/** Coalesce committed metadata without waiting for background activity to become quiet. */
export function backgroundResourceChanges(
  database: { readonly reactivity: ReactiveStore },
  notify: (categories: PluginResourceCategory[]) => void,
) {
  const tables = PluginResourceCategorySchema.options;
  return database.reactivity.changes.pipe(
    Stream.drop(1),
    Stream.filter((change) => tables.some((table) => change.tables.includes(table))),
    Stream.groupedWithin(100, "100 millis"),
    Stream.runForEach((changes) =>
      Effect.sync(() =>
        notify(tables.filter((table) => changes.some((change) => change.tables.includes(table)))),
      ),
    ),
  );
}

const historyPage = z.object({
  app: z.string().min(1),
  workflow: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
  live: z.boolean().optional(),
  runIds: z.array(z.string().min(1)).min(1).max(50).optional(),
});
const historyCursor = z.object({ filter: z.string(), at: z.string().min(1), id: z.string() });
const iso = (column: string) => `to_char(${column}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const live = "status not in ('complete', 'errored', 'terminated')";

/**
 * Newest first on (creation time, id), which never change, so a run that finishes between pages
 * is never read twice. `live` adds up to up to half a page of unfinished runs to the first page, so a
 * long-lived run older than the first page still shows; a later page can repeat one of those.
 */
export function workflowRunPage(sql: SqlClient.SqlClient, raw: unknown) {
  return Effect.gen(function* () {
    const input = yield* Effect.try(() => historyPage.parse(raw));
    const workflow = input.workflow ?? null;
    if (input.runIds) {
      const rows = yield* sql<WorkflowRunRow>`select ${sql.literal(workflowColumns)}
        from plugin_engine_workflow_runs where app = ${input.app}
          and (${workflow}::text is null or name = ${workflow})
          and id in ${sql.in(input.runIds)} order by created_at desc, id desc`;
      return { runs: rows.map(workflowRun), next: null };
    }
    const filter = digest(["workflows", input.app, workflow]);
    const cursor = yield* readCursor(input.cursor, filter);
    const lane =
      input.live && !cursor
        ? yield* sql<WorkflowRunRow>`select ${sql.literal(workflowColumns)}
            from plugin_engine_workflow_runs where app = ${input.app}
              and (${workflow}::text is null or name = ${workflow}) and ${sql.literal(live)}
            order by created_at desc, id desc limit ${Math.floor(input.limit / 2)}`
        : [];
    const rows = yield* sql<WorkflowRunRow>`select ${sql.literal(workflowColumns)}
      from plugin_engine_workflow_runs where app = ${input.app}
        and (${workflow}::text is null or name = ${workflow})
        and (${cursor?.id ?? null}::text is null
          or (created_at, id) < (${cursor?.at ?? null}::timestamp, ${cursor?.id ?? ""}))
      order by created_at desc, id desc limit ${input.limit - lane.length + 1}`;
    const page = rows.slice(0, input.limit - lane.length);
    const shown = new Set(lane.map(({ id }) => id));
    return {
      runs: [...lane, ...page.filter(({ id }) => !shown.has(id))].map(workflowRun),
      next: nextCursor(rows.length > page.length, page.at(-1), filter),
    };
  });
}

/** One page of scheduled runs, newest first on their immutable start time and id, each bounded. */
export function scheduledRunPage(
  sql: SqlClient.SqlClient,
  raw: { app: string; owner: string; limit: number; pending?: boolean; cursor?: string },
) {
  return Effect.gen(function* () {
    const filter = digest(["schedules", raw.app, raw.owner, raw.pending === true]);
    const cursor = yield* readCursor(raw.cursor, filter);
    const rows = yield* sql<{ id: string; at: string }>`select id, schedule_id as "scheduleId",
        app, owner, name, status, ${sql.literal(iso("scheduled_at"))} as "scheduledAt",
        ${sql.literal(iso("started_at"))} as "startedAt", ${sql.literal(iso("finished_at"))} as "finishedAt",
        request_id as "requestId", ${sql.literal(iso("expires_at"))} as "expiresAt",
        left(failure, 1000) as failure, started_at::text as at
      from plugin_engine_scheduled_runs where app = ${raw.app} and owner = ${raw.owner}
        and (${raw.pending === true} = false or status = 'awaiting-approval')
        and (${cursor?.id ?? null}::text is null
          or (started_at, id) < (${cursor?.at ?? null}::timestamp, ${cursor?.id ?? ""}))
      order by started_at desc, id desc limit ${raw.limit + 1}`;
    const page = rows.slice(0, raw.limit);
    return {
      runs: page.map(({ at: _at, ...run }) => run),
      next: nextCursor(rows.length > page.length, page.at(-1), filter),
    };
  });
}

type WorkflowRunRow = {
  id: string;
  app: string;
  version: string;
  workflow: string;
  status: string;
  createdAt: string;
  failure: string | null;
  at: string;
};
// `at` is the key's own text, which casts back to the exact stored timestamp.
const workflowColumns = `id, app, deployment as version, name as workflow, status, failure,
  ${iso("created_at")} as "createdAt", created_at::text as at`;
const workflowRun = ({ at: _at, failure, ...run }: WorkflowRunRow) => ({
  ...run,
  ...(run.status === "errored" ? { error: failure ?? "errored" } : {}),
});
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const readCursor = (raw: string | undefined, filter: string) =>
  Effect.gen(function* () {
    if (!raw) return undefined;
    const cursor = yield* Effect.try(() =>
      historyCursor.parse(JSON.parse(Buffer.from(raw, "base64url").toString())),
    );
    if (cursor.filter !== filter)
      return yield* Effect.fail(new Error("History cursor belongs to another listing"));
    return cursor;
  });
const nextCursor = (more: boolean, last: { id: string; at: string } | undefined, filter: string) =>
  more && last
    ? Buffer.from(JSON.stringify({ filter, at: last.at, id: last.id })).toString("base64url")
    : undefined;

/**
 * Rebuilds after an upgrade: a per-plugin claim that one engine process holds at a time (a
 * session advisory lock on a connection of its own, taken before any row lock), and the
 * diagnostic of a rebuild that failed for good, kept with the version that failed.
 */
export const rebuildStore = (sql: SqlClient.SqlClient) => ({
  claim: <A, E>(app: string, work: Effect.Effect<A, E>) =>
    sql.reserve.pipe(
      Effect.flatMap((connection) =>
        Effect.acquireUseRelease(
          connection.execute(
            "SELECT pg_advisory_lock(hashtextextended($1, 0))",
            [`plugin-rebuild:${app}`],
            undefined,
          ),
          () => work,
          () =>
            connection
              .execute(
                "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
                [`plugin-rebuild:${app}`],
                undefined,
              )
              .pipe(Effect.orDie),
        ),
      ),
      Effect.scoped,
    ),
  failed: (app: string, failure: { readonly version: string; readonly message: string }) =>
    sql`INSERT INTO opensteer_plugin_rebuild_failures (app, version, message)
      VALUES (${app}, ${failure.version}, ${failure.message.slice(0, 4_000)})
      ON CONFLICT (app) DO UPDATE SET version = EXCLUDED.version, message = EXCLUDED.message,
        failed_at = clock_timestamp()`.pipe(Effect.asVoid),
  cleared: (app: string) =>
    sql`DELETE FROM opensteer_plugin_rebuild_failures WHERE app = ${app}`.pipe(Effect.asVoid),
});

/** Why a plugin's rebuild failed for good, with the version that failed, if it did. */
export const readRebuildFailure = (sql: SqlClient.SqlClient, app: string) =>
  sql<{ version: string; message: string }>`
    SELECT version, message FROM opensteer_plugin_rebuild_failures WHERE app = ${app}`.pipe(
    Effect.map((rows) => rows[0] ?? null),
  );

export const migrateEngineProduct = (sql: SqlClient.SqlClient) =>
  sql
    .unsafe(
      `
  CREATE TABLE IF NOT EXISTS opensteer_account_links (
    app text NOT NULL REFERENCES plugin_engine_apps(id) ON DELETE CASCADE,
    requirement text NOT NULL, scope text NOT NULL CHECK (scope IN ('app', 'user')),
    account text NOT NULL REFERENCES plugin_engine_accounts(id) ON DELETE CASCADE,
    consent text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (app, requirement, scope, account)
  )`,
    )
    .pipe(
      Effect.andThen(
        sql.unsafe(
          `CREATE TABLE IF NOT EXISTS opensteer_resource_creations (owner text NOT NULL, key text NOT NULL, kind text NOT NULL, result jsonb NOT NULL, PRIMARY KEY (owner, key, kind))`,
        ),
      ),
      Effect.andThen(
        sql.unsafe(`
  CREATE TABLE IF NOT EXISTS opensteer_plugin_rebuild_failures (
    app text PRIMARY KEY REFERENCES plugin_engine_apps(id) ON DELETE CASCADE,
    version text NOT NULL, message text NOT NULL,
    failed_at timestamptz NOT NULL DEFAULT clock_timestamp()
  )`),
      ),
      Effect.andThen(
        sql.unsafe(`
  CREATE TABLE IF NOT EXISTS opensteer_oauth_connections (
    connection text PRIMARY KEY, app text NOT NULL, requirement text NOT NULL,
    scope text NOT NULL, consent text NOT NULL, owner_user_id text, local_attempt text, account_binding jsonb
  )`),
      ),
    );

const engineStorageColumns = {
  plugin_engine_apps: ["id", "active_deployment"],
  plugin_engine_accounts: ["id"],
  plugin_engine_schedules: ["id", "enabled", "active_run", "next_at", "approval_mode"],
  plugin_engine_scheduled_runs: [
    "id",
    "schedule_id",
    "app",
    "owner",
    "name",
    "status",
    "scheduled_at",
    "started_at",
    "finished_at",
    "request_id",
    "failure",
    "expires_at",
  ],
  plugin_engine_workflow_runs: [
    "id",
    "app",
    "deployment",
    "name",
    "status",
    "failure",
    "created_at",
  ],
  plugin_engine_event_deliveries: ["status", "next_at"],
  plugin_engine_webhook_sources: [
    "id",
    "status",
    "failure",
    "lease_until",
    "reconciled_deployment",
  ],
  plugin_engine_webhooks: ["id", "status", "revision", "failure"],
  plugin_engine_oauth_attempts: ["id", "encrypted"],
  plugin_engine_account_connections: ["id", "oauth_attempt"],
};
export function qualifyEngineStorage(sql: SqlClient.SqlClient) {
  return Effect.forEach(
    Object.entries(engineStorageColumns),
    ([table, columns]) =>
      sql
        .unsafe(`select ${columns.join(", ")} from ${table} limit 0`)
        .pipe(
          Effect.mapError(
            () =>
              new Error(
                `Plugin engine import changed storage required by the Host adapter: ${table} (${columns.join(", ")})`,
              ),
          ),
        ),
    { discard: true },
  );
}
