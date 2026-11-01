import { sql } from "kysely";
import { expect, it } from "vitest";
import { createDatabase } from "./connection.js";
import { threadAskedAtMigration } from "./migrations.js";

it.runIf(Boolean(process.env.OPENSTEER_TEST_DATABASE_URL))(
  "backfills human asks, including ones cancelled later, at millisecond precision and is idempotent",
  async () => {
    const database = createDatabase({ connectionString: process.env.OPENSTEER_TEST_DATABASE_URL! });
    try {
      await database.transaction().execute(async (tx) => {
        await sql`
          create temporary table threads (id text primary key, created_at timestamptz not null) on commit drop;
          create temporary table messages (id text primary key, thread_id text, kind text, author jsonb, created_at timestamptz) on commit drop;
          create temporary table thread_inputs (message_id text, policy text) on commit drop;
          insert into threads values
            ('asked', '2020-01-01T00:00:00.123456Z'),
            ('unasked', '2020-01-01T00:00:00.123456Z');
          insert into messages values
            ('human', 'asked', 'input', '{"kind":"human"}', '2021-01-01T00:00:00Z'),
            ('queued', 'asked', 'input', '{"kind":"human"}', '2021-06-01T00:00:00Z'),
            ('cancelled-later', 'asked', 'input', '{"kind":"human"}', '2022-01-01T00:00:00.987654Z'),
            ('agent', 'asked', 'input', '{"kind":"agent"}', '2023-01-01T00:00:00Z'),
            ('platform', 'asked', 'input', '{"kind":"platform","cause":"assignment-result"}', '2023-01-01T00:00:00Z'),
            ('trigger', 'asked', 'input', '{"kind":"trigger"}', '2023-01-01T00:00:00Z'),
            ('report', 'asked', 'input', '{"kind":"human"}', '2023-01-01T00:00:00Z'),
            ('reply', 'asked', 'assistant', '{"kind":"human"}', '2023-01-01T00:00:00Z'),
            ('missing', 'asked', 'input', '{"kind":"human"}', '2023-01-01T00:00:00Z');
          insert into thread_inputs values
            ('human', 'steer'), ('queued', 'queue'), ('cancelled-later', 'queue'), ('agent', 'queue'),
            ('platform', 'queue'), ('trigger', 'queue'), ('report', 'report'), ('reply', 'queue');
        `.execute(tx);
        const read = async () =>
          (
            await sql<{ id: string; askedAt: Date }>`
              select id, asked_at from threads order by id
            `.execute(tx)
          ).rows.map((row) => [row.id, row.askedAt.toISOString()]);
        await threadAskedAtMigration.up(tx);
        const first = await read();
        expect(first).toEqual([
          ["asked", "2022-01-01T00:00:00.987Z"],
          ["unasked", "2020-01-01T00:00:00.123Z"],
        ]);
        await threadAskedAtMigration.up(tx);
        expect(await read()).toEqual(first);
        // The previous release's Host inserts Threads without the column.
        const inserted = await sql<{ askedAt: Date | null }>`
          insert into threads (id, created_at) values ('old-host', now()) returning asked_at
        `.execute(tx);
        expect(inserted.rows[0]?.askedAt).toBeInstanceOf(Date);
      });
    } finally {
      await database.destroy();
    }
  },
);
