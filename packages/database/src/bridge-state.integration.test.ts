import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { createChannelId, type ChannelConversationId } from "@opensteer/channel-core";
import { expect } from "vitest";
import { AgentConnectionStore } from "./agent-connection-store.js";
import { startPersonalQueuedRunFixture } from "./personal-run-fixture.test-support.js";
import { describeStore } from "./store.integration.test-support.js";

/**
 * A chat is live, waiting or ended, from one function, and every layer reads it. These are the
 * ends and the waiting a person can cause or see: the chat paused, and the Mac a chat runs on
 * removed.
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

  it("pauses and resumes a connection holding two accounts, taking them in id order", async ({
    storeFixture,
  }) => {
    const { channels, configured, fixture } =
      await storeFixture.createChannelDeliveryFixture("state-two-accounts");
    const { database } = storeFixture;
    // A shared bot: a second account on the same connection, whose id sorts before the first,
    // so a lock taken in row order and not in id order is caught by the enforced lock order.
    const first = await database
      .selectFrom("channelAccounts")
      .selectAll()
      .where("id", "=", configured.account.id)
      .executeTakeFirstOrThrow();
    const second = "cha_00000000-0000-4000-8000-000000000001" as typeof first.id;
    expect(second < first.id).toBe(true);
    await database
      .insertInto("channelAccounts")
      .values({
        ...first,
        id: second,
        externalAccountId: `${first.externalAccountId}-second`,
        displayName: "Second workspace",
        routingMode: "shared",
      })
      .execute();
    const statuses = async () =>
      (
        await database
          .selectFrom("channelAccounts")
          .select(["id", "status"])
          .where("connectionId", "=", configured.connection.id)
          .orderBy("id")
          .execute()
      ).map(({ status }) => status);
    await channels.setConnectionStatus(configured.connection.id, fixture.userId, "paused");
    expect(await statuses()).toEqual(["paused", "paused"]);
    // Two changes at once on one connection: each takes both accounts in the same order.
    await Promise.all([
      channels.setConnectionStatus(configured.connection.id, fixture.userId, "connected"),
      channels.setConnectionStatus(configured.connection.id, fixture.userId, "paused"),
    ]);
    const after = await statuses();
    expect(after[0]).toBe(after[1]);
    await channels.setConnectionStatus(configured.connection.id, fixture.userId, "connected");
    expect(await statuses()).toEqual(["connected", "connected"]);
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

  it('gives back a code to link "me" that was taken just before a pause, and links it when the chat is back', async ({
    storeFixture,
  }) => {
    const bridge = await storeFixture.createBridgeFixture("state-code");
    const { channels, configured, fixture } = bridge;
    const { database } = storeFixture;
    const { decideBridgeIngress, startBridgeOwnerLink } = await import("./bridge-ingress.js");
    const { code } = await startBridgeOwnerLink(database, {
      userId: fixture.userId,
      accountId: configured.account.id,
    });
    const claimed = await bridge.claim({
      eventId: "code",
      text: code,
      externalUserId: "U-NEW-PHONE",
    });
    await channels.setConnectionStatus(configured.connection.id, fixture.userId, "paused");
    expect(
      await decideBridgeIngress(database, {
        ingressId: claimed.id,
        claimToken: claimed.claimToken,
      }),
    ).toEqual({ kind: "waiting" });
    expect(
      await database
        .selectFrom("channelIngressEvents")
        .select(["status", "attempts"])
        .where("id", "=", claimed.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "pending", attempts: 0 });
    // It waits, unclaimed, while the account is paused; back, it links.
    expect(await channels.claimIngress("state-code")).toBeNull();
    await channels.setConnectionStatus(configured.connection.id, fixture.userId, "connected");
    const again = await channels.claimIngress("state-code");
    expect(again?.id).toBe(claimed.id);
    expect(
      await decideBridgeIngress(database, { ingressId: again!.id, claimToken: again!.claimToken }),
    ).toEqual({ kind: "linked" });
  });

  it("decides a message that waited for a paused chat once that chat ends some other way", async ({
    storeFixture,
  }) => {
    const bridge = await storeFixture.createBridgeFixture("state-paused-ended");
    const { channels, configured, fixture } = bridge;
    const { database } = storeFixture;
    const committed = await channels.commitIngress(
      configured.connection.id,
      bridge.event({ eventId: "held", text: "Do this later" }),
    );
    await channels.setConnectionStatus(configured.connection.id, fixture.userId, "paused");
    expect(await channels.claimIngress("state-ended")).toBeNull();
    // The person disconnects the chat while its account stays paused: nothing waits for it.
    await new AgentConnectionStore(database).revoke(fixture.userId, bridge.bridge.id);
    const claimed = await channels.claimIngress("state-ended");
    expect(claimed?.id).toBe(committed.ingressId);
    const { decideBridgeIngress } = await import("./bridge-ingress.js");
    expect(
      await decideBridgeIngress(database, {
        ingressId: claimed!.id,
        claimToken: claimed!.claimToken,
      }),
    ).toMatchObject({ kind: "ignored" });
  });

  it("opens no standard CDP attempt for a paused chat", async ({ storeFixture }) => {
    const { bridgeId, channels, configured, fixture } =
      await storeFixture.createChannelDeliveryFixture("state-cdp");
    const { database, store } = storeFixture;
    const { grantRevision } = await database
      .selectFrom("agentConnections")
      .select("grantRevision")
      .where("id", "=", bridgeId!)
      .executeTakeFirstOrThrow();
    await channels.setConnectionStatus(configured.connection.id, fixture.userId, "paused");
    await expect(
      store.connectionCdpAttempts().open(`bsn_${randomUUID()}` as never, "attempt", {
        connectionId: bridgeId!,
        grantRevision,
        mode: "approval-required",
        threadId: null,
      }),
    ).rejects.toThrow("This browser authority has ended");
  });

  // A person's own message on a chat's task takes the task's lineage (thread-inbox.ts,
  // `executionConnectionId`), so the chat's Disconnect set holds it.
  it("cancels the person's own queued message on a chat's task when the chat ends", async ({
    storeFixture,
  }) => {
    const bridge = await storeFixture.createBridgeFixture("state-own-input");
    const { database, store } = storeFixture;
    const { fixture } = bridge;
    await database
      .updateTable("threads")
      .set({ originConnectionId: bridge.bridge.id })
      .where("id", "=", fixture.thread.id)
      .execute();
    const enqueue = (key: string) =>
      store.enqueueThreadInput({
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
        content: [{ type: "text", text: key }],
        source: { kind: "human" },
        policy: "queue",
        idempotencyKey: key,
      });
    const first = await enqueue("state-own-first");
    await startPersonalQueuedRunFixture(store, first.run!.id);
    const own = await enqueue("state-own-second");
    const state = async () =>
      (
        await database
          .selectFrom("threadInputs")
          .select("state")
          .where("messageId", "=", own.input.messageId)
          .executeTakeFirstOrThrow()
      ).state;
    expect(await state()).toBe("pending");
    await new AgentConnectionStore(database).revoke(fixture.userId, bridge.bridge.id);
    await store.driveConnectionCleanups({ stopper: { stop: async () => undefined } });
    expect(await state()).toBe("cancelled");
  });

  it('cancels, silently, a queued Run whose sender stopped being "me" before it was claimed', async ({
    storeFixture,
  }) => {
    const bridge = await storeFixture.createBridgeFixture("state-relink-run");
    const { database, store } = storeFixture;
    const { fixture } = bridge;
    const conversationId = createChannelId("conversation") as ChannelConversationId;
    await database
      .insertInto("bridgeConversations")
      .values({
        id: conversationId,
        bridgeId: bridge.bridge.id,
        accountId: bridge.configured.account.id,
        externalScopeId: null,
        externalConversationId: "D-state-relink-run",
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
    // The old phone's message reserves a Run at once.
    const queued = await store.enqueueThreadInput({
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
      content: [{ type: "text", text: "From the old phone" }],
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
      idempotencyKey: "state-relink-run",
    });
    if (!queued.run || !queued.command) throw new Error("Expected a queued Run");
    // The person links "me" to their new phone before that Run is sent.
    const { startBridgeOwnerLink } = await import("./bridge-ingress.js");
    const { code } = await startBridgeOwnerLink(database, {
      userId: fixture.userId,
      accountId: bridge.configured.account.id,
    });
    expect(
      (await bridge.decide({ eventId: "relink", text: code, externalUserId: "U-NEW-PHONE" }))
        .decision,
    ).toEqual({ kind: "linked" });
    const claimed = await store.claimCommand(queued.command.id, "state-relink-run");
    expect(claimed?.terminalFailure).toBeDefined();
    await store.failCommand(queued.command.id, claimed!.terminalFailure!, "seed-input");
    expect(
      await database
        .selectFrom("threadInputs")
        .select(["state", "cancelReason"])
        .where("messageId", "=", queued.input.messageId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ state: "cancelled" });
    expect(claimed!.terminalFailure).toBe(
      "Its message came from an account that is no longer linked as you.",
    );
    // The chat hears nothing about it.
    expect(
      await database
        .selectFrom("bridgeDeliveries")
        .select("id")
        .where("bridgeId", "=", bridge.bridge.id)
        .where("kind", "=", "status")
        .execute(),
    ).toEqual([]);
  });

  for (const why of ["its sender is no longer me", "its chat ended"] as const)
    it(`ends a queued Run whose claim decided its end before a restart (${why}): nothing is left stranded`, async ({
      storeFixture,
    }) => {
      const bridge = await storeFixture.createBridgeFixture(`state-restart-${why.length}`);
      const { database, store } = storeFixture;
      const { fixture } = bridge;
      const conversationId = createChannelId("conversation") as ChannelConversationId;
      await database
        .insertInto("bridgeConversations")
        .values({
          id: conversationId,
          bridgeId: bridge.bridge.id,
          accountId: bridge.configured.account.id,
          externalScopeId: null,
          externalConversationId: `D-state-restart-${why.length}`,
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
        content: [{ type: "text", text: "Before the restart" }],
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
        idempotencyKey: `state-restart-${why.length}`,
      });
      if (!queued.run || !queued.command) throw new Error("Expected a queued Run");
      if (why === "its sender is no longer me")
        await database
          .updateTable("channelIdentities")
          .set({ status: "unlinked", linkedUserId: null })
          .where("accountId", "=", bridge.configured.account.id)
          .where("externalUserId", "=", bridge.owner)
          .execute();
      else await new AgentConnectionStore(database).revoke(fixture.userId, bridge.bridge.id);
      const first = await store.claimCommand(queued.command.id, "before-restart");
      expect(first?.terminalFailure).toBeDefined();
      // The Home restarts before it records that end.
      await store.recoverCommandsAfterHostRestart();
      const again = await store.claimCommand(queued.command.id, "after-restart");
      expect(again?.terminalFailure).toBeDefined();
      await store.failCommand(queued.command.id, again!.terminalFailure!, "seed-input");
      expect(
        await database
          .selectFrom("runs")
          .innerJoin("threadInputs", "threadInputs.messageId", "runs.seedInputId")
          .select(["runs.status as run", "threadInputs.state as input"])
          .where("runs.id", "=", queued.run.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ run: "failed", input: "cancelled" });
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
