import { sql } from "kysely";
import { expect, it } from "vitest";
import { createDatabase } from "./connection.js";
import { personAskedThreadsMigration } from "./migrations.js";

it.runIf(Boolean(process.env.OPENSTEER_TEST_DATABASE_URL))(
  "lists only roots and work a person's Chat turn handed off, and repairs every stored snapshot",
  async () => {
    const database = createDatabase({ connectionString: process.env.OPENSTEER_TEST_DATABASE_URL! });
    try {
      const { once, twice } = await database.transaction().execute(async (tx) => {
        // Temporary tables shadow the Host's own, so the migration sees only this world.
        await sql`
          create temporary table threads (id text primary key, parent_thread_id text, role text, listed boolean) on commit drop;
          create temporary table delegations (child_thread_id text, parent_thread_id text, parent_run_id text, origin text) on commit drop;
          create temporary table runs (id text primary key, seed_input_id text) on commit drop;
          create temporary table messages (id text primary key, author jsonb) on commit drop;
          create temporary table workspace_events (event_id text primary key, thread_id text, type text, data jsonb) on commit drop;

          insert into messages values
            ('said', '{"kind":"human"}'), ('returned', '{"kind":"platform","cause":"assignment-result"}'),
            ('fired', '{"kind":"trigger"}'), ('task-said', '{"kind":"human"}');
          insert into runs values
            ('chat-person', 'said'), ('chat-return', 'returned'), ('chat-fired', 'fired'), ('task-person', 'task-said');

          insert into threads values
            ('chat', null, 'conversation', true),
            ('task', null, 'work', true),
            ('asked', 'chat', 'work', true),
            ('follow-up', 'chat', 'work', true),
            ('monitor', 'task', 'work', true),
            ('scheduled', 'chat', 'work', true),
            ('helper', 'task', 'work', false),
            ('retasked', 'task', 'work', false);
          insert into delegations values
            ('asked', 'chat', 'chat-person', 'run'),
            ('follow-up', 'chat', 'chat-return', 'run'),
            ('monitor', 'task', 'task-person', 'run'),
            ('monitor', 'chat', null, 'trigger'),
            ('scheduled', 'chat', null, 'trigger'),
            ('helper', 'task', 'task-person', 'run'),
            ('retasked', 'task', 'task-person', 'run'),
            ('retasked', 'chat', 'chat-person', 'run'),
            ('task', 'chat', 'chat-fired', 'run');

          insert into workspace_events values
            ('monitor-created', 'monitor', 'thread.created', '{"thread":{"id":"monitor","listed":false}}'),
            ('monitor-listed', 'monitor', 'thread.listed', '{"thread":{"id":"monitor","listed":true}}'),
            ('monitor-execution', 'monitor', 'thread.execution-updated', '{"thread":{"id":"monitor","listed":true}}'),
            ('asked-created', 'asked', 'thread.created', '{"thread":{"id":"asked","listed":true}}'),
            ('retasked-created', 'retasked', 'thread.created', '{"thread":{"id":"retasked","listed":false}}'),
            ('monitor-queued', 'monitor', 'run.queued', '{"run":{"threadId":"monitor"}}');
        `.execute(tx);
        const state = async () => ({
          events: (
            await sql<{
              id: string;
              data: unknown;
            }>`select event_id as id, data from workspace_events order by event_id`.execute(tx)
          ).rows,
          threads: (
            await sql<{
              id: string;
              listed: boolean;
            }>`select id, listed from threads order by id`.execute(tx)
          ).rows,
        });
        await personAskedThreadsMigration.up(tx);
        const once = await state();
        await personAskedThreadsMigration.up(tx);
        return { once, twice: await state() };
      });

      expect(Object.fromEntries(once.threads.map(({ id, listed }) => [id, listed]))).toEqual({
        // Roots stay listed, even when an automation-woken Chat turn later gave one work.
        chat: true,
        task: true,
        // A person's Chat turn handed these off, at creation or by re-tasking.
        asked: true,
        retasked: true,
        // Chat woke for a returning task, an automation re-tasked a task's helper, or a
        // schedule created it: none of these is work a person asked for.
        "follow-up": false,
        monitor: false,
        scheduled: false,
        helper: false,
      });
      expect(Object.fromEntries(once.events.map(({ id, data }) => [id, data]))).toEqual({
        "asked-created": { thread: { id: "asked", listed: true } },
        "monitor-created": { thread: { id: "monitor", listed: false } },
        "monitor-execution": { thread: { id: "monitor", listed: false } },
        "monitor-listed": { thread: { id: "monitor", listed: false } },
        "monitor-queued": { run: { threadId: "monitor" } },
        "retasked-created": { thread: { id: "retasked", listed: true } },
      });
      expect(twice).toEqual(once);
    } finally {
      await database.destroy();
    }
  },
);
