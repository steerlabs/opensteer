import { describe, expect, it, vi } from "vitest";
import {
  SequenceSchema,
  TeamChannelIdSchema,
  TeamMessageIdSchema,
  createId,
} from "@opensteer/core";
import {
  TeamEntryRefusalReasonSchema,
  TeamConsistentCutSchema,
  type TeamConsistentCut,
} from "@opensteer/protocol";
import {
  MockTeamHost,
  mockTeamId,
  mockTeamUserId,
  mockTeamChannelId,
  type MockTeamSocket,
} from "./mock-team-host.js";
import { TeamSessionClient } from "./team-session-client.js";
import { createMemoryTeamPersistence } from "./persistence.js";
import {
  emptyTeamTimeline,
  reduceTeamCut,
  reduceTeamPage,
  monotonicTeamSidebar,
} from "./reducers.js";

const scope = { teamDeploymentId: mockTeamId, userId: mockTeamUserId };
const channelScope = { kind: "channel", channelId: mockTeamChannelId } as const;
function fixture() {
  const host = new MockTeamHost(),
    persistence = createMemoryTeamPersistence();
  const client = new TeamSessionClient({
    scope,
    persistence,
    rpc: host.rpc,
    connect: host.connect,
  });
  return { host, persistence, client };
}
describe("team synchronization", () => {
  it.each(["Active team membership required", "Team session generation changed"])(
    "removes the partition for an older server's bootstrap refusal: %s",
    async (message) => {
      const code = "forbidden";
      const host = new MockTeamHost();
      const persistence = createMemoryTeamPersistence();
      const client = new TeamSessionClient({
        scope,
        persistence,
        connect: host.connect,
        rpc: new Proxy(host.rpc, {
          get(target, key, receiver) {
            if (key === "team.bootstrap.get")
              return async () => ({
                ok: false,
                error: { code, message, retryable: false },
              });
            return Reflect.get(target, key, receiver);
          },
        }),
      });
      try {
        await client.setDraft(channelScope, "Draft");
        await expect(client.load(false)).rejects.toMatchObject({ code });
        expect(client.getSnapshot().ended).toBe("removed");
        expect(await persistence.load(scope)).toBeNull();
      } finally {
        client.dispose();
        host.dispose();
      }
    },
  );

  it.each([...TeamEntryRefusalReasonSchema.options, "removed"])(
    "preserves the partition unless %s is membership refusal",
    async (reason) => {
      const host = new MockTeamHost(),
        persistence = createMemoryTeamPersistence();
      let refuse = false;
      const client = new TeamSessionClient({
        scope,
        persistence,
        connect: host.connect,
        rpc: new Proxy(host.rpc, {
          get(target, key, receiver) {
            if (key === "team.bootstrap.get" && refuse)
              return async () => ({
                ok: false,
                error: {
                  code:
                    reason === "removed" || reason.startsWith("assertion-")
                      ? "unauthorized"
                      : "forbidden",
                  reason,
                  message: reason,
                  retryable: false,
                },
              });
            return Reflect.get(target, key, receiver);
          },
        }),
      });
      try {
        await client.setDraft(channelScope, "Draft");
        await client.send({
          channelId: mockTeamChannelId,
          threadRootId: null,
          bodyMarkdown: "Pending",
          mentions: [],
          attachmentIds: [],
        });
        const before = await persistence.load(scope);
        refuse = true;
        await expect(client.load(false)).rejects.toMatchObject({ reason });
        if (reason === "not-a-member" || reason === "removed")
          expect(await persistence.load(scope)).toBeNull();
        else expect(await persistence.load(scope)).toEqual(before);
      } finally {
        client.dispose();
        host.dispose();
      }
    },
  );

  it("preserves not-a-member through live session teardown", async () => {
    const host = new MockTeamHost();
    let removed = false;
    const client = new TeamSessionClient({
      scope,
      persistence: createMemoryTeamPersistence(),
      connect: host.connect,
      rpc: new Proxy(host.rpc, {
        get(target, key, receiver) {
          if (key === "team.bootstrap.get" && removed)
            return async () => ({
              ok: false,
              error: {
                code: "forbidden",
                reason: "not-a-member",
                message: "Ask for an invite",
                retryable: false,
              },
            });
          return Reflect.get(target, key, receiver);
        },
      }),
    });
    try {
      await client.load(false);
      removed = true;
      await expect(client.load(false)).rejects.toMatchObject({ reason: "not-a-member" });
      expect(client.getSnapshot()).toMatchObject({
        ended: "removed",
        refusalReason: "not-a-member",
      });
    } finally {
      client.dispose();
      host.dispose();
    }
  });

  it("keeps synchronizing through a newer team server's fields and frame types", async () => {
    const host = new MockTeamHost(),
      sockets: MockTeamSocket[] = [];
    const client = new TeamSessionClient({
      scope,
      persistence: createMemoryTeamPersistence(),
      rpc: host.rpc,
      connect: () => {
        const socket = host.connect();
        sockets.push(socket);
        return socket;
      },
    });
    try {
      await client.load();
      await vi.waitFor(() => expect(client.getSnapshot().connection).toBe("connected"), {
        timeout: 1_000,
      });
      sockets[0]!.deliver({ type: "team.future", detail: { anything: true } });
      sockets[0]!.deliver({
        type: "team.presence",
        people: [{ userId: mockTeamUserId, online: true, lastSeenAt: null }],
        reason: "newer",
      });
      expect(client.getSnapshot()).toMatchObject({
        connection: "connected",
        presence: { [mockTeamUserId]: true },
      });
      expect(sockets).toHaveLength(1);
    } finally {
      client.dispose();
      host.dispose();
    }
  });
  it("refreshes and notifies a dirty channel beyond the loaded sidebar page", async () => {
    const host = new MockTeamHost(),
      notify = vi.fn();
    const template = host.channels.get(mockTeamChannelId)!;
    for (let index = 2; index <= 52; index++) {
      const id = TeamChannelIdSchema.parse(
        `tch_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      );
      host.channels.set(id, { ...template, id, name: `Channel ${index}` });
    }
    const target = TeamChannelIdSchema.parse("tch_00000000-0000-4000-8000-000000000052");
    const client = new TeamSessionClient({
      scope,
      persistence: createMemoryTeamPersistence(),
      rpc: host.rpc,
      connect: host.connect,
      notify,
    });
    try {
      await client.load();
      const cursor = client.getSnapshot().sidebar?.nextCursor;
      expect(client.getSnapshot().sidebar?.channels.some((row) => row.channel.id === target)).toBe(
        false,
      );
      const sent = await host.rpc["commands.dispatch"]({
        type: "team.message.send",
        channelId: target,
        threadRootId: null,
        clientMessageId: crypto.randomUUID(),
        bodyMarkdown: "Hello",
        mentions: [{ userId: mockTeamUserId, kind: "person" }],
        attachmentIds: [],
      });
      expect(sent.ok).toBe(true);
      const before = host.calls.length;
      client.receive({
        type: "team.sidebar.dirty",
        channelIds: [target],
        accessRevision: SequenceSchema.parse("1"),
      });
      await vi.waitFor(() =>
        expect(notify).toHaveBeenCalledWith(
          expect.objectContaining({
            channel: expect.objectContaining({ id: target }),
            unread: true,
          }),
        ),
      );
      expect(host.calls.slice(before)).toEqual(["team.sidebar.get"]);
      expect(client.getSnapshot().sidebar?.nextCursor).toBe(cursor);
    } finally {
      client.dispose();
      host.dispose();
    }
  });
  it("advances by the explicit cut even when overwritten rows skipped sequence numbers", () => {
    const f = fixture();
    let state = emptyTeamTimeline("channel", 1, channelScope);
    const initial = f.host.cut(channelScope, "channel", 1, null);
    state = reduceTeamCut(state, initial);
    const { type: _type, ...base } = initial;
    const resumed: TeamConsistentCut = {
      subscriptionId: base.subscriptionId,
      generation: base.generation,
      scope: base.scope,
      channel: base.channel,
      linkPresence: base.linkPresence,
      type: "resumed",
      throughSeq: SequenceSchema.parse("78"),
      changedRows: [],
      deletedIds: [],
      requests: [],
    };
    state = reduceTeamCut(state, resumed);
    expect(state.throughSeq).toBe("78");
    expect(state.messages).toEqual([]);
    f.host.dispose();
  });
  it("refuses resumed rows without a snapshot and requires a snapshot beyond the row bound", () => {
    const f = fixture();
    const initial = f.host.cut(channelScope, "channel", 1, null);
    const resumed = {
      subscriptionId: initial.subscriptionId,
      generation: initial.generation,
      scope: initial.scope,
      channel: initial.channel,
      linkPresence: initial.linkPresence,
      throughSeq: initial.throughSeq,
      type: "resumed",
      changedRows: [],
      deletedIds: Array.from({ length: 201 }, (_, i) => TeamMessageIdSchema.parse(String(i + 1))),
      requests: [],
    };
    expect(TeamConsistentCutSchema.safeParse(resumed).success).toBe(false);
    expect(() =>
      reduceTeamCut(emptyTeamTimeline("channel", 1, channelScope), {
        ...resumed,
        deletedIds: [],
      } as TeamConsistentCut),
    ).toThrow("cached snapshot");
    f.host.dispose();
  });
  it("ignores a late selection generation and does not advance the stream cursor from a history page", () => {
    const f = fixture();
    const initial = f.host.cut(channelScope, "channel", 1, null);
    const state = reduceTeamCut(emptyTeamTimeline("channel", 1, channelScope), initial);
    expect(reduceTeamCut(state, { ...initial, generation: 2 })).toBe(state);
    const page = {
      channel: initial.channel,
      messages: [],
      hasMore: true,
      throughSeq: SequenceSchema.parse("100"),
    };
    expect(reduceTeamPage(state, page, 2, "before")).toBe(state);
    expect(reduceTeamPage(state, page, 1, "before").throughSeq).toBe(state.throughSeq);
    f.host.dispose();
  });
  it("checks persisted send ids after a lost ack, without creating a second message", async () => {
    const f = fixture();
    try {
      await f.client.load();
      await Promise.resolve();
      f.host.loseNextSendAck = true;
      await f.client.send({
        channelId: mockTeamChannelId,
        threadRootId: null,
        bodyMarkdown: "Hello",
        mentions: [],
        attachmentIds: [],
      });
      await vi.waitFor(() => expect(f.client.getSnapshot().error).toBe("Acknowledgement lost."), {
        timeout: 1000,
      });
      expect(f.host.messages.size).toBe(1);
      expect((await f.persistence.load(scope))?.pending).toHaveLength(1);
      const callsAt = f.host.calls.length;
      await f.client.reconcilePending();
      expect(f.host.calls.slice(callsAt)).toEqual(["team.messages.check"]);
      expect(f.client.getSnapshot().pending).toHaveLength(0);
      expect(f.host.messages.size).toBe(1);
    } finally {
      f.client.dispose();
      f.host.dispose();
    }
  });
  it("keeps read markers monotonic when an older device's sidebar arrives", () => {
    const f = fixture();
    const sidebar = f.host.sidebar(),
      channel = sidebar.channels[0]!;
    const newer = {
      ...sidebar,
      channels: [
        {
          ...channel,
          lastReadMessageId: TeamMessageIdSchema.parse("20"),
          unread: false,
          mentionCount: 0,
        },
      ],
    };
    const older = {
      ...sidebar,
      channels: [
        {
          ...channel,
          lastReadMessageId: TeamMessageIdSchema.parse("10"),
          unread: true,
          mentionCount: 2,
        },
      ],
    };
    expect(monotonicTeamSidebar(newer, older).channels[0]).toMatchObject({
      lastReadMessageId: "20",
      unread: false,
      mentionCount: 0,
    });
    f.host.dispose();
  });
  it("purges only the removed team and viewer's drafts and pending sends", async () => {
    const f = fixture(),
      other = { ...scope, userId: createId("user") },
      otherTeam = { ...scope, teamDeploymentId: createId("deployment") };
    try {
      await f.client.setDraft(channelScope, "Private draft");
      await f.client.send({
        channelId: mockTeamChannelId,
        threadRootId: null,
        bodyMarkdown: "Pending",
        mentions: [],
        attachmentIds: [],
      });
      expect((await f.persistence.load(scope))?.pending).toHaveLength(1);
      await f.persistence.save(otherTeam, { drafts: { otherTeam: "Keep too" }, pending: [] });
      await f.persistence.save(other, { drafts: { other: "Keep" }, pending: [] });
      await f.client.remove();
      expect(await f.persistence.load(scope)).toBeNull();
      expect(await f.persistence.load(other)).toMatchObject({ drafts: { other: "Keep" } });
      expect(await f.persistence.load(otherTeam)).toMatchObject({
        drafts: { otherTeam: "Keep too" },
      });
      expect(f.client.getSnapshot().drafts).toEqual({});
      expect(f.client.getSnapshot().pending).toEqual([]);
    } finally {
      f.client.dispose();
      f.host.dispose();
    }
  });
  it("spreads reconnects and backs off a socket that keeps failing", async () => {
    vi.useFakeTimers();
    const host = new MockTeamHost(),
      sockets: MockTeamSocket[] = [];
    const client = new TeamSessionClient({
      scope,
      persistence: createMemoryTeamPersistence(),
      rpc: host.rpc,
      connect: () => {
        const socket = host.connect();
        sockets.push(socket);
        return socket;
      },
      random: () => 0.5,
    });
    const bootstraps = () => host.calls.filter((name) => name === "team.bootstrap.get").length;
    const reconnectsAfter = async (delayMs: number) => {
      const count = sockets.length,
        revalidated = bootstraps();
      await vi.advanceTimersByTimeAsync(delayMs - 1);
      expect(sockets).toHaveLength(count);
      expect(bootstraps()).toBe(revalidated);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(count + 1);
      expect(bootstraps()).toBe(revalidated + 1);
      await vi.advanceTimersByTimeAsync(0);
      expect(client.getSnapshot().connection).toBe("connected");
    };
    try {
      await client.load();
      await vi.advanceTimersByTimeAsync(0);
      for (const delayMs of [225, 450, 900]) {
        sockets.at(-1)!.close();
        await reconnectsAfter(delayMs);
      }
      sockets.at(-1)!.deliver({ type: "team.cut" });
      expect(client.getSnapshot().connection).toBe("offline");
      await reconnectsAfter(1_800);
      await vi.advanceTimersByTimeAsync(30_000);
      sockets.at(-1)!.close();
      await reconnectsAfter(225);
    } finally {
      client.dispose();
      host.dispose();
      vi.useRealTimers();
    }
  });
});
