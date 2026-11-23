import { sql, type Kysely } from "kysely";

/**
 * Removes the T10 wake limit and per-computer kept-alive script limit fuses:
 * - Drops `automation_wakes`, `triggers.wake_limit_per_hour`, and
 *   `execution_environments.max_active_watches`.
 * - Removes `'wake-limit-reached'` from `automation_failure_notices`.
 */
export const removeAutomationFusesMigrationName = "0058_remove_automation_fuses_contract";

export async function applyRemoveAutomationFuses(database: Kysely<unknown>): Promise<void> {
  await sql`
    drop table if exists automation_wakes;
    alter table triggers drop column if exists wake_limit_per_hour;
    alter table triggers drop column if exists webhook_secret_hash;
    alter table execution_environments drop column if exists max_active_watches;

    delete from automation_failure_notices where reason = 'wake-limit-reached';
    alter table automation_failure_notices
      drop constraint if exists automation_failure_notices_reason_check;
    alter table automation_failure_notices
      add constraint automation_failure_notices_reason_check check (
        reason in (
          'final-occurrence-failed',
          'final-occurrence-interrupted',
          'paused',
          'started-failing',
          'overran-schedule',
          'watch-crash-loop',
          'outcome-unknown'
        )
      );
  `.execute(database);
}
