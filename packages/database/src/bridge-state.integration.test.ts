import { randomUUID } from "node:crypto";
import { createId } from "@opensteer/core";
import { sql } from "kysely";
import { expect } from "vitest";
import { AgentConnectionStore } from "./agent-connection-store.js";
import { enqueueChannelConversationStatus } from "./channel-deliveries.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import { describeStore, testMessagingRunnerId } from "./store.integration.test-support.js";

/**
 * A chat is live, waiting or ended, from one function, and every layer reads it. These are the
 * ends and the waiting a person can cause or see: the chat paused, the organization's work Home
 * offboarding, tasks turned off by its policy, and the Mac a chat runs on removed.
 */
describeStore("a chat is live, waiting or ended, and every layer reads which", (it) => {
  it("reads as paused while its account is paused, never as active", async ({ storeFixture }) => {
    const { bridgeId, channels, configured, fixture } =
      await storeFixture.createChannelDeliveryFixture("state-paused");
    const connections = new AgentConnectionStore(storeFixture.database);
    const state = async () =>
      (await connections.list(fixture.userId, { includeRevoked: true })).find(
        ({ id }) => id === bridgeId,
      )?.state;
    expect(await state()).toBe("active");
    await channels.setConnectionStatus(configured.connection.id, fixture.userId, "paused");
    expect(await state()).toBe("paused");
  });

  it("keeps a message that was waiting when its chat was paused, and decides it when it is back", async ({
    storeFixture,
  }) => {
    const bridge = await storeFixture.createBridgeFixture("state-held");
    const { channels, configured, fixture } = bridge;
    const committed = await channels.commitIngress(
      configured.connection.id,
      bridge.event({ eventId: "held", text: "Do this later" }),
    );
    await channels.setConnectionStatus(configured.connection.id, fixture.userId, "paused");
    // Paused: it is not taken, so nothing can drop it.
    expect(await channels.claimIngress("state-worker")).toBeNull();
    expect(
      await storeFixture.database
        .selectFrom("channelIngressEvents")
        .select(["status", "attempts"])
        .where("id", "=", committed.ingressId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "pending", attempts: 0 });
    // Back on, it is decided like any message.
    await channels.setConnectionStatus(configured.connection.id, fixture.userId, "connected");
    const claimed = await channels.claimIngress("state-worker");
    expect(claimed?.id).toBe(committed.ingressId);
    const { decideBridgeIngress } = await import("./bridge-ingress.js");
    expect(
      await decideBridgeIngress(storeFixture.database, {
        ingressId: claimed!.id,
        claimToken: claimed!.claimToken,
      }),
    ).toMatchObject({ kind: "work", text: "Do this later" });
  });

  it("ends when the organization's work Home is offboarding: nothing more is enqueued, sent or handed off", async ({
    storeFixture,
  }) => {
    const { bridgeId, channels, conversationId, fixture } =
      await storeFixture.createChannelDeliveryFixture("state-offboard");
    const { database, insertChannelDelivery, store } = storeFixture;
    const { WorkHomeStore } = await import("./work-home.js");
    const work = new WorkHomeStore(database);
    const marker = {
      organizationId: `org_${randomUUID()}` as never,
      organizationName: "Workshop",
      assignmentId: `was_${randomUUID()}` as never,
    };
    await work.initialize(marker, fixture.deploymentId);
    await work.apply({
      assignmentId: marker.assignmentId,
      deploymentId: fixture.deploymentId,
      policy: {
        externalMaxMode: "full-access",
        allowEverything: false,
        allowTasks: true,
        devices: "assignee-may-enroll",
      },
      revision: 1,
      state: "active",
    });
    const waiting = await insertChannelDelivery({
      accountId: (await bridgeAccount(database, bridgeId!)) as never,
      conversationId,
      status: "pending",
    });
    await work.offboard();
    // Nothing more is enqueued, what waits is never handed out, and no Run is handed off.
    await commitPersonalMutation(database, (tx) =>
      enqueueChannelConversationStatus(tx, { conversationId, text: "after offboarding" }),
    );
    expect(
      (
        await database
          .selectFrom("bridgeDeliveries")
          .select("id")
          .where("bridgeId", "=", bridgeId!)
          .execute()
      ).map(({ id }) => id),
    ).toEqual([waiting]);
    expect(await channels.claimDelivery(testMessagingRunnerId)).toBeNull();
    await expect(
      store.recordConnectionRunHandoff({
        runId: createId("run"),
        bindingGeneration: 1,
        connectionId: bridgeId!,
        grantRevision: 1,
        mode: "approval-required",
      }),
    ).rejects.toThrow("The agent connection changed before this Run could be sent");
    // And the person reads it as ending, never as active.
    const connections = new AgentConnectionStore(database);
    const listed = (await connections.list(fixture.userId, { includeRevoked: true })).find(
      ({ id }) => id === bridgeId,
    );
    expect(listed?.state).not.toBe("active");
  });

  it("ends when the Mac it runs on is removed, and the end is shown with evidence", async ({
    storeFixture,
  }) => {
    const { bridgeId, configured, fixture } =
      await storeFixture.createChannelDeliveryFixture("state-mac");
    const { database, store } = storeFixture;
    // The chat's transport runs on the person's Mac, through its Messages app at read and send.
    const deviceId = await store.requireSelfDeviceId(fixture.runnerId);
    const sourceId = `con_${randomUUID()}`;
    await sql`insert into integration_connections(id, owner_user_id, connection_kind, provider,
        connection_method, status, display_name, capabilities, integration_definition_id,
        device_id, computer_access)
      values (${sourceId}, ${fixture.userId}, 'computer', 'apple-messages', 'computer',
        'connected', 'Messages', '[]'::jsonb, 'apple-messages', ${deviceId}, 'read-write')`.execute(
      database,
    );
    await database
      .updateTable("integrationConnections")
      .set({
        transportKind: "computer",
        runnerId: fixture.runnerId,
        sourceConnectionId: sourceId as never,
      })
      .where("id", "=", configured.connection.id)
      .execute();
    const connections = new AgentConnectionStore(database);
    const listed = async () =>
      (await connections.list(fixture.userId, { includeRevoked: true })).find(
        ({ id }) => id === bridgeId,
      );
    expect((await listed())?.state).toBe("active");
    // The Mac's own driver is detached: the computer that ran it is gone.
    await database
      .updateTable("deviceDrivers")
      .set({ detachedAt: new Date() })
      .where("deviceId", "=", deviceId as never)
      .where("role", "=", "self")
      .execute();
    expect((await listed())?.state).not.toBe("active");
    await store.driveConnectionCleanups({ stopper: { stop: async () => undefined } });
    expect(await listed()).toMatchObject({ state: "stopped", revokedAt: expect.any(String) });
  });
});

async function bridgeAccount(
  database: import("kysely").Kysely<import("./schema.js").DatabaseSchema>,
  bridgeId: string,
) {
  const { bridgeAccountId } = await database
    .selectFrom("agentConnections")
    .select("bridgeAccountId")
    .where("id", "=", bridgeId)
    .executeTakeFirstOrThrow();
  return bridgeAccountId;
}
