import { createId, ThreadIdSchema, type AgentGrant } from "@opensteer/core";
import {
  admitExecution,
  AgentConnectionStore,
  authorizeTarget,
  ChannelStore,
  lineagePersonalContext,
} from "@opensteer/database";
import {
  createStoreFixture,
  pendingEvent,
  testContinuationIdentity,
  testMessagingRunnerId,
} from "@opensteer/database/test-support/store";
import { describe, expect, it, vi } from "vitest";
import { lastService, serveMcp } from "../mcp/connection-caller.test-support.js";
import { ChannelService } from "./channel-service.js";

type Store = Awaited<ReturnType<typeof createStoreFixture>>;

/** The Host's ingress as it runs: messages committed the way the messaging runtime sends them. */
async function host(
  storeFixture: Store,
  options: Parameters<Store["createBridgeFixture"]>[1],
  suffix: string,
) {
  const bridge = await storeFixture.createBridgeFixture(suffix, options);
  await serveMcp(storeFixture);
  const service = new ChannelService({
    channels: new ChannelStore(storeFixture.database),
    credentials: {} as never,
    relay: { connectedRunnerIds: () => [] } as never,
    store: storeFixture.store,
    bridgeTools: () => lastService!,
    onError: (error) => {
      throw error;
    },
  });
  service.start();
  const send = async (input: Parameters<typeof bridge.event>[0]) => {
    const committed = await service.handleRuntimeRequest(testMessagingRunnerId, {
      operation: "ingress.commit",
      payload: { connectionId: bridge.configured.connection.id, event: bridge.event(input) },
    } as never);
    const ingressId = (committed as { ingressId: string }).ingressId;
    await vi.waitFor(
      async () => {
        const row = await storeFixture.database
          .selectFrom("channelIngressEvents")
          .select(["status", "lastError"])
          .where("id", "=", ingressId as never)
          .executeTakeFirstOrThrow();
        expect(["adopted", "ignored"]).toContain(row.status);
      },
      { timeout: 20_000, interval: 50 },
    );
    return storeFixture.database
      .selectFrom("channelIngressEvents")
      .select(["status", "lastError"])
      .where("id", "=", ingressId as never)
      .executeTakeFirstOrThrow();
  };
  const tasks = () =>
    storeFixture.database
      .selectFrom("threads")
      .select(["id", "originConnectionId", "accessMode"])
      .where("originConnectionId", "=", bridge.bridge.id)
      .execute();
  const runsOf = (threadId: string) =>
    storeFixture.database
      .selectFrom("runs")
      .select(["id", "connectionId", "status"])
      .where("threadId", "=", ThreadIdSchema.parse(threadId))
      .orderBy("createdAt")
      .execute();
  return { ...bridge, service, send, tasks, runsOf };
}

describe("a message from a chat reaches your own agents only as its bridge", () => {
  it("starts a task in the bridge's lineage for the person, and answers nobody else", async () => {
    const storeFixture = await createStoreFixture();
    const f = await host(storeFixture, {}, "only-me");
    try {
      // The person's own account, linked by the code they sent.
      expect(await f.send({ eventId: "m1", text: "Summarize my week" })).toMatchObject({
        status: "adopted",
      });
      const [task] = await f.tasks();
      expect(task).toMatchObject({ accessMode: "approval-required" });
      const [run] = await f.runsOf(task!.id);
      expect(run).toMatchObject({ connectionId: f.bridge.id });
      // Someone else in the same direct-message account: ignored, and nothing is said.
      expect(
        await f.send({ eventId: "m2", externalUserId: "U-STRANGER", displayName: "Eve" }),
      ).toMatchObject({ status: "ignored", lastError: "Only the person may message this bridge" });
      expect(await f.tasks()).toHaveLength(1);
      // The person's next message goes to the same task.
      expect(await f.send({ eventId: "m3", text: "And next week" })).toMatchObject({
        status: "adopted",
      });
      expect(await f.tasks()).toHaveLength(1);
      const inputs = await storeFixture.database
        .selectFrom("threadInputs")
        .select(["connectionId", "replyTarget"])
        .where("threadId", "=", task!.id)
        .execute();
      expect(inputs).toHaveLength(2);
      expect(inputs.every((input) => input.connectionId === f.bridge.id)).toBe(true);
      // "stop" interrupts it; the chat may only ever reduce what happens.
      expect(await f.send({ eventId: "m4", text: "stop" })).toMatchObject({ status: "adopted" });
      expect(
        await storeFixture.database
          .selectFrom("commands")
          .select("type")
          .where("threadId", "=", task!.id)
          .where("type", "=", "run.interrupt")
          .execute(),
      ).not.toEqual([]);
    } finally {
      await f.service.close();
      await storeFixture.close();
    }
  });

  it("runs work from anyone in its one channel without the person's personal context", async () => {
    const storeFixture = await createStoreFixture();
    const f = await host(
      storeFixture,
      { senders: "anyone", conversation: { id: "C-team", name: "#team" } },
      "anyone",
    );
    try {
      expect(
        await f.send({ eventId: "a1", externalUserId: "U-COLLEAGUE", displayName: "Alex" }),
      ).toMatchObject({ status: "adopted" });
      const [task] = await f.tasks();
      const [run] = await f.runsOf(task!.id);
      expect(await lineagePersonalContext(storeFixture.database, run!.connectionId)).toBe(false);
      // A message nobody addressed to the bot in a thread it never joined starts nothing.
      expect(
        await f.send({ eventId: "a2", trigger: "conversation-followup", threadId: "999.000" }),
      ).toMatchObject({ status: "ignored" });
    } finally {
      await f.service.close();
      await storeFixture.close();
    }
  });

  it("gives a selected bridge's Runs only what its grant holds", async () => {
    const storeFixture = await createStoreFixture();
    const grant: AgentGrant = { scope: "selected", tasks: true, resources: [] };
    const f = await host(storeFixture, { grant }, "selected");
    try {
      expect(await f.send({ eventId: "s1" })).toMatchObject({ status: "adopted" });
      const [task] = await f.tasks();
      const [run] = await f.runsOf(task!.id);
      const admitted = await admitExecution(storeFixture.database, {
        ownerUserId: f.fixture.userId,
        subject: { kind: "binding", bindingId: `run:${run!.id}` },
      });
      expect(admitted).toMatchObject({ actor: "agent", mode: "approval-required" });
      for (const target of [
        { kind: "browser-profile", profileId: createId("browserProfile") },
        {
          kind: "plugin",
          target: { kind: "installed", pluginId: `plg_${crypto.randomUUID()}` },
        },
        { kind: "chrome-tabs", sourceId: createId("browserSource") },
      ] as const)
        expect(authorizeTarget(admitted, target as never)).toBeNull();
      // And it never reaches the person's own tasks.
      await expect(
        lastService!.callTool(
          "",
          "opensteer_task_send",
          { taskId: f.fixture.thread.id, message: "Hi", delivery: "queue" },
          {
            caller: {
              kind: "connection",
              key: `connection:${f.bridge.id}`,
              connectionId: f.bridge.id,
              userId: f.fixture.userId,
              accessMode: "approval-required",
              grant,
              grantRevision: f.bridge.grantRevision!,
              agentConnection: admitted.agentConnection!,
            },
            operationKey: "outside",
          },
        ),
      ).rejects.toMatchObject({ code: "not_found" });
    } finally {
      await f.service.close();
      await storeFixture.close();
    }
  });

  it("asks the person in Opensteer, sends the chat only a link, and takes no answer from it", async () => {
    const storeFixture = await createStoreFixture();
    const f = await host(storeFixture, {}, "needs-you");
    try {
      expect(await f.send({ eventId: "r1", text: "Read my email" })).toMatchObject({
        status: "adopted",
      });
      const [task] = await f.tasks();
      const [run] = await f.runsOf(task!.id);
      // Its Run starts on the person's computer, as a Runner would start it.
      const { store } = storeFixture;
      const execute = await storeFixture.database
        .selectFrom("commands")
        .select("id")
        .where("runId", "=", run!.id as never)
        .where("type", "=", "run.execute")
        .executeTakeFirstOrThrow();
      await store.claimCommand(execute.id, "needs-you-dispatcher");
      const harness = await storeFixture.database
        .selectFrom("runs")
        .select("harnessInstanceId")
        .where("id", "=", run!.id as never)
        .executeTakeFirstOrThrow();
      const binding = await store.acquireExecutionBinding({
        bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
        continuationIdentity: testContinuationIdentity,
        harnessInstanceId: harness.harnessInstanceId,
        leaseTokenHash: "needs-you-lease",
        runnerBootId: "needs-you-boot",
        runnerId: f.fixture.runnerId,
        runId: run!.id as never,
        threadId: task!.id,
      });
      await store.commitRunnerEvent({
        environmentId: f.fixture.environmentId,
        runnerId: f.fixture.runnerId,
        runnerBootId: "needs-you-boot",
        event: pendingEvent({
          bindingGeneration: binding.bindingGeneration,
          environmentId: f.fixture.environmentId,
          runId: run!.id as never,
          threadId: task!.id,
          ordinal: 0,
          type: "run.started",
          data: { status: "running" },
        }),
      });
      // The task's Run needs the person: a Request, as any Run would raise it.
      const { request } = await storeFixture.store.requests.create({
        callId: "needs-profile",
        kind: "browser.access",
        mode: "durable",
        originatingRunId: run!.id as never,
        originatingThreadId: task!.id,
        requestedBy: f.fixture.userId,
        requiredActor: "requester",
        payload: {
          kind: "browser.access",
          reason: "Read email",
          suggestion: { kind: "user_choice" },
        },
        presentation: {
          kind: "external",
          title: "Choose a profile",
          subject: { kind: "task", id: task!.id },
        },
      });
      // It is in Needs you.
      expect(
        await storeFixture.database
          .selectFrom("personalAttention")
          .select(["kind", "requestId"])
          .where("requestId", "=", request.id)
          .execute(),
      ).toEqual([{ kind: "request", requestId: request.id }]);
      // The chat hears one line with the task's link, and nothing of what was asked.
      const notices = await storeFixture.database
        .selectFrom("bridgeDeliveries")
        .select(["content", "kind"])
        .where("bridgeId", "=", f.bridge.id)
        .where("kind", "=", "status")
        .execute();
      expect(notices).toHaveLength(1);
      const text = JSON.stringify(notices[0]!.content);
      expect(text).toContain("This task needs you:");
      expect(text).toContain(task!.id);
      expect(text).not.toContain("Choose a profile");
      expect(text).not.toContain("Read email");
      // An answer typed in the chat is a message to the task, never an answer to the Request.
      expect(await f.send({ eventId: "r2", text: "yes, allow it" })).toMatchObject({
        status: "adopted",
      });
      expect(await storeFixture.store.requests.get(request.id)).toMatchObject({
        status: "pending",
      });
    } finally {
      await f.service.close();
      await storeFixture.close();
    }
  });

  it("tells a sender who may speak, and only them, that a message came too late or could not start", async () => {
    const storeFixture = await createStoreFixture();
    const f = await host(storeFixture, {}, "notices");
    try {
      const lines = async () =>
        (
          await storeFixture.database
            .selectFrom("bridgeDeliveries")
            .select("content")
            .where("bridgeId", "=", f.bridge.id)
            .where("kind", "=", "status")
            .orderBy("createdAt")
            .execute()
        ).map(({ content }) => (content as { text: string }[])[0]!.text);
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString();
      // Too late to act on: the person hears so; a stranger hears nothing.
      expect(await f.send({ eventId: "late-1", occurredAt: twoHoursAgo })).toMatchObject({
        status: "ignored",
      });
      expect(
        await f.send({
          eventId: "late-2",
          occurredAt: twoHoursAgo,
          externalUserId: "U-STRANGER",
          displayName: "Eve",
        }),
      ).toMatchObject({ status: "ignored" });
      expect(await lines()).toEqual([
        "This message arrived too late to act on. Send it again if you still need it.",
      ]);
      // Nothing can start it (no AI account is on): the person hears one line, with no reason.
      await storeFixture.database.updateTable("harnessInstances").set({ enabled: false }).execute();
      expect(await f.send({ eventId: "fail-1", text: "Start something" })).toMatchObject({
        status: "ignored",
      });
      expect(
        await f.send({ eventId: "fail-2", externalUserId: "U-STRANGER", displayName: "Eve" }),
      ).toMatchObject({ status: "ignored" });
      expect(await lines()).toEqual([
        "This message arrived too late to act on. Send it again if you still need it.",
        "Opensteer couldn't start this. Open Opensteer to see why.",
      ]);
      expect(await f.tasks()).toEqual([]);
      // A message that ran out of attempts: the same, for the person only.
      await f.service.close();
      for (const [eventId, externalUserId] of [
        ["dead-1", undefined],
        ["dead-2", "U-STRANGER"],
      ] as const) {
        const committed = await f.channels.commitIngress(
          f.configured.connection.id,
          f.event({ eventId, ...(externalUserId ? { externalUserId } : {}) }),
        );
        await storeFixture.database
          .updateTable("channelIngressEvents")
          .set({ attempts: 20, status: "pending", nextAttemptAt: new Date(0) })
          .where("id", "=", committed.ingressId)
          .execute();
        expect(await f.channels.claimIngress("dead-worker")).toBeNull();
      }
      expect(await lines()).toEqual([
        "This message arrived too late to act on. Send it again if you still need it.",
        "Opensteer couldn't start this. Open Opensteer to see why.",
        "Opensteer couldn't start this. Open Opensteer to see why.",
      ]);
    } finally {
      await f.service.close();
      await storeFixture.close();
    }
  });

  it("never lets a stranger's queued message run with the person's context: who may speak is fixed", async () => {
    const storeFixture = await createStoreFixture();
    const f = await host(
      storeFixture,
      { senders: "anyone", conversation: { id: "C-fixed", name: "#fixed" } },
      "senders-fixed",
    );
    try {
      // A stranger's message starts a task; their next one waits in its queue.
      const stranger = { externalUserId: "U-STRANGER", displayName: "Eve" };
      expect(await f.send({ eventId: "s1", ...stranger, text: "Start" })).toMatchObject({
        status: "adopted",
      });
      expect(
        await f.send({
          eventId: "s2",
          ...stranger,
          text: "Then this",
          trigger: "conversation-followup",
        }),
      ).toMatchObject({ status: "adopted" });
      const [task] = await f.tasks();
      const inputs = () =>
        storeFixture.database
          .selectFrom("threadInputs")
          .select(["messageId", "state"])
          .where("threadId", "=", task!.id)
          .orderBy("createdAt")
          .execute();
      expect((await inputs()).map(({ state }) => state)).toContain("pending");
      // Who may speak cannot be changed on the bridge, by the store or in the database.
      const connections = new AgentConnectionStore(storeFixture.database);
      await expect(
        connections.update(f.fixture.userId, {
          connectionId: f.bridge.id,
          expectedRevision: f.bridge.grantRevision!,
          senders: "owner",
        } as never),
      ).rejects.toMatchObject({ code: "bad_request", reason: "bridge-senders-fixed" });
      await expect(
        storeFixture.database
          .updateTable("agentConnections")
          .set({ bridgeSenders: "owner" })
          .where("id", "=", f.bridge.id)
          .execute(),
      ).rejects.toMatchObject({ constraint: "agent_connections_bridge_senders_fixed" });
      // To change it, the bridge is disconnected: its queued work never runs.
      await connections.revoke(f.fixture.userId, f.bridge.id);
      await storeFixture.store.driveConnectionCleanups({
        stopper: { stop: async () => undefined },
      });
      expect((await inputs()).every(({ state }) => state !== "pending")).toBe(true);
      // And its lineage never gains the person's personal context, whatever comes after.
      expect(await lineagePersonalContext(storeFixture.database, f.bridge.id)).toBe(false);
      const onlyMe = await connections.createBridge({
        userId: f.fixture.userId,
        accountId: f.configured.account.id,
        conversation: { id: "C-fixed", name: "#fixed" },
        senders: "owner",
        accessMode: "approval-required",
        grant: { scope: "selected", tasks: true, resources: [] },
      });
      expect(await lineagePersonalContext(storeFixture.database, f.bridge.id)).toBe(false);
      expect(await f.send({ eventId: "s3", ...stranger, text: "Again" })).toMatchObject({
        status: "ignored",
      });
      expect(
        await storeFixture.database
          .selectFrom("threads")
          .select("id")
          .where("originConnectionId", "=", onlyMe.id)
          .execute(),
      ).toEqual([]);
    } finally {
      await f.service.close();
      await storeFixture.close();
    }
  });
});
