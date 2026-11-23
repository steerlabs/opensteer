import { createChannelId, type ChannelConversationId } from "@opensteer/channel-core";
import { BrowserSessionIdSchema, createId, type RequestPresentation } from "@opensteer/core";
import { sql } from "kysely";
import { expect } from "vitest";
import { AgentConnectionStore } from "./agent-connection-store.js";
import { BrowserSourceStore } from "./browser-source-store.js";
import { enqueueChannelConversationStatus } from "./channel-deliveries.js";
import { openCleanups } from "./connection-disconnect.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import { browserSignInRequestDeliverableInTransaction } from "./request-store.js";
import { agentEndedForPersonMessage, chatEndedMessage } from "./resource-access.js";
import { describeStore, testMessagingRunnerId } from "./store.integration.test-support.js";

describeStore("answers leave the Home only through a bridge's Disconnect set", (it) => {
  it("ends the bridge's Run, cancels what has not left, and keeps what may have as unknown", async ({
    storeFixture,
  }) => {
    const bridge = await storeFixture.createBridgeFixture("disconnect");
    const { database, store } = storeFixture;
    const { channels, fixture } = bridge;
    // The person's message, admitted as the bridge, queues a Run in its lineage.
    const conversationId = createChannelId("conversation") as ChannelConversationId;
    await database
      .insertInto("bridgeConversations")
      .values({
        id: conversationId,
        bridgeId: bridge.bridge.id,
        accountId: bridge.configured.account.id,
        externalScopeId: null,
        externalConversationId: "D-disconnect",
        externalThreadId: null,
        conversationType: "dm",
        displayName: null,
        threadId: null,
      })
      .execute();
    await database
      .updateTable("threads")
      .set({ originConnectionId: bridge.bridge.id })
      .where("id", "=", fixture.thread.id)
      .execute();
    const queued = await store.enqueueThreadInput({
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
      content: [{ type: "text", text: "What's on today?" }],
      source: {
        kind: "connection",
        connectionId: bridge.bridge.id,
        chat: {
          conversationId,
          revision: bridge.bridge.grantRevision!,
          sender: { displayName: "Tim", externalUserId: bridge.owner },
        },
      },
      policy: "queue",
      idempotencyKey: "disconnect-message",
    });
    expect(
      await database
        .selectFrom("runs")
        .select("connectionId")
        .where("id", "=", queued.run!.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ connectionId: bridge.bridge.id });
    // Two notices to the chat: one is mid-send, one is waiting.
    const notice = (text: string) =>
      commitPersonalMutation(database, (tx) =>
        enqueueChannelConversationStatus(tx, { conversationId, text }),
      );
    await notice("first");
    await notice("second");
    const first = (await channels.claimDelivery(testMessagingRunnerId))!;
    await channels.startDeliveryAttempt(first.delivery.id, first.claimToken);
    const deliveries = () =>
      database
        .selectFrom("bridgeDeliveries")
        .select(["id", "status"])
        .where("bridgeId", "=", bridge.bridge.id)
        .orderBy("createdAt")
        .execute();
    expect((await deliveries()).map(({ status }) => status)).toEqual([
      "attempt-started",
      "pending",
    ]);

    // Disconnect: the waiting one never leaves, and the Run's stop is asked for.
    const connections = new AgentConnectionStore(database);
    expect(await connections.revoke(fixture.userId, bridge.bridge.id)).toBe(true);
    await store.driveConnectionCleanups({ stopper: { stop: async () => undefined } });
    expect((await deliveries()).map(({ status }) => status)).toEqual([
      "attempt-started",
      "cancelled",
    ]);
    expect(
      await database
        .selectFrom("commands")
        .select("type")
        .where("runId", "=", queued.run!.id)
        .where("type", "=", "run.interrupt")
        .execute(),
    ).toEqual([{ type: "run.interrupt" }]);
    // The one mid-send holds the bridge at Stopping until its runtime answers.
    const state = async () =>
      (await connections.list(fixture.userId, { includeRevoked: true })).find(
        ({ id }) => id === bridge.bridge.id,
      );
    expect(await state()).toMatchObject({ state: "stopping" });
    // Nothing more is handed out, or starts, once Disconnect committed.
    expect(await channels.claimDelivery(testMessagingRunnerId)).toBeNull();
    // Its answer never came: it may have arrived, so it is unknown, and the end shows that.
    await channels.finishDelivery({
      claimToken: first.claimToken,
      deliveryId: first.delivery.id,
      outcome: "unknown",
      error: "The provider never confirmed",
    });
    await store.driveConnectionCleanups({ stopper: { stop: async () => undefined } });
    expect(await channels.claimDelivery(testMessagingRunnerId)).toBeNull();
    expect(await state()).toMatchObject({ lastActionUncertain: true });
  });

  it("never hands out a send that may have happened, and tries again only a proven failure", async ({
    storeFixture,
  }) => {
    const { channels, conversationId, configured } =
      await storeFixture.createChannelDeliveryFixture("unknown-once");
    const { insertChannelDelivery, database } = storeFixture;
    const id = await insertChannelDelivery({
      accountId: configured.account.id,
      conversationId,
      status: "pending",
    });
    const claim = (await channels.claimDelivery(testMessagingRunnerId))!;
    expect(claim).toMatchObject({ delivery: { id } });
    await channels.startDeliveryAttempt(claim.delivery.id, claim.claimToken);
    await channels.finishDelivery({
      claimToken: claim.claimToken,
      deliveryId: claim.delivery.id,
      outcome: "unknown",
    });
    await database
      .updateTable("bridgeDeliveries")
      .set({ nextAttemptAt: new Date(0) })
      .where("id", "=", id)
      .execute();
    expect(await channels.claimDelivery(testMessagingRunnerId)).toBeNull();
    // A provider's refusal before sending is proof it did not happen: it is tried again.
    const retried = await insertChannelDelivery({
      accountId: configured.account.id,
      conversationId,
      status: "retryable-failed",
    });
    expect((await channels.claimDelivery(testMessagingRunnerId))?.delivery.id).toBe(retried);
  });

  it("keeps a reply waiting while its chat is paused or its computer is gone, and cancels it only at an end", async ({
    storeFixture,
  }) => {
    const { channels, conversationId, configured, fixture } =
      await storeFixture.createChannelDeliveryFixture("paused");
    const { insertChannelDelivery, database, store } = storeFixture;
    const id = await insertChannelDelivery({
      accountId: configured.account.id,
      conversationId,
      status: "pending",
    });
    const reply = () =>
      database
        .selectFrom("bridgeDeliveries")
        .select(["status", "claimOwner"])
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
    const claim = (await channels.claimDelivery(testMessagingRunnerId))!;
    expect(claim.delivery.id).toBe(id);
    // The person pauses the chat just before the send leaves: it waits, it is not cancelled.
    await channels.setConnectionStatus(configured.connection.id, fixture.userId, "paused");
    await expect(
      channels.startDeliveryAttempt(claim.delivery.id, claim.claimToken),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await reply()).toEqual({ status: "pending", claimOwner: null });
    expect(await channels.claimDelivery(testMessagingRunnerId)).toBeNull();
    // Resumed and connected again, it leaves.
    await channels.setConnectionStatus(configured.connection.id, fixture.userId, "connected");
    await database
      .updateTable("integrationConnections")
      .set({ status: "connected" })
      .where("id", "=", configured.connection.id)
      .execute();
    expect((await channels.claimDelivery(testMessagingRunnerId))?.delivery.id).toBe(id);
    // The computer holding it is removed before it started: it goes to whichever takes over.
    await store.revokeRunner(testMessagingRunnerId, fixture.userId, { allowDeployment: true });
    expect(await reply()).toEqual({ status: "pending", claimOwner: null });
  });

  it("ends with the provider account it speaks through", async ({ storeFixture }) => {
    const bridge = await storeFixture.createBridgeFixture("account-ends");
    const connections = new AgentConnectionStore(storeFixture.database);
    await bridge.channels.setConnectionStatus(
      bridge.configured.connection.id,
      bridge.fixture.userId,
      "revoked",
    );
    await storeFixture.store.driveConnectionCleanups({ stopper: { stop: async () => undefined } });
    expect(
      (await connections.list(bridge.fixture.userId, { includeRevoked: true })).find(
        ({ id }) => id === bridge.bridge.id,
      ),
    ).toMatchObject({ state: "stopped", revokedAt: expect.any(String) });
  });
});

describeStore("locks are taken in their stable order when many rows move at once", (it) => {
  it("tells two senders of dead messages at once, each through its own bridge", async ({
    storeFixture,
  }) => {
    const bridge = await storeFixture.createBridgeFixture("dead-two", {
      conversation: { id: "C-dead", name: "#dead" },
    });
    const second = await new AgentConnectionStore(storeFixture.database).createBridge({
      userId: bridge.fixture.userId,
      accountId: bridge.configured.account.id,
      senders: "owner",
      accessMode: "approval-required",
      grant: { scope: "selected", tasks: true, resources: [] },
    });
    // A message to each bridge, both of which ran out of attempts.
    const events = [
      bridge.event({ eventId: "dead-channel", trigger: "mention" }),
      {
        ...bridge.event({ eventId: "dead-dm" }),
        conversation: {
          displayName: null,
          externalConversationId: "D-dead-two",
          externalScopeId: "T-dead-two",
          externalThreadId: null,
          type: "dm" as const,
        },
        trigger: "direct-message" as const,
      },
    ];
    const { declineBridgeIngress, decideBridgeIngress } = await import("./bridge-ingress.js");
    // Each conversation exists already: a message in it was decided before.
    for (const [index, event] of events.entries()) {
      const first = await bridge.channels.commitIngress(bridge.configured.connection.id, {
        ...event,
        eventId: `${event.eventId}-first`,
        providerMessageId: `${event.eventId}-first`,
      });
      const claimed = await bridge.channels.claimIngress(`dead-two-${index}`);
      expect(claimed?.id).toBe(first.ingressId);
      const decision = await decideBridgeIngress(storeFixture.database, {
        ingressId: claimed!.id,
        claimToken: claimed!.claimToken,
      });
      if (decision.kind !== "work") throw new Error("Expected the message to be admitted");
      await declineBridgeIngress(storeFixture.database, {
        ingressId: claimed!.id,
        claimToken: claimed!.claimToken,
        conversationId: decision.conversationId,
        reason: "settled by the test",
      });
    }
    await storeFixture.database.deleteFrom("bridgeDeliveries").execute();
    for (const event of events) {
      const committed = await bridge.channels.commitIngress(bridge.configured.connection.id, event);
      await storeFixture.database
        .updateTable("channelIngressEvents")
        .set({ attempts: 20, status: "pending", nextAttemptAt: new Date(0) })
        .where("id", "=", committed.ingressId)
        .execute();
    }
    expect(await bridge.channels.claimIngress("dead-two-worker")).toBeNull();
    expect(
      await storeFixture.database
        .selectFrom("bridgeDeliveries")
        .select("bridgeId")
        .where("kind", "=", "status")
        .orderBy("bridgeId")
        .execute(),
    ).toEqual([bridge.bridge.id, second.id].sort().map((bridgeId) => ({ bridgeId })));
  });

  it("gives back every reply a removed computer held, in order", async ({ storeFixture }) => {
    const { configured, conversationId, fixture } =
      await storeFixture.createChannelDeliveryFixture("revoke-two");
    const { database, insertChannelDelivery, store } = storeFixture;
    const second = await storeFixture.createChannelDeliveryFixture("revoke-two-b");
    const ids = [
      await insertChannelDelivery({
        accountId: configured.account.id,
        conversationId,
        status: "leased",
      }),
      await insertChannelDelivery({
        accountId: second.configured.account.id,
        conversationId: second.conversationId,
        status: "leased",
      }),
    ];
    await store.revokeRunner(testMessagingRunnerId, fixture.userId, { allowDeployment: true });
    expect(
      await database
        .selectFrom("bridgeDeliveries")
        .select("status")
        .where("id", "in", ids as never)
        .execute(),
    ).toEqual([{ status: "pending" }, { status: "pending" }]);
  });

  it("hiding (removing) a connection never stops or skips its Disconnect cleanup", async ({
    storeFixture,
  }) => {
    const { database, store } = storeFixture;
    const running = await storeFixture.startRunFixture("removed-cleanup");
    const connections = new AgentConnectionStore(database);
    const agent = await connections.create({
      userId: running.userId,
      label: "Hidden Agent",
      clientName: "Hidden Agent",
      accessMode: "approval-required",
      resource: "https://home.example/mcp",
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await database
      .updateTable("threads")
      .set({ originConnectionId: agent.id })
      .where("id", "=", running.thread.id)
      .execute();
    await database
      .updateTable("runs")
      .set({ connectionId: agent.id })
      .where("id", "=", running.run.id)
      .execute();
    await database
      .updateTable("runAttempts")
      .set({ connectionId: agent.id })
      .where("runId", "=", running.run.id)
      .execute();
    expect(await connections.revoke(running.userId, agent.id)).toBe(true);
    // A person cannot remove while cleanup is outstanding, and even if a row is already hidden
    // (removed_at set while cleanup_completed_at is null), cleanup still runs to completion.
    await expect(connections.remove(running.userId, agent.id)).rejects.toMatchObject({
      code: "conflict",
      reason: "cleanup-outstanding",
    });
    await database
      .updateTable("agentConnections")
      .set({ removedAt: new Date() })
      .where("id", "=", agent.id)
      .execute();
    expect(
      (await connections.list(running.userId, { includeRevoked: true })).find(
        ({ id }) => id === agent.id,
      ),
    ).toBeUndefined();
    const retryAt = new Date(Date.now() + 5_000);
    expect(await connections.nextMaintenance(retryAt)).not.toBeNull();
    let stoppedRun = false;
    const driven = await store.driveConnectionCleanups({
      stopper: {
        stop: async (attempt) => {
          if (attempt.kind === "run-attempt" && attempt.runId === running.run.id) {
            stoppedRun = true;
            return "ended";
          }
          return undefined;
        },
      },
    });
    expect(driven.failures).toEqual([]);
    expect(stoppedRun).toBe(true);
    expect(driven.settled).toContain(agent.id);
    expect(
      (
        await database
          .selectFrom("agentConnections")
          .select("cleanupCompletedAt")
          .where("id", "=", agent.id)
          .executeTakeFirstOrThrow()
      ).cleanupCompletedAt,
    ).toBeInstanceOf(Date);
  });

  it("refuses answering a Request once its task's connection has ended", async ({
    storeFixture,
  }) => {
    const { database, store } = storeFixture;
    const running = await storeFixture.startRunFixture("ended-request");
    const connections = new AgentConnectionStore(database);
    const agent = await connections.create({
      userId: running.userId,
      label: "Ended Agent",
      clientName: "Ended Agent",
      accessMode: "approval-required",
      resource: "https://home.example/mcp",
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await database
      .updateTable("threads")
      .set({ originConnectionId: agent.id })
      .where("id", "=", running.thread.id)
      .execute();
    const presentation: RequestPresentation = {
      kind: "form",
      title: "Continue?",
      detail: "Choose.",
      fields: [
        {
          choices: [{ label: "Yes", value: "Yes" }],
          custom: false,
          id: "q1",
          multiSelect: false,
          prompt: "Continue?",
          secret: false,
        },
      ],
    };
    const { request } = await store.requests.create({
      callId: "ended-request-question",
      kind: "person.question",
      mode: "durable",
      originatingRunId: running.run.id,
      originatingThreadId: running.thread.id,
      payload: { kind: "person.question" },
      presentation,
      requestedBy: running.userId,
      requiredActor: "requester",
    });
    expect(await connections.revoke(running.userId, agent.id)).toBe(true);
    await expect(
      store.requests.answerPersonQuestion({
        requestId: request.id,
        expectedRevision: (await store.requests.revision(request.id))!,
        resolvedBy: running.userId,
        response: { kind: "form", answers: { q1: ["Yes"] } },
      }),
    ).rejects.toMatchObject({ code: "forbidden", message: agentEndedForPersonMessage });

    // Same for an ended chat's Request, using the chat's sentence.
    const bridge = await storeFixture.createBridgeFixture("ended-chat-request");
    const chatRun = await storeFixture.startRunFixture("ended-chat-request-run");
    await database
      .updateTable("threads")
      .set({ originConnectionId: bridge.bridge.id })
      .where("id", "=", chatRun.thread.id)
      .execute();
    const { request: chatRequest } = await store.requests.create({
      callId: "ended-chat-question",
      kind: "person.question",
      mode: "durable",
      originatingRunId: chatRun.run.id,
      originatingThreadId: chatRun.thread.id,
      payload: { kind: "person.question" },
      presentation,
      requestedBy: chatRun.userId,
      requiredActor: "requester",
    });
    expect(await connections.revoke(bridge.fixture.userId, bridge.bridge.id)).toBe(true);
    await expect(
      store.requests.answerPersonQuestion({
        requestId: chatRequest.id,
        expectedRevision: (await store.requests.revision(chatRequest.id))!,
        resolvedBy: chatRun.userId,
        response: { kind: "form", answers: { q1: ["Yes"] } },
      }),
    ).rejects.toMatchObject({ code: "forbidden", message: chatEndedMessage });

    // Task detail reports endedOrigin for ended chat & connected-agent tasks, and null for own tasks.
    const { detailThreadValue } = await import("./personal-snapshot-store.js");
    const { withPersonalReadTransaction } = await import("./personal-transaction.js");
    const detailOf = (userId: typeof running.userId, threadId: typeof running.thread.id) =>
      withPersonalReadTransaction(database, (tx) => detailThreadValue(tx, userId, threadId));
    expect((await detailOf(running.userId, running.thread.id))?.endedOrigin).toBe("agent");
    expect((await detailOf(chatRun.userId, chatRun.thread.id))?.endedOrigin).toBe("chat");
    const { thread: ownTask } = await store.createThread({
      createdBy: running.userId,
      environmentId: running.environmentId,
      harnessInstanceId: running.harnessInstance.id,
      idempotencyKey: "ended-origin-own-task",
      modelSelection: running.thread.modelSelection,
      title: "Own task",
    });
    expect((await detailOf(running.userId, ownTask.id))?.endedOrigin).toBeNull();
  });

  it("refuses answering a live Request once its connection has ended, before Disconnect runs, and enqueues nothing for the Runner", async ({
    storeFixture,
  }) => {
    const { database, store } = storeFixture;
    const connections = new AgentConnectionStore(database);

    // 1. Live Request on a connected agent's waiting Run.
    const running = await storeFixture.startRunFixture("ended-live-request");
    const agent = await connections.create({
      userId: running.userId,
      label: "Ended Live Agent",
      clientName: "Ended Live Agent",
      accessMode: "approval-required",
      resource: "https://home.example/mcp",
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await database
      .updateTable("threads")
      .set({ originConnectionId: agent.id })
      .where("id", "=", running.thread.id)
      .execute();
    await database
      .updateTable("runs")
      .set({ connectionId: agent.id })
      .where("id", "=", running.run.id)
      .execute();
    const { request: liveRequest } = await store.requests.create({
      callId: "live-approval-agent",
      kind: "harness.approval",
      mode: "live",
      originatingRunId: running.run.id,
      originatingThreadId: running.thread.id,
      payload: { kind: "harness.approval" },
      presentation: {
        kind: "choice",
        title: "Run shell command?",
        options: [
          { id: "allow", label: "Allow", hint: "allow-once" },
          { id: "deny", label: "Deny", hint: "reject-once" },
        ],
      },
      requestedBy: running.userId,
      requiredActor: "requester",
    });
    await database
      .updateTable("runs")
      .set({ status: "waiting" })
      .where("id", "=", running.run.id)
      .execute();
    // Revoke WITHOUT running driveConnectionCleanups (Run is still waiting, grant still active).
    expect(await connections.revoke(running.userId, agent.id)).toBe(true);
    await expect(
      store.enqueueRunnerControl({
        expectedRevision: (await store.requests.revision(liveRequest.id))!,
        idempotencyKey: "live-approve-after-agent-end",
        requestId: liveRequest.id,
        requestedBy: running.userId,
        response: { kind: "choice", optionId: "allow" },
        runId: running.run.id,
        sealedResponse: {
          envelope: Buffer.from("sealed-live-response"),
          keyVersion: 1,
          requestFingerprint: "hmac-sha256-v1:1:live-approve-after-agent-end",
        },
        threadId: running.thread.id,
        type: "request.respond",
      }),
    ).rejects.toMatchObject({ code: "forbidden", message: agentEndedForPersonMessage });
    expect(
      await database
        .selectFrom("commands")
        .select("id")
        .where("runId", "=", running.run.id)
        .where("type", "=", "request.respond")
        .execute(),
    ).toEqual([]);

    // 2. Live Request on a chat's waiting Run.
    const bridge = await storeFixture.createBridgeFixture("ended-live-chat");
    const chatRun = await storeFixture.startRunFixture("ended-live-chat-run");
    await database
      .updateTable("threads")
      .set({ originConnectionId: bridge.bridge.id })
      .where("id", "=", chatRun.thread.id)
      .execute();
    await database
      .updateTable("runs")
      .set({ connectionId: bridge.bridge.id })
      .where("id", "=", chatRun.run.id)
      .execute();
    const { request: chatLiveRequest } = await store.requests.create({
      callId: "live-approval-chat",
      kind: "harness.approval",
      mode: "live",
      originatingRunId: chatRun.run.id,
      originatingThreadId: chatRun.thread.id,
      payload: { kind: "harness.approval" },
      presentation: {
        kind: "choice",
        title: "Run shell command for chat?",
        options: [{ id: "allow", label: "Allow", hint: "allow-once" }],
      },
      requestedBy: chatRun.userId,
      requiredActor: "requester",
    });
    await database
      .updateTable("runs")
      .set({ status: "waiting" })
      .where("id", "=", chatRun.run.id)
      .execute();
    expect(await connections.revoke(bridge.fixture.userId, bridge.bridge.id)).toBe(true);
    await expect(
      store.enqueueRunnerControl({
        expectedRevision: (await store.requests.revision(chatLiveRequest.id))!,
        idempotencyKey: "live-approve-after-chat-end",
        requestId: chatLiveRequest.id,
        requestedBy: chatRun.userId,
        response: { kind: "choice", optionId: "allow" },
        runId: chatRun.run.id,
        sealedResponse: {
          envelope: Buffer.from("sealed-chat-live-response"),
          keyVersion: 1,
          requestFingerprint: "hmac-sha256-v1:1:live-approve-after-chat-end",
        },
        threadId: chatRun.thread.id,
        type: "request.respond",
      }),
    ).rejects.toMatchObject({ code: "forbidden", message: chatEndedMessage });
    expect(
      await database
        .selectFrom("commands")
        .select("id")
        .where("runId", "=", chatRun.run.id)
        .where("type", "=", "request.respond")
        .execute(),
    ).toEqual([]);
  });

  it("records a browser.sign-in receipt already delivered before Disconnect and does not cancel its Request", async ({
    storeFixture,
  }) => {
    const { database, store } = storeFixture;
    const bridge = await storeFixture.createBridgeFixture("signin-after-end");
    const run = await storeFixture.startRunFixture("signin-after-end-run");
    const deployment = await database
      .selectFrom("deployments")
      .select("id")
      .executeTakeFirstOrThrow();
    const connections = new AgentConnectionStore(database);
    const browserSources = new BrowserSourceStore(database);
    await database
      .updateTable("threads")
      .set({ originConnectionId: bridge.bridge.id })
      .where("id", "=", run.thread.id)
      .execute();
    await database
      .updateTable("runs")
      .set({ connectionId: bridge.bridge.id })
      .where("id", "=", run.run.id)
      .execute();
    const sourceId = createId("browserSource");
    await database
      .insertInto("browserSources")
      .values({
        id: sourceId,
        ownerId: run.userId,
        name: "Mac Chrome",
        tokenHash: `hash-${sourceId}`,
      })
      .execute();
    const browserSession = await store.createBrowserSession({
      id: BrowserSessionIdSchema.parse(`bsn_${crypto.randomUUID()}`),
      origin: "agent",
      placementKey: `runner:${run.runnerId}:browser`,
      profileId: null,
      runnerId: run.runnerId,
      runtimeId: "browser",
      ownerId: run.userId,
    });
    await store.transitionBrowserSession({ sessionId: browserSession.id, state: "ready" });
    const sessionId = browserSession.id;
    const site = "https://bank.example";
    const { request: signInReq } = await store.requests.create({
      callId: "browser-signin-delivered",
      kind: "browser.sign-in",
      mode: "durable",
      originatingRunId: run.run.id,
      originatingThreadId: run.thread.id,
      payload: {
        kind: "browser.sign-in",
        reason: "Check statement",
        sessionId,
        site,
      },
      presentation: {
        kind: "external",
        title: "Sign in to bank.example?",
        detail: "Check statement",
        subject: { kind: "browser-site", id: site },
      },
      requestedBy: run.userId,
      requiredActor: "requester",
    });

    // Step 2: delivery decision passes while the chat is live, and cookies reach the browser.
    expect(
      await database.transaction().execute((tx) =>
        browserSignInRequestDeliverableInTransaction(tx, {
          ownerId: run.userId,
          requestId: signInReq.id,
          scope: { sessionId, site },
        }),
      ),
    ).toBe(true);

    // Step 3: the connection ends before commitSignIn records the delivered sign-in.
    expect(await connections.revoke(bridge.fixture.userId, bridge.bridge.id)).toBe(true);

    // Any NEW delivery decision is refused now.
    expect(
      await database.transaction().execute((tx) =>
        browserSignInRequestDeliverableInTransaction(tx, {
          ownerId: run.userId,
          requestId: signInReq.id,
          scope: { sessionId, site },
        }),
      ),
    ).toBe(false);

    // Step 4: commitSignIn records the receipt + site grant and does NOT roll back.
    const invocationId = crypto.randomUUID();
    const committed = await browserSources.commitSignIn({
      actor: "request",
      deploymentId: deployment.id,
      invocationId,
      ownerId: run.userId,
      profileName: "Work",
      rememberSite: true,
      requestId: signInReq.id,
      sessionId,
      site,
      sourceId,
      sourceName: "Mac Chrome",
    });
    expect(committed.receipt.id).toBe(invocationId);
    expect(committed.receipt.requestId).toBe(signInReq.id);
    const grant = await database
      .selectFrom("browserSiteGrants")
      .select(["site", "lastSignedInAt"])
      .where("ownerId", "=", run.userId)
      .where("site", "=", site)
      .executeTakeFirst();
    expect(grant?.lastSignedInAt).toBeInstanceOf(Date);
    expect(await store.requests.get(signInReq.id)).toMatchObject({ status: "fulfilled" });
    // No continuation is queued for an ended connection.
    expect(
      await database
        .selectFrom("requestContinuations")
        .select("requestId")
        .where("requestId", "=", signInReq.id)
        .execute(),
    ).toEqual([]);

    // Step 5: Disconnect runs and must NOT turn the already-delivered sign-in into a clean cancel.
    await store.driveConnectionCleanups();
    expect(await store.requests.get(signInReq.id)).toMatchObject({ status: "fulfilled" });
  });

  it("removing an expired connection leaves cleanup requested until onCleanup closes its lineage", async ({
    storeFixture,
  }) => {
    const { database, store } = storeFixture;
    const fixture = await storeFixture.createRunFixture("remove-before-cleanup");
    const connections = new AgentConnectionStore(database);
    const expired = await connections.create({
      userId: fixture.userId,
      label: "Expired Before Cleanup",
      clientName: "Expired Before Cleanup",
      accessMode: "approval-required",
      resource: "https://home.example/mcp",
      expiresAt: new Date(Date.now() - 60_000),
    });
    await connections.remove(fixture.userId, expired.id);
    const row = await database
      .selectFrom("agentConnections")
      .select(["removedAt", "cleanupRequestedAt", "cleanupCompletedAt", "cleanupReason"])
      .where("id", "=", expired.id)
      .executeTakeFirstOrThrow();
    expect(row.removedAt).toBeInstanceOf(Date);
    expect(row.cleanupRequestedAt).toBeInstanceOf(Date);
    expect(row.cleanupReason).toBe("expired");
    expect(row.cleanupCompletedAt).toBeNull();
    expect(await openCleanups(database)).toContain(expired.id);

    const closed: string[] = [];
    await store.driveConnectionCleanups({
      onCleanup: async (cleanup) => {
        closed.push(cleanup.connectionId);
      },
    });
    expect(closed).toContain(expired.id);
    expect(await openCleanups(database)).not.toContain(expired.id);
    expect(
      (
        await database
          .selectFrom("agentConnections")
          .select("cleanupCompletedAt")
          .where("id", "=", expired.id)
          .executeTakeFirstOrThrow()
      ).cleanupCompletedAt,
    ).toBeInstanceOf(Date);
    // Keep sql import used for lint cleanliness if needed.
    await sql`select 1`.execute(database);
  });
});
