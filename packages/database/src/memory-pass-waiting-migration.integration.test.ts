import { sql } from "kysely";
import { expect, it } from "vitest";
import { createDatabase } from "./connection.js";
import { memoryPassWaitingMigration } from "./migrations.js";

const noLightModel =
  "This engine has no light model. Choose a model for the light pass, then resume.";

it.runIf(Boolean(process.env.OPENSTEER_TEST_DATABASE_URL))(
  "resumes light passes paused only for a light model, keeping the person's pauses and memory off",
  async () => {
    const database = createDatabase({ connectionString: process.env.OPENSTEER_TEST_DATABASE_URL! });
    try {
      const rows = await database.transaction().execute(async (tx) => {
        await sql`
          create temporary table threads (id text primary key, done_at timestamptz) on commit drop;
          create temporary table triggers (
            id text primary key, anchor_thread_id text, system_role text, status text,
            pause_reason text, next_fire_at timestamptz, consecutive_failures integer,
            updated_at timestamptz,
            check (pause_reason is null or status = 'paused')
          ) on commit drop;
          insert into threads values ('worker', null), ('done-worker', now()), ('other', null);
        `.execute(tx);
        const rows = [
          ["no-light", "worker", "memory-light", noLightModel],
          ["no-light-done", "done-worker", "memory-light", noLightModel],
          ["off", "worker", "memory-light", `Memory is off at your request. ${noLightModel}`],
          ["person", "worker", "memory-light", null],
          ["nightly-off", "worker", "memory-nightly", "Memory is off at your request."],
          ["ordinary", "other", null, noLightModel],
        ] as const;
        for (const [id, anchor, role, reason] of rows)
          await sql`insert into triggers values (${id}, ${anchor}, ${role}, 'paused', ${reason}, null, 2, now())`.execute(
            tx,
          );
        await memoryPassWaitingMigration.up(tx);
        return (
          await sql<{
            id: string;
            status: string;
            pauseReason: string | null;
            fires: boolean;
            consecutiveFailures: number;
            waitingReason: string | null;
          }>`select id, status, pause_reason, next_fire_at is not null as fires,
              consecutive_failures, waiting_reason from triggers order by id`.execute(tx)
        ).rows;
      });
      expect(rows).toEqual([
        {
          id: "nightly-off",
          status: "paused",
          pauseReason: "Memory is off at your request.",
          fires: false,
          consecutiveFailures: 2,
          waitingReason: null,
        },
        {
          id: "no-light",
          status: "active",
          pauseReason: null,
          fires: true,
          consecutiveFailures: 0,
          waitingReason: null,
        },
        {
          id: "no-light-done",
          status: "paused",
          pauseReason: null,
          fires: false,
          consecutiveFailures: 0,
          waitingReason: null,
        },
        {
          id: "off",
          status: "paused",
          pauseReason: "Memory is off at your request.",
          fires: false,
          consecutiveFailures: 2,
          waitingReason: null,
        },
        {
          id: "ordinary",
          status: "paused",
          pauseReason: noLightModel,
          fires: false,
          consecutiveFailures: 2,
          waitingReason: null,
        },
        {
          id: "person",
          status: "paused",
          pauseReason: null,
          fires: false,
          consecutiveFailures: 2,
          waitingReason: null,
        },
      ]);
    } finally {
      await database.destroy();
    }
  },
);
