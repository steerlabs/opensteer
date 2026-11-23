import { sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * A directory entry is a name and the exact origins it is verified by. The signing keys and the
 * platforms an entry was embedded through served only verification through a platform, which no
 * longer exists, so they are dropped.
 */
export const platformVerificationRemovalMigration: Migration = {
  async up(database) {
    await sql`
      alter table public.agent_directory_entries
        drop column if exists keys,
        drop column if exists embeds_via
    `.execute(database);
  },
};
