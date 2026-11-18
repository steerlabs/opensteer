import { createHttpHostApiClient } from "../host/host-api-client.js";
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
  MockTeamSocket,
} from "./mock-team-host.js";
import { TeamSessionClient } from "./team-session-client.js";
import { teamScopeKey } from "./reducers.js";
import { teamAskRefusalNotice } from "./ask-status.js";
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
  it("keeps a sent message confirmed while showing scoped agent refusals", async () => {
    const f = fixture();
    const read = f.host.read.bind(f.host);
    const target = createId("user");
    vi.spyOn(f.host, "read").mockImplementation(async (name, input) => {
      const result = await read(name, input);
      if (name === "commands.dispatch" && (input as { type: string }).type === "team.message.send")
        return {
          ...(result as object),
          askOutcomes: [{ ownerUserId: target, outcome: "no-link" }],
        };
      return result;
    });
    try {
      await f.client.load();
      await vi.waitFor(
        () =>
          expect(f.client.getSnapshot().connection, "Team session never connected").toBe(
            "connected",
          ),
        {
          timeout: 1000,
        },
      );
      await f.client.send({
        channelId: mockTeamChannelId,
        threadRootId: null,
        bodyMarkdown: "@maya-agent help",
        mentions: [],
        attachmentIds: [],
      });
      await vi.waitFor(
        () =>
          expect(
            f.client.getSnapshot().sendNotices[teamScopeKey(channelScope)],
            "Agent refusal never reached the composer",
          ).toEqual([{ ownerUserId: target, outcome: "no-link" }]),
        { timeout: 1000 },
      );
      expect(f.client.getSnapshot().pending).toEqual([]);
      expect(
        [...f.host.messages.values()].some(
          (message) => message.bodyMarkdown === "@maya-agent help",
        ),
      ).toBe(true);
      expect(
        teamAskRefusalNotice(
          f.client.getSnapshot().sendNotices[teamScopeKey(channelScope)]!,
          () => "Maya",
        ),
      ).toContain("Maya’s agent");
      expect(teamAskRefusalNotice([], () => "Maya")).toBeNull();
      await f.client.remove();
      expect(f.client.getSnapshot().sendNotices).toEqual({});
    } finally {
      f.client.dispose();
      f.host.dispose();
    }
  });

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

  it("says why a thread could not open, and a newly selected thread starts without that failure", async () => {
    const f = fixture();
    try {
      await f.client.load();
      await vi.waitFor(() => expect(f.client.getSnapshot().connection).toBe("connected"), {
        timeout: 1000,
      });
      f.client.selectThread(mockTeamChannelId, TeamMessageIdSchema.parse("404"));
      await vi.waitFor(
        () =>
          expect(f.client.getSnapshot().error).toBe(
            "Couldn't load this thread. It may have been deleted, or you don't have access.",
          ),
        { timeout: 1000 },
      );
      const root = f.host.post({ channelId: mockTeamChannelId, bodyMarkdown: "root" });
      f.client.selectThread(mockTeamChannelId, root.id);
      expect(f.client.getSnapshot().error).toBeNull();
      await vi.waitFor(() => expect(f.client.getSnapshot().thread?.messages[0]?.id).toBe(root.id), {
        timeout: 1000,
      });
      expect(f.client.getSnapshot().error).toBeNull();
    } finally {
      f.client.dispose();
      f.host.dispose();
    }
  });

  it("reconciles recipient state across devices, snapshot and resume without inferring from requests", async () => {
    const f = fixture();
    const rootId = TeamMessageIdSchema.parse("1");
    try {
      await f.client.load();
      await vi.waitFor(() => expect(f.client.getSnapshot().connection).toBe("connected"), {
        timeout: 1000,
      });
      f.client.selectChannel(mockTeamChannelId);
      await f.client.setAgentRecipient(mockTeamChannelId, rootId, true);
      await f.client.setAgentRecipient(mockTeamChannelId, rootId, true);
      expect(f.client.getSnapshot().agentRecipients).toEqual([
        { channelId: mockTeamChannelId, rootId, enabled: true, version: "1" },
      ]);
      const cut = f.host.cut(
        channelScope,
        "channel",
        f.client.getSnapshot().channel!.generation,
        null,
      );
      f.client.receive({
        type: "team.agent.recipient",
        recipient: {
          channelId: mockTeamChannelId,
          rootId,
          enabled: false,
          version: SequenceSchema.parse("2"),
        },
      });
      expect(f.client.getSnapshot().agentRecipients[0]?.enabled).toBe(false);
      f.client.receive({ type: "team.cut", cut });
      expect(f.client.getSnapshot().agentRecipients[0]?.enabled).toBe(false);
      f.client.receive({
        type: "team.agent.recipient",
        recipient: { ...cut.agentRecipients[0]!, enabled: true },
      });
      expect(f.client.getSnapshot().agentRecipients[0]?.enabled).toBe(false);
      f.host.agentRecipients.set(`${mockTeamChannelId}:${rootId}`, {
        channelId: mockTeamChannelId,
        rootId,
        enabled: false,
        version: SequenceSchema.parse("2"),
      });
      const resumed = f.host.cut(channelScope, "channel", cut.generation, cut.throughSeq);
      expect(resumed.type).toBe("resumed");
      f.client.receive({ type: "team.cut", cut: resumed });
      expect(f.client.getSnapshot().agentRecipients).toEqual([
        { channelId: mockTeamChannelId, rootId, enabled: false, version: "2" },
      ]);
      f.client.receive({ type: "team.cut", cut: { ...cut, generation: cut.generation + 1 } });
      expect(f.client.getSnapshot().agentRecipients[0]?.enabled).toBe(false);
      await f.client.setAgentRecipient(mockTeamChannelId, rootId, true);
      expect(f.client.getSnapshot().agentRecipients[0]).toMatchObject({
        enabled: true,
        version: "3",
      });
    } finally {
      f.client.dispose();
      f.host.dispose();
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
          expect.any(Function),
        ),
      );
      const current = notify.mock.calls[0]![1] as () => boolean;
      expect(current()).toBe(true);
      expect(client.getSnapshot().sidebar?.nextCursor).toBe(cursor);
      client.dispose();
      expect(current()).toBe(false);
      expect(host.calls.slice(before)).toEqual(["team.sidebar.get"]);
      expect(client.getSnapshot().sidebar).toBeNull();
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
      agentRecipients: base.agentRecipients,
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
      agentRecipients: initial.agentRecipients,
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
      await vi.waitFor(
        () => expect(f.client.getSnapshot().error).toBe("Couldn't confirm this change."),
        {
          timeout: 1000,
        },
      );
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

describe("member names", () => {
  it("moves a name only forward and never takes role or state from a rename", async () => {
    const f = fixture();
    await f.client.load(false);
    const self = f.client.getSnapshot().bootstrap!.member;
    const renamed = (displayName: string, nameRevision: number) => ({
      ...self,
      role: "member" as const,
      state: "removed" as const,
      displayName,
      nameRevision,
    });
    f.client.receive({ type: "team.member.updated", member: renamed("Maya Chen", 5) });
    // Renames publish after independent commits, so an older one can arrive last.
    f.client.receive({ type: "team.member.updated", member: renamed("Maya", 4) });
    const snapshot = f.client.getSnapshot();
    expect(snapshot.memberUpdates?.[self.userId]).toMatchObject({
      displayName: "Maya Chen",
      nameRevision: 5,
    });
    expect(snapshot.bootstrap!.member).toEqual({
      ...self,
      displayName: "Maya Chen",
      nameRevision: 5,
    });
  });
});

describe("a team server swap", () => {
  function swapFixture() {
    vi.useFakeTimers();
    const host = new MockTeamHost(),
      persistence = createMemoryTeamPersistence(),
      sockets: MockTeamSocket[] = [];
    let failing = false;
    let refusal: { code: string; reason: string } | null = null;
    const client = new TeamSessionClient({
      scope,
      persistence,
      connect: () => {
        const socket = host.connect();
        sockets.push(socket);
        if (failing) {
          // Never opens: the server is out of reach.
          socket.readyState = 2;
          queueMicrotask(() => socket.close(1006));
        }
        return socket;
      },
      rpc: new Proxy(host.rpc, {
        get(target, key, receiver) {
          if (key === "team.bootstrap.get" && refusal) {
            const { code, reason } = refusal;
            return async () => {
              host.calls.push(key);
              return { ok: false, error: { code, reason, message: "Refused", retryable: false } };
            };
          }
          return Reflect.get(target, key, receiver);
        },
      }),
      random: () => 0.5,
    });
    const bootstraps = () => host.calls.filter((name) => name === "team.bootstrap.get").length;
    return {
      host,
      persistence,
      sockets,
      client,
      bootstraps,
      fail: (value: boolean) => (failing = value),
      refuse: (value: { code: string; reason: string } | null) => (refusal = value),
      dispose: () => {
        client.dispose();
        host.dispose();
        vi.useRealTimers();
      },
    };
  }

  it("reads as out of reach once, five seconds after the first close, until a socket opens", async () => {
    const f = swapFixture();
    try {
      await f.client.load();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.client.getSnapshot()).toMatchObject({
        connection: "connected",
        resumedGeneration: 0,
      });

      f.sockets.at(-1)!.close(1012);
      expect(f.client.getSnapshot()).toMatchObject({ connection: "offline", unreachable: false });
      await vi.advanceTimersByTimeAsync(225);
      expect(f.client.getSnapshot()).toMatchObject({
        connection: "connected",
        unreachable: false,
        resumedGeneration: 1,
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(f.client.getSnapshot().unreachable, "A finished swap still read as out of reach").toBe(
        false,
      );

      f.fail(true);
      const before = f.sockets.length;
      f.sockets.at(-1)!.close(1006);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(f.sockets.length - before, "Failed attempts never retried").toBeGreaterThanOrEqual(3);
      expect(f.client.getSnapshot().unreachable).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.client.getSnapshot().unreachable).toBe(true);
      expect(f.client.getSnapshot().resumedGeneration).toBe(1);

      f.fail(false);
      await vi.advanceTimersByTimeAsync(12_000);
      expect(f.client.getSnapshot()).toMatchObject({
        connection: "connected",
        unreachable: false,
        resumedGeneration: 2,
      });

      // Disconnected on purpose, nothing reaches the team until connecting again.
      f.client.disconnect();
      expect(f.client.connection.getSnapshot().phase).toBe("idle");
      f.client.connect();
      expect(f.client.getSnapshot().unreachable).toBe(false);
    } finally {
      f.dispose();
    }
  });

  it("reconnects from a planned restart without asking who the viewer is", async () => {
    const f = swapFixture();
    try {
      await f.client.load();
      await vi.advanceTimersByTimeAsync(0);
      const asked = f.bootstraps(),
        opened = f.sockets.length;
      f.sockets.at(-1)!.close(1012);
      await vi.advanceTimersByTimeAsync(224);
      expect(f.sockets).toHaveLength(opened);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.sockets).toHaveLength(opened + 1);
      expect(f.bootstraps()).toBe(asked);
    } finally {
      f.dispose();
    }
  });

  it("asks at once why a socket was refused and ends a removed viewer's session", async () => {
    const f = swapFixture();
    try {
      await f.client.load();
      await vi.advanceTimersByTimeAsync(0);
      await f.client.setDraft(channelScope, "Draft");
      const asked = f.bootstraps();
      f.sockets.at(-1)!.close(1008);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.bootstraps(), "A refused socket waited before revalidating").toBe(asked + 1);
      expect(f.client.getSnapshot().connection).toBe("offline");

      await vi.advanceTimersByTimeAsync(225);
      expect(f.client.getSnapshot().connection).toBe("connected");
      f.refuse({ code: "forbidden", reason: "removed" });
      f.sockets.at(-1)!.close(1008);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.client.getSnapshot()).toMatchObject({ ended: "removed", refusalReason: "removed" });
      expect(await f.persistence.load(scope)).toBeNull();
    } finally {
      f.dispose();
    }
  });

  it.each([
    ["api-version-mismatch", "update-app"],
    ["client-too-old", "update-app"],
    ["host-too-old", "update-server"],
  ] as const)(
    "shows a %s refusal at once, keeps drafts, and clears it once the team accepts",
    async (reason, shown) => {
      const f = swapFixture();
      try {
        await f.client.load();
        await vi.advanceTimersByTimeAsync(0);
        await f.client.setDraft(channelScope, "Draft");
        f.refuse({ code: "conflict", reason });
        f.sockets.at(-1)!.close(1008);
        await vi.advanceTimersByTimeAsync(0);
        expect(f.client.getSnapshot()).toMatchObject({
          versionRefusal: shown,
          unreachable: false,
          ended: null,
        });
        expect(f.client.getSnapshot().drafts[teamScopeKey(channelScope)]).toBe("Draft");
        expect(await f.persistence.load(scope)).not.toBeNull();

        f.refuse(null);
        f.client.connection.retry();
        await vi.advanceTimersByTimeAsync(0);
        expect(f.client.getSnapshot()).toMatchObject({
          versionRefusal: null,
          connection: "connected",
        });
      } finally {
        f.dispose();
      }
    },
  );

  it("rereads member names that moved while the socket was away", async () => {
    const f = swapFixture();
    try {
      await f.client.load();
      await vi.advanceTimersByTimeAsync(0);
      const lists = () => f.host.calls.filter((name) => name === "team.members.list").length;
      expect(lists(), "A first connect reread the directory").toBe(0);
      const self = f.client.getSnapshot().bootstrap!.member;
      f.host.members[0] = { ...self, displayName: "Maya Chen", nameRevision: 3 };
      f.sockets.at(-1)!.close(1012);
      await vi.advanceTimersByTimeAsync(225);
      expect(lists()).toBe(1);
      expect(f.client.getSnapshot().memberUpdates?.[self.userId]).toMatchObject({
        displayName: "Maya Chen",
        nameRevision: 3,
      });
      expect(f.client.getSnapshot().bootstrap!.member.displayName).toBe("Maya Chen");

      f.sockets.at(-1)!.close(1012);
      await vi.advanceTimersByTimeAsync(450);
      expect(f.client.getSnapshot().connection).toBe("connected");
      expect(lists(), "Unmoved names were read again").toBe(1);

      // A reread that fails is tried at the next catch-up even though the revision is unchanged.
      const read = f.host.read.bind(f.host);
      const failing = vi.spyOn(f.host, "read").mockImplementation(async (name, input) => {
        if (name === "team.members.list") throw new Error("Unavailable");
        return read(name, input);
      });
      f.host.members[0] = { ...self, displayName: "Maya C.", nameRevision: 4 };
      f.sockets.at(-1)!.close(1012);
      await vi.advanceTimersByTimeAsync(900);
      expect(lists()).toBe(2);
      failing.mockRestore();
      f.sockets.at(-1)!.close(1012);
      await vi.advanceTimersByTimeAsync(1_800);
      expect(lists()).toBe(3);
      expect(f.client.getSnapshot().bootstrap!.member.displayName).toBe("Maya C.");
    } finally {
      f.dispose();
    }
  });
});

it("evicts a team's admitted content on 401 headers before a stalled body", async () => {
  vi.useFakeTimers();
  const host = new MockTeamHost(),
    persistence = createMemoryTeamPersistence();
  const rpc = createHttpHostApiClient({
    baseUrl: new URL("https://team.example"),
    kind: "team",
    onAuthenticationRequired: () => {},
    fetch: async (input) => {
      if (String(input).includes("team.bootstrap.get"))
        return Response.json(await host.rpc["team.bootstrap.get"]({}));
      return new Response(new ReadableStream({ start() {} }), { status: 401 });
    },
  });
  const client = new TeamSessionClient({ scope, rpc, persistence, connect: host.connect });
  try {
    await client.load();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getSnapshot().bootstrap).not.toBeNull();
    const reading = client.rpc["team.members.list"]({});
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getSnapshot()).toMatchObject({
      bootstrap: null,
      sidebar: null,
      ended: "sign-in",
    });
    expect(client.connection.getSnapshot().scope).toBeNull();
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(reading).resolves.toMatchObject({
      ok: false,
      error: { code: "unauthorized", retryable: false },
    });
  } finally {
    client.dispose();
    host.dispose();
    vi.useRealTimers();
  }
});

describe("team attempt fencing", () => {
  it("admits the current channel when selection changes before the first cut", async () => {
    vi.useFakeTimers();
    const host = new MockTeamHost();
    const nextChannelId = createId("teamChannel");
    host.channels.set(nextChannelId, {
      ...host.channels.get(mockTeamChannelId)!,
      id: nextChannelId,
    });
    const subscriptions = new Map<string, { subscriptionId: string; generation: number }>();
    let socket!: MockTeamSocket;
    const client = new TeamSessionClient({
      scope,
      persistence: createMemoryTeamPersistence(),
      rpc: host.rpc,
      connect: () =>
        (socket = new MockTeamSocket((frame) => {
          if (frame.type === "team.subscribe" && frame.scope)
            subscriptions.set(frame.scope.channelId, frame);
        })),
    });
    try {
      client.selectChannel(mockTeamChannelId);
      await client.load();
      await vi.advanceTimersByTimeAsync(0);
      const old = subscriptions.get(mockTeamChannelId)!;
      client.selectChannel(nextChannelId);
      const current = subscriptions.get(nextChannelId)!;
      socket.deliver({ type: "team.sidebar", sidebar: host.bootstrap.sidebar });
      socket.deliver({
        type: "team.cut",
        cut: host.cut(channelScope, old.subscriptionId, old.generation, null),
      });
      expect(client.connection.getSnapshot().phase).toBe("connecting");
      socket.deliver({
        type: "team.cut",
        cut: host.cut(
          { kind: "channel", channelId: nextChannelId },
          current.subscriptionId,
          current.generation,
          null,
        ),
      });
      expect(client.connection.getSnapshot().phase).toBe("ready");
    } finally {
      client.dispose();
      host.dispose();
      vi.useRealTimers();
    }
  });

  it("abandons an open team socket that never delivers the initial cut", async () => {
    vi.useFakeTimers();
    const host = new MockTeamHost();
    let socket!: MockTeamSocket;
    const client = new TeamSessionClient({
      scope,
      persistence: createMemoryTeamPersistence(),
      rpc: host.rpc,
      connect: () => (socket = new MockTeamSocket(() => {})),
    });
    try {
      client.selectChannel(mockTeamChannelId);
      await client.load();
      await vi.advanceTimersByTimeAsync(0);
      socket.deliver({ type: "team.sidebar", sidebar: host.bootstrap.sidebar });
      expect(client.connection.getSnapshot().phase).toBe("connecting");
      await vi.advanceTimersByTimeAsync(15_000);
      expect(socket.readyState).toBe(3);
      expect(client.connection.getSnapshot().phase).toBe("recovering");
    } finally {
      client.dispose();
      host.dispose();
      vi.useRealTimers();
    }
  });

  it.each(["superseded", "current"] as const)(
    "preserves recovery when a %s refused socket's HTTP check gets a 503",
    async (visit) => {
      vi.useFakeTimers();
      const host = new MockTeamHost();
      const sockets: MockTeamSocket[] = [];
      const temporary = {
        ok: false as const,
        error: {
          code: "internal" as const,
          reason: "proxy-unavailable",
          retryable: true,
          message: "Unavailable",
        },
      };
      const held = Promise.withResolvers<typeof temporary>();
      const boot = host.rpc["team.bootstrap.get"];
      const read = vi
        .fn(boot)
        .mockImplementationOnce(boot)
        .mockImplementationOnce(() => held.promise);
      const rpc = new Proxy(host.rpc, {
        get: (target, key, receiver) =>
          key === "team.bootstrap.get" ? read : Reflect.get(target, key, receiver),
      });
      let networkChanged!: (state: "online", path: "changed") => void;
      const client = new TeamSessionClient({
        scope,
        persistence: createMemoryTeamPersistence(),
        rpc,
        connect: () => {
          const socket = host.connect();
          sockets.push(socket);
          return socket;
        },
        lifecycle: {
          getSnapshot: () => ({ network: "online", visibility: "foreground" }),
          onNetworkChange: (listener) => {
            networkChanged = listener;
            return () => {};
          },
          onForeground: () => () => {},
          onBackground: () => () => {},
        },
      });
      try {
        await client.load();
        await vi.advanceTimersByTimeAsync(0);
        expect(client.connection.getSnapshot().phase).toBe("ready");
        sockets[0]!.close(1008);
        expect(read).toHaveBeenCalledTimes(2);
        if (visit === "superseded") {
          networkChanged("online", "changed");
          await vi.advanceTimersByTimeAsync(0);
          expect(sockets).toHaveLength(2);
          expect(client.connection.getSnapshot().phase).toBe("ready");
        }
        held.resolve(temporary);
        await vi.advanceTimersByTimeAsync(0);
        if (visit === "superseded") {
          expect(sockets[1]!.readyState).toBe(1);
          expect(client.connection.getSnapshot().phase).toBe("ready");
        } else {
          expect(client.connection.getSnapshot().phase).toBe("recovering");
          await vi.advanceTimersByTimeAsync(300);
          expect(client.connection.getSnapshot().phase).toBe("ready");
        }
      } finally {
        client.dispose();
        host.dispose();
        vi.useRealTimers();
      }
    },
  );
});
