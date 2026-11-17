import { createHash } from "node:crypto";
// Direct engine-schema dependencies: re-qualify this adapter on every import.
import { Effect, Stream } from "effect";
import type { SqlClient } from "effect/sql";
import type { ReactiveStore } from "@opensteer/plugin-engine-reactivity";
import { z } from "zod";
import pg from "pg";

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

export const engineOAuthAttempt = (sql: SqlClient.SqlClient, connection: string) =>
  sql<{
    id: string;
    encrypted: Uint8Array;
  }>`select attempt.id, attempt.encrypted from plugin_engine_oauth_attempts attempt join plugin_engine_account_connections connection on connection.oauth_attempt = attempt.id where connection.id = ${connection}`;

export const lockEngineApp = (sql: SqlClient.SqlClient, app: string) =>
  sql`select id from plugin_engine_apps where id = ${app} for no key update`;

export const readEngineLinks = (sql: SqlClient.SqlClient, app: string) =>
  sql`select requirement, scope, account, consent from opensteer_account_links where app = ${app} order by created_at, account`;

/** Only resource state enters the signature; workflow progress and leases do not. */
export function backgroundResourceChanges(
  database: { readonly reactivity: ReactiveStore },
  sql: SqlClient.SqlClient,
  notify: () => void,
) {
  const tables = ["scheduledRuns", "workflowRuns", "webhooks", "webhookSources", "schedules"];
  const snapshot = database.reactivity.read(
    tables,
    sql<{ signature: string }>`select md5(jsonb_build_array(
    (select jsonb_agg(row(id, status, failure) order by id) from plugin_engine_scheduled_runs),
    (select jsonb_agg(row(id, status, failure) order by id) from plugin_engine_workflow_runs),
    (select jsonb_agg(row(id, status, revision, failure) order by id) from plugin_engine_webhooks),
    (select jsonb_agg(row(id, status, failure, reconciled_deployment) order by id) from plugin_engine_webhook_sources),
    (select jsonb_agg(row(id, enabled, approval_mode, next_at) order by id) from plugin_engine_schedules)
  )::text) as signature`,
  );
  return database.reactivity.subscribe(snapshot).pipe(
    Stream.map(({ value }) => value[0]?.signature),
    Stream.changes,
    Stream.drop(1),
    Stream.debounce("100 millis"),
    Stream.runForEach(() => Effect.sync(notify)),
  );
}

const workflowPage = z.object({
  app: z.string().min(1),
  workflow: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});
const workflowCursor = z.object({
  filter: z.string(),
  live: z.number().int().min(0).max(1),
  at: z.string().datetime(),
  id: z.string(),
});
export function ownerWorkflowRunIds(sql: SqlClient.SqlClient, raw: unknown) {
  return Effect.gen(function* () {
    const input = yield* Effect.try(() => workflowPage.parse(raw));
    const filter = createHash("sha256")
      .update(JSON.stringify([input.app, input.workflow ?? null]))
      .digest("hex");
    const cursor = yield* Effect.try(() =>
      input.cursor
        ? workflowCursor.parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString()))
        : undefined,
    );
    if (cursor && cursor.filter !== filter)
      return yield* Effect.fail(new Error("Workflow cursor belongs to another listing"));
    const rows = yield* sql<{
      id: string;
      live: number;
      created_at: Date;
    }>`select id, case when status in ('queued', 'running') then 0 else 1 end as live, created_at
      from plugin_engine_workflow_runs where app = ${input.app}
        and (${input.workflow ?? null}::text is null or name = ${input.workflow ?? null})
        and (${cursor?.id ?? null}::text is null or (case when status in ('queued', 'running') then 0 else 1 end > ${cursor?.live ?? 0})
          or (case when status in ('queued', 'running') then 0 else 1 end = ${cursor?.live ?? 0} and (created_at, id) < (${cursor?.at ?? new Date(0).toISOString()}::timestamp, ${cursor?.id ?? ""})))
      order by live asc, created_at desc, id desc limit ${input.limit + 1}`;
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      ids: page.map(({ id }) => id),
      next:
        rows.length > input.limit && last
          ? Buffer.from(
              JSON.stringify({
                filter,
                live: last.live,
                at: new Date(last.created_at).toISOString(),
                id: last.id,
              }),
            ).toString("base64url")
          : undefined,
    };
  });
}

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
  plugin_engine_scheduled_runs: ["id", "status", "failure", "expires_at"],
  plugin_engine_workflow_runs: ["id", "app", "name", "status", "failure", "created_at"],
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
