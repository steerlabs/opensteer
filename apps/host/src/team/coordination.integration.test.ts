import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sql } from "kysely";
import { createId } from "@opensteer/core";
import { teamApiVersion } from "@opensteer/deployment-authority";
import { createDatabase } from "@opensteer/database";
import { createTeamKnowledgeFixture } from "@opensteer/database/test-support/team-knowledge";
import { TeamAccessStore, emptyTeamAccessEffects } from "@opensteer/database/team-access";
import { TeamBus } from "@opensteer/database/team-bus";
import { TeamChatStore } from "@opensteer/database/team-chat";
import { TeamEndpointLinks } from "../team-link-endpoint/links.js";
import { TeamRealtimeHub } from "./realtime.js";

let f: Awaited<ReturnType<typeof createTeamKnowledgeFixture>>;
let databaseB: ReturnType<typeof createDatabase>;
let a: TeamAccessStore, b: TeamAccessStore;
let busA: TeamBus, busB: TeamBus;
let chatA: TeamChatStore, chatB: TeamChatStore;
let hubA: TeamRealtimeHub, hubB: TeamRealtimeHub;
const cleanups: (() => void)[] = [];
beforeEach(async () => {
  f = await createTeamKnowledgeFixture();
  databaseB = createDatabase({
    connectionString: f.databaseUrl,
    applicationName: "coordination-b",
  });
  a = new TeamAccessStore(f.database);
  b = new TeamAccessStore(databaseB);
  await Promise.all([a.initialize(), b.initialize()]);
  busA = new TeamBus(f.database);
  busB = new TeamBus(databaseB);
  cleanups.push(a.attach(busA), b.attach(busB));
  const identity = { teamId: f.deploymentId, teamName: "Acme" };
  chatA = new TeamChatStore(a, identity);
  chatB = new TeamChatStore(b, identity);
  cleanups.push(chatA.attach(busA), chatB.attach(busB));
  hubA = new TeamRealtimeHub(a, chatA, busA, "a");
  hubB = new TeamRealtimeHub(b, chatB, busB, "b");
  cleanups.push(busB.onResync(() => hubB.resync()));
  await Promise.all([busA.start(), busB.start()]);
});
afterEach(async () => {
  hubA.close();
  hubB.close();
  for (const cleanup of cleanups.splice(0)) cleanup();
  await Promise.all([busA.close(), busB.close()]);
  await databaseB.destroy();
  await f.database.destroy();
  await f.close();
});
const wait = { timeout: 5000, interval: 20 };
it("closes another copy's peer and refuses a buffered read after committed revocation", async () => {
  const userId = await f.member("Removed");
  const close = vi.fn();
  hubB.connect({ kind: "human", userId }, { send: () => true, close });
  const revision = await b.current();
  const writerClose = vi.fn();
  a.onRevoke(writerClose);
  await a.mutate(async (t) => {
    await t
      .updateTable("teamMembers")
      .set({ state: "removed" })
      .where("userId", "=", userId)
      .execute();
    return { value: undefined, effects: { ...emptyTeamAccessEffects, users: [userId] } };
  });
  expect(writerClose).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(close).toHaveBeenCalledWith(1008, "Team membership changed"), wait);
  const deliver = vi.fn();
  await expect(
    b.handoff(
      revision,
      async () => {
        await databaseB.transaction().execute((t) => b.member(t, userId));
        return true;
      },
      deliver,
    ),
  ).rejects.toMatchObject({ code: "forbidden" });
  expect(deliver).not.toHaveBeenCalled();
});
it("closes all local transports when retained access changes have a gap", async () => {
  const stale = new TeamAccessStore(databaseB);
  await stale.initialize();
  const close = vi.fn();
  stale.onCloseAll(close);
  for (let i = 0; i < 2; i++)
    await a.mutate(async () => ({ value: undefined, effects: emptyTeamAccessEffects }));
  await sql`delete from team_access_changes where revision < (select max(revision) from team_access_changes)`.execute(
    f.database,
  );
  await stale.current();
  expect(close).toHaveBeenCalledWith(1012);
});
it("shares presence and typing across copies", async () => {
  const channel = await chatA.create(
    { kind: "human", userId: f.userId },
    { id: createId("teamChannel"), name: "general", kind: "public", peopleOnly: false, access: [] },
  );
  const frames: unknown[] = [];
  const actor = { kind: "human" as const, userId: f.userId };
  const p = hubA.connect(actor, { send: () => true, close: () => {} });
  const q = hubB.connect(actor, {
    send: (frame) => {
      frames.push(frame);
      return true;
    },
    close: () => {},
  });
  const subscribe = {
    type: "team.subscribe",
    teamApiVersion,
    subscriptionId: "channel",
    generation: 1,
    sidebar: true,
    scope: { kind: "channel", channelId: channel.id },
    sinceSeq: null,
  };
  await p.receive(subscribe);
  await q.receive(subscribe);
  await p.receive({ type: "team.presence", visible: true, watchedUserIds: [] });
  expect(await hubB.visible(f.userId, channel.id)).toBe(true);
  await p.receive({ type: "team.typing", channelId: channel.id, rootId: null, typing: true });
  await vi.waitFor(
    () =>
      expect(frames).toContainEqual({
        type: "team.typing",
        channelId: channel.id,
        rootId: null,
        userIds: [f.userId],
      }),
    wait,
  );
  p.close();
  await vi.waitFor(async () => expect(await hubB.visible(f.userId, channel.id)).toBe(false), wait);
});
it("redraws a name another copy changed for people connected here", async () => {
  const frames: { type: string; member?: { userId: string; displayName: string } }[] = [];
  hubB.connect(
    { kind: "human", userId: f.userId },
    {
      send: (frame) => {
        frames.push(frame as (typeof frames)[number]);
        return true;
      },
      close: () => {},
    },
  );
  await f.database
    .updateTable("users")
    .set({ displayName: "Maya Renamed" })
    .where("id", "=", f.userId)
    .execute();
  await vi.waitFor(
    () =>
      expect(frames).toContainEqual(
        expect.objectContaining({
          type: "team.member.updated",
          member: expect.objectContaining({ userId: f.userId, displayName: "Maya Renamed" }),
        }),
      ),
    wait,
  );
});
it("resyncs a missed channel change and full sidebar after losing LISTEN", async () => {
  const actor = { kind: "human" as const, userId: f.userId };
  const channel = await chatA.create(actor, {
    id: createId("teamChannel"),
    name: "general",
    kind: "public",
    peopleOnly: false,
    access: [],
  });
  const frames: { type: string }[] = [];
  const peer = hubB.connect(actor, {
    send: (frame) => {
      frames.push(frame);
      return true;
    },
    close: () => {},
  });
  await peer.receive({
    type: "team.subscribe",
    teamApiVersion,
    subscriptionId: "channel",
    generation: 1,
    sidebar: true,
    scope: { kind: "channel", channelId: channel.id },
    sinceSeq: null,
  });
  const sidebars = frames.filter((f) => f.type === "team.sidebar").length;
  const cuts = frames.filter((f) => f.type === "team.cut").length;
  await sql`select pg_terminate_backend(pid) from pg_stat_activity where datname=current_database() and application_name='coordination-b' and query='listen opensteer_team'`.execute(
    f.database,
  );
  await chatA.send(actor, {
    channelId: channel.id,
    threadRootId: null,
    clientMessageId: randomUUID(),
    bodyMarkdown: "Recovered",
    mentions: [],
    attachmentIds: [],
  });
  await vi.waitFor(() => {
    expect(frames.filter((f) => f.type === "team.sidebar").length).toBeGreaterThan(sidebars);
    expect(frames.filter((f) => f.type === "team.cut").length).toBeGreaterThan(cuts);
  }, wait);
});
it("fences a superseded link's write and keeps replacement presence during cleanup", async () => {
  const linkId = await f.link(f.userId);
  const linksA = new TeamEndpointLinks(f.database, a, "Acme"),
    linksB = new TeamEndpointLinks(databaseB, b, "Acme");
  const old = await linksA.hello(linkId, "a");
  const replacement = await linksB.hello(linkId, "b");
  const channel = await chatA.create(
    { kind: "human", userId: f.userId },
    { id: createId("teamChannel"), name: "posts", kind: "public", peopleOnly: false, access: [] },
  );
  await expect(
    a.withLinkEpoch(linkId, old, () =>
      chatA.send(
        { kind: "agent", userId: f.userId },
        {
          channelId: channel.id,
          threadRootId: null,
          clientMessageId: randomUUID(),
          bodyMarkdown: "Stale",
          mentions: [],
          attachmentIds: [],
        },
      ),
    ),
  ).rejects.toMatchObject({ code: "forbidden" });
  await linksA.disconnected(linkId, old);
  expect(await linksB.isOnline(f.userId)).toBe(true);
  await linksB.assertEpoch(linkId, replacement);
});

it("closes transports after ten seconds without a healthy bus", async () => {
  await busB.close();
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  const off = b.attach(busB);
  const close = vi.fn();
  b.onCloseAll(close);
  try {
    await vi.advanceTimersByTimeAsync(10_000);
    expect(close).toHaveBeenCalledWith(1012);
  } finally {
    off();
    vi.useRealTimers();
  }
});
it("settles a link presence change that arrives after its copy's database closed", async () => {
  const userId = await f.member("Linked");
  const closed = createDatabase({ connectionString: f.databaseUrl, applicationName: "closed" });
  const hub = new TeamRealtimeHub(new TeamAccessStore(closed), chatA);
  await sql`select 1`.execute(closed);
  await closed.destroy();
  await expect(hub.linkPresenceChanged(userId, true)).resolves.toBeUndefined();
});
