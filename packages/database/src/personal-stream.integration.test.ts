import { createId } from "@opensteer/core";
import { sql } from "kysely";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { expect, test } from "vitest";
import { commitPersonalMutation, installPersonalMutationHooks } from "./personal-mutation.js";
import { refreshRequestAttention } from "./personal-attention-store.js";
import { requestInsert } from "./request-persistence.js";
import { liveRequest } from "./store.integration.test-support.js";
import { acceptPersonalRunnerStatement } from "./personal-runner-receipts.js";
import { createPersonalStateFixture } from "./personal-state.test-support.js";
import {
  completePersonalHostToolCall,
  completePersonalToolCall,
  startPersonalToolCall,
} from "./personal-tool-calls.js";
import { readPersonalToolImage, resolvePersonalToolImages } from "./personal-tool-images.js";

test("orders scoped mutations at the deployment fence and leaves no rollback gap", async () => {
  const fixture = await createPersonalStateFixture("scope-commit-order");
  const { database, run } = fixture;
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const inFlight: Promise<unknown>[] = [];
  const head = () =>
    database.selectFrom("clientSyncState").select("sequence").executeTakeFirstOrThrow();
  try {
    const initial = BigInt((await head()).sequence);
    const scopeKey = `thread:${run.threadId}` as const;
    const write = (hold?: boolean) =>
      commitPersonalMutation(database, async (_tx, mutation) => {
        mutation.change(
          { scopeKey, entityKind: "collection", entityId: "queue", operation: "invalidate" },
          () => ({ revision: mutation.sequence }),
        );
        if (hold) {
          ready.resolve();
          await withTimeout(release.promise, 5_000, {
            timeoutError: () => new Error("The first scoped mutation was never released"),
          });
        }
        return mutation.sequence;
      });
    const first = write(true);
    inFlight.push(first);
    void first.catch(() => undefined);
    await withTimeout(ready.promise, 5_000, {
      timeoutError: () =>
        new Error("The first scoped mutation never acquired the deployment fence"),
    });
    const second = write();
    inFlight.push(second);
    void second.catch(() => undefined);
    expect((await head()).sequence).toBe(initial.toString());
    release.resolve();
    expect(await Promise.all([first, second])).toEqual([
      (initial + 1n).toString(),
      (initial + 2n).toString(),
    ]);
    await expect(
      commitPersonalMutation(database, async (_tx, mutation) => {
        mutation.change({
          scopeKey,
          entityKind: "collection",
          entityId: "queue",
          operation: "invalidate",
        });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await write()).toBe((initial + 3n).toString());
    const changes = await database
      .selectFrom("clientChanges")
      .select(["sequence", "payload"])
      .where("scopeKey", "=", scopeKey)
      .orderBy("sequence")
      .execute();
    expect(changes).toEqual(
      [1n, 2n, 3n].map((offset) => ({
        sequence: (initial + offset).toString(),
        payload: { revision: (initial + offset).toString() },
      })),
    );
  } finally {
    release.resolve();
    await Promise.allSettled(inFlight);
    await fixture.close();
  }
});

test.each(["feed", "receipt"] as const)(
  "rolls back current facts and reactions if the %s write fails",
  async (failure) => {
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
        .select(["sequence", "pendingRequestCount", "needsYouCount"])
        .executeTakeFirstOrThrow();
      const output = {
        text: "fixture-secret-marker",
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
      const request = liveRequest({
        harnessInstanceId: run.harnessInstance.id,
        id: createId("request"),
        requestedBy: run.userId,
        runId: run.runId,
        threadId: run.threadId,
        presentation: {
          kind: "choice",
          title: "Review this request",
          options: [{ id: "allow", label: "Allow", hint: "allow-once" }],
        },
      });
      const write = () =>
        commitPersonalMutation(database, (tx, mutation) =>
          acceptPersonalRunnerStatement(tx, mutation, statement, async () => {
            await tx
              .selectFrom("threads")
              .select("id")
              .where("id", "=", run.threadId)
              .forNoKeyUpdate()
              .executeTakeFirstOrThrow();
            await tx.insertInto("requests").values(requestInsert(request)).execute();
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
            await refreshRequestAttention(tx, mutation, request.id);
            mutation.reaction(() => {
              reactions++;
            });
            return "applied";
          }),
        );
      const table = sql.ref(failure === "feed" ? "client_changes" : "runner_event_receipts");
      const assertion = failure === "feed" ? sql`entity_kind <> 'item'` : sql`ordinal <> 1`;
      await sql`alter table ${table} add constraint fixture_reject_commit check (${assertion})`.execute(
        database,
      );
      await expect(write()).rejects.toThrow("fixture_reject_commit");
      expect(
        await database.selectFrom("requests").select("id").where("id", "=", request.id).execute(),
      ).toEqual([]);
      expect(await database.selectFrom("personalAttention").select("id").execute()).toEqual([]);
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
        await database
          .selectFrom("clientSyncState")
          .select(["sequence", "pendingRequestCount", "needsYouCount"])
          .executeTakeFirstOrThrow(),
      ).toEqual(initial);
      expect({ wakes, reactions }).toEqual({ wakes: 0, reactions: 0 });
      await sql`alter table ${table} drop constraint fixture_reject_commit`.execute(database);
      expect(await write()).toEqual({ throughOrdinal: 1, replayed: false });
      expect(await write()).toEqual({ throughOrdinal: 1, replayed: true });
      expect(await database.selectFrom("toolOutputImages").select("path").execute()).toEqual([
        { path: "/fixture/output.png" },
      ]);
      const viewerId = run.userId;
      const threadId = run.threadId;
      const paths = ["/fixture/output.png"];
      expect(
        await resolvePersonalToolImages(database, {
          viewerId,
          threadId,
          paths: ["/fixture/nested/../output.png", "/fixture/output.png\u0001"],
        }),
      ).toEqual([]);
      const [image] = await resolvePersonalToolImages(database, { viewerId, threadId, paths });
      expect(image).toMatchObject({ path: paths[0], mediaType: "image/png" });
      const otherThreadId = createId("thread");
      const thread = await database
        .selectFrom("threads")
        .selectAll()
        .where("id", "=", threadId)
        .executeTakeFirstOrThrow();
      await database
        .insertInto("threads")
        .values({
          ...thread,
          id: otherThreadId,
          lineageRootThreadId: otherThreadId,
        })
        .execute();
      const imageId = image!.id;
      expect(await readPersonalToolImage(database, { viewerId, threadId, imageId })).toEqual(image);
      expect(
        await resolvePersonalToolImages(database, { viewerId, threadId: otherThreadId, paths }),
      ).toEqual([]);
      expect(
        await readPersonalToolImage(database, { viewerId, threadId: otherThreadId, imageId }),
      ).toBeNull();
      await expect(
        readPersonalToolImage(database, { viewerId: createId("user"), threadId, imageId }),
      ).rejects.toThrow("unavailable to this viewer");
      const feed = await database.selectFrom("clientChanges").select("payload").execute();
      expect(JSON.stringify(feed)).not.toContain(output.text);
      expect(reactions).toBe(1);
    } finally {
      disconnect();
      await fixture.close();
    }
  },
);

test("commits provisional and final tool statements once while retaining one card", async () => {
  const fixture = await createPersonalStateFixture("provisional-tool");
  const { database, run, attemptId } = fixture;
  let starts = 0;
  const releaseHooks = installPersonalMutationHooks(database, {
    wake() {},
    onFailure(error) {
      throw error;
    },
    react(reaction) {
      if (reaction.type === "teamStep") starts++;
    },
  });
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
    releaseHooks();
    await fixture.close();
  }
});

test("validates a new receipt against the current boot and hashes normalized JSON", async () => {
  const fixture = await createPersonalStateFixture("receipt-authority");
  const { database, run } = fixture;
  try {
    const malformed: Record<string, string> = { ["bad\u0000"]: "\ud800" };
    const original = {
      runId: run.runId,
      threadId: run.threadId,
      environmentId: run.environmentId,
      runnerId: run.runnerId,
      runnerBootId: run.runnerBootId,
      bindingGeneration: run.bindingGeneration,
      ordinal: 1,
      type: "reasoning.completed",
      emittedAt: "2026-01-01T00:00:00.000Z",
      data: { z: malformed, a: 1 },
    };
    let applied = 0;
    const write = (statement: typeof original) =>
      commitPersonalMutation(database, (tx, mutation) =>
        acceptPersonalRunnerStatement(tx, mutation, statement, async (_digest, normalized) => {
          expect(normalized.data).toEqual({ z: { "bad�": "�" }, a: 1 });
          applied++;
          return "applied";
        }),
      );
    await expect(write({ ...original, runnerBootId: "retired-boot" })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(write(original)).resolves.toEqual({ throughOrdinal: 1, replayed: false });
    await expect(
      write({
        ...original,
        emittedAt: "2025-12-31T19:00:00-05:00",
        data: {
          a: 1,
          z: { "bad�": "�" },
        },
      }),
    ).resolves.toEqual({ throughOrdinal: 1, replayed: true });
    await database
      .updateTable("runs")
      .set({ bindingGeneration: run.bindingGeneration + 1 })
      .where("id", "=", run.runId)
      .execute();
    await expect(write({ ...original, ordinal: 2 })).rejects.toMatchObject({ code: "forbidden" });
    expect(applied).toBe(1);
  } finally {
    await fixture.close();
  }
});

test("settles Host effects only through their admitted handle and live attempt and node", async () => {
  const fixture = await createPersonalStateFixture("host-effect-authority");
  const { database, run, attemptId } = fixture;
  try {
    const nodeId = createId("executionNode");
    await database
      .insertInto("executionNodes")
      .values({
        id: nodeId,
        attemptId,
        runId: run.runId,
        status: "running",
        kind: "subagent",
        effort: null,
        phaseIndex: null,
        phases: sql`'[]'::jsonb`,
        title: "Subagent",
        startedAt: new Date(),
        endedAt: null,
        nativeRef: "fixture",
        originCallId: null,
        parentNodeId: null,
        prompt: null,
        result: null,
        sessionRef: null,
        model: null,
      })
      .execute();
    const start = (node: typeof nodeId | null, callId: string) =>
      commitPersonalMutation(database, (tx, mutation) =>
        startPersonalToolCall(tx, mutation, {
          runId: run.runId,
          threadId: run.threadId,
          attemptId,
          bindingGeneration: run.bindingGeneration,
          origin: "host-harness",
          nodeId: node,
          callId,
          tool: { namespace: "opensteer", name: "read" },
          arguments: { exact: true },
        }),
      );
    const nested = await start(nodeId, "harness:scope");
    const root = await start(null, "harness:scope");
    expect(nested.call.id).not.toBe(root.call.id);
    expect(nested.handle).toBeDefined();
    expect(root.handle).toBeDefined();
    expect(await start(null, "harness:scope")).toMatchObject({
      started: false,
      outcome: "outcome-unknown",
    });
    const complete = (handle: NonNullable<typeof root.handle>) =>
      commitPersonalMutation(database, (tx, mutation) =>
        completePersonalHostToolCall(tx, mutation, handle, {
          output: {
            text: "result",
            images: [{ path: "/fixture/tool.png", mediaType: "image/png" }],
          },
          isError: false,
        }),
      );
    await expect(complete({ ...root.handle!, toolCallId: "missing" })).rejects.toMatchObject({
      code: "not_found",
    });
    await database
      .updateTable("executionNodes")
      .set({ status: "interrupted", endedAt: new Date() })
      .where("id", "=", nodeId)
      .execute();
    await expect(complete(nested.handle!)).rejects.toMatchObject({ code: "forbidden" });
    await database
      .updateTable("runs")
      .set({ bindingGeneration: run.bindingGeneration + 1 })
      .where("id", "=", run.runId)
      .execute();
    await expect(complete(root.handle!)).rejects.toMatchObject({ code: "conflict" });
    expect(await database.selectFrom("toolOutputImages").select("id").execute()).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("fails an authority mutation closed when no dispatch fence is installed", async () => {
  const fixture = await createPersonalStateFixture("missing-dispatch-fence");
  const { database, run } = fixture;
  try {
    await expect(
      commitPersonalMutation(database, async (tx, mutation) => {
        await tx
          .updateTable("threads")
          .set({ removedAt: mutation.state.now })
          .where("id", "=", run.threadId)
          .execute();
        mutation.purge(`thread:${run.threadId}`);
      }),
    ).rejects.toThrow("no dispatch fence");
    expect(
      await database
        .selectFrom("threads")
        .select("removedAt")
        .where("id", "=", run.threadId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ removedAt: null });
  } finally {
    await fixture.close();
  }
});

test("resumes a suspended scope when a deferred constraint rolls back COMMIT", async () => {
  const fixture = await createPersonalStateFixture("authority-rollback");
  const { database, run } = fixture;
  const observed: string[] = [];
  const uninstall = installPersonalMutationHooks(database, {
    wake() {
      observed.push("wake");
    },
    onFailure(error) {
      throw error;
    },
    suspend() {
      observed.push("suspend");
      return {
        committed() {
          observed.push("close");
        },
        rolledBack() {
          observed.push("resume");
        },
      };
    },
  });
  try {
    await expect(
      commitPersonalMutation(database, async (tx, mutation) => {
        await tx
          .updateTable("runs")
          .set({
            status: "completed",
            completedAt: mutation.state.now,
            terminalReplyMessageId: createId("message"),
          })
          .where("id", "=", run.runId)
          .execute();
        mutation.fence(`thread:${run.threadId}`);
      }),
    ).rejects.toMatchObject({ code: "23503" });
    expect(observed).toEqual(["suspend", "resume"]);
  } finally {
    uninstall();
    await fixture.close();
  }
});
