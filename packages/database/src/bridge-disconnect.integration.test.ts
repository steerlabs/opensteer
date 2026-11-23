import { createChannelId, type ChannelConversationId } from "@opensteer/channel-core";
import { expect } from "vitest";
import { AgentConnectionStore } from "./agent-connection-store.js";
import { enqueueChannelConversationStatus } from "./channel-deliveries.js";
import { commitPersonalMutation } from "./personal-mutation.js";
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
    expect(claim).toMatchObject({ delivery: { id }, mayHaveBeenSent: false });
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
});
