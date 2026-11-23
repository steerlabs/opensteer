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
    // A grant without tasks can always be written (a policy taking tasks away must never fail);
    // such a bridge is simply not live.
    await insertBridgeRow(database, {
      ...base,
      conversationId: "C-no-tasks",
      grant: { scope: "selected", tasks: false, resources: [] },
    });
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
    // What the person may choose for it later is what they may choose when it is made.
    await expect(
      connections.update(fixture.userId, {
        connectionId: bridge.id,
        expectedRevision: bridge.grantRevision!,
        grant: { scope: "selected", tasks: false, resources: [] },
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    const team = await connections.createBridge({
      ...base,
      conversation: { id: "C-team", name: "#team" },
      senders: "anyone",
      accessMode: "approval-required",
      grant: tasksOnly,
    });
    await expect(
      connections.update(fixture.userId, {
        connectionId: team.id,
        expectedRevision: team.grantRevision!,
        grant: { scope: "everything" },
      }),
    ).rejects.toMatchObject({ code: "bad_request", reason: "bridge-anyone-grant" });
    await connections.revoke(fixture.userId, team.id);
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

  it("ends through Disconnect when the organization takes tasks away, and never refuses the policy", async ({
    storeFixture,
  }) => {
    const { configured, fixture } = await storeFixture.createChannelDeliveryFixture("bridge-off", {
      bridge: false,
    });
    const { database } = storeFixture;
    const { WorkHomeStore } = await import("./work-home.js");
    const work = new WorkHomeStore(database);
    const marker = {
      organizationId: `org_${randomUUID()}` as never,
      organizationName: "Workshop",
      assignmentId: `was_${randomUUID()}` as never,
    };
    await work.initialize(marker, fixture.deploymentId);
    const document = (revision: number, allowTasks: boolean) => ({
      assignmentId: marker.assignmentId,
      deploymentId: fixture.deploymentId,
      policy: {
        externalMaxMode: "full-access" as const,
        allowEverything: false,
        allowTasks,
        devices: "assignee-may-enroll" as const,
      },
      revision,
      state: "active" as const,
    });
    await work.apply(document(1, true));
    const connections = new AgentConnectionStore(database);
    const bridge = await connections.createBridge({
      userId: fixture.userId,
      accountId: configured.account.id,
      senders: "owner",
      accessMode: "approval-required",
      grant: tasksOnly,
    });
    // The organization turns tasks off: the policy is written, whatever bridges exist.
    await expect(work.apply(document(2, false))).resolves.toEqual({ revision: 2, changed: true });
    const row = () =>
      database
        .selectFrom("agentConnections")
        .select(["grant", "revokedAt", "cleanupReason"])
        .where("id", "=", bridge.id)
        .executeTakeFirstOrThrow();
    expect((await row()).grant).toEqual({ ...tasksOnly, tasks: false });
    // From that statement on it is not live, and the person never reads it as active.
    expect(
      (await connections.list(fixture.userId, { includeRevoked: true })).find(
        ({ id }) => id === bridge.id,
      )?.state,
    ).not.toBe("active");
    // A bridge without tasks has no authority from that statement on, and its end is a
    // Disconnect: the worker revokes it and shows the end with evidence.
    await storeFixture.store.driveConnectionCleanups({ stopper: { stop: async () => undefined } });
    expect(await row()).toMatchObject({ cleanupReason: "revoked", revokedAt: expect.any(Date) });
    expect(
      (await connections.list(fixture.userId, { includeRevoked: true })).find(
        ({ id }) => id === bridge.id,
      ),
    ).toMatchObject({ state: "stopped" });
    // The image before this one writes the same narrowing in place, and is never refused.
    const other = await connections
      .createBridge({
        userId: fixture.userId,
        accountId: configured.account.id,
        senders: "owner",
        accessMode: "approval-required",
        grant: tasksOnly,
      })
      .catch((error: unknown) => error);
    expect(other).toMatchObject({ code: "forbidden" });
    const previous = await insertBridgeRow(database, {
      userId: fixture.userId,
      accountId: configured.account.id,
    });
    await expect(
      sql`update agent_connections set "grant" = jsonb_set("grant", '{tasks}', 'false')
        where id = ${previous}`.execute(database),
    ).resolves.toBeDefined();
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

describeStore("the ingress asks the one bridge admission before it writes anything", (it) => {
  it("applies the organization's policy, and links nobody on an account that is not connected", async ({
    storeFixture,
  }) => {
    const bridge = await storeFixture.createBridgeFixture("ingress-policy");
    const { database } = storeFixture;
    const conversations = () =>
      database
        .selectFrom("bridgeConversations")
        .select("id")
        .where("bridgeId", "=", bridge.bridge.id)
        .execute();
    // A work Home whose policy does not allow tasks: the message is refused at admission,
    // before any conversation is written for it.
    const { WorkHomeStore } = await import("./work-home.js");
    await new WorkHomeStore(database).initialize(
      {
        organizationId: `org_${randomUUID()}` as never,
        organizationName: "Workshop",
        assignmentId: `was_${randomUUID()}` as never,
      },
      bridge.fixture.deploymentId,
    );
    const { decision } = await bridge.decide({ eventId: "policy-1" });
    expect(decision).toMatchObject({ kind: "ignored" });
    expect(await conversations()).toEqual([]);
  });

  it("redeems a link code only for a connected account", async ({ storeFixture }) => {
    const bridge = await storeFixture.createBridgeFixture("link-paused", { linkOwner: false });
    const { startBridgeOwnerLink } = await import("./bridge-ingress.js");
    const { code } = await startBridgeOwnerLink(storeFixture.database, {
      userId: bridge.fixture.userId,
      accountId: bridge.configured.account.id,
    });
    // The code arrived while connected; by the time it is read, the account is paused.
    const claimed = await bridge.claim({ eventId: "link-1", text: code });
    await storeFixture.database
      .updateTable("channelAccounts")
      .set({ status: "paused" })
      .where("id", "=", bridge.configured.account.id)
      .execute();
    const { decideBridgeIngress } = await import("./bridge-ingress.js");
    const decision = await decideBridgeIngress(storeFixture.database, {
      ingressId: claimed.id,
      claimToken: claimed.claimToken,
    });
    expect(decision).not.toEqual({ kind: "linked" });
    expect(
      await storeFixture.database
        .selectFrom("channelIdentities")
        .select("id")
        .where("accountId", "=", bridge.configured.account.id)
        .where("status", "=", "linked")
        .execute(),
    ).toEqual([]);
  });
});

describeStore("a bridge's sender rule, account and conversation are fixed for its life", (it) => {
  it("refuses any change to them, even in the database", async ({ storeFixture }) => {
    const { configured, fixture } = await storeFixture.createChannelDeliveryFixture("fixed", {
      bridge: false,
    });
    const other = await storeFixture.createChannelDeliveryFixture("fixed-other", {
      bridge: false,
    });
    const bridge = await new AgentConnectionStore(storeFixture.database).createBridge({
      userId: fixture.userId,
      accountId: configured.account.id,
      conversation: { id: "C-fixed", name: "#fixed" },
      senders: "owner",
      accessMode: "approval-required",
      grant: tasksOnly,
    });
    for (const change of [
      { bridgeSenders: "anyone" as const },
      { bridgeAccountId: other.configured.account.id as never },
      { bridgeConversationId: "C-elsewhere" },
    ])
      await expect(
        storeFixture.database
          .updateTable("agentConnections")
          .set(change)
          .where("id", "=", bridge.id)
          .execute(),
        JSON.stringify(change),
      ).rejects.toMatchObject({ constraint: "agent_connections_bridge_senders_fixed" });
  });
});

describeStore('"me" is one identity on an account at a time', (it) => {
  it("unlinks the earlier one when the person links another", async ({ storeFixture }) => {
    const bridge = await storeFixture.createBridgeFixture("relink");
    const { declineBridgeIngress, startBridgeOwnerLink } = await import("./bridge-ingress.js");
    /** Decide one message, and let the chat go on as the Host's ingress would after it. */
    const decideAndSettle = async (input: Parameters<typeof bridge.decide>[0]) => {
      const { claimed, decision } = await bridge.decide(input);
      if (decision.kind === "work")
        await declineBridgeIngress(storeFixture.database, {
          ingressId: claimed.id,
          claimToken: claimed.claimToken,
          conversationId: decision.conversationId,
          reason: "settled by the test",
        });
      return decision;
    };
    expect(await decideAndSettle({ eventId: "before" })).toMatchObject({ kind: "work" });
    // The person moves to a new account on the same workspace and sends a new code from it.
    const { code } = await startBridgeOwnerLink(storeFixture.database, {
      userId: bridge.fixture.userId,
      accountId: bridge.configured.account.id,
    });
    expect(
      await decideAndSettle({ eventId: "relink", text: code, externalUserId: "U-NEW" }),
    ).toEqual({ kind: "linked" });
    // What the person sees as "me" is what is accepted as "me": the old account is not.
    expect(
      await storeFixture.database
        .selectFrom("channelIdentities")
        .select("externalUserId")
        .where("accountId", "=", bridge.configured.account.id)
        .where("status", "=", "linked")
        .execute(),
    ).toEqual([{ externalUserId: "U-NEW" }]);
    expect(await decideAndSettle({ eventId: "old" })).toMatchObject({
      kind: "ignored",
      reason: "Only the person may message this bridge",
    });
    expect(await decideAndSettle({ eventId: "new", externalUserId: "U-NEW" })).toMatchObject({
      kind: "work",
    });
  });
});

describeStore('"me" is one identity, enforced by the database', (it) => {
  it("makes one live code however many are asked for at once, and links one identity per person", async ({
    storeFixture,
  }) => {
    const bridge = await storeFixture.createBridgeFixture("one-me", { linkOwner: false });
    const { database } = storeFixture;
    const { startBridgeOwnerLink } = await import("./bridge-ingress.js");
    const accountId = bridge.configured.account.id;
    // Two tabs ask for a code at the same moment: one code is live, the other never links.
    const codes = await Promise.all(
      [1, 2].map(() =>
        startBridgeOwnerLink(database, { userId: bridge.fixture.userId, accountId }),
      ),
    );
    expect(
      await database
        .selectFrom("bridgeLinkCodes")
        .select("id")
        .where("accountId", "=", accountId)
        .where("consumedAt", "is", null)
        .execute(),
    ).toHaveLength(1);
    // Two people send the codes at once: at most one of them is "me".
    // Each from their own direct message with the bot: two lanes, decided at the same time.
    for (const [index, { code }] of codes.entries()) {
      const event = bridge.event({
        eventId: `code-${index}`,
        text: code,
        externalUserId: `U-${index}`,
      });
      await bridge.channels.commitIngress(bridge.configured.connection.id, {
        ...event,
        conversation: { ...event.conversation, externalConversationId: `D-one-me-${index}` },
      });
    }
    const sent = [
      (await bridge.channels.claimIngress("one-me-a"))!,
      (await bridge.channels.claimIngress("one-me-b"))!,
    ];
    expect(sent.every(Boolean)).toBe(true);
    const { decideBridgeIngress } = await import("./bridge-ingress.js");
    await Promise.all(
      sent.map((claimed) =>
        decideBridgeIngress(database, { ingressId: claimed.id, claimToken: claimed.claimToken }),
      ),
    );
    expect(
      await database
        .selectFrom("channelIdentities")
        .select("externalUserId")
        .where("accountId", "=", accountId)
        .where("status", "=", "linked")
        .execute(),
    ).toHaveLength(1);
    // And the database itself refuses a second "me" for the person on the account.
    const linked = await database
      .selectFrom("channelIdentities")
      .select("linkedUserId")
      .where("accountId", "=", accountId)
      .where("status", "=", "linked")
      .executeTakeFirstOrThrow();
    const second = await identity(database, accountId, "U-second");
    await expect(
      database
        .updateTable("channelIdentities")
        .set({ status: "linked", linkedUserId: linked.linkedUserId })
        .where("id", "=", second as never)
        .execute(),
    ).rejects.toMatchObject({ constraint: "channel_identities_one_me" });
  });
});

/** An identity on the account, as the first message from it makes one. */
async function identity(
  database: Kysely<DatabaseSchema>,
  accountId: string,
  externalUserId: string,
): Promise<string> {
  const { upsertChannelIdentity } = await import("./channel-store.js");
  const { commitPersonalMutation } = await import("./personal-mutation.js");
  const made = await commitPersonalMutation(database, (tx) =>
    upsertChannelIdentity(tx, {
      accountId: accountId as never,
      displayName: externalUserId,
      externalUserId,
    }),
  );
  return made.id;
}
