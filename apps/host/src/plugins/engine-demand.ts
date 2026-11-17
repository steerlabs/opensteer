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
