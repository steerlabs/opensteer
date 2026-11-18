import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { sql } from "kysely";
import { expect, test } from "vitest";
import { createId } from "@opensteer/core";
import { withLockOrderMode } from "./lock-order-checker.test-support.js";
import {
  createStoreFixture,
  liveRequest,
  pendingEvent,
  sealedTestRequestResponse,
} from "./store.integration.test-support.js";

const enabled = process.env.OPENSTEER_PERSONAL_WRITE_PERF === "1";

let captured: string[] | null = null;

/** One pg `query` call is one round trip; a simple-protocol text can carry several statements. */
function statements(text: string) {
  return text.split(";").filter((part) => part.trim()).length;
}

async function measure(name: string, action: () => Promise<unknown>) {
  captured = [];
  try {
    await action();
    const texts = captured;
    return {
      name,
      roundTrips: texts.length,
      statements: texts.reduce((sum, text) => sum + statements(text), 0),
      shape: texts.map((text) => text.replace(/\s+/g, " ").slice(0, 140)),
    };
  } finally {
    captured = null;
  }
}

test.skipIf(!enabled)(
  "measures round trips per hot Personal write and sustained Runner statements",
  async () => {
    const original = pg.Client.prototype.query;
    pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
      const first = args[0] as string | { text?: string };
      captured?.push(typeof first === "string" ? first : (first.text ?? ""));
      return (original as (...values: unknown[]) => unknown).apply(this, args);
    } as typeof original;
    try {
      // Row-lock instrumentation adds its own queries to every statement.
      await withLockOrderMode("off", async () => {
        const fixture = await createStoreFixture();
        try {
          const run = await fixture.startRunFixture("write-performance");
          const idle = await fixture.createRunFixture("write-performance-idle");
          let ordinal = Number(
            (
              await fixture.database
                .selectFrom("runs")
                .select("nextRunnerOrdinal")
                .where("id", "=", run.run.id)
                .executeTakeFirstOrThrow()
            ).nextRunnerOrdinal,
          );
          const commit = (type: string, data: unknown) =>
            fixture.store.commitRunnerEvent({
              environmentId: run.environmentId,
              runnerBootId: run.runnerBootId,
              runnerId: run.runnerId,
              event: pendingEvent({
                bindingGeneration: run.bindingGeneration,
                environmentId: run.environmentId,
                runId: run.run.id,
                threadId: run.threadId,
                ordinal: ordinal++,
                type,
                data,
              } as never),
            });
          const assistant = (index: number) =>
            commit("assistant.message", {
              content: [{ type: "text", text: `Assistant text ${index} `.repeat(20) }],
              messageId: createId("message"),
            });
          for (let index = 0; index < 20; index++) await assistant(index);
          // A Host in use keeps its feed at the row cap, so every commit also prunes.
          await sql`delete from client_changes`.execute(fixture.database);
          await sql`with head as (select deployment_id, sequence from client_sync_state)
            insert into client_changes(deployment_id,sequence,scope_key,ordinal,entity_kind,entity_id,operation,payload,created_at)
            select head.deployment_id, head.sequence + s, 'node:write-performance', o, 'collection', 'scope', 'invalidate', '{}', now()
            from head, generate_series(1,32) s, generate_series(0,127) o`.execute(fixture.database);
          await sql`update client_sync_state set pruned_through_sequence = sequence,
            sequence = sequence + 32, retained_change_count = 4096`.execute(fixture.database);

          const results = [];
          for (let repetition = 0; repetition < 3; repetition++) {
            results.push(await measure("runner assistant text", () => assistant(100 + repetition)));
            const callId = `call-${repetition}`;
            results.push(
              await measure("runner tool start", () =>
                commit("tool.started", {
                  callId,
                  tool: { namespace: "native", name: "read" },
                  arguments: { path: "/fixture" },
                }),
              ),
            );
            results.push(
              await measure("runner tool completion", () =>
                commit("tool.completed", {
                  callId,
                  isError: false,
                  output: { text: "Work completed" },
                }),
              ),
            );
            results.push(
              await measure("person message queued", () =>
                fixture.store.enqueueThreadInput({
                  requestedBy: run.userId,
                  threadId: run.threadId,
                  content: [{ type: "text", text: `Person follow-up ${repetition}` }],
                  source: { kind: "human" },
                  policy: "queue",
                  idempotencyKey: `person-${repetition}`,
                }),
              ),
            );
            const requestId = createId("request");
            await commit("request.opened", {
              request: liveRequest({
                harnessInstanceId: run.harnessInstance.id,
                id: requestId,
                presentation: {
                  detail: "Approve this operation",
                  kind: "choice",
                  options: [{ hint: "allow-once", id: "allow", label: "Allow" }],
                  title: "Approval required",
                },
                requestedBy: run.userId,
                runId: run.run.id,
                threadId: run.threadId,
              }),
            });
            const revision = (await fixture.store.requests.revision(requestId))!;
            results.push(
              await measure("request answer", () =>
                fixture.store.enqueueRunnerControl({
                  idempotencyKey: `answer-${repetition}`,
                  requestId,
                  requestedBy: run.userId,
                  response: { kind: "choice", optionId: "allow" },
                  sealedResponse: sealedTestRequestResponse(),
                  runId: run.run.id,
                  threadId: run.threadId,
                  expectedRevision: revision,
                  type: "request.respond",
                } as never),
              ),
            );
          }
          results.push(
            await measure("person message starts a Run", () =>
              fixture.store.enqueueThreadInput({
                requestedBy: idle.userId,
                threadId: idle.threadId,
                content: [{ type: "text", text: "Start working" }],
                source: { kind: "human" },
                policy: "queue",
                idempotencyKey: "person-idle",
              }),
            ),
          );

          const sustained = 1_000;
          const started = performance.now();
          for (let index = 0; index < sustained; index++) await assistant(1_000 + index);
          const runnerStatementsPerSecond = (sustained / (performance.now() - started)) * 1_000;

          const byName = new Map<string, number[]>();
          for (const result of results)
            byName.set(result.name, [...(byName.get(result.name) ?? []), result.roundTrips]);
          const roundTrips = Object.fromEntries(
            [...byName].map(([name, values]) => [name, Math.max(...values)]),
          );
          const out =
            process.env.OPENSTEER_PERSONAL_WRITE_PERF_OUT ??
            join(tmpdir(), "opensteer-personal-write-perf.json");
          await writeFile(
            out,
            JSON.stringify({ roundTrips, runnerStatementsPerSecond, results }, null, 2) + "\n",
          );
          expect(roundTrips["runner assistant text"]).toBeLessThanOrEqual(12);
          expect(roundTrips["runner tool start"]).toBeLessThanOrEqual(12);
          expect(roundTrips["runner tool completion"]).toBeLessThanOrEqual(12);
        } finally {
          await fixture.close();
        }
      });
    } finally {
      pg.Client.prototype.query = original;
    }
  },
  600_000,
);
