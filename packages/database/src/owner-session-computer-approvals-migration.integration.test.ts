import { sql } from "kysely";
import { expect, it } from "vitest";
import { createDatabase } from "./connection.js";
import { ownerSessionComputerApprovalsMigration } from "./migrations.js";

it.runIf(Boolean(process.env.OPENSTEER_TEST_DATABASE_URL))(
  "removes locality keys and signature envelopes while preserving committed policy",
  async () => {
    const database = createDatabase({ connectionString: process.env.OPENSTEER_TEST_DATABASE_URL! });
    const rollback = new Error("Rollback migration fixture");
    try {
      await expect(
        database.transaction().execute(async (tx) => {
          await sql`alter table public.computer_use_policies rename to computer_use_policies_saved;
        create table public.computer_use_policies (app_approval text, revision integer, approval jsonb);
        create table public.computer_use_approval_keys (runner_id text, public_key_pem text);
        insert into public.computer_use_policies values ('automatic', 7, '{"signature":"obsolete"}');
        insert into public.computer_use_approval_keys values ('computer', 'obsolete');`.execute(tx);
          await ownerSessionComputerApprovalsMigration.up(tx);
          await ownerSessionComputerApprovalsMigration.up(tx);
          expect(
            (
              await sql<{
                appApproval: string;
                revision: number;
              }>`select * from public.computer_use_policies`.execute(tx)
            ).rows,
          ).toEqual([{ appApproval: "automatic", revision: 7 }]);
          expect(
            (
              await sql<{
                name: string | null;
              }>`select to_regclass('public.computer_use_approval_keys')::text as name`.execute(tx)
            ).rows,
          ).toEqual([{ name: null }]);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    } finally {
      await database.destroy();
    }
  },
);
