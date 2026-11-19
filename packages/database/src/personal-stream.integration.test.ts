import {
  readPersonalScopeCut,
  readTranscriptItem,
  readTranscriptPage,
} from "./personal-sync-store.js";
import { writeExecutionItem } from "./execution-changes.js";
import {
  applyAnsweredQuestionRecords,
  applyTaskApprovalReceipts,
} from "./personal-state-schema.js";
import { readTranscriptOverlays } from "./personal-overlay-store.js";
import { RequestSchema, createId, type Request } from "@opensteer/core";
import { sql } from "kysely";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { expect, test } from "vitest";
import { commitPersonalMutation, installPersonalMutationHooks } from "./personal-mutation.js";
import { publishExecutionNode } from "./execution-nodes.js";
import { refreshRequestAttention } from "./personal-attention-store.js";
import { lockRequestThreads, refreshRequestState, requestInsert } from "./request-persistence.js";
import { liveRequest, pendingEvent } from "./store.integration.test-support.js";
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
  const { database } = fixture;
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const inFlight: Promise<unknown>[] = [];
  const head = () =>
    database.selectFrom("clientSyncState").select("sequence").executeTakeFirstOrThrow();
  try {
    const initial = BigInt((await head()).sequence);
    const scopeKey = "shell" as const;
    const write = (hold?: boolean) =>
      commitPersonalMutation(database, async (_tx, mutation) => {
        mutation.change({
          scopeKey,
          entityKind: "visit",
          entityId: "fence-order",
          operation: "remove",
        });
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
          entityKind: "visit",
          entityId: "fence-order",
          operation: "remove",
        });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await write()).toBe((initial + 3n).toString());
    const changes = await database
      .selectFrom("clientChanges")
      .select(["sequence", "payload"])
      .where("scopeKey", "=", scopeKey)
      .where("entityId", "=", "fence-order")
      .orderBy("sequence")
      .execute();
    expect(changes).toEqual(
      [1n, 2n, 3n].map((offset) => ({
        sequence: (initial + offset).toString(),
        payload: {},
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
      await sql`alter table ${table} add constraint fixture_reject_commit check (${assertion}) not valid`.execute(
        database,
      );
      await expect(write()).rejects.toThrow("fixture_reject_commit");
      expect(
        await database.selectFrom("requests").select("id").where("id", "=", request.id).execute(),
      ).toEqual([]);
      expect(await database.selectFrom("personalAttention").select("id").execute()).toEqual([]);
      expect(await database.selectFrom("toolCalls").select("id").execute()).toEqual([]);
      expect(await database.selectFrom("toolOutputImages").select("id").execute()).toEqual([]);
      expect(
        await database
          .selectFrom("transcriptItems")
          .select("id")
          .where("kind", "in", ["tool", "request"])
          .execute(),
      ).toEqual([]);
      expect(await database.selectFrom("runnerEventReceipts").select("ordinal").execute()).toEqual([
        { ordinal: "0" },
      ]);
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
      .where("kind", "=", "tool")
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
        .where("kind", "=", "tool")
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

test("keeps pending Requests in the overlay and writes one terminal receipt when the Run fails", async () => {
  const f = await createPersonalStateFixture("terminal-receipts");
  const { database, store, run } = f;
  try {
    const scope = { kind: "thread", threadId: run.threadId } as const;
    const read = { viewerId: run.userId, scope };
    const request = liveRequest({
      id: createId("request"),
      harnessInstanceId: run.harnessInstance.id,
      requestedBy: run.userId,
      runId: run.runId,
      threadId: run.threadId,
      presentation: {
        kind: "choice",
        title: "May I publish?",
        options: [{ id: "yes", label: "Publish", hint: "confirm" }],
      },
    });
    const emit = (event: Parameters<typeof pendingEvent>[0]) =>
      store.commitRunnerEvent({
        event: pendingEvent(event),
        environmentId: run.environmentId,
        runnerId: run.runnerId,
        runnerBootId: run.runnerBootId,
      });
    const source = {
      runId: run.runId,
      threadId: run.threadId,
      environmentId: run.environmentId,
      bindingGeneration: run.bindingGeneration,
    };
    await emit({
      ...source,
      ordinal: 1,
      type: "tool.started",
      data: {
        callId: "open",
        tool: { namespace: "harness", name: "read" },
        arguments: { target: "test" },
      },
    });
    await emit({
      ...source,
      ordinal: 2,
      type: "request.opened",
      data: { request },
    });
    const pending = await readTranscriptPage(database, read);
    if (pending.kind !== "page") throw new Error("Expected history");
    expect(pending.items.filter((item) => item.kind === "request")).toEqual([]);
    const overlay = await readTranscriptOverlays(database, { ...read, kind: "requests" });
    expect(overlay).toMatchObject({ entries: [expect.objectContaining({ id: request.id })] });
    const open = pending.items.find((item) => item.kind === "tool");
    expect(open).toMatchObject({ view: { status: "running" } });

    await emit({
      ...source,
      ordinal: 3,
      type: "run.failed",
      data: { status: "failed", code: "harness_error", message: "Engine failed", retryable: false },
    });
    await store.drainRunFinish(run.runId);
    const ended = await database
      .selectFrom("runs")
      .select("completedAt")
      .where("id", "=", run.runId)
      .executeTakeFirstOrThrow();
    const settled = await readTranscriptPage(database, read);
    if (settled.kind !== "page" || !open || !ended.completedAt)
      throw new Error("Expected settled history");
    const stopped = settled.items.find((item) => item.kind === "tool");
    expect(stopped).toMatchObject({
      id: open.id,
      position: open.position,
      createdAt: open.createdAt,
      completedAt: ended.completedAt.toISOString(),
      view: { status: "stopped" },
    });
    expect(settled.items.filter((item) => item.kind === "request")).toEqual([
      expect.objectContaining({
        id: `request:${request.id}`,
        requestId: request.id,
        requestKind: "harness.input",
        createdAt: ended.completedAt.toISOString(),
        waitedSince: request.createdAt,
        view: { title: "May I publish?", status: "cancelled", preview: "Cancelled · run-ended" },
      }),
    ]);
    expect(await readTranscriptItem(database, { ...read, itemId: open.id })).toMatchObject({
      item: stopped,
      body: { kind: "tool", arguments: { target: "test" } },
    });
  } finally {
    await f.close();
  }
});

test("projects the exact decision and provenance on compact Request receipts", async () => {
  const f = await createPersonalStateFixture("receipt-decisions");
  const { database, run } = f;
  const resolvedAt = "2026-05-01T00:00:02.000Z";
  const createdAt = "2026-05-01T00:00:00.000Z";
  const allow = { id: "allow", label: "Publish", hint: "confirm" } as const;
  const decline = { id: "decline", label: "Decline", hint: "reject-once" } as const;
  const cancel = { id: "cancel", label: "Cancel", hint: "cancel" } as const;
  const provenance = { sessionId: "fixture-device", deviceLabel: "iPhone" };
  const choice = (optionId: string) => ({ kind: "choice", optionId }) as const;
  const external = (decision?: string) =>
    ({ kind: "external", ...(decision ? { value: { decision } } : {}) }) as const;
  const variants: readonly [string, Partial<Request>][] = [
    [
      "Cancelled · source-closed",
      { status: "cancelled", cancellationReason: "source-closed", resolvedBy: null },
    ],
    ["Declined", { status: "declined", response: choice(decline.id) }],
    [
      "Declined · Cancel",
      {
        status: "declined",
        response: choice(cancel.id),
        presentation: { kind: "choice", title: "Publish?", options: [allow, decline, cancel] },
      },
    ],
    ["Fulfilled · Publish", { status: "fulfilled", response: choice(allow.id) }],
    [
      "Answered by Research lead",
      {
        kind: "harness.input",
        status: "fulfilled",
        response: choice(allow.id),
        resolvedBy: null,
        settlementProvenance: {
          kind: "agent",
          title: "Research lead",
          runId: createId("run"),
          threadId: createId("thread"),
        },
      },
    ],
    ["Withdrawn", { status: "withdrawn" }],
    ["Declined", { status: "declined", response: external("declined") }],
    ["Allowed", { status: "fulfilled", response: external("fulfilled") }],
    ["Fulfilled", { status: "fulfilled", response: external() }],
    [
      "Allowed on iPhone",
      { status: "fulfilled", response: external("fulfilled"), settlementProvenance: provenance },
    ],
    [
      "Declined on iPhone",
      { status: "declined", response: external("declined"), settlementProvenance: provenance },
    ],
  ];
  try {
    const expected = [];
    for (const [preview, variant] of variants) {
      const id = createId("request");
      const kind = variant.kind ?? "person.question";
      const live = kind === "harness.input";
      const request = RequestSchema.parse({
        id,
        callId: id,
        cancellationReason: null,
        createdAt,
        kind,
        mode: live ? "live" : "durable",
        originatingOccurrenceId: null,
        originatingRunId: run.runId,
        originatingThreadId: run.threadId,
        payload: { kind },
        presentation: { kind: "choice", title: "Publish?", options: [allow, decline] },
        requestedBy: run.userId,
        requiredActor: "requester",
        resolvedAt,
        resolvedBy: run.userId,
        response: null,
        ...variant,
      });
      await commitPersonalMutation(database, async (tx) => {
        await tx.insertInto("requests").values(requestInsert(request)).execute();
        await refreshRequestState(tx, request.id);
      });
      expected.push({
        id: `request:${id}`,
        requestId: id,
        requestKind: kind,
        createdAt: resolvedAt,
        ...(live ? { waitedSince: createdAt } : {}),
        view: { title: "Publish?", status: request.status, preview },
      });
    }
    const page = await readTranscriptPage(database, {
      viewerId: run.userId,
      scope: { kind: "thread", threadId: run.threadId },
    });
    if (page.kind !== "page") throw new Error("Expected Request receipt history");
    const receipts = page.items.filter((item) => item.kind === "request");
    expect(receipts).toHaveLength(variants.length);
    for (const receipt of expected) {
      const item = receipts.find(({ id }) => id === receipt.id);
      expect(item).toMatchObject(receipt);
      if (receipt.waitedSince === undefined) expect(item?.waitedSince).toBeUndefined();
    }
  } finally {
    await f.close();
  }
});

test("names a nested asker and the subagent it runs inside on the waiting Request", async () => {
  const fixture = await createPersonalStateFixture("nested-asker");
  const { database, run, attemptId } = fixture;
  try {
    const node = (
      title: string,
      parentNodeId: ReturnType<typeof createId<"executionNode">> | null,
    ) => ({
      id: createId("executionNode"),
      attemptId,
      runId: run.runId,
      status: "running" as const,
      kind: "subagent" as const,
      effort: null,
      phaseIndex: null,
      phases: sql`'[]'::jsonb`,
      title,
      startedAt: new Date(),
      endedAt: null,
      nativeRef: title,
      originCallId: null,
      parentNodeId,
      prompt: null,
      result: null,
      sessionRef: null,
      model: null,
    });
    const parent = node("Trace the payment flow", null);
    const child = node("Check webhook retries", parent.id);
    await database
      .insertInto("executionNodes")
      .values([parent, child] as never)
      .execute();
    const request = liveRequest({
      harnessInstanceId: run.harnessInstance.id,
      id: createId("request"),
      requestedBy: run.userId,
      runId: run.runId,
      threadId: run.threadId,
      presentation: {
        kind: "choice",
        title: "Run stripe listen?",
        options: [{ id: "allow", label: "Allow", hint: "allow-once" }],
      },
    });
    await database
      .insertInto("requests")
      .values({ ...requestInsert(request), originatingNodeId: child.id })
      .execute();
    const { RequestStore } = await import("./request-store.js");
    const page = await new RequestStore(database).waitingOnUserPage({
      userId: run.userId,
      limit: 10,
    });
    expect(page.requests.find(({ request: { id } }) => id === request.id)?.subagent).toEqual({
      id: child.id,
      title: "Check webhook retries",
      within: { id: parent.id, title: "Trace the payment flow" },
    });
  } finally {
    await fixture.close();
  }
});

test("a settled subagent's card carries what it found", async () => {
  const fixture = await createPersonalStateFixture("node-result-card");
  const { database, run, attemptId } = fixture;
  try {
    const nodeId = createId("executionNode");
    await database
      .insertInto("executionNodes")
      .values({
        id: nodeId,
        attemptId,
        runId: run.runId,
        status: "completed",
        kind: "subagent",
        effort: null,
        phaseIndex: null,
        phases: sql`'[]'::jsonb`,
        title: "Trace the payment flow",
        startedAt: new Date(),
        endedAt: new Date(),
        nativeRef: "fixture",
        originCallId: null,
        parentNodeId: null,
        prompt: null,
        result: "The tap is lost in PayButton.tsx:42, before Stripe confirm runs.",
        sessionRef: null,
        model: null,
      })
      .execute();
    await commitPersonalMutation(database, (tx) => publishExecutionNode(tx, nodeId));
    const card = await database
      .selectFrom("transcriptItems")
      .select("view")
      .where("id", "=", `node:${nodeId}`)
      .executeTakeFirstOrThrow();
    expect(card.view).toMatchObject({
      status: "completed",
      preview: "The tap is lost in PayButton.tsx:42, before Stripe confirm runs.",
    });
  } finally {
    await fixture.close();
  }
});

test("draws a subagent's settled approval once, in its task, and nothing else of the subagent", async () => {
  const f = await createPersonalStateFixture("task-approval-receipt");
  const { database, run, attemptId } = f;
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
        title: "researcher",
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
    // The subagent's own step and words, which stay in its history.
    await commitPersonalMutation(database, async (tx, mutation) => {
      await startPersonalToolCall(tx, mutation, {
        runId: run.runId,
        threadId: run.threadId,
        attemptId,
        bindingGeneration: run.bindingGeneration,
        origin: "host-harness",
        nodeId,
        callId: "harness:child-command",
        tool: { namespace: "harness", name: "shell" },
        arguments: { command: "ls" },
      });
      await writeExecutionItem(tx, mutation, {
        id: `node-message:${nodeId}`,
        kind: "node-message",
        createdAt: new Date(),
        threadId: run.threadId,
        runId: run.runId,
        attemptId,
        nodeId,
        visible: true,
        isTurnStart: false,
        body: "Reading the release notes.",
        view: { preview: "Reading the release notes." },
      });
    });
    const ask = (
      kind: "harness.approval" | "harness.input",
      asker: typeof nodeId | null,
      settled?: true,
    ) => {
      const id = createId("request");
      return RequestSchema.parse({
        ...liveRequest({
          id,
          harnessInstanceId: run.harnessInstance.id,
          requestedBy: run.userId,
          runId: run.runId,
          threadId: run.threadId,
          presentation: {
            kind: "choice",
            title: "Run this command?",
            options: [{ id: "allow", label: "Allow once", hint: "allow-once" }],
          },
        }),
        kind,
        payload: { kind },
        ...(asker ? { originatingNodeId: asker } : {}),
        ...(settled
          ? {
              status: "fulfilled",
              response: { kind: "choice", optionId: "allow" },
              resolvedAt: new Date().toISOString(),
              resolvedBy: run.userId,
            }
          : {}),
      });
    };
    const approval = ask("harness.approval", nodeId);
    const question = ask("harness.input", nodeId, true);
    const rootApproval = ask("harness.approval", null, true);
    for (const request of [approval, question, rootApproval])
      await commitPersonalMutation(database, async (tx) => {
        await tx.insertInto("requests").values(requestInsert(request)).execute();
        await refreshRequestState(tx, request.id);
      });
    const task = {
      viewerId: run.userId,
      scope: { kind: "thread", threadId: run.threadId },
    } as const;
    const node = {
      viewerId: run.userId,
      scope: { kind: "node", threadId: run.threadId, nodeId },
    } as const;
    // Pending, it is answered from either the task or the subagent.
    for (const read of [task, node])
      expect(await readTranscriptOverlays(database, { ...read, kind: "requests" })).toMatchObject({
        entries: [expect.objectContaining({ id: approval.id })],
      });
    const { sequence: before } = await database
      .selectFrom("clientSyncState")
      .select("sequence")
      .executeTakeFirstOrThrow();
    await commitPersonalMutation(database, async (tx) => {
      await lockRequestThreads(tx, [run.threadId]);
      await tx
        .updateTable("requests")
        .set({
          status: "fulfilled",
          response: sql`${JSON.stringify({ kind: "choice", optionId: "allow" })}::jsonb`,
          resolvedAt: new Date(),
          resolvedBy: run.userId,
        })
        .where("id", "=", approval.id)
        .execute();
      await refreshRequestState(tx, approval.id);
    });
    const changes = await database
      .selectFrom("clientChanges")
      .select(["sequence", "scopeKey", "entityKind", "entityId", "operation", "payload"])
      .where("sequence", ">", before)
      .where("entityId", "in", [approval.id, `request:${approval.id}`])
      .where("scopeKey", "!=", "shell")
      .orderBy("scopeKey")
      .orderBy("entityKind")
      .execute();
    // One commit takes the question away from both views and puts one receipt in the task.
    expect(new Set(changes.map(({ sequence }) => sequence)).size).toBe(1);
    expect(
      changes.map(({ scopeKey, entityKind, operation }) => [scopeKey, entityKind, operation]),
    ).toEqual([
      [`node:${nodeId}`, "request", "remove"],
      [`thread:${run.threadId}`, "item", "upsert"],
      [`thread:${run.threadId}`, "request", "remove"],
    ]);
    const published = changes.find(({ entityKind }) => entityKind === "item")!.payload;
    const page = await readTranscriptPage(database, task);
    const anchored = await readTranscriptPage(database, {
      ...task,
      anchorItemId: `request:${approval.id}`,
    });
    const single = await readTranscriptItem(database, {
      ...task,
      itemId: `request:${approval.id}`,
    });
    const nodePage = await readTranscriptPage(database, node);
    if (page.kind !== "page" || anchored.kind !== "page" || nodePage.kind !== "page")
      throw new Error("Expected history pages");
    const receipt = page.items.find(({ id }) => id === `request:${approval.id}`);
    expect(receipt).toEqual(published);
    expect(receipt).toMatchObject({
      nodeId: null,
      requestKind: "harness.approval",
      view: { title: "Run this command?", status: "fulfilled", preview: "Fulfilled · Allow once" },
    });
    expect(anchored.items.find(({ id }) => id === receipt!.id)).toEqual(receipt);
    expect(single).toMatchObject({ kind: "item", item: receipt });
    // The task shows its own receipts and the subagent's approval; the subagent's question,
    // step and words stay in its own history.
    expect(page.items.filter(({ kind }) => kind === "request").map(({ id }) => id)).toEqual(
      [rootApproval.id, approval.id].map((id) => `request:${id}`),
    );
    expect(nodePage.items.map(({ kind, id }) => [kind, id])).toEqual([
      ["tool", expect.any(String)],
      ["node-message", `node-message:${nodeId}`],
      ["request", `request:${question.id}`],
    ]);
    expect(
      await readTranscriptItem(database, { ...node, itemId: `request:${approval.id}` }),
    ).toEqual({ kind: "unavailable" });
    // The canonical row still names the subagent that asked.
    expect(
      await database
        .selectFrom("transcriptItems")
        .select(["nodeId", "attemptId", "runId"])
        .where("id", "=", `request:${approval.id}`)
        .executeTakeFirstOrThrow(),
    ).toEqual({ nodeId, attemptId, runId: run.runId });
  } finally {
    await f.close();
  }
});

test("starts every scope over after a change to what its cards draw", async () => {
  const f = await createPersonalStateFixture("task-approval-epoch");
  const { database, run } = f;
  try {
    const resume = async () => {
      const state = await database
        .selectFrom("clientSyncState")
        .select(["deploymentId", "epoch", "sequence"])
        .executeTakeFirstOrThrow();
      const cursor = {
        deploymentId: state.deploymentId,
        epoch: state.epoch,
        viewerId: run.userId,
        scopeKey: `thread:${run.threadId}` as const,
        afterSequence: state.sequence,
      };
      return () =>
        readPersonalScopeCut(database, {
          viewerId: run.userId,
          scope: { kind: "thread", threadId: run.threadId },
          cursor,
          snapshot: async () => "snapshot",
        });
    };
    for (const migrate of [applyTaskApprovalReceipts, applyAnsweredQuestionRecords]) {
      const fromBefore = await resume();
      expect(await fromBefore()).toMatchObject({ kind: "replay" });
      await migrate(database);
      expect(await fromBefore()).toMatchObject({ kind: "snapshot", snapshot: "snapshot" });
    }
  } finally {
    await f.close();
  }
});
