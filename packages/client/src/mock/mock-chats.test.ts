import { describe, expect, it, vi } from "vitest";
import { mutationIdempotencyKey } from "../host/index.js";
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
        data: { ready: false, issues: [{ message: "Slack says the token was revoked." }] },
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
});
