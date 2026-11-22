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
    const { configured, fixture } = await storeFixture.createChannelDeliveryFixture("bridge-live");
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
    const { configured, fixture } = await storeFixture.createChannelDeliveryFixture("bridge-rules");
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
    const { configured, fixture } = await storeFixture.createChannelDeliveryFixture("bridge-make");
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
    const { configured, fixture } = await storeFixture.createChannelDeliveryFixture("bridge-work");
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
  it("is decided by the lineage's own row, for the Run and for every task under it", async ({
    storeFixture,
  }) => {
    const { configured, fixture } = await storeFixture.createChannelDeliveryFixture("bridge-ctx");
    const { database } = storeFixture;
    const { runAllowsPersonalContext, threadAllowsPersonalContext } =
      await import("./run-personal-context.js");
    // A task of the person's that no chat ever wrote to.
    const task = await storeFixture.createTaskForOwner(fixture.userId, "bridge-ctx-task");
    const queued = await storeFixture.store.enqueueThreadInput({
      requestedBy: fixture.userId,
      threadId: task.id,
      content: [{ type: "text", text: "Work" }],
      source: { kind: "human" },
      policy: "queue",
      idempotencyKey: "bridge-ctx-run",
    });
    const run = queued.run!.id;
    // The person's own Run.
    expect(await runAllowsPersonalContext(database, run)).toBe(true);
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
    const lineage = async (connectionId: string) => {
      await database
        .updateTable("threads")
        .set({ originConnectionId: connectionId })
        .where("id", "=", task.id)
        .execute();
      await database.updateTable("runs").set({ connectionId }).where("id", "=", run).execute();
    };
    await lineage(onlyMe.id);
    expect(await runAllowsPersonalContext(database, run)).toBe(true);
    await lineage(anyone.id);
    expect(await runAllowsPersonalContext(database, run)).toBe(false);
    expect(await threadAllowsPersonalContext(database, task.id, fixture.userId)).toBe(false);
  });
});
