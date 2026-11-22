import { createChannelId } from "@opensteer/channel-core";
import { createId, ThreadIdSchema, type AgentGrant } from "@opensteer/core";
import { AgentConnectionStore, upsertChannelIdentity } from "@opensteer/database";
import { createStoreFixture } from "@opensteer/database/test-support/store";
import { describe, expect, it } from "vitest";
import type { ConnectionCaller } from "../mcp/agent-caller.js";
import { lastService, serveMcp } from "../mcp/connection-caller.test-support.js";
import { resolveBridgeCaller } from "./bridge-caller.js";

const tasksOnly: AgentGrant = { scope: "selected", tasks: true, resources: [] };

async function bridgeFixture(suffix: string) {
  const storeFixture = await createStoreFixture();
  const { configured, fixture } = await storeFixture.createChannelDeliveryFixture(suffix, {
    bridge: false,
  });
  await serveMcp(storeFixture);
  const connections = new AgentConnectionStore(storeFixture.database);
  const bridge = await connections.createBridge({
    userId: fixture.userId,
    accountId: configured.account.id,
    senders: "owner",
    accessMode: "approval-required",
    grant: tasksOnly,
  });
  // "Me" on the account, as sending the link code makes it.
  await storeFixture.database.transaction().execute(async (tx) => {
    const identity = await upsertChannelIdentity(tx, {
      accountId: configured.account.id,
      displayName: "Tim",
      externalUserId: "U-OWNER",
    });
    await tx
      .updateTable("channelIdentities")
      .set({ linkedUserId: fixture.userId, status: "linked" })
      .where("id", "=", identity.id)
      .execute();
  });
  const conversation = async (bridgeId: string, external: string) => {
    const id = createChannelId("conversation");
    await storeFixture.database
      .insertInto("bridgeConversations")
      .values({
        id,
        bridgeId,
        accountId: configured.account.id,
        externalScopeId: null,
        externalConversationId: external,
        externalThreadId: null,
        conversationType: "dm",
        displayName: null,
        threadId: null,
      })
      .execute();
    return id;
  };
  const conversationId = await conversation(bridge.id, `D-${suffix}`);
  const call = (caller: ConnectionCaller, name: string, args: unknown, key: string) =>
    lastService!.callTool("", name, args, {
      caller,
      resolveCaller: async () => caller,
      operationKey: key,
    });
  return { storeFixture, fixture, configured, bridge, conversationId, conversation, call };
}

describe("a bridge asks your own agents to work through the task tools' own entry points", () => {
  it("starts a task in its lineage, under its ceiling, replying where the message came from", async () => {
    const f = await bridgeFixture("bridge-create");
    try {
      const caller = await resolveBridgeCaller(f.storeFixture.store, {
        ownerUserId: f.fixture.userId,
        bridgeId: f.bridge.id,
        chat: {
          conversationId: f.conversationId,
          revision: f.bridge.grantRevision!,
          sender: { displayName: "Tim", externalUserId: "U-OWNER" },
        },
      });
      const created = (await f.call(
        caller,
        "opensteer_task_create",
        { message: "Summarize my week" },
        "ingress:1",
      )) as { taskId: string };
      const taskId = ThreadIdSchema.parse(created.taskId);
      const { database } = f.storeFixture;
      expect(
        await database
          .selectFrom("threads")
          .select(["originConnectionId", "accessMode"])
          .where("id", "=", taskId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ originConnectionId: f.bridge.id, accessMode: "approval-required" });
      const input = await database
        .selectFrom("threadInputs")
        .innerJoin("messages", "messages.id", "threadInputs.messageId")
        .select(["threadInputs.replyTarget", "messages.author", "threadInputs.connectionId"])
        .where("threadInputs.threadId", "=", taskId)
        .executeTakeFirstOrThrow();
      expect(input).toMatchObject({
        replyTarget: { kind: "channel", conversationId: f.conversationId },
        connectionId: f.bridge.id,
        author: { kind: "human", userId: f.fixture.userId },
      });
      expect(input.author).toMatchObject({ displayName: expect.stringContaining("via Slack") });
      // The same message again is the same task: the operation key is the chat's event.
      const again = (await f.call(
        caller,
        "opensteer_task_create",
        { message: "Summarize my week" },
        "ingress:1",
      )) as { taskId: string };
      expect(again.taskId).toBe(taskId);
    } finally {
      await f.storeFixture.close();
    }
  });

  it("admits nobody its sender rule leaves out, and touches nothing outside its lineage", async () => {
    const f = await bridgeFixture("bridge-refuse");
    try {
      const stranger = {
        conversationId: f.conversationId,
        revision: f.bridge.grantRevision!,
        sender: { displayName: "Someone else", externalUserId: "U-STRANGER" },
      };
      // Only me: someone else's message is never admitted as this bridge.
      await expect(
        resolveBridgeCaller(f.storeFixture.store, {
          ownerUserId: f.fixture.userId,
          bridgeId: f.bridge.id,
          chat: stranger,
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
      // Nor when a caller says otherwise: the inbox reads the rule from the row itself.
      const owner = await resolveBridgeCaller(f.storeFixture.store, {
        ownerUserId: f.fixture.userId,
        bridgeId: f.bridge.id,
        chat: { ...stranger, sender: { displayName: "Tim", externalUserId: "U-OWNER" } },
      });
      const refused = {
        code: "forbidden",
        message: "This chat may no longer ask your own agents to work.",
      };
      const bridgeTasks = () =>
        f.storeFixture.database
          .selectFrom("threads")
          .select("id")
          .where("originConnectionId", "=", f.bridge.id)
          .execute();
      await expect(
        f.call({ ...owner, chat: stranger }, "opensteer_task_create", { message: "Hi" }, "k1"),
      ).rejects.toMatchObject(refused);
      // A conversation another bridge covers is not this bridge's to answer.
      const other = await new AgentConnectionStore(f.storeFixture.database).createBridge({
        userId: f.fixture.userId,
        accountId: f.configured.account.id,
        conversation: { id: "C-other", name: "#other" },
        senders: "owner",
        accessMode: "approval-required",
        grant: tasksOnly,
      });
      const foreign = await f.conversation(other.id, "C-other");
      await expect(
        f.call(
          { ...owner, chat: { ...owner.chat!, conversationId: foreign } },
          "opensteer_task_create",
          { message: "Hi" },
          "k2",
        ),
      ).rejects.toMatchObject(refused);
      // Neither left a task behind.
      expect(await bridgeTasks()).toEqual([]);
      // A selected bridge cannot send into the person's own task: it reads as not there.
      await expect(
        f.call(
          owner,
          "opensteer_task_send",
          { taskId: f.fixture.thread.id, message: "Hi", delivery: "queue" },
          "k3",
        ),
      ).rejects.toMatchObject({ code: "not_found" });
    } finally {
      await f.storeFixture.close();
    }
  });

  it("asks the one bridge admission at every layer: caller, inbox and hand-off", async () => {
    const f = await bridgeFixture("bridge-one-rule");
    try {
      const owner = {
        conversationId: f.conversationId,
        revision: f.bridge.grantRevision!,
        sender: { displayName: "Tim", externalUserId: "U-OWNER" },
      };
      // The caller reads who wrote from the linked identities, never from what it is told.
      await expect(
        resolveBridgeCaller(f.storeFixture.store, {
          ownerUserId: f.fixture.userId,
          bridgeId: f.bridge.id,
          chat: {
            ...owner,
            sender: { displayName: "Eve", externalUserId: "U-STRANGER", owner: true },
          } as never,
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
      // A message admitted under an earlier revision of the bridge makes no task at all.
      const caller = await resolveBridgeCaller(f.storeFixture.store, {
        ownerUserId: f.fixture.userId,
        bridgeId: f.bridge.id,
        chat: owner,
      });
      await new AgentConnectionStore(f.storeFixture.database).update(f.fixture.userId, {
        connectionId: f.bridge.id,
        expectedRevision: f.bridge.grantRevision!,
        accessMode: "auto",
      });
      await expect(
        f.call(caller, "opensteer_task_create", { message: "Hi" }, "stale-revision"),
      ).rejects.toMatchObject({
        code: "forbidden",
        message: "This chat may no longer ask your own agents to work.",
      });
      expect(
        await f.storeFixture.database
          .selectFrom("threads")
          .select("id")
          .where("originConnectionId", "=", f.bridge.id)
          .execute(),
      ).toEqual([]);
      // A paused account hands nothing off: the hand-off reads the same liveness.
      await f.storeFixture.database
        .updateTable("channelAccounts")
        .set({ status: "paused" })
        .where("id", "=", f.configured.account.id)
        .execute();
      await expect(
        f.storeFixture.store.recordConnectionRunHandoff({
          runId: createId("run"),
          bindingGeneration: 1,
          connectionId: f.bridge.id,
          grantRevision: f.bridge.grantRevision! + 1,
          mode: "approval-required",
        }),
      ).rejects.toThrow("The agent connection changed before this Run could be sent");
    } finally {
      await f.storeFixture.close();
    }
  });
});
