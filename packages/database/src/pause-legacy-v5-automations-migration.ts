import { sql, type Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";

export const pauseLegacyV5AutomationsMigrationName = "0056_pause_legacy_v5_automations";

/**
 * One-time transition from the removed v5 JS/TS program runtime to script automations (T14, Y16):
 * - Pauses every active user-authored automation whose current revision has no script row in
 *   `trigger_revision_scripts`, setting `pause_reason` to "Needs an update: ask your agent",
 *   `paused_by = 'system'`, `paused_at = now()`, and clearing `next_fire_at`.
 * - Stops any active `trigger_watch_activations` belonging to those legacy v5 watches.
 * - Preserves `trigger_revisions.program` untouched so an agent can read the legacy source and
 *   rewrite it.
 * - Leaves script-based automations, system memory passes (`system_role is not null`, which
 *   `MemoryPassService` upgrades automatically), and archived automations untouched.
 */
export async function applyPauseLegacyV5Automations(
  database: Kysely<DatabaseSchema>,
): Promise<void> {
  await sql`
    update triggers
    set
      status = 'paused',
      next_fire_at = null,
      pause_reason = 'Needs an update: ask your agent',
      paused_by = 'system',
      paused_by_thread_id = null,
      paused_at = now(),
      updated_at = now()
    where status = 'active'
      and system_role is null
      and not exists (
        select 1 from trigger_revision_scripts
        where trigger_revision_scripts.revision_id = triggers.current_revision_id
      );

    update trigger_watch_activations
    set
      desired = 'stopped',
      updated_at = now()
    where desired = 'active'
      and trigger_id in (
        select id from triggers
        where system_role is null
          and not exists (
            select 1 from trigger_revision_scripts
            where trigger_revision_scripts.revision_id = triggers.current_revision_id
          )
      );
  `.execute(database);
}
