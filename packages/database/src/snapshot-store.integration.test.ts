import { createId, ModelSelectionSchema } from "@opensteer/core";
import { expect } from "vitest";
import { OpensteerStore } from "./store.js";
import {
  describeStore,
  testModelSelection,
  testContinuationIdentity,
} from "./store.integration.test-support.js";

describeStore("Workspace snapshot history", (it) => {
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
