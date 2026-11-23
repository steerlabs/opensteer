/**
 * The preview Home answers as the Home does. One script of what a person does with chats and
 * messaging accounts is run here against a real Home (its store, `ChannelService` and the command
 * and read handlers the API serves), and each answer and the views it leaves are compared with
 * `packages/client/src/mock/chat-parity.fixture.json`. The mock's unit test replays the same
 * script from that fixture and must give the same answers. A Home that changes its answer fails
 * here; a mock that differs fails there. To record a change on purpose:
 * `OPENSTEER_UPDATE_CHAT_PARITY=1 pnpm test:integration apps/host/src/channels/chat-parity.integration.test.ts`.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createId, type AgentGrant } from "@opensteer/core";
import { AgentConnectionStore, ChannelStore } from "@opensteer/database";
import { createStoreFixture, testMessagingRunnerId } from "@opensteer/database/test-support/store";
import {
  chatParityChat,
  chatParityNormalized,
  chatParityProvider,
  chatParityRefusal,
  chatParityViews,
  type ChatParityAnswer,
  type ChatParityRecord,
  type ChatParityStep,
} from "@opensteer/client/mock";
import { hostApi, type HostApiServerContext } from "@opensteer/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChannelService } from "./channel-service.js";
import { CredentialService } from "../identity/credential-service.js";
import { createChannelRpcHandlers, handleChannelCommand } from "./channel-handlers.js";
import { handleConnectionCommand } from "../mcp/connections/connection-routes.js";

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
  {
    name: "change #team's safety mode and give it a plugin",
    command: {
      kind: "connection.update",
      account: "Workshop",
      chat: "Slack · #team",
      revision: "current",
      accessMode: "auto",
      grant: {
        scope: "selected",
        tasks: true,
        resources: [
          {
            kind: "plugin",
            target: { kind: "installed", pluginId: "plugin_team_notes" },
            access: "read",
          },
        ],
      },
    },
  },
  {
    name: "give #team a grant a chat for anyone may not hold",
    command: {
      kind: "connection.update",
      account: "Workshop",
      chat: "Slack · #team",
      revision: "current",
      grant: { scope: "everything" },
    },
  },
  {
    name: "save #team from a page read before the last save (two devices)",
    command: {
      kind: "connection.update",
      account: "Workshop",
      chat: "Slack · #team",
      revision: "stale",
      accessMode: "full-access",
    },
  },
  {
    name: "rename #team",
    command: {
      kind: "connection.update",
      account: "Workshop",
      chat: "Slack · #team",
      revision: "current",
      label: "Team room",
    },
  },
  {
    name: "edit the chat whose account was removed",
    command: {
      kind: "connection.update",
      account: "On-call",
      chat: "Slack",
      revision: "current",
      accessMode: "auto",
    },
  },
  {
    name: "remove Studio's chat before disconnecting it",
    command: { kind: "connection.remove", account: "Studio", chat: "Slack" },
  },
  {
    name: "disconnect Studio's paused chat",
    command: { kind: "connection.revoke", account: "Studio", chat: "Slack" },
  },
  {
    // Disconnect is never refused: a second one (another device, a retry) is answered done and
    // finishes stopping what the first began.
    name: "disconnect Studio's chat again, from another device",
    command: { kind: "connection.revoke", account: "Studio", chat: "Slack" },
  },
  {
    name: "remove Studio's chat after disconnecting it",
    command: { kind: "connection.remove", account: "Studio", chat: "Slack" },
  },
  {
    name: "link me on the removed account",
    command: { kind: "me.link", account: "On-call" },
  },
  {
    name: "check the removed account",
    command: { kind: "account.check", account: "On-call" },
  },
  {
    name: "check an account that does not exist",
    command: { kind: "account.check", account: "Nowhere" },
  },
  {
    name: "check Workshop",
    command: { kind: "account.check", account: "Workshop" },
  },
  {
    name: "link me on Workshop",
    command: { kind: "me.link", account: "Workshop" },
  },
  {
    name: "pause the removed account",
    command: { kind: "account.status", account: "On-call", status: "paused" },
  },
  {
    name: "add iMessage with tokens",
    command: { kind: "account.create", provider: "imessage", token: "Parity" },
  },
  {
    name: "add a Slack account with its tokens",
    command: { kind: "account.create", provider: "slack", token: "Parity" },
  },
  {
    name: "add a Slack account with tokens its provider refuses",
    command: { kind: "account.create", provider: "slack", token: "" },
  },
  {
    name: "add Slack through a computer",
    command: { kind: "account.computer.create", provider: "slack" },
  },
  {
    name: "add iMessage through this Mac",
    command: { kind: "account.computer.create", provider: "imessage" },
  },
  {
    name: "replace the removed account's tokens",
    command: { kind: "credentials.replace", account: "On-call", token: "On-call" },
  },
  {
    name: "replace Workshop's tokens",
    command: { kind: "credentials.replace", account: "Workshop", token: "Workshop" },
  },
  {
    name: "replace Workshop's tokens with another workspace's",
    command: { kind: "credentials.replace", account: "Workshop", token: "Elsewhere" },
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
    // The Home's own credential service: what it refuses before asking a provider is compared.
    const credentials = new CredentialService({ key: randomBytes(32), store });
    await credentials.initialize();
    service = new ChannelService({
      channels,
      credentials,
      // The messaging runtime is attached, as on a Home a person uses, and carries every
      // provider; what it is told to hold is taken and nothing more is asked of it.
      relay: {
        connectedRunnerIds: () => [testMessagingRunnerId],
        selectRunner: () => testMessagingRunnerId,
        // It carries no computer app: this test has no Mac.
        capabilities: () => [],
        isConnected: () => true,
        supports: () => true,
        // The provider it reaches is the script's own (`chatParityProvider`), as the preview's is.
        request: async (_runnerId: string, method: string, params: unknown) =>
          method === "connection.inspect"
            ? chatParityProvider.inspect(params as Parameters<typeof chatParityProvider.inspect>[0])
            : {},
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
        // Sealed as the Home seals them: its tokens name its workspace to the provider.
        credential: await credentials.prepare({
          name,
          ownerId: userId,
          provider: "channel:slack",
          secrets: { botToken: `xoxb-${name}`, appToken: `xapp-${name}` },
        }),
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
      for (const row of dashboard.accounts) {
        accountIds.set(row.displayName, row.id);
        connectionIds.set(row.displayName, row.connectionId);
      }
    };
    const connectionIds = new Map<string, string>();
    // An account never seen is one that does not exist: a well-formed id the Home never made.
    const accountOf = (name: string) => accountIds.get(name) ?? `cha_${crypto.randomUUID()}`;
    const connectionOf = (_dashboard: unknown, name: string) =>
      connectionIds.get(name) ?? `con_${crypto.randomUUID()}`;
    // A chat by the name the person sees it under, on its account, in the views just read.
    const chatOf = (command: { readonly chat: string; readonly account: string }) =>
      current.connections.find(
        ({ label, bridge }) => label === command.chat && bridge?.accountName === command.account,
      );
    const owner = {
      session: { id: "parity-session", user: { id: userId, disabledAt: null } },
    } as unknown as HostApiServerContext;
    // What the Home does after a Disconnect: its cleanup worker takes the chat at once.
    const cleanups = {
      stopLineage: async () => {
        await store.driveConnectionCleanups({ stopper: { stop: async () => undefined } });
      },
    };
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
        } else if (command.kind === "task.stop") {
          const chat = chatOf(command)!;
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
            idempotencyKey: createId("command"),
          });
          answer = { ok: true };
        } else if (command.kind === "connection.update") {
          const chat = chatOf(command)!;
          const revision = chat.grantRevision ?? 1;
          const { connection } = (await handleConnectionCommand(
            { store: connections } as never,
            {
              type: "connection.update",
              connectionId: chat.id,
              expectedRevision: command.revision === "current" ? revision : revision - 1,
              ...(command.accessMode !== undefined ? { accessMode: command.accessMode } : {}),
              ...(command.grant !== undefined ? { grant: command.grant } : {}),
              ...(command.label !== undefined ? { label: command.label } : {}),
              idempotencyKey: createId("command"),
            } as never,
            owner,
            cleanups,
          )) as { connection: Parameters<typeof chatParityChat>[0] };
          answer = { ok: true, chat: chatParityChat(connection) };
        } else if (command.kind === "connection.revoke" || command.kind === "connection.remove") {
          await handleConnectionCommand(
            { store: connections } as never,
            {
              type: command.kind,
              connectionId: chatOf(command)!.id,
              idempotencyKey: createId("command"),
            } as never,
            owner,
            cleanups,
          );
          answer = { ok: true };
        } else if (command.kind === "me.link") {
          // The code is new each time: only that one was made is compared.
          await handleChannelCommand(
            service,
            {
              type: "channel.me.link",
              accountId: accountOf(command.account) as never,
              idempotencyKey: createId("command"),
            } as never,
            context,
          );
          answer = { ok: true };
        } else if (command.kind === "account.check") {
          const checked = await rpc["channel.connection.check"](
            { connectionId: connectionOf(current.channels, command.account) as never },
            context,
          );
          answer = checked.ok
            ? { ok: true }
            : {
                ok: false,
                code: checked.error.code,
                reason: checked.error.reason ?? null,
                message: checked.error.message,
              };
        } else if (command.kind === "account.create") {
          await handleChannelCommand(
            service,
            {
              type: "channel.connection.create",
              provider: command.provider,
              routingMode: "dedicated",
              credentials: { botToken: `xoxb-${command.token}`, appToken: "xapp-parity" },
              idempotencyKey: createId("command"),
            } as never,
            context,
          );
          answer = { ok: true };
        } else if (command.kind === "account.computer.create") {
          await handleChannelCommand(
            service,
            {
              type: "channel.connection.computer.create",
              provider: command.provider,
              runnerId: testMessagingRunnerId,
              idempotencyKey: createId("command"),
            } as never,
            context,
          );
          answer = { ok: true };
        } else {
          await handleChannelCommand(
            service,
            {
              type: "channel.connection.credentials.replace",
              connectionId: connectionOf(current.channels, command.account) as never,
              credentials: { botToken: `xoxb-${command.token}`, appToken: "xapp-parity" },
              idempotencyKey: createId("command"),
            } as never,
            context,
          );
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
