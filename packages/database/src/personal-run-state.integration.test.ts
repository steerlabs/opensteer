import { sql } from "kysely";
import { expect, test } from "vitest";
import { commitPersonalMutation } from "./personal-mutation.js";
import { advancePersonalRunFinish, beginPersonalRunFinish } from "./personal-run-state.js";
import {
  acceptPersonalRunnerStatement,
  runnerStatementDigest,
} from "./personal-runner-receipts.js";
import { createPersonalStateFixture } from "./personal-state.test-support.js";
import { interruptPersonalToolCalls } from "./personal-tool-calls.js";

test("a finishing Run resumes its bounded work and only acknowledges an exact terminal statement after the final batch", async () => {
  const fixture = await createPersonalStateFixture("bounded-finalization");
  const { database, run, attemptId } = fixture;
  try {
    await sql`insert into tool_calls(id,thread_id,run_id,call_id,origin,tool,arguments,status,started_at)
      select 'fixture-call-'||n,${run.threadId},${run.runId},'harness:fixture-'||n,'host-harness',
        '{"name":"read","namespace":"harness"}','{}','open',clock_timestamp()
      from generate_series(1,145) n
    `.execute(database);
    await sql`insert into transcript_items(id,thread_id,run_id,kind,position,visible,is_turn_start,created_at,tool_call_id,view)
      select 'tool:'||id,thread_id,run_id,'tool',row_number() over(order by id),true,false,started_at,id,'{}'
      from tool_calls where run_id=${run.runId}
    `.execute(database);
    await database
      .updateTable("threads")
      .set({ nextTranscriptPosition: "145" })
      .where("id", "=", run.threadId)
      .execute();
    const statement = {
      runId: run.runId,
      threadId: run.threadId,
      environmentId: run.environmentId,
      runnerId: run.runnerId,
      runnerBootId: run.runnerBootId,
      bindingGeneration: run.bindingGeneration,
      ordinal: 1,
      type: "run.interrupted",
      data: { status: "interrupted" },
      emittedAt: new Date().toISOString(),
    };
    const digest = runnerStatementDigest(statement).toString("hex");
    await commitPersonalMutation(database, (tx, mutation) =>
      beginPersonalRunFinish(tx, mutation, {
        runId: run.runId,
        intent: {
          attemptId,
          bindingGeneration: run.bindingGeneration,
          outcome: "interrupted",
          completedAt: statement.emittedAt,
          replyMessageId: null,
          statement: { ordinal: 1, runnerId: run.runnerId, runnerBootId: run.runnerBootId, digest },
        },
      }),
    );
    const observedBatchSizes: number[] = [];
    let ack: Awaited<ReturnType<typeof acceptPersonalRunnerStatement>> | undefined;
    const advance = () =>
      commitPersonalMutation(database, (tx, mutation) =>
        advancePersonalRunFinish(tx, mutation, run.runId, {
          async settle(children) {
            const { requests, commands, steers, nodes, grants, tools } = children;
            observedBatchSizes.push(
              [requests, commands, steers, nodes, grants, tools].reduce(
                (sum, ids) => sum + ids.length,
                0,
              ),
            );
            expect({ requests, steers, nodes }).toEqual({ requests: [], steers: [], nodes: [] });
            if (commands.length) {
              await tx
                .selectFrom("commands")
                .select("id")
                .where("id", "in", commands)
                .orderBy("id")
                .forNoKeyUpdate()
                .execute();
              await tx
                .updateTable("commands")
                .set({ status: "failed" })
                .where("id", "in", commands)
                .execute();
            }
            if (grants.length) {
              await tx
                .selectFrom("grants")
                .select("id")
                .where("id", "in", grants)
                .orderBy("id")
                .forNoKeyUpdate()
                .execute();
              await tx
                .updateTable("grants")
                .set({ status: "revoked", revokedAt: mutation.state.now })
                .where("id", "in", grants)
                .execute();
            }
            await interruptPersonalToolCalls(tx, mutation, run.runId, tools);
          },
          async finalize(intent) {
            ack = await acceptPersonalRunnerStatement(tx, mutation, statement, async () => {
              await tx
                .updateTable("runs")
                .set({
                  status: intent.outcome,
                  completedAt: new Date(intent.completedAt),
                  runnerSafetyTerminal: true,
                })
                .where("id", "=", run.runId)
                .execute();
              return "applied";
            });
          },
        }),
      );
    expect(await advance()).toBe("more");
    expect(ack).toBeUndefined();
    expect(
      await database.selectFrom("runnerEventReceipts").select("ordinal").limit(1).execute(),
    ).toEqual([]);
    const checkpoint = await database
      .selectFrom("runs")
      .select(["finishIntent", "nextRunnerOrdinal"])
      .where("id", "=", run.runId)
      .executeTakeFirstOrThrow();
    expect(checkpoint).toMatchObject({
      nextRunnerOrdinal: 1,
      finishIntent: { statement: { digest } },
    });
    await expect(
      commitPersonalMutation(database, (tx, mutation) =>
        acceptPersonalRunnerStatement(
          tx,
          mutation,
          { ...statement, data: { status: "other" } },
          async () => {
            throw new Error("Changed terminal statement authorized an effect");
          },
        ),
      ),
    ).rejects.toThrow("The Run is finishing");
    expect(await advance()).toBe("settled");
    expect(ack).toEqual({ throughOrdinal: 1, replayed: false });
    expect(observedBatchSizes).toHaveLength(2);
    expect(observedBatchSizes[0]).toBe(128);
    expect(observedBatchSizes[1]).toBeLessThan(128);
    expect(
      await database
        .selectFrom("toolCalls")
        .select("id")
        .where("status", "=", "open")
        .limit(1)
        .execute(),
    ).toEqual([]);
    const receipt = await database
      .selectFrom("runnerEventReceipts")
      .select("reportedDigest")
      .where("runId", "=", run.runId)
      .where("ordinal", "=", 1)
      .executeTakeFirstOrThrow();
    expect(receipt.reportedDigest.toString("hex")).toBe(digest);
  } finally {
    await fixture.close();
  }
});
