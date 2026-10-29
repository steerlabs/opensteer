import { mkdir, writeFile } from "node:fs/promises";
import { sql } from "kysely";
import { expect, it } from "vitest";
import { createDatabase } from "./connection.js";
import { taskDoneMigration } from "./migrations.js";

it.runIf(Boolean(process.env.OPENSTEER_TEST_DATABASE_URL))(
  "carries over the creator's effective Done, excluding unread, pending, Chat and channel tasks",
  async () => {
    const database = createDatabase({ connectionString: process.env.OPENSTEER_TEST_DATABASE_URL! });
    try {
      const rows = await database.transaction().execute(async (tx) => {
        await sql`
          create temporary table agent_control_requests (action text constraint agent_control_requests_action_check check (action in ('environment.list', 'thread.read')), action_class text constraint agent_control_requests_action_class_check check (action_class in ('environment.list', 'thread.read'))) on commit drop;
          create temporary table requests (originating_thread_id text, status text, cancellation_reason text constraint requests_cancellation_reason_check check (cancellation_reason is null)) on commit drop;
          create temporary table threads (id text primary key, workspace_id text, created_by text, role text, listed boolean, status text, input_queue_paused boolean, updated_at timestamptz, input_queue_paused_by text) on commit drop;
          create temporary table delegations (status text, child_thread_id text, parent_thread_id text) on commit drop;
          create temporary table runs (id text, thread_id text, status text, run_ordinal integer) on commit drop;
          create temporary table workspaces (id text, home_thread_id text) on commit drop;
          create temporary table channel_conversation_contexts (active_thread_id text) on commit drop;
          create temporary table thread_read_markers (thread_id text, user_id text, sequence bigint, placement_done boolean, placement_sequence bigint, placement_revision bigint) on commit drop;
          create temporary table messages (id text, thread_id text, sequence bigint, kind text, author jsonb) on commit drop;
          create temporary table thread_inputs (message_id text, state text, policy text, requested_by text, thread_id text) on commit drop;
          insert into workspaces values ('workspace', 'chat');
        `.execute(tx);
        const ids = [
          "done",
          "kept",
          "stale-done",
          "stale-kept",
          "aged",
          "unread",
          "running",
          "waiting",
          "paused",
          "paused-empty",
          "asks",
          "queued-input",
          "delegating",
          "archived",
          "chat",
          "channel",
          "other-member",
        ];
        for (const id of ids) {
          await sql`insert into threads values (${id}, 'workspace', 'creator', 'work', true, 'idle', false, now() - interval '25 hours', null)`.execute(
            tx,
          );
          await sql`insert into messages values (${id + "-message"}, ${id}, 2, 'assistant', '{"kind":"agent"}'::jsonb)`.execute(
            tx,
          );
          if (id !== "unread")
            await sql`insert into thread_read_markers values (${id}, 'creator', 2, null, null, 0)`.execute(
              tx,
            );
        }
        await sql`
          update threads set status = 'running' where id in ('running', 'paused');
          update threads set status = 'waiting' where id = 'waiting';
          update threads set input_queue_paused = true, input_queue_paused_by = 'creator' where id in ('paused', 'paused-empty');
          insert into requests values ('asks', 'pending', null);
          insert into thread_inputs values ('queued-input-message', 'pending', 'queue', 'creator', 'queued-input');
          insert into delegations values ('open', 'worker', 'delegating');
          update threads set status = 'archived' where id in ('archived', 'chat', 'channel');
          insert into runs values ('running-run', 'running', 'running', 1), ('waiting-run', 'waiting', 'waiting', 1), ('paused-run', 'paused', 'queued', 1);
          insert into channel_conversation_contexts values ('channel');
          update thread_read_markers set placement_done = true, placement_sequence = 2 where thread_id = 'done';
          update thread_read_markers set placement_done = false, placement_sequence = 2 where thread_id = 'kept';
          update thread_read_markers set placement_done = true, placement_sequence = 1 where thread_id = 'stale-done';
          update thread_read_markers set placement_done = false, placement_sequence = 1 where thread_id = 'stale-kept';
          update threads set updated_at = now() where id = 'stale-done';
          insert into thread_read_markers values ('other-member', 'other', 2, false, 2, 1);
        `.execute(tx);
        await taskDoneMigration.up(tx);
        // Thread writes join what agents may record; what was allowed stays allowed.
        await sql`insert into agent_control_requests values ('thread.write', 'thread.write'), ('environment.list', 'environment.list')`.execute(
          tx,
        );
        return (
          await sql<{
            id: string;
            done: boolean;
            status: string;
            paused: boolean;
          }>`select id, done_at is not null as done, status, input_queue_paused as paused from threads order by id`.execute(
            tx,
          )
        ).rows;
      });
      expect(rows.filter((row) => row.done).map((row) => row.id)).toEqual([
        "aged",
        "archived",
        "done",
        "other-member",
        "paused-empty",
        "stale-kept",
      ]);
      // A Done task keeps its queue unpaused, so Reopen needs no Resume.
      expect(rows.filter((row) => row.done && row.paused)).toEqual([]);
      expect(rows.some((row) => row.status === "archived")).toBe(false);
      await mkdir("/tmp/opensteer-task-done", { recursive: true });
      await writeFile("/tmp/opensteer-task-done/migration.json", JSON.stringify({ rows }, null, 2));
    } finally {
      await database.destroy();
    }
  },
);
