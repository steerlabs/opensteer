import {
  createId,
  type KnowledgeNoteId,
  type KnowledgeTopicId,
  type TeamActor,
  type UserId,
} from "@opensteer/core";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { createTeamKnowledgeFixture } from "@opensteer/database/test-support/team-knowledge";
import { TeamMembersStore } from "@opensteer/database/team-members";
import {
  teamReadSchemas,
  type TeamCommandSchema,
  type TeamKnowledgeReadInput,
  type TeamKnowledgeWrite,
} from "@opensteer/protocol";
import { sql } from "kysely";
import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { testTeamAccess, testTeamAudit } from "./team-access.test-support.js";
import {
  startTeamKnowledge,
  type TeamKnowledgeAgent,
  type TeamKnowledgeReadName,
} from "./team-knowledge.js";

const none = { users: [], channels: [], topics: [], links: [], requests: [] };

/**
 * Mira, a plain member, reaches pricing through nested groups and manages payroll; Sam posts in
 * #support and reads roadmap; Lee manages roadmap; Ada is an admin on no list. #support holds
 * Mira and Sam; #deals is the revenue group's, so only Mira.
 */
async function team() {
  const f = await createTeamKnowledgeFixture();
  const { access, pauses, changes } = testTeamAccess(f.database);
  await access.initialize();
  const knowledge = await startTeamKnowledge({
    database: f.database,
    access,
    audit: testTeamAudit,
  });
  const owner = f.owner;
  const mira = await f.member("Mira");
  const sam = await f.member("Sam");
  const lee = await f.member("Lee");
  const ada = await f.member("Ada", "admin");
  const sales = await f.group("sales", [mira]);
  const revenue = await f.group("revenue", [], [sales]);
  const support = await f.channel({
    name: "support",
    access: [
      { userId: mira, level: "post", manage: true },
      { userId: sam, level: "post" },
    ],
  });
  const deals = await f.channel({
    name: "deals",
    kind: "private",
    access: [{ groupId: revenue, level: "post" }],
  });
  const general = (await f.database.selectFrom("teamTopics").select("id").executeTakeFirstOrThrow())
    .id;
  const pricing = await f.topic("pricing", [
    { subject: { kind: "group", groupId: revenue }, level: "write" },
  ]);
  const roadmap = await f.topic("roadmap", [
    { subject: { kind: "person", userId: sam }, level: "read" },
    { subject: { kind: "person", userId: lee }, level: "manage" },
  ]);
  const payroll = await f.topic("payroll", [
    { subject: { kind: "person", userId: mira }, level: "manage" },
  ]);
  const asks = {
    mira: await f.request(mira, support.channelId),
    miraDeals: await f.request(mira, deals.channelId),
    sam: await f.request(sam, support.channelId),
  };
  /** Each person's agent from a private Run: their link, no request. */
  const agents = {
    mira: { linkId: asks.mira.linkId, ownerUserId: mira },
    sam: { linkId: asks.sam.linkId, ownerUserId: sam },
    owner: { linkId: await f.link(owner), ownerUserId: owner },
    ada: { linkId: await f.link(ada), ownerUserId: ada },
  } satisfies Record<string, TeamKnowledgeAgent>;
  const asking = (who: keyof typeof asks): TeamKnowledgeAgent => ({
    linkId: asks[who].linkId,
    ownerUserId: who === "sam" ? sam : mira,
    requestId: asks[who].requestId,
  });
  const topics = async (agent: TeamKnowledgeAgent) => (await knowledge.topics(agent)).result;
  const readNotes = async (agent: TeamKnowledgeAgent, input: TeamKnowledgeReadInput) =>
    (await knowledge.readNotes(agent, input)).result;
  const create = (
    agent: TeamKnowledgeAgent,
    topicId: KnowledgeTopicId,
    title = "Note",
    noteId: KnowledgeNoteId = createId("knowledgeNote"),
  ) =>
    knowledge
      .write(agent, {
        noteId,
        topicId,
        expectedVersion: null,
        title,
        body: `${title} body`,
      })
      .then((answer) => answer.result);
  const write = (agent: TeamKnowledgeAgent, input: TeamKnowledgeWrite) =>
    knowledge.write(agent, input).then((answer) => answer.result);
  const person = (userId: UserId): TeamActor => ({ kind: "human", userId });
  /** A person's read, checked against the wire contract. */
  const read = async <Name extends TeamKnowledgeReadName>(
    userId: UserId,
    name: Name,
    input: z.input<(typeof teamReadSchemas)[Name]["input"]>,
  ) =>
    teamReadSchemas[name].output.parse(
      await knowledge.read(person(userId), name, input),
    ) as z.infer<(typeof teamReadSchemas)[Name]["output"]>;
  const command = (userId: UserId, input: z.infer<typeof TeamCommandSchema>) =>
    knowledge.command(person(userId), input);
  const versions = async () =>
    Number(
      (
        await sql<{
          count: string;
        }>`select count(*)::text as count from team_note_versions`.execute(f.database)
      ).rows[0]!.count,
    );
  return {
    ...f,
    knowledge,
    lock: access,
    pauses,
    changes,
    people: { owner, mira, sam, lee, ada },
    groups: { sales, revenue },
    channels: { support, deals },
    topicIds: { general, pricing, roadmap, payroll },
    asks,
    agents,
    asking,
    topics,
    readNotes,
    create,
    write,
    read,
    command,
    versions,
  };
}
type Team = Awaited<ReturnType<typeof team>>;

/** Resolves when the call reaches the pause; `release` lets it go on. */
function hold() {
  const reached = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  return {
    reached: reached.promise,
    release: () => released.resolve(),
    pause: async () => {
      reached.resolve();
      await released.promise;
    },
  };
}

const reason = (promise: Promise<unknown>) =>
  promise.then(
    () => "allowed",
    (error: unknown) => (error as { reason?: string }).reason ?? String(error),
  );

/** Every way Mira's agent can lose pricing, its owner's group-granted topic. */
const losses: Record<string, (t: Team) => Promise<void>> = {
  member: async (t) => {
    await new TeamMembersStore(t.lock).change(person(t.people.owner), t.people.mira, "remove");
  },
  link: (t) =>
    t.lock.mutate(async (transaction) => {
      await transaction
        .updateTable("teamLinks")
        .set({ state: "revoked", revokedAt: new Date() })
        .where("id", "=", t.asks.mira.linkId)
        .execute();
      return { value: undefined, effects: { ...none, links: [t.asks.mira.linkId] } };
    }),
  topic: async (t) => {
    await t.command(t.people.owner, {
      type: "team.knowledge.topic.access.set",
      topicId: t.topicIds.pricing,
      expectedRevision: "0" as never,
      access: [{ subject: { kind: "person", userId: t.people.sam }, level: "read" }],
    });
  },
  group: (t) =>
    t.lock.mutate(async (transaction) => {
      await transaction
        .deleteFrom("teamGroupPeople")
        .where("groupId", "=", t.groups.sales)
        .where("userId", "=", t.people.mira)
        .execute();
      return { value: undefined, effects: { ...none, users: [t.people.mira] } };
    }),
};
const lost = /^knowledge-(link-unavailable|topic-not-found)$/u;

function person(userId: UserId): TeamActor {
  return { kind: "human", userId };
}

async function waitingOnLock(t: Team) {
  await vi.waitFor(
    async () => {
      const { rows } = await sql<{ waiting: string }>`
        select count(*)::text as waiting from pg_catalog.pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
      `.execute(t.database);
      if (rows[0]?.waiting === "0") throw new Error("The access change never waited for the write");
    },
    { timeout: 10_000, interval: 20 },
  );
}

describe("team knowledge", () => {
  it("lets an agent read and write exactly what its owner can, never what its owner only manages", async () => {
    const t = await team();
    const { general, pricing, roadmap, payroll } = t.topicIds;
    const listed = async (agent: TeamKnowledgeAgent) =>
      (await t.topics(agent)).topics.map((topic) => [topic.name, topic.canWrite]);
    expect(await listed(t.agents.mira)).toEqual([
      ["General", true],
      ["payroll", true],
      ["pricing", true],
    ]);
    expect(await listed(t.agents.sam)).toEqual([
      ["General", true],
      ["roadmap", false],
    ]);
    // The owner and an admin manage every topic, but their agents get only what they read.
    expect(await listed(t.agents.owner)).toEqual([["General", true]]);
    expect(await listed(t.agents.ada)).toEqual([["General", true]]);
    expect((await t.topics(t.agents.mira)).topics[0]).toEqual({
      id: general,
      name: "General",
      description: expect.any(String),
      canWrite: true,
      archived: false,
      audience: { everyone: true, people: 5 },
    });
    expect(await reason(t.create(t.agents.sam, roadmap))).toBe("knowledge-topic-read-only");
    expect(await reason(t.create(t.agents.sam, payroll))).toBe("knowledge-topic-not-found");
    expect(await reason(t.create(t.agents.ada, pricing))).toBe("knowledge-topic-not-found");
    const secret = await t.create(t.agents.mira, payroll, "Salaries");
    if (!secret.written) throw new Error("Mira's agent could not write payroll");
    expect(await reason(t.readNotes(t.agents.sam, { noteId: secret.noteId }))).toBe(
      "knowledge-note-not-found",
    );
    expect(await reason(t.readNotes(t.agents.ada, { topicId: payroll }))).toBe(
      "knowledge-topic-not-found",
    );
    // No topic structure for agents: archived topics stay readable but take nothing new.
    await t.command(t.people.mira, { type: "team.knowledge.topic.archive", topicId: payroll });
    expect((await t.topics(t.agents.mira)).topics.at(-1)).toMatchObject({
      name: "payroll",
      archived: true,
      canWrite: false,
    });
    expect((await t.readNotes(t.agents.mira, { topicId: payroll })).notes).toHaveLength(1);
    expect(await reason(t.create(t.agents.mira, payroll))).toBe("knowledge-topic-read-only");
    // A link names only its own requests.
    await expect(
      t.knowledge.topics({ ...t.agents.sam, requestId: t.asks.mira.requestId }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  it("tells a team request's agent whether everyone in the asking channel can read each topic", async () => {
    const t = await team();
    const roomCanRead = async (agent: TeamKnowledgeAgent) =>
      Object.fromEntries(
        (await t.topics(agent)).topics.map((topic) => [topic.name, topic.roomCanRead]),
      );
    // #support holds Mira and Sam; Sam cannot read pricing or payroll.
    expect(await roomCanRead(t.asking("mira"))).toEqual({
      General: true,
      payroll: false,
      pricing: false,
    });
    // #deals is the revenue group's channel, so through sales only Mira reads it.
    expect(await roomCanRead(t.asking("miraDeals"))).toEqual({
      General: true,
      payroll: true,
      pricing: true,
    });
    expect(Object.values(await roomCanRead(t.agents.mira))).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    await t.create(t.agents.mira, t.topicIds.pricing, "Discount ladder");
    const found = await t.readNotes(t.asking("mira"), { query: "discount" });
    expect(found.notes.map((note) => note.title)).toEqual(["Discount ladder"]);
    expect(found.topics).toEqual([
      expect.objectContaining({
        id: t.topicIds.pricing,
        audience: { everyone: false, people: 1 },
        roomCanRead: false,
      }),
    ]);
  });

  it("versions agent and person writes, gives a stale agent the note and a stale person a conflict", async () => {
    const t = await team();
    const { general } = t.topicIds;
    const noteId = createId("knowledgeNote");
    const first = await t.create(t.asking("mira"), general, "Refunds", noteId);
    expect(first).toEqual({ written: true, noteId, topicId: general, version: 1 });
    // A resent agent write answers with its first outcome.
    expect(await t.create(t.asking("mira"), general, "Refunds", noteId)).toEqual(first);
    await t.command(t.people.sam, {
      type: "team.knowledge.note.write",
      noteId,
      topicId: general,
      expectedVersion: 1,
      title: "Refunds",
      body: "Annual plans: 30 days.",
    });
    const stale = await t.write(t.agents.mira, { noteId, expectedVersion: 1, body: "14 days" });
    expect(stale).toMatchObject({
      written: false,
      current: {
        version: 2,
        body: "Annual plans: 30 days.",
        writer: { kind: "human", name: "Sam" },
      },
    });
    await expect(
      t.command(t.people.lee, {
        type: "team.knowledge.note.write",
        noteId,
        topicId: general,
        expectedVersion: 1,
        title: "Refunds",
        body: "Mine",
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "knowledge-note-changed",
      message: "Sam changed this note while you were editing it.",
    });
    expect(
      await t.command(t.people.lee, {
        type: "team.knowledge.note.delete",
        noteId,
        expectedVersion: 2,
      }),
    ).toEqual({ type: "team.knowledge.note.delete", noteId, version: 3 });
    expect(
      (await t.read(t.people.lee, "team.knowledge.notes.page", { topicId: general })).notes,
    ).toEqual([]);
    await t.write(t.agents.mira, { noteId, expectedVersion: 3, body: "Restored" });
    const history = await t.read(t.people.sam, "team.knowledge.note.history", { noteId });
    expect(
      history.versions.map((version) => [
        version.version,
        version.deleted,
        version.writer.kind,
        version.writer.name,
        version.source,
      ]),
    ).toEqual([
      [4, false, "agent", "Mira", null],
      [3, true, "human", "Lee", null],
      [2, false, "human", "Sam", null],
      [
        1,
        false,
        "agent",
        "Mira",
        { channelId: t.channels.support.channelId, messageId: t.asks.mira.messageId },
      ],
    ]);
    expect(await t.read(t.people.sam, "team.knowledge.note.get", { noteId })).toMatchObject({
      version: 4,
      body: "Restored",
    });
  });

  it("searches by word prefixes across only the topics the reader can read", async () => {
    const t = await team();
    await t.create(t.agents.mira, t.topicIds.general, "Refund policy");
    await t.create(t.agents.mira, t.topicIds.payroll, "Refund of expenses");
    await t.create(t.agents.mira, t.topicIds.pricing, "Pricing tiers");
    const titles = async (agent: TeamKnowledgeAgent, query: string) =>
      (await t.readNotes(agent, { query })).notes.map((note) => note.title).toSorted();
    expect(await titles(t.agents.mira, "refu")).toEqual(["Refund of expenses", "Refund policy"]);
    expect(await titles(t.agents.sam, "refu")).toEqual(["Refund policy"]);
    expect(await titles(t.agents.ada, "pric")).toEqual([]);
    const people = await t.read(t.people.sam, "team.knowledge.notes.page", { query: "REFUND" });
    expect(people.notes.map((note) => note.title)).toEqual(["Refund policy"]);
    // Owners and admins manage without reading: the list shows the topic, never its notes.
    const listed = await t.read(t.people.ada, "team.knowledge.topics.list", {});
    expect(listed.topics.find((topic) => topic.id === t.topicIds.payroll)).toMatchObject({
      noteCount: 0,
      can: { read: false, write: false, manage: true },
    });
    await expect(
      t.read(t.people.ada, "team.knowledge.notes.page", { topicId: t.topicIds.payroll }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("audits agent calls with ids and counts, never note text or search words", async () => {
    const t = await team();
    await t.topics(t.asking("mira"));
    const saved = await t.create(t.asking("mira"), t.topicIds.pricing, "PINE_TITLE");
    await t.readNotes(t.asking("mira"), { query: "PINE_TITLE" });
    await reason(t.create(t.agents.sam, t.topicIds.payroll, "PINE_DENIED"));
    const rows = await t.database
      .selectFrom("teamAudit")
      .selectAll()
      .where("actorKind", "=", "agent")
      .orderBy("id")
      .execute();
    expect(rows.map((row) => [row.action, row.outcome, row.actorUserId])).toEqual([
      ["knowledge.topics", "allowed", t.people.mira],
      ["knowledge.write", "allowed", t.people.mira],
      ["knowledge.read", "allowed", t.people.mira],
      ["knowledge.write", "denied", t.people.sam],
    ]);
    expect(rows[1]).toMatchObject({
      linkId: t.asks.mira.linkId,
      agentRequestId: t.asks.mira.requestId,
      channelId: t.channels.support.channelId,
      resourceId: t.topicIds.pricing,
      metadata: { noteId: saved.written ? saved.noteId : null, written: true, version: 1 },
    });
    expect(rows[2]!.metadata).toMatchObject({ count: 1, search: true });
    expect(JSON.stringify(rows)).not.toMatch(/PINE|body/u);
  });

  it("cuts a removed member's agent off as soon as the removal returns", async () => {
    const t = await team();
    await t.topics(t.agents.mira);
    await new TeamMembersStore(t.lock).change(person(t.people.owner), t.people.mira, "remove");
    for (const call of [
      t.topics(t.agents.mira),
      t.readNotes(t.agents.mira, { query: "anything" }),
      t.create(t.agents.mira, t.topicIds.general),
    ])
      expect(await reason(call)).toBe("knowledge-link-unavailable");
  });

  it("replays a write's outcome only while its topic is still writable", async () => {
    const t = await team();
    const noteId = createId("knowledgeNote");
    const first = await t.create(t.agents.mira, t.topicIds.pricing, "Replayed", noteId);
    expect(await t.create(t.agents.mira, t.topicIds.pricing, "Replayed", noteId)).toEqual(first);
    const saved = await t.versions();
    await losses.topic!(t);
    expect(await reason(t.create(t.agents.mira, t.topicIds.pricing, "Replayed", noteId))).toBe(
      "knowledge-topic-not-found",
    );
    expect(await t.versions()).toBe(saved);
  });

  describe.each(Object.keys(losses))("losing access by %s", (loss) => {
    it("refuses a write authorized before the change returned that had not reached the lock", async () => {
      const t = await team();
      const paused = hold();
      t.pauses.beforeWriteLock = paused.pause;
      const writing = reason(t.create(t.agents.mira, t.topicIds.pricing, "late"));
      await paused.reached;
      const before = await t.versions();
      await losses[loss]!(t);
      const afterReturn = await t.versions();
      paused.release();
      expect(await writing).toMatch(lost);
      expect(afterReturn).toBe(before);
      expect(await t.versions()).toBe(before);
    });

    it("does not return the change until a write already holding the lock has committed", async () => {
      const t = await team();
      const paused = hold();
      t.pauses.insideWriteLock = paused.pause;
      const writing = reason(t.create(t.agents.mira, t.topicIds.pricing, "early"));
      await paused.reached;
      const before = await t.versions();
      let returned = false;
      const changing = losses[loss]!(t).then(() => {
        returned = true;
      });
      await waitingOnLock(t);
      expect(returned).toBe(false);
      paused.release();
      await changing;
      const afterReturn = await t.versions();
      delete t.pauses.insideWriteLock;
      expect(await writing).toBe("allowed");
      expect(afterReturn).toBe(before + 1);
      expect(await reason(t.create(t.agents.mira, t.topicIds.pricing, "after"))).toMatch(lost);
      expect(await t.versions()).toBe(afterReturn);
    });

    it("discards a buffered read when the access it was answered under is lost before handoff", async () => {
      const t = await team();
      await t.create(t.agents.mira, t.topicIds.pricing, "Discount ladder");
      const delivered = await t.knowledge.readNotes(t.agents.mira, { query: "discount" });
      expect(delivered.result.notes).toHaveLength(1);
      expect(await delivered.reauthorize()).toBe(true);
      const paused = hold();
      t.pauses.beforeHandoff = paused.pause;
      const reading = t.readNotes(t.agents.mira, { query: "discount" });
      await paused.reached;
      await losses[loss]!(t);
      paused.release();
      await expect(reading).rejects.toMatchObject({ code: "forbidden" });
      // The link's own final handoff rechecks the same topics.
      expect(await delivered.reauthorize()).toBe(false);
    });

    it("withholds the current note from a stale write when access is lost before handoff", async () => {
      const t = await team();
      const created = await t.create(t.agents.mira, t.topicIds.pricing, "Discount ladder");
      if (!created.written) throw new Error("Mira's agent could not write pricing");
      const { noteId } = created;
      await t.write(t.agents.mira, { noteId, expectedVersion: 1, body: "Ten percent" });
      const paused = hold();
      t.pauses.beforeHandoff = paused.pause;
      const stale = t.knowledge.write(t.agents.mira, {
        noteId,
        expectedVersion: 1,
        body: "Five percent",
      });
      await paused.reached;
      await losses[loss]!(t);
      paused.release();
      await expect(stale).rejects.toMatchObject({ code: "forbidden" });
    });
  });

  it("still hands over a buffered read when access changed only elsewhere", async () => {
    const t = await team();
    await t.create(t.agents.mira, t.topicIds.pricing, "Discount ladder");
    const paused = hold();
    t.pauses.beforeHandoff = paused.pause;
    const reading = t.readNotes(t.agents.mira, { query: "discount" });
    await paused.reached;
    await t.command(t.people.lee, {
      type: "team.knowledge.topic.access.set",
      topicId: t.topicIds.roadmap,
      expectedRevision: "0" as never,
      access: [{ subject: { kind: "person", userId: t.people.lee }, level: "manage" }],
    });
    paused.release();
    expect((await reading).notes.map((note) => note.title)).toEqual(["Discount ladder"]);
  });

  it.each(["update", "archive", "restore"] as const)(
    "fences a topic %s already admitted by a manager until commit before removing their grant",
    async (action) => {
      const t = await team();
      const { payroll } = t.topicIds;
      const barrier = hold();
      let paused = false;
      const topic = t.lock.topic.bind(t.lock);
      vi.spyOn(t.lock, "topic").mockImplementation(async (tx, actor, topicId) => {
        const rights = await topic(tx, actor, topicId);
        if (!paused && actor.userId === t.people.mira && topicId === payroll) {
          paused = true;
          await withTimeout(barrier.pause(), 5000, {
            timeoutError: () => new Error("Metadata barrier never released"),
          });
        }
        return rights;
      });
      const outcome = reason(
        t.command(
          t.people.mira,
          action === "update"
            ? {
                type: "team.knowledge.topic.update",
                topicId: payroll,
                name: "Updated",
                description: "",
              }
            : {
                type:
                  action === "archive"
                    ? "team.knowledge.topic.archive"
                    : "team.knowledge.topic.restore",
                topicId: payroll,
              },
        ),
      );
      await withTimeout(barrier.reached, 5000, {
        timeoutError: () => new Error("Metadata never checked manager authority"),
      });
      let removed = false;
      const removal = t
        .command(t.people.ada, {
          type: "team.knowledge.topic.access.set",
          topicId: payroll,
          expectedRevision: "0" as never,
          access: [{ subject: { kind: "person", userId: t.people.ada }, level: "manage" }],
        })
        .then(() => {
          removed = true;
        });
      try {
        await waitingOnLock(t);
        expect(removed).toBe(false);
      } finally {
        barrier.release();
        await removal;
        await outcome;
      }
      expect(await outcome).toBe("allowed");
      await expect(
        t.command(t.people.mira, {
          type: "team.knowledge.topic.update",
          topicId: payroll,
          name: "After removal",
          description: "",
        }),
      ).rejects.toMatchObject({ code: "not_found" });
    },
  );

  it("lets any member create a topic they manage, and only managers change a list at its revision", async () => {
    const t = await team();
    const { sam, lee, ada, mira } = t.people;
    const { roadmap, payroll } = t.topicIds;
    const created = createId("knowledgeTopic");
    await t.command(sam, {
      type: "team.knowledge.topic.create",
      id: created,
      name: "Support macros",
      description: "Replies we reuse",
      access: [{ subject: { kind: "everyone" }, level: "read" }],
    });
    expect(await t.read(sam, "team.knowledge.topic.get", { topicId: created })).toMatchObject({
      name: "Support macros",
      audience: { everyone: true, people: 5 },
      can: { read: true, write: true, manage: true },
    });
    expect(await t.read(lee, "team.knowledge.topic.get", { topicId: created })).toMatchObject({
      can: { read: true, write: false, manage: false },
    });
    expect(await reason(t.read(sam, "team.knowledge.topic.get", { topicId: payroll }))).toBe(
      "knowledge-topic-not-found",
    );
    const access = await t.read(lee, "team.knowledge.topic.access.get", { topicId: roadmap });
    expect(access).toMatchObject({ revision: "0", can: { manage: true } });
    await expect(
      t.command(sam, {
        type: "team.knowledge.topic.access.set",
        topicId: roadmap,
        expectedRevision: access.revision,
        access: [],
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      t.command(mira, {
        type: "team.knowledge.topic.access.set",
        topicId: roadmap,
        expectedRevision: access.revision,
        access: [],
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await t.command(ada, {
      type: "team.knowledge.topic.access.set",
      topicId: roadmap,
      expectedRevision: access.revision,
      access: [...access.entries, { subject: { kind: "person", userId: ada }, level: "read" }],
    });
    await expect(
      t.command(lee, {
        type: "team.knowledge.topic.access.set",
        topicId: roadmap,
        expectedRevision: access.revision,
        access: access.entries,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await t.read(ada, "team.knowledge.topic.get", { topicId: roadmap })).toMatchObject({
      can: { read: true, manage: true },
    });
    // The access service records and announces an admin's self-add from the change's actor.
    expect(t.changes).toContainEqual({
      actor: { kind: "human", userId: ada },
      action: "team.knowledge.topic.access.set",
    });
  });

  it("notifies the previous topic manager when an admin replaces every grant with themselves", async () => {
    const t = await team();
    await t.command(t.people.ada, {
      type: "team.knowledge.topic.access.set",
      topicId: t.topicIds.payroll,
      expectedRevision: "0" as never,
      access: [{ subject: { kind: "person", userId: t.people.ada }, level: "manage" }],
    });
    expect(
      await t.database
        .selectFrom("teamNotices")
        .select("recipientUserId")
        .where("recipientUserId", "=", t.people.mira)
        .execute(),
    ).toHaveLength(1);
  });

  it("seeds General once, however often the team Host starts", async () => {
    const t = await team();
    await startTeamKnowledge({ database: t.database, access: t.lock, audit: testTeamAudit });
    expect(
      (await t.database.selectFrom("teamTopics").select("name").execute()).filter(
        (topic) => topic.name === "General",
      ),
    ).toHaveLength(1);
  });
});
