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
        chat: { conversationId, sender: { displayName: "Tim", owner: true } },
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
