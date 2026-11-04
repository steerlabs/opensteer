import { recoverThreadWorkQueues } from "./execution-recovery.js";
import { finalizeRunTransaction } from "./run-finalization.js";
import { messageFromRow, threadInputFromRow } from "./thread-row-mappers.js";
import { sql } from "kysely";
import { createId, ModelSelectionSchema } from "@opensteer/core";
import { expect } from "vitest";
import { OpensteerStore } from "./store.js";
import {
  describeStore,
  testModelSelection,
  testContinuationIdentity,
} from "./store.integration.test-support.js";

describeStore("Workspace snapshot history", (it) => {
  it("remembers a human hand-off returned to the queue at finalization", async ({
    storeFixture,
  }) => {
    const { database, store, startRunFixture } = storeFixture;
    const f = await startRunFixture("waited-returned-steer");
    await database
      .updateTable("threads")
      .set({ role: "conversation", inputQueuePaused: true, inputQueuePausedBy: f.userId })
      .where("id", "=", f.thread.id)
      .execute();
    await database
      .updateTable("messages")
      .set({
        author: {
          kind: "watch",
          displayName: "Watcher",
          activationId: createId("triggerWatchActivation"),
          revisionId: createId("triggerRevision"),
          triggerId: createId("trigger"),
        },
      })
      .where("id", "=", f.run.seedInputId)
      .execute();
    await database
      .updateTable("runs")
      .set({ personWaited: false })
      .where("id", "=", f.run.id)
      .execute();
    const queued = await store.enqueueThreadInput({
      content: [{ type: "text", text: "Please help" }],
      idempotencyKey: "waited-return",
      policy: "queue",
      requestedBy: f.userId,
      source: { kind: "human" },
      threadId: f.thread.id,
    });
    await database
      .updateTable("threads")
      .set({ inputQueuePaused: false, inputQueuePausedBy: null })
      .where("id", "=", f.thread.id)
      .execute();
    const steered = await store.steerThreadInput({
      threadId: f.thread.id,
      expectedRunId: f.run.id,
      messageId: queued.message.id,
      requestedBy: f.userId,
      idempotencyKey: "waited-steer",
    });
    expect(steered.command).not.toBeNull();
    await database
      .updateTable("threads")
      .set({ inputQueuePaused: true, inputQueuePausedBy: f.userId })
      .where("id", "=", f.thread.id)
      .execute();
    await database.transaction().execute((tx) =>
      finalizeRunTransaction(tx, {
        completedAt: new Date(),
        links: { threadUrl: (id) => `https://example.test/thread/${id}` },
        queuedInputCancellation: "seed-input",
        runId: f.run.id,
        source: "runner",
        status: "completed",
      }),
    );
    expect(
      await database
        .selectFrom("messages")
        .select("runId")
        .where("id", "=", queued.message.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ runId: null });
    expect(
      await database
        .selectFrom("runs")
        .select(["personWaited"])
        .where("id", "=", f.run.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ personWaited: true });
  });

  it("interrupts legacy report-driven queued Runs during recovery", async ({ storeFixture }) => {
    const { database, createRunFixture, enqueueHumanTrigger } = storeFixture;
    const f = await createRunFixture("quiet-legacy-report");
    const admitted = await enqueueHumanTrigger({
      content: [{ type: "text", text: "Legacy report" }],
      requestedBy: f.userId,
      idempotencyKey: "legacy-report",
      threadId: f.thread.id,
    });
    await database
      .updateTable("messages")
      .set({
        author: {
          kind: "watch",
          displayName: "Watcher",
          activationId: createId("triggerWatchActivation"),
          revisionId: createId("triggerRevision"),
          triggerId: createId("trigger"),
        },
      })
      .where("id", "=", admitted.run.seedInputId)
      .execute();
    await database
      .updateTable("runs")
      .set({ personWaited: false })
      .where("id", "=", admitted.run.id)
      .execute();
    await database
      .updateTable("threadInputs")
      .set({ policy: "report" })
      .where("messageId", "=", admitted.run.seedInputId)
      .execute();
    await recoverThreadWorkQueues(database);
    expect(
      await database
        .selectFrom("runs")
        .select(["status"])
        .where("id", "=", admitted.run.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "interrupted" });
  });

  it("keeps a human-seeded Run stopped before claim", async ({ storeFixture }) => {
    const { database, store, createRunFixture, enqueueHumanTrigger } = storeFixture;
    const f = await createRunFixture("human-stop-before-claim");
    const admitted = await enqueueHumanTrigger({
      content: [{ type: "text", text: "Please help" }],
      requestedBy: f.userId,
      idempotencyKey: "human-stop",
      threadId: f.thread.id,
    });
    await database.transaction().execute((tx) =>
      finalizeRunTransaction(tx, {
        completedAt: new Date(),
        links: { threadUrl: (id) => `https://example.test/thread/${id}` },
        queuedInputCancellation: "seed-input",
        runId: admitted.run.id,
        source: "host",
        status: "interrupted",
      }),
    );
    expect(
      await database
        .selectFrom("runs")
        .select(["personWaited"])
        .where("id", "=", admitted.run.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ personWaited: true });
    expect(
      await store.threadEventPageForOwner({
        ownerId: f.userId,
        threadId: f.thread.id,
        maxTurns: 10,
      }),
    ).not.toBeNull();
  });

  it("does not count report updates or automatic steers as new turns", async ({ storeFixture }) => {
    const { database, store, startRunFixture } = storeFixture;
    const f = await startRunFixture("automatic-page-boundaries");
    await database
      .updateTable("threads")
      .set({ role: "conversation" })
      .where("id", "=", f.thread.id)
      .execute();
    const seed = await database
      .selectFrom("messages")
      .selectAll()
      .where("id", "=", f.run.seedInputId)
      .executeTakeFirstOrThrow();
    const input = threadInputFromRow(
      await database
        .selectFrom("threadInputs")
        .selectAll()
        .where("messageId", "=", f.run.seedInputId)
        .executeTakeFirstOrThrow(),
    );
    const message = {
      ...messageFromRow(seed),
      author: {
        kind: "watch",
        displayName: "Watcher",
        activationId: createId("triggerWatchActivation"),
        revisionId: createId("triggerRevision"),
        triggerId: createId("trigger"),
      },
    };
    const starts: string[] = [];
    for (const [type, data] of [
      ["message.placed", { message }],
      [
        "message.created",
        { message: { ...message, id: createId("message") }, input: { ...input, policy: "steer" } },
      ],
      ["message.placed", { message: { ...message, id: createId("message") } }],
      [
        "message.created",
        {
          message: { ...message, id: createId("message"), runId: null },
          input: { ...input, policy: "report" },
        },
      ],
      [
        "run.completed",
        {
          status: "completed",
          replyMessageId: null,
          startedBy: message.author,
          personWaiting: false,
          startedAt: seed.createdAt.toISOString(),
        },
      ],
    ] as const) {
      const clock = await database
        .updateTable("workspaces")
        .set({ eventSequence: sql`event_sequence + 1` })
        .where("id", "=", f.workspace.id)
        .returning("eventSequence")
        .executeTakeFirstOrThrow();
      starts.push(clock.eventSequence);
      await sql`insert into workspace_events (event_id, sequence, workspace_id, thread_id, run_id, environment_id, type, data, created_at)
        values (${createId("event")}, ${clock.eventSequence}, ${f.workspace.id}, ${f.thread.id}, ${f.run.id}, ${f.environmentId}, ${type}, ${JSON.stringify(data)}::jsonb, now())`.execute(
        database,
      );
    }
    const page = await store.threadEventPageForOwner({
      ownerId: f.userId,
      threadId: f.thread.id,
      maxTurns: 1,
    });
    expect(page!.events.map(({ sequence }) => sequence)).toEqual(starts);
    expect(page!.window.nextBefore).toBe(starts[0]);
    expect(page!.window.totalItems).toBeGreaterThanOrEqual(5);
  });

  it("moves tasks only for admitted human work, including steering a running turn", async ({
    storeFixture,
  }) => {
    const { database, store, startRunFixture } = storeFixture;
    const f = await startRunFixture("task-asked");
    const other = await store.createThread({
      createdBy: f.userId,
      environmentId: f.environmentId,
      harnessInstanceId: f.harnessInstance.id,
      idempotencyKey: "task-asked-other",
      modelSelection: testModelSelection,
      title: "Other",
      workspaceId: f.workspace.id,
    });
    expect(other.thread.askedAt).toBe(other.thread.createdAt);
    await database
      .updateTable("threads")
      .set({ askedAt: new Date("2020-01-01") })
      .where("id", "=", f.thread.id)
      .execute();
    await database
      .updateTable("threads")
      .set({ askedAt: new Date("2021-01-01") })
      .where("id", "=", other.thread.id)
      .execute();
    const page = () => store.taskPageForUser({ userId: f.userId });
    expect((await page()).tasks.map(({ thread }) => thread.id)).toEqual([
      other.thread.id,
      f.thread.id,
    ]);
    const steer = await store.enqueueThreadInput({
      content: [{ type: "text", text: "Please change direction" }],
      idempotencyKey: "task-asked-steer",
      policy: "steer",
      requestedBy: f.userId,
      source: { kind: "human" },
      threadId: f.thread.id,
    });
    expect(steer.disposition).toBe("steering");
    const asked = (await page()).tasks[0]!.thread;
    expect(asked.id).toBe(f.thread.id);
    expect(Date.parse(asked.askedAt!)).toBeGreaterThan(Date.parse("2021-01-01"));
    const unchanged = async () =>
      expect(
        (await page()).tasks.find(({ thread }) => thread.id === f.thread.id)!.thread.askedAt,
      ).toBe(asked.askedAt);
    await store.enqueueThreadInput({
      content: [{ type: "text", text: "Agent context" }],
      idempotencyKey: "task-asked-agent",
      policy: "queue",
      requestedBy: f.userId,
      source: { kind: "agent", runId: f.run.id },
      threadId: f.thread.id,
    });
    await unchanged();
    const child = await store.delegateThread({
      accessMode: "auto",
      createdBy: f.userId,
      environmentId: f.environmentId,
      harnessInstanceId: f.harnessInstance.id,
      idempotencyKey: "task-asked-child",
      modelSelection: testModelSelection,
      origin: { kind: "run", parentRunId: f.run.id, parentThreadId: f.thread.id },
      task: [{ type: "text", text: "Check something" }],
      title: "Child",
      workspaceId: f.workspace.id,
    });
    await database
      .updateTable("runs")
      .set({ status: "completed" })
      .where("id", "=", child.run.id)
      .execute();
    await database
      .updateTable("delegations")
      .set({
        status: "completed",
        resultRunId: child.run.id,
        resultText: "Checked",
        finishedAt: new Date(),
      })
      .where("id", "=", child.assignment.id)
      .execute();
    expect(
      (await store.drainAssignmentReturn(child.assignment.id)).some(
        ({ type }) => type === "message.created",
      ),
    ).toBe(true);
    await unchanged();

    await store.enqueueThreadInput({
      content: [{ type: "text", text: "Human report" }],
      idempotencyKey: "task-asked-report",
      policy: "report",
      requestedBy: f.userId,
      source: { kind: "human" },
      threadId: f.thread.id,
    });
    await unchanged();
    await database
      .updateTable("threads")
      .set({ titleSource: "provisional", iconSource: "provisional" })
      .where("id", "=", f.thread.id)
      .execute();
    expect(
      await store.applyGeneratedThreadName({
        threadId: f.thread.id,
        title: "Generated",
        icon: "code",
      }),
    ).not.toBeNull();
    await unchanged();
    await store.renameThread({
      threadId: f.thread.id,
      requestedBy: f.userId,
      idempotencyKey: "task-asked-rename",
      title: "Renamed",
    });
    await unchanged();
    await database
      .updateTable("runs")
      .set({ status: "completed" })
      .where("threadId", "=", f.thread.id)
      .execute();
    await store.updateThreadExecutionSelection({
      threadId: f.thread.id,
      requestedBy: f.userId,
      idempotencyKey: "task-asked-model",
      harnessInstanceId: f.harnessInstance.id,
      continuationIdentity: testContinuationIdentity,
      modelSelection: ModelSelectionSchema.parse({
        ...testModelSelection,
        modelId: "another-model",
      }),
    });
    await unchanged();
    await database
      .updateTable("threads")
      .set({ askedAt: new Date("2020-01-01") })
      .where("id", "=", other.thread.id)
      .execute();
    await store.enqueueThreadInput({
      content: [{ type: "text", text: "Start other" }],
      idempotencyKey: "task-asked-human",
      policy: "queue",
      requestedBy: f.userId,
      source: { kind: "human" },
      threadId: other.thread.id,
    });
    expect((await page()).tasks[0]!.thread.id).toBe(other.thread.id);
  });

  it("omits history without reading message rows or counts and retains metadata", async ({
    storeFixture,
  }) => {
    const { database, store, startRunFixture, openLiveRequest } = storeFixture;
    const f = await startRunFixture("snapshot-omitted-history");
    const requestId = createId("request");
    await openLiveRequest(f, requestId);
    let messageQueries = 0;
    const observed = new OpensteerStore(
      database.withPlugin({
        transformQuery({ node }) {
          if (JSON.stringify(node).includes('"name":"messages"')) messageQueries += 1;
          return node;
        },
        async transformResult({ result }) {
          return result;
        },
      }),
    );
    const full = await observed.workspaceSnapshot(f.workspace.id);
    expect(full.messages.length).toBeGreaterThan(0);
    expect(full.messageWindows).toContainEqual(
      expect.objectContaining({ threadId: f.thread.id, totalItems: 1 }),
    );
    expect(full).not.toHaveProperty("messagesOmitted");
    expect(messageQueries).toBe(2);
    messageQueries = 0;
    const omitted = await observed.workspaceSnapshot(f.workspace.id, { omitMessages: true });
    expect.soft(omitted.messages).toEqual([]);
    expect.soft(omitted.messageWindows).toEqual([]);
    expect.soft(omitted).toHaveProperty("messagesOmitted", true);
    expect(messageQueries).toBe(0);
    expect(omitted.serializedBytes).toBe(Buffer.byteLength(JSON.stringify(omitted), "utf8"));
    const metadata = ({
      messages: _messages,
      messageWindows: _windows,
      serializedBytes: _bytes,
      messagesOmitted: _omitted,
      ...rest
    }: typeof omitted) => rest;
    expect(metadata(omitted)).toEqual(metadata(full));
    // Viewer state still reads the latest published sequence, never history bodies.
    const withViewer = await store.workspaceSnapshot(f.workspace.id, { viewerId: f.userId });
    const omittedWithViewer = await store.workspaceSnapshot(f.workspace.id, {
      viewerId: f.userId,
      omitMessages: true,
    });
    expect(omittedWithViewer.readStates).toHaveLength(1);
    expect(metadata(omittedWithViewer)).toEqual(metadata(withViewer));
    expect(omittedWithViewer.pendingRequests).toContainEqual(
      expect.objectContaining({ id: requestId }),
    );
    expect(omittedWithViewer.runQueue).toContainEqual(expect.objectContaining({ id: f.run.id }));
  });
});
