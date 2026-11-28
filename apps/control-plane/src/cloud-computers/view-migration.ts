import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const cloudComputerViewMigration: Migration = {
  async up(database) {
    await sql`alter table public.cloud_computers add column renews_at timestamptz`.execute(
      database,
    );
    await sql`alter table public.cloud_computer_egress_endpoints add column public_address text`.execute(
      database,
    );
  },
};
