import { describe, expect, it, vi } from "vitest";
import {
  OpensteerError,
  SequenceSchema,
  TeamChannelIdSchema,
  TeamMessageIdSchema,
  createId,
} from "@opensteer/core";
import { MockTeamHost, mockTeamId, mockTeamUserId, mockTeamChannelId } from "./mock-team-host.js";
import { TeamSessionClient } from "./team-session-client.js";
import { createMemoryTeamPersistence } from "./persistence.js";
import { TeamTransportRegistry } from "./transport-registry.js";

const scope = { teamDeploymentId: mockTeamId, userId: mockTeamUserId };
const channelScope = { kind: "channel", channelId: mockTeamChannelId } as const;
const sendInput = (bodyMarkdown: string) => ({
  channelId: mockTeamChannelId,
  threadRootId: null,
  bodyMarkdown,
  mentions: [],
  attachmentIds: [],
});
function fixture() {
  const host = new MockTeamHost(),
    persistence = createMemoryTeamPersistence();
  const client = new TeamSessionClient({
    scope,
    persistence,
    rpc: host.rpc,
    connect: host.connect,
  });
  return {
    host,
    persistence,
    client,
    stop() {
      client.dispose();
      host.dispose();
    },
  };
}
async function seed(host: MockTeamHost, count: number, rootId: string | null = null) {
  for (let index = 0; index < count; index++) {
    const result = await host.rpc["commands.dispatch"]({
      type: "team.message.send",
      clientMessageId: crypto.randomUUID(),
      ...sendInput(`match ${index}`),
      threadRootId: rootId ? TeamMessageIdSchema.parse(rootId) : null,
    });
    if (!result.ok) throw new Error(result.error.message);
  }
}

describe("team session lifecycle", () => {
  it("purges an open removed member on socket close, but keeps another viewer's partition", async () => {
    const f = fixture(),
      other = { ...scope, userId: createId("user") };
    try {
      await f.client.load();
      await f.client.setDraft(channelScope, "Secret draft");
      await f.persistence.save(other, { drafts: { other: "Keep" }, pending: [] });
      const read = f.host.read.bind(f.host);
      vi.spyOn(f.host, "read").mockImplementation((name, input) => {
        if (name === "team.bootstrap.get")
          throw new OpensteerError({ code: "forbidden", message: "Membership removed" });
        return read(name, input);
      });
      f.host.dispose();
      await vi.waitFor(() => expect(f.client.getSnapshot().ended).toBe("removed"), {
        timeout: 1000,
      });
      await vi.waitFor(async () => expect(await f.persistence.load(scope)).toBeNull(), {
        timeout: 1000,
      });
      expect(f.client.getSnapshot()).toMatchObject({
        bootstrap: null,
        sidebar: null,
        channel: null,
        pending: [],
        drafts: {},
      });
      expect(await f.persistence.load(other)).toMatchObject({ drafts: { other: "Keep" } });
      expect(f.host.socketCount).toBe(0);
    } finally {
      f.stop();
    }
  });

  it("retains drafts and cached content across ordinary network loss", async () => {
    const f = fixture();
    try {
      await f.client.load();
      await f.client.setDraft(channelScope, "Keep through offline");
      const read = f.host.read.bind(f.host);
      vi.spyOn(f.host, "read").mockImplementation((name, input) => {
        if (name === "team.bootstrap.get") throw new Error("Network unavailable");
        return read(name, input);
      });
      f.host.dispose();
      await vi.waitFor(
        () => expect(f.host.calls.filter((name) => name === "team.bootstrap.get")).toHaveLength(2),
        { timeout: 1000 },
      );
      expect(f.client.getSnapshot()).toMatchObject({
        ended: null,
        connection: "offline",
        drafts: { [JSON.stringify(["channel", mockTeamChannelId])]: "Keep through offline" },
      });
      expect(f.client.getSnapshot().bootstrap).not.toBeNull();
    } finally {
      f.stop();
    }
  });

  it("ends the old viewer when the authenticated team login changes", async () => {
    const f = fixture();
    try {
      await f.client.load();
      await f.client.setDraft(channelScope, "Old viewer only");
      const read = f.host.read.bind(f.host);
      vi.spyOn(f.host, "read").mockImplementation((name, input) =>
        name === "team.bootstrap.get"
          ? Promise.resolve({
              ...f.host.bootstrap,
              member: { ...f.host.bootstrap.member, userId: createId("user") },
            })
          : read(name, input),
      );
      f.host.dispose();
      await vi.waitFor(() => expect(f.client.getSnapshot().ended).toBe("viewer-changed"), {
        timeout: 1000,
      });
      await vi.waitFor(async () => expect(await f.persistence.load(scope)).toBeNull(), {
        timeout: 1000,
      });
    } finally {
      f.stop();
    }
  });

  it("replaces a registry session and its partition when joining as a different viewer", async () => {
    const persistence = createMemoryTeamPersistence();
    const hosts: MockTeamHost[] = [];
    const registry = new TeamTransportRegistry("desktop", (next) => {
      const host = new MockTeamHost({ userId: next.userId as typeof mockTeamUserId });
      hosts.push(host);
      return { scope: next, persistence, rpc: host.rpc, connect: host.connect };
    });
    try {
      const first = await registry.join(scope);
      await first.setDraft(channelScope, "Old account");
      const nextScope = { ...scope, userId: createId("user") };
      const second = await registry.join(nextScope);
      expect(second).not.toBe(first);
      expect(first.getSnapshot().ended).toBe("removed");
      expect(await persistence.load(scope)).toBeNull();
      expect(second.getSnapshot().bootstrap?.member.userId).toBe(nextScope.userId);
    } finally {
      registry.dispose();
      for (const host of hosts) host.dispose();
    }
  });

  it("persists terminal send failures and sends the next channel's queued message", async () => {
    const f = fixture();
    try {
      const otherChannel = TeamChannelIdSchema.parse(createId("teamChannel"));
      f.host.channels.set(otherChannel, {
        ...f.host.channels.get(mockTeamChannelId)!,
        id: otherChannel,
      });
      const refusedId = await f.client.send(sendInput("Refused"));
      await f.client.send({ ...sendInput("Allowed"), channelId: otherChannel });
      const read = f.host.read.bind(f.host);
      vi.spyOn(f.host, "read").mockImplementation((name, input) => {
        if (
          name === "commands.dispatch" &&
          (input as { channelId?: string }).channelId === mockTeamChannelId
        )
          throw new OpensteerError({ code: "forbidden", message: "Posting revoked" });
        return read(name, input);
      });
      await f.client.load();
      await vi.waitFor(() => expect(f.client.getSnapshot().pending).toHaveLength(1), {
        timeout: 1000,
      });
      expect(f.client.getSnapshot().pending[0]).toMatchObject({ failure: "Posting revoked" });
      expect((await f.persistence.load(scope))?.pending[0]?.failure).toBe("Posting revoked");
      expect([...f.host.messages.values()].map((row) => row.bodyMarkdown)).toEqual(["Allowed"]);
      await f.client.editPending(refusedId, "Revised");
      expect(f.client.getSnapshot().pending).toEqual([]);
      expect(Object.values(f.client.getSnapshot().drafts)).toEqual(["Revised"]);
    } finally {
      f.stop();
    }
  });

  it("retains an oversized draft across reload and refuses it before admission", async () => {
    const f = fixture();
    try {
      const text = "😀".repeat(5000);
      await f.client.setDraft(channelScope, text);
      await expect(f.client.send(sendInput(text))).rejects.toThrow();
      expect(f.client.getSnapshot().pending).toEqual([]);
      const restored = new TeamSessionClient({
        scope,
        persistence: f.persistence,
        rpc: f.host.rpc,
        connect: f.host.connect,
      });
      try {
        await restored.load(false);
        expect(Object.values(restored.getSnapshot().drafts)).toEqual([text]);
      } finally {
        restored.dispose();
      }
    } finally {
      f.stop();
    }
  });

  it("opens a long thread with its independent root, pages replies, and retains the root at the cap", async () => {
    const f = fixture();
    try {
      await seed(f.host, 1);
      await seed(f.host, 350, "1");
      await f.client.load();
      f.client.selectChannel(mockTeamChannelId);
      f.client.selectThread(mockTeamChannelId, TeamMessageIdSchema.parse("1"));
      await vi.waitFor(
        () =>
          expect(f.client.getSnapshot().thread?.messages.some((row) => row.id === "1")).toBe(true),
        { timeout: 1000 },
      );
      expect(f.client.getSnapshot().thread?.messages).toHaveLength(51);
      await f.client.loadPage("thread", "before");
      expect(f.client.getSnapshot().thread?.messages).toHaveLength(101);
      for (let index = 0; index < 5; index++) await f.client.loadPage("thread", "before");
      expect(f.client.getSnapshot().thread?.messages).toHaveLength(300);
      expect(f.client.getSnapshot().thread?.messages[0]?.id).toBe("1");
      const state = f.client.getSnapshot().thread!;
      f.client.receive({
        type: "team.cut",
        cut: f.host.cut(state.scope, state.subscriptionId, state.generation, null),
      });
      expect(f.client.getSnapshot().thread?.messages[0]?.id).toBe("1");
    } finally {
      f.stop();
    }
  });

  it("lands on an old channel root and an old reply from cold and open channels", async () => {
    const f = fixture();
    try {
      await seed(f.host, 110);
      await seed(f.host, 110, "1");
      await f.client.load();
      const root = await f.client.landMessage(mockTeamChannelId, TeamMessageIdSchema.parse("2"));
      expect(root?.id).toBe("2");
      expect(f.client.getSnapshot().channel?.messages.some((row) => row.id === "2")).toBe(true);
      const reply = await f.client.landMessage(mockTeamChannelId, TeamMessageIdSchema.parse("112"));
      expect(reply?.threadRootId).toBe("1");
      expect(f.client.getSnapshot().thread?.messages.some((row) => row.id === "112")).toBe(true);
      expect(f.client.getSnapshot().thread?.messages[0]?.id).toBe("1");
      expect(f.client.getSnapshot().channel?.throughSeq).toBe(SequenceSchema.parse("220"));
    } finally {
      f.stop();
    }
  });

  it("loads the 51st readable sidebar channel on the same socket", async () => {
    const f = fixture();
    try {
      const template = f.host.channels.get(mockTeamChannelId)!;
      for (let index = 2; index <= 51; index++) {
        const id = TeamChannelIdSchema.parse(
          `tch_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        );
        f.host.channels.set(id, { ...template, id });
      }
      await f.client.load();
      expect(f.client.getSnapshot().sidebar?.channels).toHaveLength(50);
      await f.client.loadMoreSidebar();
      expect(f.client.getSnapshot().sidebar?.channels).toHaveLength(51);
      expect(f.client.getSnapshot().sidebar?.nextCursor).toBeNull();
      expect(f.host.socketCount).toBe(1);
    } finally {
      f.stop();
    }
  });
  it("leaves through Host membership removal and keeps the session when the last owner is refused", async () => {
    const f = fixture();
    try {
      await f.client.load();
      await f.client.setDraft(channelScope, "Retain if refused");
      await expect(f.client.leave()).rejects.toThrow("last owner");
      expect(f.client.getSnapshot().bootstrap).not.toBeNull();
      expect(Object.values(f.client.getSnapshot().drafts)).toEqual(["Retain if refused"]);
      f.host.members.push({ ...f.host.bootstrap.member, userId: createId("user") });
      await f.client.leave();
      expect(f.host.bootstrap.member.state).toBe("removed");
      expect(f.client.getSnapshot().ended).toBe("removed");
      expect(await f.persistence.load(scope)).toBeNull();
      expect(f.host.socketCount).toBe(0);
    } finally {
      f.stop();
    }
  });

  it("pages a saved search and discards a late page after the query changes", async () => {
    const f = fixture();
    try {
      await seed(f.host, 75);
      await f.client.load();
      await f.client.search({ query: "match" });
      expect(f.client.getSnapshot().search?.results).toHaveLength(50);
      await f.client.loadMoreSearch();
      expect(f.client.getSnapshot().search?.results).toHaveLength(75);
      expect(f.client.getSnapshot().search?.hasMore).toBe(false);
      await f.client.search({ query: "match" });
      const read = f.host.read.bind(f.host),
        gate = Promise.withResolvers<void>();
      vi.spyOn(f.host, "read").mockImplementation(async (name, input) => {
        if (name === "team.search" && (input as { input: { before?: string } }).input.before)
          await gate.promise;
        return read(name, input);
      });
      const page = f.client.loadMoreSearch();
      await f.client.search({ query: "not found" });
      gate.resolve();
      await page;
      expect(f.client.getSnapshot().search?.results).toEqual([]);
    } finally {
      f.stop();
    }
  });
  it("keeps an authorized anchor when the first live cut arrives after its RPC page", async () => {
    const f = fixture();
    try {
      await seed(f.host, 120);
      await f.client.load(false);
      await f.client.landMessage(mockTeamChannelId, TeamMessageIdSchema.parse("2"));
      f.client.connect();
      await vi.waitFor(() => expect(f.client.getSnapshot().connection).toBe("connected"), {
        timeout: 1000,
      });
      expect(f.client.getSnapshot().channel?.messages.some((row) => row.id === "2")).toBe(true);
    } finally {
      f.stop();
    }
  });

  it("uses the authoritative mention total before every channel page is loaded", async () => {
    const f = fixture();
    try {
      const template = f.host.channels.get(mockTeamChannelId)!;
      for (let index = 2; index <= 51; index++) {
        const id = TeamChannelIdSchema.parse(
          `tch_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        );
        f.host.channels.set(id, { ...template, id });
      }
      const target = TeamChannelIdSchema.parse("tch_00000000-0000-4000-8000-000000000051");
      const message = f.host.post({
        channelId: target,
        bodyMarkdown: "Mention",
        mentions: [{ userId: f.host.userId, kind: "person" }],
      });
      await f.client.load();
      expect(f.client.getSnapshot().sidebar?.channels).toHaveLength(50);
      expect(f.client.getSnapshot().sidebar?.totalMentionCount).toBe(1);
      await f.client.loadMoreSidebar();
      expect(f.client.getSnapshot().sidebar?.totalMentionCount).toBe(1);
      await f.client.markRead(target, message.id);
      expect(f.client.getSnapshot().sidebar?.totalMentionCount).toBe(0);
    } finally {
      f.stop();
    }
  });

  it("pages thread matches on the Host before limiting results", async () => {
    const f = fixture();
    try {
      await seed(f.host, 1);
      await seed(f.host, 60, "1");
      await seed(f.host, 100);
      await f.client.load();
      await f.client.search({ query: "match", threadsOnly: true });
      expect(f.client.getSnapshot().search?.results).toHaveLength(50);
      expect(
        f.client.getSnapshot().search?.results.every((row) => row.message.threadRootId === "1"),
      ).toBe(true);
      await f.client.loadMoreSearch();
      expect(f.client.getSnapshot().search?.results).toHaveLength(60);
      expect(f.client.getSnapshot().search?.results.at(-1)?.message.id).toBe("2");
    } finally {
      f.stop();
    }
  });
  it("clears a revoked channel on revalidation while keeping membership and other channel drafts", async () => {
    const f = fixture();
    try {
      const otherId = TeamChannelIdSchema.parse(createId("teamChannel"));
      f.host.channels.set(otherId, { ...f.host.channels.get(mockTeamChannelId)!, id: otherId });
      await f.client.load();
      f.client.selectChannel(mockTeamChannelId);
      await f.client.setDraft(channelScope, "Revoked channel text");
      await f.client.setDraft({ kind: "channel", channelId: otherId }, "Keep other channel");
      const read = f.host.read.bind(f.host);
      vi.spyOn(f.host, "read").mockImplementation((name, input) => {
        if (name === "team.bootstrap.get")
          return Promise.resolve({
            ...f.host.bootstrap,
            sidebar: {
              ...f.host.sidebar(),
              accessRevision: "2",
              channels: f.host
                .sidebar()
                .channels.filter((row) => row.channel.id !== mockTeamChannelId),
            },
          });
        if (name === "team.channel.get")
          throw new OpensteerError({ code: "forbidden", message: "Channel access removed" });
        return read(name, input);
      });
      f.host.dispose();
      await vi.waitFor(() => expect(f.client.getSnapshot().channel).toBeNull(), { timeout: 1000 });
      expect(f.client.getSnapshot().ended).toBeNull();
      expect(f.client.getSnapshot().bootstrap?.member.userId).toBe(mockTeamUserId);
      expect(Object.values(f.client.getSnapshot().drafts)).toEqual(["Keep other channel"]);
      expect(f.client.getSnapshot().contentGeneration).toBeGreaterThan(0);
    } finally {
      f.stop();
    }
  });
});
