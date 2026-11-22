import { createChannelId } from "@opensteer/channel-core";
import { sql } from "kysely";
import { expect } from "vitest";
import { applyBridgeConversion } from "./bridge-conversion-migration.js";
import { describeStore, testChannelAccessPolicy } from "./store.integration.test-support.js";

const policy = (
  directMessages: string,
  channels: { scope: "off" | "selected" | "all"; conversationIds?: string[] },
) => ({
  directMessages: { mode: directMessages, allowedExternalUserIds: [] },
  channels: {
    scope: channels.scope,
    conversationIds: channels.conversationIds ?? [],
    sender: { mode: "anyone", allowedExternalUserIds: ["U-ALLOWED"] },
  },
});

describeStore("an existing Messaging route becomes bridges that can only do less", (it) => {
  it("answers only the person, Supervised, with tasks alone, and leaves the routes as they were", async ({
    storeFixture,
  }) => {
    const { configured, fixture } = await storeFixture.createChannelDeliveryFixture("convert", {
      bridge: false,
    });
    const { database } = storeFixture;
    const binding = async (
      accessPolicy: unknown,
      status: "active" | "paused" = "active",
      createdAt = new Date(),
    ) => {
      const id = createChannelId("binding");
      await database
        .insertInto("channelBindings")
        .values({
          accessPolicy: sql`${JSON.stringify(accessPolicy)}::jsonb`,
          accountId: configured.account.id,
          createdBy: fixture.userId,
          executionPolicy: sql`${JSON.stringify({ harness: "default", harnessInstanceId: null })}::jsonb`,
          id,
          revision: 3,
          selector: sql`${JSON.stringify({ conversationId: null, conversationType: null, scopeId: null, threadId: null })}::jsonb`,
          status,
          createdAt,
          updatedAt: createdAt,
        })
        .execute();
      return id;
    };
    // The fixture's own route answered anyone in direct messages and every channel.
    await database
      .updateTable("channelBindings")
      .set({ status: "revoked" })
      .where("id", "=", configured.binding.id as never)
      .execute();
    const first = await binding(
      policy("anyone", { scope: "selected", conversationIds: ["C-general"] }),
      "active",
      new Date(Date.now() - 60_000),
    );
    const overlapping = await binding(policy("owner", { scope: "all" }));
    const paused = await binding(
      policy("owner", { scope: "selected", conversationIds: ["C-paused"] }),
      "paused",
    );
    const before = await database.selectFrom("channelBindings").selectAll().execute();

    await applyBridgeConversion(database as never);

    const bridges = await database
      .selectFrom("agentConnections")
      .select([
        "label",
        "accessMode",
        "grant",
        "tokenHash",
        "revokedAt",
        "bridgeConversationId",
        "bridgeSenders",
        "bridgeFromBindingId",
        "bridgeNotice",
      ])
      .where("bridgeAccountId", "=", configured.account.id)
      .orderBy("bridgeConversationId", "desc")
      .execute();
    const supervised = {
      accessMode: "approval-required",
      grant: { scope: "selected", tasks: true, resources: [] },
      tokenHash: null,
      revokedAt: null,
      bridgeSenders: "owner",
      bridgeFromBindingId: first,
      bridgeNotice: "converted",
    };
    // Anyone, approved people and allow lists are gone: only the person, in both. The paused
    // route stays off, and the later route that overlapped the first adds no bridge; its every
    // channel is not guessed, and the direct messages' bridge says so.
    expect(bridges).toEqual([
      {
        ...supervised,
        label: "Slack",
        bridgeConversationId: null,
        bridgeNotice: "converted-without-channels",
      },
      { ...supervised, label: "Slack · C-general", bridgeConversationId: "C-general" },
    ]);
    expect(bridges.some(({ bridgeFromBindingId }) => bridgeFromBindingId === overlapping)).toBe(
      false,
    );
    expect(bridges.some(({ bridgeFromBindingId }) => bridgeFromBindingId === paused)).toBe(false);
    // The previous image's rows are exactly as they were.
    expect(await database.selectFrom("channelBindings").selectAll().execute()).toEqual(before);
  });

  it("does not guess channels from history, and ties work without personal context to an ended connection", async ({
    storeFixture,
  }) => {
    const {
      configured,
      fixture,
      legacyConversationId: conversationId,
    } = await storeFixture.createChannelDeliveryFixture("convert-all", { bridge: false });
    const { database } = storeFixture;
    await database
      .updateTable("channelBindings")
      .set({ accessPolicy: sql`${JSON.stringify(testChannelAccessPolicy("owner"))}::jsonb` })
      .where("id", "=", configured.binding.id as never)
      .execute();
    // The fixture's conversation ran in a channel, so its task had no personal context.
    await database
      .updateTable("channelConversations")
      .set({ conversationType: "channel", personalContext: false })
      .where("id", "=", conversationId)
      .execute();
    const personal = await storeFixture.createTaskForOwner(fixture.userId, "convert-own");

    await applyBridgeConversion(database as never);

    const bridges = await database
      .selectFrom("agentConnections")
      .select(["bridgeConversationId", "bridgeNotice"])
      .where("bridgeAccountId", "=", configured.account.id)
      .execute();
    expect(bridges).toEqual([
      { bridgeConversationId: null, bridgeNotice: "converted-without-channels" },
    ]);
    const tied = await database
      .selectFrom("threads")
      .innerJoin("agentConnections", "agentConnections.id", "threads.originConnectionId")
      .select(["threads.id", "agentConnections.label", "agentConnections.revokedAt"])
      .execute();
    expect(tied).toEqual([
      { id: fixture.thread.id, label: "Messages before the update", revokedAt: expect.any(Date) },
    ]);
    expect(
      await database
        .selectFrom("threads")
        .select("originConnectionId")
        .where("id", "=", personal.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ originConnectionId: null });
  });

  it("makes nothing the old route did not match", async ({ storeFixture }) => {
    const { database } = storeFixture;
    const route = async (
      suffix: string,
      accessPolicy: unknown,
      selector: Partial<
        Record<"conversationId" | "conversationType" | "scopeId" | "threadId", string>
      > = {},
    ) => {
      const { configured } = await storeFixture.createChannelDeliveryFixture(suffix, {
        bridge: false,
      });
      await database
        .updateTable("channelBindings")
        .set({
          accessPolicy: sql`${JSON.stringify(accessPolicy)}::jsonb`,
          selector: sql`${JSON.stringify({ conversationId: null, conversationType: null, scopeId: null, threadId: null, ...selector })}::jsonb`,
        })
        .where("id", "=", configured.binding.id as never)
        .execute();
      return async () =>
        database
          .selectFrom("agentConnections")
          .select(["bridgeConversationId", "bridgeNotice", "revokedAt"])
          .where("bridgeAccountId", "=", configured.account.id)
          .orderBy("bridgeConversationId")
          .execute();
    };
    const channelsOff = {
      ...policy("owner", { scope: "selected", conversationIds: ["C-quiet"] }),
      channels: {
        scope: "selected",
        conversationIds: ["C-quiet"],
        sender: { mode: "off", allowedExternalUserIds: [] },
      },
    };
    const sendersOff = await route("convert-senders-off", channelsOff);
    const channelOnly = await route(
      "convert-channel-only",
      policy("owner", { scope: "selected", conversationIds: ["C-team"] }),
      { conversationType: "channel" },
    );
    const named = await route("convert-named", policy("owner", { scope: "all" }), {
      conversationId: "C-one",
    });
    const directOff = await route("convert-dms-off", policy("off", { scope: "all" }));
    const oneThread = await route(
      "convert-thread",
      policy("owner", { scope: "selected", conversationIds: ["C-thread"] }),
      { threadId: "1786320000.000100" },
    );

    await applyBridgeConversion(database as never);

    // Channels whose senders were off make no channel bridge.
    expect(await sendersOff()).toEqual([
      { bridgeConversationId: null, bridgeNotice: "converted", revokedAt: null },
    ]);
    // A route that matched only channels makes no direct-message bridge.
    expect(await channelOnly()).toEqual([
      { bridgeConversationId: "C-team", bridgeNotice: "converted", revokedAt: null },
    ]);
    // A route that named one conversation makes that one.
    expect(await named()).toEqual([
      { bridgeConversationId: "C-one", bridgeNotice: "converted", revokedAt: null },
    ]);
    // Every channel with direct messages off: nothing is guessed, and the notice is kept.
    expect(await directOff()).toEqual([
      {
        bridgeConversationId: null,
        bridgeNotice: "converted-without-channels",
        revokedAt: expect.any(Date),
      },
    ]);
    // A route for one thread matched less than any bridge covers.
    expect(await oneThread()).toEqual([]);
  });

  it("never makes what a more specific route had turned off, and keeps the notice where routes overlap", async ({
    storeFixture,
  }) => {
    const { database } = storeFixture;
    const routes = async (
      suffix: string,
      list: readonly {
        readonly accessPolicy: unknown;
        readonly selector?: Partial<Record<"conversationId" | "conversationType", string>>;
      }[],
    ) => {
      const { configured, fixture } = await storeFixture.createChannelDeliveryFixture(suffix, {
        bridge: false,
      });
      await database
        .updateTable("channelBindings")
        .set({ status: "revoked" })
        .where("id", "=", configured.binding.id as never)
        .execute();
      for (const [index, route] of list.entries())
        await database
          .insertInto("channelBindings")
          .values({
            accessPolicy: sql`${JSON.stringify(route.accessPolicy)}::jsonb`,
            accountId: configured.account.id,
            createdBy: fixture.userId,
            executionPolicy: sql`${JSON.stringify({ harness: "default", harnessInstanceId: null })}::jsonb`,
            id: createChannelId("binding"),
            revision: 1,
            selector: sql`${JSON.stringify({ conversationId: null, conversationType: null, scopeId: null, threadId: null, ...route.selector })}::jsonb`,
            status: "active",
            createdAt: new Date(Date.now() - 60_000 + index * 1_000),
            updatedAt: new Date(),
          })
          .execute();
      return async () =>
        database
          .selectFrom("agentConnections")
          .select(["bridgeConversationId", "bridgeNotice", "revokedAt"])
          .where("bridgeAccountId", "=", configured.account.id)
          .orderBy("bridgeConversationId")
          .execute();
    };
    const owner = { mode: "owner", allowedExternalUserIds: [] };
    // A broad route answered direct messages and #one and #two; more specific routes had turned
    // #one and direct messages off.
    const shadowed = await routes("convert-shadowed", [
      {
        accessPolicy: {
          directMessages: owner,
          channels: { scope: "selected", conversationIds: ["C-one", "C-two"], sender: owner },
        },
      },
      {
        accessPolicy: {
          directMessages: owner,
          channels: { scope: "off", conversationIds: [], sender: owner },
        },
        selector: { conversationId: "C-one" },
      },
      {
        accessPolicy: {
          directMessages: { mode: "off", allowedExternalUserIds: [] },
          channels: { scope: "off", conversationIds: [], sender: owner },
        },
        selector: { conversationType: "dm" },
      },
    ]);
    // A route for every channel, and a more specific one for direct messages only.
    const overlapping = await routes("convert-overlap", [
      {
        accessPolicy: {
          directMessages: owner,
          channels: { scope: "all", conversationIds: [], sender: owner },
        },
      },
      {
        accessPolicy: {
          directMessages: owner,
          channels: { scope: "off", conversationIds: [], sender: owner },
        },
        selector: { conversationType: "dm" },
      },
    ]);

    await applyBridgeConversion(database as never);

    expect(await shadowed()).toEqual([
      { bridgeConversationId: "C-two", bridgeNotice: "converted", revokedAt: null },
    ]);
    expect(await overlapping()).toEqual([
      { bridgeConversationId: null, bridgeNotice: "converted-without-channels", revokedAt: null },
    ]);
  });

  it("ends the old route with its bridge, and cancels only chat messages known not to have run", async ({
    storeFixture,
  }) => {
    const { configured, fixture } = await storeFixture.createChannelDeliveryFixture("convert-end", {
      bridge: false,
    });
    const { database, store } = storeFixture;
    await database
      .updateTable("channelBindings")
      .set({ accessPolicy: sql`${JSON.stringify(policy("owner", { scope: "off" }))}::jsonb` })
      .where("id", "=", configured.binding.id as never)
      .execute();
    // Two messages a chat queued before the update: one waiting, one whose outcome is unknown.
    const queued = [];
    for (const key of ["legacy-waiting", "legacy-unknown", "legacy-waiting-too"])
      queued.push(
        await store.enqueueThreadInput({
          requestedBy: fixture.userId,
          threadId: fixture.thread.id,
          content: [{ type: "text", text: key }],
          source: { kind: "human" },
          policy: "queue",
          idempotencyKey: key,
        }),
      );
    await database
      .updateTable("threadInputs")
      .set({
        authoritySource: sql`${JSON.stringify({ kind: "channel-ingress", conversationId: "legacy" })}::jsonb`,
      })
      .where("threadId", "=", fixture.thread.id)
      .where("state", "=", "pending")
      .execute();
    await database
      .updateTable("threadInputs")
      .set({ state: "unknown" })
      .where("messageId", "=", queued[1]!.message.id)
      .execute();

    await applyBridgeConversion(database as never);
    const { cancelLegacyChatInputs } = await import("./execution-recovery.js");
    await cancelLegacyChatInputs(database);
    const states = await database
      .selectFrom("threadInputs")
      .select(["messageId", "state"])
      .where(
        "messageId",
        "in",
        queued.map(({ message }) => message.id),
      )
      .orderBy("createdAt")
      .execute();
    expect(states.map(({ state }) => state)).toEqual(["cancelled", "unknown", "cancelled"]);

    // The person disconnects the converted bridge: the route it came from ends with it.
    const { AgentConnectionStore } = await import("./agent-connection-store.js");
    const bridge = await database
      .selectFrom("agentConnections")
      .select("id")
      .where("bridgeFromBindingId", "=", configured.binding.id)
      .executeTakeFirstOrThrow();
    expect(await new AgentConnectionStore(database).revoke(fixture.userId, bridge.id)).toBe(true);
    expect(
      await database
        .selectFrom("channelBindings")
        .select("status")
        .where("id", "=", configured.binding.id as never)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "revoked" });
  });

  it("creates on a work Home that does not allow tasks only bridges that are already ended", async ({
    storeFixture,
  }) => {
    const { fixture, configured } = await storeFixture.createChannelDeliveryFixture(
      "convert-work",
      { bridge: false },
    );
    const { WorkHomeStore } = await import("./work-home.js");
    await new WorkHomeStore(storeFixture.database).initialize(
      {
        organizationId: `org_${crypto.randomUUID()}` as never,
        organizationName: "Workshop",
        assignmentId: `was_${crypto.randomUUID()}` as never,
      },
      fixture.deploymentId,
    );
    await applyBridgeConversion(storeFixture.database as never);
    const bridges = await storeFixture.database
      .selectFrom("agentConnections")
      .select(["revokedAt", "cleanupReason"])
      .where("bridgeAccountId", "=", configured.account.id)
      .execute();
    expect(bridges).toEqual([{ revokedAt: expect.any(Date), cleanupReason: "revoked" }]);
  });
});
