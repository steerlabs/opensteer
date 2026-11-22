import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { sql } from "kysely";
import type { AgentGrant, UserId } from "@opensteer/core";
import { AgentConnectionStore } from "./agent-connection-store.js";
import { admitExecution } from "./resource-access.js";
import { describeStore } from "./store.integration.test-support.js";
import type { DatabaseSchema } from "./schema.js";
import type { Kysely } from "kysely";

const lineageEnded = {
  code: "forbidden",
  message:
    "This connected agent's access ended. The person can reconnect it from Connected agents.",
};
const tasksOnly: AgentGrant = { scope: "selected", tasks: true, resources: [] };

/** A bridge row as the store writes one: no credential, an ordinary far-future expiry. */
async function insertBridgeRow(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly userId: UserId;
    readonly accountId: string;
    readonly conversationId?: string | null;
    readonly senders?: "owner" | "anyone";
    readonly grant?: AgentGrant;
  },
): Promise<string> {
  const id = `mcn_${randomUUID()}`;
  await database
    .insertInto("agentConnections")
    .values({
      id,
      userId: input.userId,
      label: "Slack",
      clientName: "Slack",
      accessMode: "approval-required",
      resource: "opensteer:bridge",
      tokenHash: null,
      lastUsedAt: null,
      revokedAt: null,
      expiresAt: new Date(Date.UTC(9999, 11, 31)),
      grant: sql`${JSON.stringify(input.grant ?? tasksOnly)}::jsonb` as never,
      consentVersion: 2,
      bridgeAccountId: input.accountId as never,
      bridgeConversationId: input.conversationId ?? null,
      bridgeSenders: input.senders ?? "owner",
    })
    .execute();
  return id;
}

describeStore("a messaging bridge is a connection", (it) => {
  it("has authority with no credential, never signs in over MCP, and ends with its account", async ({
    storeFixture,
  }) => {
    const { configured, fixture } = await storeFixture.createChannelDeliveryFixture("bridge-live", {
      bridge: false,
    });
    const { database } = storeFixture;
    const bridgeId = await insertBridgeRow(database, {
      userId: fixture.userId,
      accountId: configured.account.id,
    });

    // Live with no token and no expiry of its own: admitted like any connection.
    const admitted = await admitExecution(database, {
      ownerUserId: fixture.userId,
      subject: { kind: "connection", agentConnectionId: bridgeId },
    });
    expect(admitted).toMatchObject({
      actor: "agent",
      mode: "approval-required",
      agentConnection: { agentConnectionId: bridgeId, bridgeSenders: "owner" },
    });

    // Nothing an MCP client holds ever matches a bridge.
    const connections = new AgentConnectionStore(database);
    expect(await connections.activate(bridgeId, "bridge-token-hash")).toBe(false);
    expect(await connections.authenticate("bridge-token-hash")).toBeNull();

    // Its provider account stops speaking: the bridge has no authority in the same read.
    await database
      .updateTable("channelAccounts")
      .set({ status: "paused" })
      .where("id", "=", configured.account.id)
      .execute();
    await expect(
      admitExecution(database, {
        ownerUserId: fixture.userId,
        subject: { kind: "connection", agentConnectionId: bridgeId },
      }),
    ).rejects.toMatchObject(lineageEnded);
  });

  it("never lets anyone speak in direct messages, nor an anyone bridge hold more than tasks and plugins", async ({
    storeFixture,
  }) => {
    const { configured, fixture } = await storeFixture.createChannelDeliveryFixture(
      "bridge-rules",
      { bridge: false },
    );
    const { database } = storeFixture;
    const base = { userId: fixture.userId, accountId: configured.account.id };
    // Direct messages are always "only me".
    await expect(insertBridgeRow(database, { ...base, senders: "anyone" })).rejects.toMatchObject({
      constraint: "agent_connections_bridge",
    });
    // Anyone in one channel: never everything, never a browser profile.
    await expect(
      insertBridgeRow(database, {
        ...base,
        conversationId: "C-everything",
        senders: "anyone",
        grant: { scope: "everything" },
      }),
    ).rejects.toMatchObject({ constraint: "agent_connections_bridge" });
    await expect(
      insertBridgeRow(database, {
        ...base,
        conversationId: "C-profile",
        senders: "anyone",
        grant: {
          scope: "selected",
          tasks: true,
          resources: [{ kind: "browser-profile", profileId: `bpr_${randomUUID()}` as never }],
        },
      }),
    ).rejects.toMatchObject({ constraint: "agent_connections_bridge" });
    // A bridge always holds tasks: without them it can do nothing.
    await expect(
      insertBridgeRow(database, {
        ...base,
        conversationId: "C-no-tasks",
        grant: { scope: "selected", tasks: false, resources: [] },
      }),
    ).rejects.toMatchObject({ constraint: "agent_connections_bridge" });
    // Two live bridges never cover the same conversation.
    await insertBridgeRow(database, { ...base, conversationId: "C-shared", senders: "anyone" });
    await expect(
      insertBridgeRow(database, { ...base, conversationId: "C-shared" }),
    ).rejects.toMatchObject({ constraint: "agent_connections_bridge_cover" });
  });
});

describeStore("a bridge is made on the same consent as a connected agent", (it) => {
  it("is Supervised unless chosen, holds tasks, and answers only the person in direct messages", async ({
    storeFixture,
  }) => {
    const { configured, fixture } = await storeFixture.createChannelDeliveryFixture("bridge-make", {
      bridge: false,
    });
    const connections = new AgentConnectionStore(storeFixture.database);
    const base = { userId: fixture.userId, accountId: configured.account.id } as const;
    const bridge = await connections.createBridge({
      ...base,
      senders: "owner",
      accessMode: "approval-required",
      grant: tasksOnly,
    });
    expect(bridge).toMatchObject({
      label: "Slack",
      clientName: "Slack",
      accessMode: "approval-required",
      expiresAt: null,
      bridge: { accountId: configured.account.id, conversationId: null, senders: "owner" },
    });
    await expect(
      connections.createBridge({
        ...base,
        conversation: { id: "C-general", name: "#general" },
        senders: "owner",
        accessMode: "approval-required",
        grant: { scope: "selected", tasks: false, resources: [] },
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      connections.createBridge({
        ...base,
        senders: "anyone",
        accessMode: "approval-required",
        grant: tasksOnly,
      }),
    ).rejects.toMatchObject({ code: "bad_request", message: "Direct messages answer only you." });
    await expect(
      connections.createBridge({
        ...base,
        conversation: { id: "C-general", name: "#general" },
        senders: "anyone",
        accessMode: "approval-required",
        grant: { scope: "everything" },
      }),
    ).rejects.toMatchObject({ code: "bad_request", reason: "bridge-anyone-grant" });
    // One conversation, one bridge.
    await expect(
      connections.createBridge({
        ...base,
        senders: "owner",
        accessMode: "approval-required",
        grant: tasksOnly,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    // Listed with the connected agents; it does not expire.
    expect(await connections.list(fixture.userId)).toEqual([
      expect.objectContaining({ id: bridge.id, state: "active", expiresAt: null }),
    ]);
  });

  it("sits under a work Home's ceiling exactly as a connected agent does", async ({
    storeFixture,
  }) => {
    const { configured, fixture } = await storeFixture.createChannelDeliveryFixture("bridge-work", {
      bridge: false,
    });
    const { WorkHomeStore } = await import("./work-home.js");
    await new WorkHomeStore(storeFixture.database).initialize(
      {
        organizationId: `org_${randomUUID()}` as never,
        organizationName: "Workshop",
        assignmentId: `was_${randomUUID()}` as never,
      },
      fixture.deploymentId,
    );
    // The default policy does not allow tasks, and a bridge always holds them.
    await expect(
      new AgentConnectionStore(storeFixture.database).createBridge({
        userId: fixture.userId,
        accountId: configured.account.id,
        senders: "owner",
        accessMode: "full-access",
        grant: tasksOnly,
      }),
    ).rejects.toMatchObject({ code: "forbidden", message: "Your organization doesn't allow this" });
  });
});

describeStore("work from a bridge anyone may speak to has no personal context", (it) => {
  it("is decided by the lineage's own row, and the person's own work reads nothing", async ({
    storeFixture,
  }) => {
    const { configured, fixture } = await storeFixture.createChannelDeliveryFixture("bridge-ctx", {
      bridge: false,
    });
    const { database } = storeFixture;
    const { lineagePersonalContext } = await import("./resource-access.js");
    // The person's own work has no connection: it has personal context, with no query at all.
    const issued: string[] = [];
    const counted = database.withPlugin({
      transformQuery: (args) => {
        issued.push(args.node.kind);
        return args.node;
      },
      transformResult: async (args) => args.result,
    });
    expect(await lineagePersonalContext(counted, null)).toBe(true);
    expect(issued).toEqual([]);
    const connections = new AgentConnectionStore(database);
    const onlyMe = await connections.createBridge({
      userId: fixture.userId,
      accountId: configured.account.id,
      senders: "owner",
      accessMode: "approval-required",
      grant: tasksOnly,
    });
    const anyone = await connections.createBridge({
      userId: fixture.userId,
      accountId: configured.account.id,
      conversation: { id: "C-team", name: "#team" },
      senders: "anyone",
      accessMode: "approval-required",
      grant: tasksOnly,
    });
    expect(await lineagePersonalContext(database, onlyMe.id)).toBe(true);
    expect(await lineagePersonalContext(database, anyone.id)).toBe(false);
    // A lineage whose connection cannot be read is never given the person's context.
    expect(await lineagePersonalContext(database, `mcn_${randomUUID()}`)).toBe(false);
  });
});

describeStore("a change of who may speak to a bridge stops what is running", (it) => {
  it("raises the revision and asks the lineage's work to stop, in either direction", async ({
    storeFixture,
  }) => {
    const { configured, fixture } = await storeFixture.createChannelDeliveryFixture(
      "bridge-senders",
      { bridge: false },
    );
    const connections = new AgentConnectionStore(storeFixture.database);
    const bridge = await connections.createBridge({
      userId: fixture.userId,
      accountId: configured.account.id,
      conversation: { id: "C-senders", name: "#senders" },
      senders: "owner",
      accessMode: "approval-required",
      grant: tasksOnly,
    });
    const cleanup = () =>
      storeFixture.database
        .selectFrom("agentConnections")
        .select(["grantRevision", "bridgeSenders", "cleanupReason", "cleanupMinimumGrantRevision"])
        .where("id", "=", bridge.id)
        .executeTakeFirstOrThrow();
    await connections.update(fixture.userId, {
      connectionId: bridge.id,
      expectedRevision: 1,
      senders: "anyone",
    });
    expect(await cleanup()).toEqual({
      grantRevision: 2,
      bridgeSenders: "anyone",
      cleanupReason: "narrowed",
      cleanupMinimumGrantRevision: 2,
    });
    await connections.update(fixture.userId, {
      connectionId: bridge.id,
      expectedRevision: 2,
      senders: "owner",
    });
    expect(await cleanup()).toMatchObject({
      grantRevision: 3,
      bridgeSenders: "owner",
      cleanupMinimumGrantRevision: 3,
    });
    // Renaming it changes nothing about who may speak.
    await connections.update(fixture.userId, {
      connectionId: bridge.id,
      expectedRevision: 3,
      label: "Team channel",
    });
    expect(await cleanup()).toMatchObject({ grantRevision: 3 });
    // "Anyone" is refused while the bridge holds more than tasks and plugins.
    await connections.update(fixture.userId, {
      connectionId: bridge.id,
      expectedRevision: 3,
      grant: { scope: "everything" },
    });
    await expect(
      connections.update(fixture.userId, {
        connectionId: bridge.id,
        expectedRevision: 4,
        senders: "anyone",
      }),
    ).rejects.toMatchObject({ code: "bad_request", reason: "bridge-anyone-grant" });
  });
});
