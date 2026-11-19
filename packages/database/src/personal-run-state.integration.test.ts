import { sql } from "kysely";
import { expect, test } from "vitest";
import { commitPersonalMutation, installPersonalMutationHooks } from "./personal-mutation.js";
import { advancePersonalRunFinish, beginPersonalRunFinish } from "./personal-run-state.js";
import {
  acceptPersonalRunnerStatement,
  deleteTerminalRunReceipts,
  runnerStatementDigest,
} from "./personal-runner-receipts.js";
import { createPersonalStateFixture } from "./personal-state.test-support.js";
import { interruptPersonalToolCalls } from "./personal-tool-calls.js";

test("a finishing Run resumes its bounded work and only acknowledges an exact terminal statement after the final batch", async () => {
  const fixture = await createPersonalStateFixture("bounded-finalization");
  const { database, run, attemptId } = fixture;
  const liveClosed: unknown[] = [];
  const disconnect = installPersonalMutationHooks(database, {
    wake() {},
    onFailure(error) {
      throw error;
    },
    suspend() {
      throw new Error("A finish that spans commits is not a revocation");
    },
    react(reaction) {
      if (reaction.type === "runLiveClosed") liveClosed.push(reaction);
    },
  });
  try {
    await sql`insert into tool_calls(id,thread_id,run_id,call_id,origin,tool,arguments,status,started_at)
      select 'fixture-call-'||n,${run.threadId},${run.runId},'harness:fixture-'||n,'host-harness',
        '{"name":"read","namespace":"harness"}',jsonb_build_object('payload',repeat('x',478*1024)),'open',clock_timestamp()
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
    await database
      .updateTable("commands")
      .set({ status: "unknown" })
      .where("id", "=", run.turn.command.id)
      .execute();
    await expect(
      commitPersonalMutation(database, (tx, mutation) =>
        acceptPersonalRunnerStatement(tx, mutation, statement, async (reported) => {
          expect(reported.toString("hex")).toBe(digest);
          await beginPersonalRunFinish(tx, mutation, {
            runId: run.runId,
            intent: {
              attemptId,
              bindingGeneration: run.bindingGeneration,
              outcome: "interrupted",
              completedAt: statement.emittedAt,
              replyMessageId: null,
              statement: {
                ordinal: 1,
                runnerId: run.runnerId,
                runnerBootId: run.runnerBootId,
                digest,
              },
            },
          });
          return "applied";
        }),
      ),
    ).resolves.toEqual({ finishing: true });
    expect(liveClosed).toEqual([
      {
        type: "runLiveClosed",
        runId: run.runId,
        threadId: run.threadId,
        attemptId,
        bindingGeneration: run.bindingGeneration,
      },
    ]);
    const observedBatchSizes: number[] = [];
    const crash = new Error("Host stopped before final commit");
    const advance = (failure?: Error) =>
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
            await tx
              .updateTable("runs")
              .set({
                status: intent.outcome,
                completedAt: new Date(intent.completedAt),
                runnerSafetyTerminal: true,
              })
              .where("id", "=", run.runId)
              .execute();
            // Like finalizeRunOutcome, which owns deleting a terminal Run's receipts.
            deleteTerminalRunReceipts(tx, mutation, run.runId);
            if (failure) throw failure;
          },
        }),
      );
    expect(await advance()).toBe("more");
    expect(
      await database
        .selectFrom("commands")
        .select("status")
        .where("id", "=", run.turn.command.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "failed" });
    expect(
      await database
        .selectFrom("runnerEventReceipts")
        .select("ordinal")
        .where("ordinal", "=", 1)
        .execute(),
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
        acceptPersonalRunnerStatement(tx, mutation, statement, async () => {
          throw new Error("A pending retry reached the apply callback");
        }),
      ),
    ).resolves.toEqual({ finishing: true });
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
    await expect(advance(crash)).rejects.toBe(crash);
    expect(
      await database
        .selectFrom("runnerEventReceipts")
        .select("ordinal")
        .where("ordinal", "=", 1)
        .execute(),
    ).toEqual([]);
    expect(await advance()).toBe("settled");
    await expect(
      commitPersonalMutation(database, (tx, mutation) =>
        acceptPersonalRunnerStatement(tx, mutation, statement, async () => {
          throw new Error("A final retry reached the apply callback");
        }),
      ),
    ).resolves.toEqual({ throughOrdinal: 1, replayed: true });
    expect(observedBatchSizes).toHaveLength(3);
    expect(observedBatchSizes[0]).toBe(128);
    expect(observedBatchSizes[1]).toBeLessThan(128);
    expect(observedBatchSizes[2]).toBe(observedBatchSizes[1]);
    expect(
      await database
        .selectFrom("toolCalls")
        .select("id")
        .where("status", "=", "open")
        .limit(1)
        .execute(),
    ).toEqual([]);
    // The finish admitted the frozen statement; the terminal Run keeps no receipts.
    expect(
      await database
        .selectFrom("runs")
        .select("nextRunnerOrdinal")
        .where("id", "=", run.runId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ nextRunnerOrdinal: 2 });
    expect(
      await database
        .selectFrom("runnerEventReceipts")
        .select("ordinal")
        .where("runId", "=", run.runId)
        .execute(),
    ).toEqual([]);
  } finally {
    disconnect();
    await fixture.close();
  }
});
