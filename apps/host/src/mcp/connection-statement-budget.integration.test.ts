import type { AgentGrant, RunId, ThreadId } from "@opensteer/core";
import { describeStore, testModelSelection } from "@opensteer/database/test-support/store";
import { startPersonalQueuedRunFixture } from "@opensteer/database/test-support/personal-run";
import pg from "pg";
import { expect, vi } from "vitest";
import { connection, createTask, queuedRun, serveMcp } from "./connection-caller.test-support.js";

/** Every statement this process sends while `action` runs. */
async function statements(action: () => Promise<unknown>): Promise<string[]> {
  const sent: string[] = [];
  const prototype: { query(...args: unknown[]): unknown } = pg.Client.prototype;
  const query = prototype.query;
  const spy = vi.spyOn(prototype, "query").mockImplementation(function (
    this: pg.Client,
    ...args: unknown[]
  ) {
    const first = args[0];
    sent.push(
      typeof first === "string"
        ? first
        : first && typeof first === "object" && "text" in first && typeof first.text === "string"
          ? first.text
          : "<unknown>",
    );
    return Reflect.apply(query, this, args);
  });
  try {
    await action();
  } finally {
    spy.mockRestore();
  }
  return sent;
}

describeStore("a connected agent's reads stay within their statement budgets", (it) => {
  it("discovers, waits on a child task and reads a task in a fixed number of statements", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("connection-statements");
    const url = await serveMcp(storeFixture);
    const everything = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
    });
    const tasksOnly: AgentGrant = { scope: "selected", tasks: true, resources: [] };
    const selected = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
      grant: tasksOnly,
    });
    const own = await createTask(selected, f, "statements-own");
    const ownRun = await startPersonalQueuedRunFixture(
      storeFixture.store,
      (await queuedRun(storeFixture, own)).id,
    );
    const requestIds: string[] = [];
    for (const callId of ["statements-first", "statements-second", "statements-third"]) {
      const { request } = await storeFixture.store.requests.create({
        callId,
        kind: "person.question",
        mode: "durable",
        originatingRunId: ownRun.runId as RunId,
        originatingThreadId: own as ThreadId,
        requestedBy: f.userId,
        requiredActor: "requester",
        payload: { kind: "person.question" },
        presentation: {
          kind: "form",
          title: "Question",
          fields: [
            { id: "answer", prompt: "Ready?", secret: false, custom: true, multiSelect: false },
          ],
        },
      });
      // A resolved Request is an item of the task's activity.
      await storeFixture.store.requests.withdraw({
        requestId: request.id,
        threadId: own as ThreadId,
        withdrawnBy: f.userId,
      });
      requestIds.push(request.id);
    }
    const child = await storeFixture.store.delegateThread({
      accessMode: "full-access",
      createdBy: f.userId,
      environmentId: f.environmentId,
      harnessInstanceId: f.harnessInstance.id,
      idempotencyKey: "statements-child",
      modelSelection: testModelSelection,
      origin: { kind: "run", parentRunId: ownRun.runId, parentThreadId: own },
      task: [{ type: "text", text: "Sub-work" }],
      title: "Child of the connection's task",
    });
    // A settled child answers on its first snapshot, so the count does not depend on timing.
    await storeFixture.database
      .updateTable("runs")
      .set({ status: "completed", completedAt: new Date() })
      .where("id", "=", child.run.id)
      .execute();
    const calls = {
      discover: () => everything.client.callTool({ name: "discover", arguments: {} }),
      childWait: () =>
        selected.client.callTool({
          name: "opensteer_task_wait",
          // Give the settled child's first snapshot room to complete instead of racing a 1ms timer.
          arguments: { taskId: child.thread.id, timeoutMs: 5_000 },
        }),
      taskRead: () =>
        selected.client.callTool({
          name: "opensteer_task_read",
          arguments: { taskId: own, view: "activity" },
        }),
    };
    const counts: Record<string, number> = {};
    for (const [name, call] of Object.entries(calls)) {
      const warm = await call();
      expect(warm.isError, JSON.stringify(warm.content)).not.toBe(true);
      if (name === "childWait")
        expect((warm.structuredContent as { status?: string }).status).toBe("settled");
      if (name === "taskRead")
        for (const id of requestIds) expect(JSON.stringify(warm.structuredContent)).toContain(id);
      counts[name] = (await statements(call)).length;
    }
    // Fixed per-call budgets:
    // - discover: 22 (one live check per discover call; 27 before).
    // - childWait: 89 (settled first snapshot with status === "settled"; previously 36/34 when
    //   timeoutMs: 1 aborted mid-read and returned timed_out depending on machine speed).
    // - taskRead: 28 (down from 32 after folding connectionRequests into recent/activity SQL
    //   and removing post-hoc visibleConnectionRequestIds and duplicate owner reads).
    expect(counts).toEqual({ discover: 22, childWait: 89, taskRead: 28 });
  });
});
