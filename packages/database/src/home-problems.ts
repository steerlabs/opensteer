import { harnessKinds } from "@opensteer/core";
import {
  reportTime,
  type Problem,
  type ProblemCode,
  type ProblemFields,
} from "@opensteer/protocol/problems";
import { sql, type Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";

/** How far back an outcome that already ended still counts as a problem now. */
export const recentProblemDays = 7;
/** A Disconnect still converging this long after it was asked is stuck. */
const stoppingStuckMinutes = 15;

interface ProblemRow {
  readonly code: ProblemCode;
  readonly field: string | null;
  readonly count: number;
  // The database's camel-case plugin names the result columns.
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
}

const engines = new Set<string>(harnessKinds);

/** The one field each stored problem carries, from the row's `field` column. */
function fieldsOf(code: ProblemCode, field: string | null): ProblemFields {
  switch (code) {
    case "engine.inspection_failed":
      return { engine: field && engines.has(field) ? (field as never) : "other" };
    case "operation.outcome_unknown":
      return { operation: field as NonNullable<ProblemFields["operation"]> };
    case "sign_in.unfinished":
      return { surface: field as NonNullable<ProblemFields["surface"]> };
    case "update.failed":
      return { updateTarget: "desktop", updateResult: "failed" };
    default:
      return {};
  }
}

/**
 * The problems this Home knows from the rows it already keeps, now: an engine that failed
 * inspection, a Stop that could not be confirmed, an outcome that may or may not have happened,
 * a plugin sign-in that did not finish, a desktop update that failed, a Disconnect that has not
 * converged. One statement, each part over a partial index or a small table; nothing is written.
 * It is never on a hot path: the person's Settings, `opensteer_state` and the report timer read
 * it. What only the machine knows (services, backups, disk) is added by the Host.
 */
export async function readStoredProblems(database: Kysely<DatabaseSchema>): Promise<Problem[]> {
  const recent = sql`now() - make_interval(days => ${recentProblemDays})`;
  const result = await sql<ProblemRow>`
    select 'engine.inspection_failed' as code, catalog->>'driverKind' as field,
      count(*)::int as count, min(captured_at) as first_seen_at, max(captured_at) as last_seen_at
      from harness_catalogs where catalog->>'status' = 'error'
      group by catalog->>'driverKind'
    union all
    select 'stop.unconfirmed', null, count(*)::int, min(updated_at), max(updated_at)
      from threads where unconfirmed_stop_run_id is not null having count(*) > 0
    union all
    select 'operation.outcome_unknown', 'agent-operation', count(*)::int,
      min(completed_at), max(completed_at)
      from agent_operations where outcome = 'unknown' and completed_at > ${recent}
      having count(*) > 0
    union all
    select 'operation.outcome_unknown', 'automation-firing', count(*)::int,
      min(updated_at), max(updated_at)
      from trigger_occurrences where status = 'unknown' and updated_at > ${recent}
      having count(*) > 0
    union all
    select 'operation.outcome_unknown', 'chat-reply', count(*)::int, min(updated_at), max(updated_at)
      from bridge_deliveries where status = 'unknown' and updated_at > ${recent}
      having count(*) > 0
    union all
    select 'sign_in.unfinished', surface, count(*)::int, min(created_at), max(created_at)
      from integration_auth_attempts
      where created_at > ${recent}
        and (status = 'failed' or (status in ('pending', 'launched') and expires_at < now()))
      group by surface
    union all
    select 'update.failed', null, count(*)::int, min(updated_at), max(updated_at)
      from personal_desktop_update where state = 'failed' and updated_at > ${recent}
      having count(*) > 0
    union all
    select 'connection.stopping_stuck', null, count(*)::int,
      min(cleanup_requested_at), max(cleanup_requested_at)
      from agent_connections
      where cleanup_requested_at < now() - make_interval(mins => ${stoppingStuckMinutes})
        and cleanup_completed_at is null
      having count(*) > 0
  `.execute(database);
  // Engines outside the product's own list are counted together, as one "other".
  const merged = new Map<string, Problem>();
  for (const row of result.rows) {
    const fields = fieldsOf(row.code, row.field);
    const key = `${row.code} ${JSON.stringify(fields)}`;
    // To the minute, as every report time is (ReportTimeSchema).
    const firstSeenAt = reportTime(row.firstSeenAt);
    const lastSeenAt = reportTime(row.lastSeenAt);
    const known = merged.get(key);
    merged.set(
      key,
      known
        ? {
            ...known,
            count: known.count + row.count,
            firstSeenAt: known.firstSeenAt < firstSeenAt ? known.firstSeenAt : firstSeenAt,
            lastSeenAt: known.lastSeenAt > lastSeenAt ? known.lastSeenAt : lastSeenAt,
          }
        : { code: row.code, count: row.count, firstSeenAt, lastSeenAt, fields },
    );
  }
  return [...merged.values()];
}
