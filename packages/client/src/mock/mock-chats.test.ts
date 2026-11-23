import { describe, expect, it, vi } from "vitest";
import { mutationIdempotencyKey } from "../host/index.js";
import { defaultThreadPlacement } from "../host/thread-placement.js";
import { MockHostClient } from "./mock-host-client.js";
import { mockConnectedAgents } from "./mock-connected-agents.js";

/** The chats preview agrees with itself and follows the Home's rules for chats. */
describe("the chats preview", () => {
  it("shows each chat as its account is, with who is you as Messaging says, beside an ordinary connected agent", () => {
    const scene = mockConnectedAgents("chats");
    const dashboard = scene.channels!;
    expect(scene.connections.some((row) => row.bridge === undefined)).toBe(true);
    for (const chat of scene.connections) {
      if (!chat.bridge || chat.state === "stopped") continue;
      const connection = dashboard.connections.find(
        ({ id }) => id === chat.bridge!.channelConnectionId,
      )!;
      expect([chat.label, chat.state]).toEqual([
        chat.label,
        connection.status === "connected" ? "active" : "paused",
      ]);
      const me = dashboard.me?.find(({ accountId }) => accountId === chat.bridge!.accountId);
      expect([chat.label, chat.bridge.me?.displayName ?? null]).toEqual([
        chat.label,
        me?.displayName ?? null,
      ]);
    }
  });

  it("adds a chat on a paused account paused, saying what becomes of what is sent to it", async () => {
    const client = new MockHostClient({ latencyMs: 0, ...mockConnectedAgents("chats-empty") });
    try {
      const dashboard = await client.rpc["channels.get"]({});
      if (!dashboard.ok) throw new Error("No messaging accounts");
      const messages = dashboard.data.accounts.find(({ provider }) => provider === "imessage")!;
      const listener = vi.fn();
      client.subscribeConnectionsChanged(listener);
      const added = await client.dispatch({
        type: "channel.chat.create",
        accountId: messages.id,
        conversation: null,
        senders: "owner",
        accessMode: "approval-required",
        grant: { scope: "selected", tasks: true, resources: [] },
        idempotencyKey: mutationIdempotencyKey("channel-chat"),
      });
      const chat = (added as { connection: { state: string; bridge: unknown } }).connection;
      expect(chat.state).toBe("paused");
      expect(chat.bridge).toMatchObject({ pausedBy: "you", pausedMessages: "kept" });
      // Lists that show connected agents read again.
      expect(listener).toHaveBeenCalled();
    } finally {
      client.dispose();
    }
  });

  it("tells connected-agent lists when pausing an account pauses its chats", async () => {
    const client = new MockHostClient({ latencyMs: 0, ...mockConnectedAgents("chats") });
    try {
      const dashboard = await client.rpc["channels.get"]({});
      if (!dashboard.ok) throw new Error("No messaging accounts");
      const workshop = dashboard.data.connections.find(
        ({ displayName }) => displayName === "Workshop",
      )!;
      const listener = vi.fn();
      client.subscribeConnectionsChanged(listener);
      await client.dispatch({
        type: "channel.connection.status.set",
        connectionId: workshop.id,
        status: "paused",
        idempotencyKey: mutationIdempotencyKey("channel-status"),
      });
      expect(listener).toHaveBeenCalled();
    } finally {
      client.dispose();
    }
  });

  it("answers Check again with what the account reports", async () => {
    const client = new MockHostClient({ latencyMs: 0, ...mockConnectedAgents("chats") });
    try {
      const dashboard = await client.rpc["channels.get"]({});
      if (!dashboard.ok) throw new Error("No messaging accounts");
      const byName = (name: string) =>
        dashboard.data.connections.find(({ displayName }) => displayName === name)!.id;
      const healthy = await client.rpc["channel.connection.check"]({
        connectionId: byName("Workshop"),
      });
      expect(healthy).toMatchObject({ ok: true, data: { ready: true, issues: [] } });
      const broken = await client.rpc["channel.connection.check"]({
        connectionId: byName("On-call"),
      });
      expect(broken).toMatchObject({
        ok: true,
        // Its provider no longer accepts the token it holds, and says so.
        data: { ready: false, issues: [{ message: "The provider did not accept these tokens." }] },
      });
    } finally {
      client.dispose();
    }
  });

  it("reads a resumed account as Connecting, as the Home does, until its messaging service answers", async () => {
    const client = new MockHostClient({ latencyMs: 0, ...mockConnectedAgents("chats") });
    try {
      const status = async (name: string) => {
        const read = await client.rpc["channels.get"]({});
        if (!read.ok) throw new Error("No messaging accounts");
        return read.data.connections.find(({ displayName }) => displayName === name)!;
      };
      const messages = await status("Messages on Studio Mac");
      await client.dispatch({
        type: "channel.connection.status.set",
        connectionId: messages.id,
        status: "connected",
        idempotencyKey: mutationIdempotencyKey("channel-status"),
      });
      expect(await status("Messages on Studio Mac")).toMatchObject({
        status: "pending",
        statusDetail: "Reconnecting to messaging provider",
      });
      // Nothing here stands in for the messaging service: it reads so until that answers.
      expect((await status("Messages on Studio Mac")).status).toBe("pending");
    } finally {
      client.dispose();
    }
  });

  it("previews a Home whose accounts and connected agents can't be read", async () => {
    const client = new MockHostClient({ latencyMs: 0, ...mockConnectedAgents("chats-unreadable") });
    try {
      expect((await client.rpc["channels.get"]({})).ok).toBe(false);
      expect((await client.rpc["connections.list"]({})).ok).toBe(false);
    } finally {
      client.dispose();
    }
  });

  it("previews remote access through Connect as a Home reports it, readable by its own rules", async () => {
    const client = new MockHostClient({ latencyMs: 0, ...mockConnectedAgents("chats") });
    try {
      client.connectRemoteAccess("https://alex.connect.opensteer.invalid");
      const read = await client.rpc["personal.remoteAccess.get"]({});
      expect(read).toMatchObject({
        ok: true,
        data: { access: { mode: "connect", accountLink: { state: "active" } } },
      });
    } finally {
      client.dispose();
    }
  });

  it("keeps a refusal's code, reason and words at its dispatch boundary: connection.update", async () => {
    const client = new MockHostClient({ latencyMs: 0, ...mockConnectedAgents("chats") });
    try {
      const listed = await client.rpc["connections.list"]({ includeRevoked: true });
      if (!listed.ok) throw new Error("No connections");
      const team = listed.data.connections.find(({ label }) => label === "Slack · #team")!;
      const stale = await client.rpc["commands.dispatch"]({
        type: "connection.update",
        connectionId: team.id,
        expectedRevision: (team.grantRevision ?? 1) + 5,
        accessMode: "auto",
        idempotencyKey: mutationIdempotencyKey("parity"),
      } as never);
      expect(stale).toMatchObject({ ok: false, error: { code: "conflict" } });
      const refused = await client.rpc["commands.dispatch"]({
        type: "connection.update",
        connectionId: team.id,
        expectedRevision: team.grantRevision ?? 1,
        grant: { scope: "everything" },
        idempotencyKey: mutationIdempotencyKey("parity"),
      } as never);
      expect(refused).toMatchObject({
        ok: false,
        error: { code: "bad_request", reason: "bridge-anyone-grant" },
      });
      // The same through the client's own dispatch, as a screen sends it.
      await expect(
        client.dispatch({
          type: "connection.update",
          connectionId: team.id,
          expectedRevision: team.grantRevision ?? 1,
          grant: { scope: "everything" },
          idempotencyKey: mutationIdempotencyKey("parity"),
        } as never),
      ).rejects.toMatchObject({ code: "bad_request", reason: "bridge-anyone-grant" });
      await expect(
        client.dispatch({
          type: "connection.update",
          connectionId: team.id,
          expectedRevision: (team.grantRevision ?? 1) + 5,
          accessMode: "auto",
          idempotencyKey: mutationIdempotencyKey("parity"),
        } as never),
      ).rejects.toMatchObject({ code: "conflict" });
    } finally {
      client.dispose();
    }
  });

  it("marks a disconnected chat's tasks as endedOrigin: 'chat' and refuses new messages with the Home's exact sentence", async () => {
    const client = new MockHostClient({ latencyMs: 0, ...mockConnectedAgents("chats") });
    try {
      const chatId = "mcn_00000000-0000-4000-8000-0000000000c1";
      const taskId = "thr_00000000-0000-4000-8000-0000000000c1";
      expect(client.getSnapshot().threads.find(({ id }) => id === taskId)?.endedOrigin).toBeNull();
      await client.dispatch({
        type: "connection.revoke",
        connectionId: chatId,
        idempotencyKey: mutationIdempotencyKey("revoke-chat"),
      });
      expect(client.getSnapshot().threads.find(({ id }) => id === taskId)?.endedOrigin).toBe(
        "chat",
      );
      await expect(
        client.dispatch({
          type: "thread.sendMessage",
          threadId: taskId as never,
          content: [{ type: "text", text: "Should be refused" }],
          delivery: "queue",
          idempotencyKey: mutationIdempotencyKey("send-ended-chat"),
        }),
      ).rejects.toMatchObject({
        code: "forbidden",
        message:
          "This chat ended, so this task takes no new messages. Start a new task, or add the chat again on Messaging.",
      });
    } finally {
      client.dispose();
    }
  });

  it("cleans outside names at every MockHostClient entrance matching the Home", async () => {
    const dirty = "Work\u202E\n👩\u200D💻 می\u200Cخواهم";
    const cleaned = "Work 👩\u200D💻 می\u200Cخواهم";
    const client = new MockHostClient({
      latencyMs: 0,
      ...mockConnectedAgents("chats-empty"),
      messagingProvider: {
        inspect: () => ({
          ready: true,
          capabilities: [],
          issues: [],
          identity: {
            connectionDisplayName: dirty,
            accountDisplayName: dirty,
            externalAccountId: "T-DIRTY",
            externalIdentityId: "U-DIRTY",
            handle: dirty,
            metadata: {},
          },
        }),
      },
    });
    try {
      const snapshot = client.getSnapshot();
      const placement = defaultThreadPlacement(snapshot.environments, snapshot.harnesses)!;
      const created = await client.createThread({
        accessMode: "approval-required",
        environmentId: placement.environmentId,
        harnessInstanceId: placement.harnessInstanceId,
        modelSelection: placement.modelSelection,
        title: dirty,
      });
      expect(created.title).toBe(cleaned);

      const renamed = await client.renameThread(created.id, `Next\u202E\n${cleaned}`);
      expect(renamed.title).toBe(`Next ${cleaned}`);

      const profileResult = await client.dispatch({
        type: "browser.profile.create",
        idempotencyKey: mutationIdempotencyKey("dirty-profile"),
        input: { name: dirty },
      });
      if (profileResult.type !== "browser.profile.create") throw new Error("Profile mismatch");
      expect(profileResult.profile.name).toBe(cleaned);

      const channel = await client.dispatch({
        type: "channel.connection.create",
        provider: "slack",
        credentials: { botToken: "xoxb-test", appToken: "xapp-test" },
        routingMode: "dedicated",
        idempotencyKey: mutationIdempotencyKey("dirty-channel"),
      });
      if (channel.type !== "channel.connection.create") throw new Error("Channel mismatch");
      expect(channel.connection.displayName).toBe(cleaned);
      expect(channel.account.displayName).toBe(cleaned);
      expect(channel.account.handle).toBe(cleaned);

      const machine = snapshot.machines[0]!;
      await client.dispatch({
        type: "machine.rename",
        machineId: machine.id,
        name: dirty,
        idempotencyKey: mutationIdempotencyKey("dirty-machine"),
      });
      expect(client.getSnapshot().machines.find(({ id }) => id === machine.id)?.name).toBe(cleaned);

      const localEnroll = await client.dispatch({
        type: "runner.enrollment.createLocal",
        allowedModules: ["browser"],
        name: dirty,
        idempotencyKey: mutationIdempotencyKey("dirty-local"),
      });
      if (localEnroll.type !== "runner.enrollment.createLocal") throw new Error("Local mismatch");
      expect(
        client.getSnapshot().machines.find(({ id }) => id === localEnroll.enrollmentId)?.name,
      ).toBe(cleaned);

      const phoneEnroll = await client.dispatch({
        type: "runner.enrollment.createPhone",
        name: dirty,
        profile: "iphone",
        idempotencyKey: mutationIdempotencyKey("dirty-phone"),
      });
      if (phoneEnroll.type !== "runner.enrollment.createPhone") throw new Error("Phone mismatch");
      expect(
        client.getSnapshot().machines.find(({ id }) => id === phoneEnroll.enrollmentId)?.name,
      ).toBe(cleaned);

      const renamedHarness = await client.dispatch({
        type: "harness.rename",
        environmentId: placement.environmentId,
        harnessInstanceId: placement.harnessInstanceId,
        name: dirty,
        idempotencyKey: mutationIdempotencyKey("dirty-harness"),
      });
      if (renamedHarness.type !== "harness.rename") throw new Error("Harness mismatch");
      expect(renamedHarness.harness.name).toBe(cleaned);

      const trigCreated = await client.dispatch({
        type: "trigger.create",
        idempotencyKey: mutationIdempotencyKey("dirty-trig-cmd"),
        input: {
          anchorThreadId: created.id,
          name: dirty,
          script: {
            interpreter: null,
            text: "console.log('ok')",
          },
          source: {
            kind: "schedule",
            schedule: { expression: "0 9 * * *", kind: "cron", timezone: "UTC" },
          },
        },
      });
      if (trigCreated.type !== "trigger.create") throw new Error("Trigger mismatch");
      expect(trigCreated.trigger.name).toBe(cleaned);

      const trigUpdated = await client.dispatch({
        type: "trigger.update",
        idempotencyKey: mutationIdempotencyKey("dirty-trig-upd"),
        triggerId: trigCreated.trigger.id,
        input: {
          expectedRevisionId: trigCreated.revision.id,
          name: `Updated\u202E\n${cleaned}`,
        },
      });
      if (trigUpdated.type !== "trigger.update") throw new Error("Trigger update mismatch");
      expect(trigUpdated.trigger.name).toBe(`Updated ${cleaned}`);
    } finally {
      client.dispose();
    }
  });
});
