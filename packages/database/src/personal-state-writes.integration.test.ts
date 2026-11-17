import { sql } from "kysely";
import { expect, test } from "vitest";
import { commitPersonalMutation, installPersonalMutationHooks } from "./personal-mutation.js";
import { acceptPersonalRunnerStatement } from "./personal-runner-receipts.js";
import { createPersonalStateFixture } from "./personal-state.test-support.js";
import { completePersonalToolCall, startPersonalToolCall } from "./personal-tool-calls.js";

test("rolls back the tool, images, receipt, Run ordinal and reaction if the feed write fails", async () => {
  const fixture = await createPersonalStateFixture("target-atomicity");
  const { database, run, attemptId } = fixture;
  let wakes = 0;
  let reactions = 0;
  const disconnect = installPersonalMutationHooks(database, {
    wake: () => {
      wakes++;
    },
    onFailure(error) {
      throw error;
    },
  });
  try {
    const initial = await database
      .selectFrom("clientSyncState")
      .select("sequence")
      .executeTakeFirstOrThrow();
    const output = {
      text: "Result",
      images: [{ path: "/fixture/output.png", mediaType: "image/png" as const }],
    };
    const statement = {
      runId: run.runId,
      threadId: run.threadId,
      environmentId: run.environmentId,
      runnerId: run.runnerId,
      runnerBootId: run.runnerBootId,
      bindingGeneration: run.bindingGeneration,
      ordinal: 1,
      type: "tool.completed",
      emittedAt: new Date().toISOString(),
      data: { callId: "missing-start", isError: false, output },
    };
    const write = () =>
      commitPersonalMutation(database, (tx, mutation) =>
        acceptPersonalRunnerStatement(tx, mutation, statement, async () => {
          await tx
            .selectFrom("threads")
            .select("id")
            .where("id", "=", run.threadId)
            .forNoKeyUpdate()
            .executeTakeFirstOrThrow();
          await tx
            .updateTable("commands")
            .set({ lastError: { message: "outbox update" } })
            .where("id", "=", run.turn.command.id)
            .execute();
          await completePersonalToolCall(tx, mutation, {
            runId: run.runId,
            threadId: run.threadId,
            attemptId,
            bindingGeneration: run.bindingGeneration,
            origin: "runner",
            nodeId: null,
            ...statement.data,
          });
          mutation.reaction(() => {
            reactions++;
          });
          return "applied";
        }),
      );
    await sql`alter table client_changes add constraint fixture_reject_item check (entity_kind <> 'item')`.execute(
      database,
    );
    await expect(write()).rejects.toThrow("fixture_reject_item");
    expect(await database.selectFrom("toolCalls").select("id").execute()).toEqual([]);
    expect(await database.selectFrom("toolOutputImages").select("id").execute()).toEqual([]);
    expect(await database.selectFrom("transcriptItems").select("id").execute()).toEqual([]);
    expect(await database.selectFrom("runnerEventReceipts").select("ordinal").execute()).toEqual(
      [],
    );
    expect(
      await database
        .selectFrom("runs")
        .select("nextRunnerOrdinal")
        .where("id", "=", run.runId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ nextRunnerOrdinal: 1 });
    expect(
      await database
        .selectFrom("commands")
        .select("lastError")
        .where("id", "=", run.turn.command.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ lastError: null });
    expect(
      await database.selectFrom("clientSyncState").select("sequence").executeTakeFirstOrThrow(),
    ).toEqual(initial);
    expect({ wakes, reactions }).toEqual({ wakes: 0, reactions: 0 });
    await sql`alter table client_changes drop constraint fixture_reject_item`.execute(database);
    expect(await write()).toEqual({ throughOrdinal: 1, replayed: false });
    expect(await write()).toEqual({ throughOrdinal: 1, replayed: true });
    expect(await database.selectFrom("toolOutputImages").select("path").execute()).toEqual([
      { path: "/fixture/output.png" },
    ]);
    expect(reactions).toBe(1);
  } finally {
    disconnect();
    await fixture.close();
  }
});

test("commits provisional and final tool statements once while retaining one card", async () => {
  const fixture = await createPersonalStateFixture("provisional-tool");
  const { database, run, attemptId } = fixture;
  try {
    const common = {
      runId: run.runId,
      threadId: run.threadId,
      environmentId: run.environmentId,
      runnerId: run.runnerId,
      runnerBootId: run.runnerBootId,
      bindingGeneration: run.bindingGeneration,
      type: "tool.started",
      emittedAt: new Date().toISOString(),
    };
    const tool = { namespace: "claude", name: "Bash" };
    const first = {
      ...common,
      ordinal: 1,
      data: { callId: "one", tool, arguments: {}, provisional: true as const },
    };
    const final = {
      ...common,
      ordinal: 2,
      data: { callId: "one", tool, arguments: { command: "pwd" } },
    };
    let starts = 0;
    const write = (statement: typeof first | typeof final) =>
      commitPersonalMutation(database, (tx, mutation) =>
        acceptPersonalRunnerStatement(tx, mutation, statement, async () => {
          const result = await startPersonalToolCall(tx, mutation, {
            runId: run.runId,
            threadId: run.threadId,
            attemptId,
            bindingGeneration: run.bindingGeneration,
            origin: "runner",
            nodeId: null,
            ...statement.data,
          });
          if (result.started)
            mutation.reaction(() => {
              starts++;
            });
          return result.started || statement.ordinal === final.ordinal ? "applied" : "absorbed";
        }),
      );
    expect(await write(first)).toEqual({ throughOrdinal: 1, replayed: false });
    const original = await database
      .selectFrom("transcriptItems")
      .select(["id", "position", "createdAt"])
      .executeTakeFirstOrThrow();
    expect(await write(first)).toEqual({ throughOrdinal: 1, replayed: true });
    await expect(
      write({ ...first, data: { ...first.data, arguments: { other: "different" } } }),
    ).rejects.toThrow("already used");
    expect(await write(final)).toEqual({ throughOrdinal: 2, replayed: false });
    expect(await write(final)).toEqual({ throughOrdinal: 2, replayed: true });
    await expect(
      write({ ...final, data: { ...final.data, arguments: { command: "ls" } } }),
    ).rejects.toThrow("already used");
    expect(
      await database
        .selectFrom("transcriptItems")
        .select(["id", "position", "createdAt"])
        .execute(),
    ).toEqual([original]);
    const call = await database
      .selectFrom("toolCalls")
      .select(["arguments", "provisional"])
      .executeTakeFirstOrThrow();
    expect(call).toEqual({ arguments: { command: "pwd" }, provisional: false });
    expect(starts).toBe(1);
  } finally {
    await fixture.close();
  }
});
