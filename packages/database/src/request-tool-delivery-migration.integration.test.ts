import { sql } from "kysely";
import { expect, it } from "vitest";
import { createDatabase } from "./connection.js";
import { requestToolDeliveryMigration } from "./migrations.js";

it.runIf(Boolean(process.env.OPENSTEER_TEST_DATABASE_URL))(
  "allows delivered continuations only with an attempt time and no reason",
  async () => {
    const database = createDatabase({ connectionString: process.env.OPENSTEER_TEST_DATABASE_URL! });
    try {
      await database.transaction().execute(async (tx) => {
        await sql`create temporary table request_continuations (
          status text not null, attempted_at timestamptz, reason text,
          constraint request_continuations_status_check check (status in ('waiting', 'queued', 'undeliverable')),
          constraint request_continuations_state_check check (
            (status = 'waiting' and reason is null) or
            (status = 'queued' and attempted_at is not null and reason is null) or
            (status = 'undeliverable' and attempted_at is not null and reason is not null)
          )
        ) on commit drop`.execute(tx);
        await sql`insert into request_continuations values ('waiting', null, null), ('queued', now(), null), ('undeliverable', now(), 'gone')`.execute(
          tx,
        );
        await requestToolDeliveryMigration.up(tx);
        await sql`insert into request_continuations values ('delivered', now(), null)`.execute(tx);
        for (const [attemptedAt, reason] of [
          [null, null],
          [new Date(), "not allowed"],
        ] as const) {
          await sql`savepoint invalid_delivery`.execute(tx);
          await expect(
            sql`insert into request_continuations values ('delivered', ${attemptedAt}, ${reason})`.execute(
              tx,
            ),
          ).rejects.toMatchObject({
            code: "23514",
            constraint: "request_continuations_state_check",
          });
          await sql`rollback to savepoint invalid_delivery`.execute(tx);
        }
        expect((await sql`select * from request_continuations`.execute(tx)).rows).toHaveLength(4);
      });
    } finally {
      await database.destroy();
    }
  },
);
