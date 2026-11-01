import { sql } from "kysely";
import { expect } from "vitest";
import { threadAskedAtMigration } from "./migrations.js";
import { testModelSelection, describeStore } from "./store.integration.test-support.js";

describeStore("Thread asked time migration", (it) => {
  it("backfills admitted human work at millisecond precision and is idempotent", async ({
    storeFixture,
  }) => {
    const { database, createRunFixture } = storeFixture;
    const asked = await createRunFixture("asked-migration");
    const untouched = await storeFixture.store.createThread({
      createdBy: asked.userId,
      environmentId: asked.environmentId,
      harnessInstanceId: asked.harnessInstance.id,
      idempotencyKey: "unasked-migration",
      modelSelection: testModelSelection,
      title: "Unasked",
      workspaceId: asked.workspace.id,
    });
    await database.transaction().execute(async (tx) => {
      // Shadow the input history while keeping the real threads table and its schema default.
      await sql`
        create temporary table messages (id text primary key, thread_id text, kind text, author jsonb, created_at timestamptz) on commit drop;
        create temporary table thread_inputs (message_id text, policy text, cancel_reason text) on commit drop;
        alter table public.threads drop column asked_at;
        update public.threads set created_at = '2020-01-01T00:00:00.123456Z';
      `.execute(tx);
      await sql`
        insert into messages values
          ('human', ${asked.thread.id}, 'input', '{"kind":"human"}', '2021-01-01T00:00:00Z'),
          ('queued', ${asked.thread.id}, 'input', '{"kind":"human"}', '2022-01-01T00:00:00.987654Z'),
          ('agent', ${asked.thread.id}, 'input', '{"kind":"agent"}', '2023-01-01T00:00:00Z'),
          ('platform', ${asked.thread.id}, 'input', '{"kind":"platform","cause":"assignment-result"}', '2023-01-01T00:00:00Z'),
          ('trigger', ${asked.thread.id}, 'input', '{"kind":"trigger"}', '2023-01-01T00:00:00Z'),
          ('report', ${asked.thread.id}, 'input', '{"kind":"human"}', '2023-01-01T00:00:00Z'),
          ('cancelled', ${asked.thread.id}, 'input', '{"kind":"human"}', '2023-01-01T00:00:00Z'),
          ('reply', ${asked.thread.id}, 'assistant', '{"kind":"human"}', '2023-01-01T00:00:00Z'),
          ('missing', ${asked.thread.id}, 'input', '{"kind":"human"}', '2023-01-01T00:00:00Z');
      `.execute(tx);
      await sql`
        insert into thread_inputs values
          ('human', 'steer', null), ('queued', 'queue', null), ('agent', 'queue', null),
          ('platform', 'queue', null), ('trigger', 'queue', null), ('report', 'report', null),
          ('cancelled', 'queue', 'execution-authority-unavailable'), ('reply', 'queue', null);
      `.execute(tx);
      await threadAskedAtMigration.up(tx);
      const first = await tx
        .selectFrom("threads")
        .select(["id", "askedAt"])
        .orderBy("id")
        .execute();
      expect(first.find(({ id }) => id === asked.thread.id)?.askedAt.toISOString()).toBe(
        "2022-01-01T00:00:00.987Z",
      );
      expect(first.find(({ id }) => id === untouched.thread.id)?.askedAt.toISOString()).toBe(
        "2020-01-01T00:00:00.123Z",
      );
      const precision = await sql<{ precise: boolean }>`
        select bool_and(asked_at = date_trunc('milliseconds', asked_at)) as precise from public.threads
      `.execute(tx);
      expect(precision.rows[0]?.precise).toBe(true);
      await threadAskedAtMigration.up(tx);
      expect(
        await tx.selectFrom("threads").select(["id", "askedAt"]).orderBy("id").execute(),
      ).toEqual(first);
      const column = await sql<{
        columnDefault: string;
      }>`select column_default as column_default from information_schema.columns where table_schema = 'public' and table_name = 'threads' and column_name = 'asked_at'`.execute(
        tx,
      );
      expect(column.rows[0]?.columnDefault).toBe("now()");
    });
  });
});
