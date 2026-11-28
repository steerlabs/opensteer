import { AgentConnectionStore, readAgentRequest } from "@opensteer/database";
import { describeStore, pendingEvent } from "@opensteer/database/test-support/store";
import { expect } from "vitest";
import {
  commands,
  connection,
  ownerTask,
  send,
  serveMcp,
} from "./connection-caller.test-support.js";

describeStore("one send rule, at send, at dequeue and at the start of a Run", (it) => {
  it("cancels a follow-up waiting on the person's task once its connection is narrowed to selected", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("narrowed-follow-up");
    const { database, store } = storeFixture;
    const url = await serveMcp(storeFixture);
    const agent = await connection(store, url, {
      userId: f.userId,
      accessMode: "full-access",
      grant: { scope: "everything" },
    });
    // The person's task is busy, so the agent's message waits as a follow-up.
    const sent = await send(agent, f.threadId, "narrowed-follow-up");
    expect(sent.isError, JSON.stringify(sent.content)).not.toBe(true);
    const waiting = await database
      .selectFrom("threadInputs")
      .select(["messageId", "state", "connectionId"])
      .where("threadId", "=", f.threadId)
      .where("connectionId", "=", agent.id)
      .executeTakeFirstOrThrow();
    expect(waiting.state).toBe("pending");
    // Tasks stay on; only the reach narrows to the agent's own tasks.
    await new AgentConnectionStore(database).update(f.userId, {
      connectionId: agent.id,
      expectedRevision: 1,
      grant: { scope: "selected", tasks: true, resources: [] },
    });
    await store.commitRunnerEvent({
      environmentId: f.environmentId,
      runnerId: f.runnerId,
      runnerBootId: f.runnerBootId,
      event: pendingEvent({
        bindingGeneration: f.bindingGeneration,
        data: { status: "completed" },
        environmentId: f.environmentId,
        ordinal: 1,
        runId: f.run.id,
        threadId: f.threadId,
        type: "run.completed",
      }),
    });
    expect(
      await database
        .selectFrom("threadInputs")
        .select(["state", "cancelReason"])
        .where("messageId", "=", waiting.messageId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: "cancelled", cancelReason: "authority-revoked" });
    expect(
      await database
        .selectFrom("runs")
        .select("id")
        .where("threadId", "=", f.threadId)
        .where("status", "=", "queued")
        .execute(),
    ).toEqual([]);
  });

  it("refuses to start a queued Run that disagrees with its connection seed, rather than run it as the person's", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("seed-mismatch");
    const { database, store } = storeFixture;
    const url = await serveMcp(storeFixture);
    const agent = await connection(store, url, {
      userId: f.userId,
      accessMode: "full-access",
      grant: { scope: "everything" },
    });
    const task = await ownerTask(storeFixture, f, "seed-mismatch");
    expect((await send(agent, task, "seed-mismatch")).isError).not.toBe(true);
    const run = await database
      .selectFrom("runs")
      .select(["id", "connectionId"])
      .where("threadId", "=", task)
      .where("status", "=", "queued")
      .executeTakeFirstOrThrow();
    expect(run.connectionId).toBe(agent.id);
    // As a Run queued before lineage existed would read: no connection, though its seed has one.
    await database
      .updateTable("runs")
      .set({ connectionId: null })
      .where("id", "=", run.id)
      .execute();
    const command = await database
      .selectFrom("commands")
      .select("id")
      .where("runId", "=", run.id)
      .where("type", "=", "run.execute")
      .executeTakeFirstOrThrow();
    await expect(store.claimCommand(command.id, "seed-mismatch")).rejects.toMatchObject({
      reason: "run-lineage-mismatch",
    });
  });

  it("lets a connection read a Request on the person's task only when the person's own work asked it", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("request-origin");
    const { database, store } = storeFixture;
    const url = await serveMcp(storeFixture);
    const reader = await connection(store, url, {
      userId: f.userId,
      accessMode: "full-access",
      grant: { scope: "everything" },
    });
    const other = await connection(store, url, {
      userId: f.userId,
      accessMode: "full-access",
      grant: { scope: "everything" },
    });
    const created = await store.requests.create({
      callId: "request-origin",
      kind: "person.question",
      mode: "durable",
      originatingRunId: f.run.id,
      originatingThreadId: f.threadId,
      payload: { kind: "person.question" },
      presentation: {
        kind: "form",
        title: "Which one?",
        fields: [
          { id: "q", prompt: "Which one?", custom: true, multiSelect: false, secret: false },
        ],
      },
      requestedBy: f.userId,
      requiredActor: "requester",
    } as never);
    const read = () =>
      reader.client.callTool({
        name: "opensteer_task_wait",
        arguments: { taskId: f.threadId, timeoutMs: 1_000 },
      });
    // Asked by the person's own Run: an `everything` agent may read it.
    const first = await read();
    expect(first.isError, JSON.stringify(first.content)).not.toBe(true);
    expect(first.structuredContent).toMatchObject({ pendingRequest: { id: created.request.id } });
    expect(JSON.stringify(first)).not.toMatch(
      /Which one|Ready\?|custom|multiSelect|pendingRequests/u,
    );
    // The same task, but the asking Run worked for another connection.
    await database
      .updateTable("runs")
      .set({ connectionId: other.id })
      .where("id", "=", f.run.id)
      .execute();
    const taskRead = async () =>
      reader.client.callTool({
        name: "opensteer_task_read",
        arguments: { taskId: f.threadId, view: "activity" },
      });
    const hiddenTask = await taskRead();
    expect(hiddenTask.isError, JSON.stringify(hiddenTask.content)).not.toBe(true);
    expect(hiddenTask.structuredContent).not.toHaveProperty("task.pendingRequests");
    expect(JSON.stringify(hiddenTask)).not.toContain(created.request.id);
    const hidden = await read();
    expect(hidden.isError).not.toBe(true);
    expect(hidden.structuredContent).not.toHaveProperty("pendingRequest");
    expect(JSON.stringify(hidden)).not.toContain(created.request.id);

    const authority = {
      kind: "connection",
      userId: f.userId,
      connectionId: other.id,
      accessMode: "full-access",
    } as const;
    const readAsOther = () => readAgentRequest(database, authority, created.request.id);
    await expect(readAsOther()).resolves.toMatchObject({ request: { id: created.request.id } });
    const administration = commands(storeFixture, f.userId);
    await administration.update(other.id, { accessMode: "approval-required" });
    await expect(readAsOther()).rejects.toMatchObject({ code: "forbidden" });
    await administration.update(other.id, {
      expectedRevision: 2,
      grant: { scope: "selected", tasks: false, resources: [] },
    });
    await expect(
      readAgentRequest(
        database,
        { ...authority, accessMode: "approval-required" },
        created.request.id,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
