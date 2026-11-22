/**
 * The preview Home answers as the Home does. One script of what a person does with chats and
 * messaging accounts is run here against a real Home (its store, `ChannelService` and the command
 * and read handlers the API serves), and each answer and the views it leaves are compared with
 * `packages/client/src/mock/chat-parity.fixture.json`. The mock's unit test replays the same
 * script from that fixture and must give the same answers. A Home that changes its answer fails
 * here; a mock that differs fails there. To record a change on purpose:
 * `OPENSTEER_UPDATE_CHAT_PARITY=1 pnpm test:integration apps/host/src/channels/chat-parity.integration.test.ts`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createId, type AgentGrant } from "@opensteer/core";
import { AgentConnectionStore, ChannelStore } from "@opensteer/database";
import { createStoreFixture, testMessagingRunnerId } from "@opensteer/database/test-support/store";
import {
  chatParityChat,
  chatParityNormalized,
  chatParityRefusal,
  chatParityViews,
  type ChatParityAnswer,
  type ChatParityRecord,
  type ChatParityStep,
} from "@opensteer/client/mock";
import { hostApi, type HostApiServerContext } from "@opensteer/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChannelService } from "./channel-service.js";
import { createChannelRpcHandlers, handleChannelCommand } from "./channel-handlers.js";

const fixturePath = fileURLToPath(
  new URL("../../../../packages/client/src/mock/chat-parity.fixture.json", import.meta.url),
);
const tasksOnly: AgentGrant = { scope: "selected", tasks: true, resources: [] };

/** The script: everything a person does with chats and accounts, valid and refused. */
const script: readonly ChatParityStep[] = [
  {
    name: "add a chat for anyone in #team",
    command: {
      kind: "chat.create",
      account: "Workshop",
      conversation: { id: "C-TEAM", name: "#team" },
      senders: "anyone",
      accessMode: "approval-required",
      grant: tasksOnly,
    },
  },
  {
    name: "add #team again, where another chat already answers",
    command: {
      kind: "chat.create",
      account: "Workshop",
      conversation: { id: "C-TEAM", name: "#team" },
      senders: "owner",
      accessMode: "approval-required",
      grant: tasksOnly,
    },
  },
  {
    name: "add direct messages for anyone",
    command: {
      kind: "chat.create",
      account: "Studio",
      conversation: null,
      senders: "anyone",
      accessMode: "approval-required",
      grant: tasksOnly,
    },
  },
  {
    name: "add a chat for anyone that could do everything",
    command: {
      kind: "chat.create",
      account: "Workshop",
      conversation: { id: "C-OPS", name: "#ops" },
      senders: "anyone",
      accessMode: "approval-required",
      grant: { scope: "everything" },
    },
  },
  {
    name: "add a chat without tasks",
    command: {
      kind: "chat.create",
      account: "Workshop",
      conversation: { id: "C-QUIET", name: "#quiet" },
      senders: "owner",
      accessMode: "approval-required",
      grant: { scope: "selected", tasks: false, resources: [] },
    },
  },
  {
    name: "add a chat on a paused account",
    command: {
      kind: "chat.create",
      account: "Studio",
      conversation: null,
      senders: "owner",
      accessMode: "auto",
      grant: tasksOnly,
    },
  },
  {
    name: "add a chat on an account that is connecting",
    command: {
      kind: "chat.create",
      account: "Lab",
      conversation: null,
      senders: "owner",
      accessMode: "approval-required",
      grant: tasksOnly,
    },
  },
  {
    name: "add a chat on an account that needs attention",
    command: {
      kind: "chat.create",
      account: "On-call",
      conversation: null,
      senders: "owner",
      accessMode: "approval-required",
      grant: tasksOnly,
    },
  },
  {
    name: "pause Workshop",
    command: { kind: "account.status", account: "Workshop", status: "paused" },
  },
  {
    name: "resume Workshop",
    command: { kind: "account.status", account: "Workshop", status: "connected" },
  },
  {
    name: "remove On-call",
    command: { kind: "account.status", account: "On-call", status: "revoked" },
  },
  {
    name: "add a chat on the removed account",
    command: {
      kind: "chat.create",
      account: "On-call",
      conversation: { id: "C-PAGER", name: "#pager" },
      senders: "owner",
      accessMode: "approval-required",
      grant: tasksOnly,
    },
  },
  {
    name: "stop a task with nothing running",
    command: { kind: "task.stop", account: "Workshop", chat: "Slack", task: "Book the dentist" },
  },
  {
    name: "stop the running task",
    command: { kind: "task.stop", account: "Workshop", chat: "Slack", task: "Summarize my week" },
  },
];

type Store = Awaited<ReturnType<typeof createStoreFixture>>;

describe("the preview Home answers as the Home does", () => {
  let storeFixture: Store;
  let service: ChannelService;
  beforeAll(async () => {
    storeFixture = await createStoreFixture();
  });
  afterAll(async () => {
    await service?.close();
    await storeFixture?.close();
  });

  it("gives the recorded answer and views for every step of the script", async () => {
    const { database, store } = storeFixture;
    // The person, their Mac and its messaging service.
    const delivery = await storeFixture.createChannelDeliveryFixture("parity", { bridge: false });
    const userId = delivery.fixture.userId;
    const channels = new ChannelStore(database);
    service = new ChannelService({
      channels,
      credentials: {} as never,
      // The messaging runtime is attached, as on a Home a person uses, and carries every
      // provider; what it is told to hold is taken and nothing more is asked of it.
      relay: {
        connectedRunnerIds: () => [testMessagingRunnerId],
        isConnected: () => true,
        supports: () => true,
        request: async () => ({}),
      } as never,
      store,
      bridgeTools: () => ({ callTool: async () => ({}) }) as never,
    });
    const context = { session: { user: { id: userId } } } as unknown as HostApiServerContext;
    // Its accounts, one in each state a person meets: connected, paused, connecting, needing
    // attention. The fixture's own account is removed first, so only these are listed.
    await channels.setConnectionStatus(delivery.configured.connection.id, userId, "revoked");
    const account = async (name: string) => {
      const created = await channels.createConnection({
        account: { displayName: name, externalAccountId: `T-${name}`, routingMode: "dedicated" },
        connection: {
          runnerId: testMessagingRunnerId,
          connectionMethod: "bring-your-own",
          displayName: name,
          externalIdentityId: `U-${name}`,
          externalTenantId: `T-${name}`,
          provider: "slack",
          transportKind: "socket",
        },
        createdBy: userId,
        credential: {
          encryptedPayload: Buffer.from(name),
          encryptionKeyVersion: 1,
          id: createId("credential"),
          name,
          ownerId: userId,
          provider: "channel:slack",
        },
      });
      return created;
    };
    const health = (
      connectionId: Awaited<ReturnType<typeof account>>["connection"]["id"],
      status: "connected" | "needs-attention",
    ) =>
      channels.setRuntimeConnectionHealth({
        connectionId,
        detail: status === "connected" ? null : "Slack says the token was revoked.",
        reason: status === "connected" ? null : "credentials",
        runnerId: testMessagingRunnerId,
        status,
      });
    const workshop = await account("Workshop");
    await health(workshop.connection.id, "connected");
    const studio = await account("Studio");
    await health(studio.connection.id, "connected");
    await channels.setConnectionStatus(studio.connection.id, userId, "paused");
    await account("Lab");
    const onCall = await account("On-call");
    await health(onCall.connection.id, "needs-attention");
    // Workshop's direct messages are a chat with one task at work and one done.
    const connections = new AgentConnectionStore(database);
    const slack = await connections.createBridge({
      userId,
      accountId: workshop.account.id,
      senders: "owner",
      accessMode: "approval-required",
      grant: tasksOnly,
    });
    const running = await storeFixture.startRunFixture("parity-running");
    const done = await storeFixture.createRunFixture("parity-done");
    for (const [thread, title] of [
      [running.thread.id, "Summarize my week"],
      [done.thread.id, "Book the dentist"],
    ] as const)
      await database
        .updateTable("threads")
        .set({ originConnectionId: slack.id, title })
        .where("id", "=", thread)
        .execute();

    const rpc = createChannelRpcHandlers(service);
    const read = async () => {
      const dashboard = await rpc["channels.get"]({}, context);
      if (!dashboard.ok) throw new Error("Messaging could not be read");
      const listed = hostApi["connections.list"].success.parse({
        connections: await connections.list(userId, { includeRevoked: true }),
        endedConnections: [],
      });
      return { channels: dashboard.data, connections: listed.connections };
    };
    // Names as the person sees them, kept once known: a removed account is still named.
    const accountIds = new Map<string, string>();
    const remember = (dashboard: Awaited<ReturnType<typeof read>>["channels"]) => {
      for (const row of dashboard.accounts) accountIds.set(row.displayName, row.id);
    };
    const accountOf = (name: string) => accountIds.get(name) ?? `cha_${crypto.randomUUID()}`;
    const connectionOf = (dashboard: Awaited<ReturnType<typeof read>>["channels"], name: string) =>
      dashboard.accounts.find(({ displayName }) => displayName === name)?.connectionId ??
      `icn_${crypto.randomUUID()}`;
    let current = await read();
    remember(current.channels);
    const seed = chatParityNormalized(current);
    const start = chatParityViews(current.channels, current.connections);
    const steps: ChatParityRecord["steps"][number][] = [];
    for (const step of script) {
      let answer: ChatParityAnswer;
      try {
        const command = step.command;
        if (command.kind === "chat.create") {
          const made = await handleChannelCommand(
            service,
            {
              type: "channel.chat.create",
              accountId: accountOf(command.account) as never,
              conversation: command.conversation,
              senders: command.senders,
              accessMode: command.accessMode,
              grant: command.grant,
              idempotencyKey: createId("command"),
            } as never,
            context,
          );
          answer = {
            ok: true,
            chat: chatParityChat(
              (made as { connection: Parameters<typeof chatParityChat>[0] }).connection,
            ),
          };
        } else if (command.kind === "account.status") {
          await handleChannelCommand(
            service,
            {
              type: "channel.connection.status.set",
              connectionId: connectionOf(current.channels, command.account) as never,
              status: command.status,
              idempotencyKey: createId("command"),
            } as never,
            context,
          );
          // A removed account's chats end; the Home's cleanup worker takes them at once.
          if (command.status === "revoked")
            await store.driveConnectionCleanups({ stopper: { stop: async () => undefined } });
          answer = { ok: true };
        } else {
          const chat = current.connections.find(
            ({ label, bridge }) =>
              label === command.chat && bridge?.accountName === command.account,
          )!;
          const task = chat.bridge?.tasks?.find(({ title }) => title === command.task);
          // A task with nothing running has nothing to stop: both clients say so before asking
          // the Home (`threadStopTarget`). A running one is stopped the way the Home stops it.
          if (!task?.running) throw new Error("This Thread has nothing to stop.");
          const runId = await database
            .selectFrom("runs")
            .select("id")
            .where("threadId", "=", task.id as never)
            .orderBy("createdAt", "desc")
            .executeTakeFirstOrThrow();
          await store.enqueueRunnerControl({
            type: "run.interrupt",
            threadId: task.id as never,
            runId: runId.id,
            requestedBy: userId,
            auditOwnerStop: true,
            idempotencyKey: createId("command"),
          });
          answer = { ok: true };
        }
      } catch (error) {
        answer = chatParityRefusal(error);
      }
      current = await read();
      remember(current.channels);
      steps.push({
        ...step,
        answer,
        views: chatParityViews(current.channels, current.connections),
      });
    }
    const record: ChatParityRecord = { seed, start, steps };
    if (process.env.OPENSTEER_UPDATE_CHAT_PARITY === "1")
      writeFileSync(fixturePath, `${JSON.stringify(record, null, 2)}\n`);
    const recorded = JSON.parse(readFileSync(fixturePath, "utf8")) as ChatParityRecord;
    expect({ start: record.start, steps: record.steps }).toEqual({
      start: recorded.start,
      steps: recorded.steps,
    });
    expect(record.seed).toEqual(recorded.seed);
  });
});
