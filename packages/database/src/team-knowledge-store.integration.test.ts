import { createId, type KnowledgeTopicId, type TeamActor, type UserId } from "@opensteer/core";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { sql } from "kysely";
import { describe, expect, it, vi } from "vitest";
import { TeamAccessStore } from "./team-access-store.js";
import {
  ensureTeamStarterTopic,
  setTeamTopicGrants,
  teamChannelReaders,
  teamNoteHistory,
  teamNotesPage,
  teamTopicReaders,
  updateTeamTopic,
  writeTeamNote,
  type TeamNoteWrite,
} from "./team-knowledge-store.js";
import { createTeamKnowledgeFixture } from "./team-knowledge.test-support.js";

async function team() {
  const f = await createTeamKnowledgeFixture();
  const access = new TeamAccessStore(f.database);
  await access.initialize();
  const mira = await f.member("Mira");
  const sam = await f.member("Sam");
  const ada = await f.member("Ada", "admin");
  /** Mira is in sales, which revenue contains. */
  const sales = await f.group("sales", [mira]);
  const revenue = await f.group("revenue", [], [sales]);
  const rights = (actor: TeamActor, topicId: KnowledgeTopicId) =>
    f.database.transaction().execute((t) => access.topic(t, actor, topicId));
  const versionCount = async () =>
    Number(
      (
        await f.database
          .selectFrom("teamNoteVersions")
          .select((eb) => eb.fn.countAll<string>().as("count"))
          .executeTakeFirstOrThrow()
      ).count,
    );
  return { ...f, access, mira, sam, ada, sales, revenue, rights, versionCount };
}
type Team = Awaited<ReturnType<typeof team>>;

const human = (userId: UserId): TeamActor => ({ kind: "human", userId });
const agent = (userId: UserId): TeamActor => ({ kind: "agent", userId });

function writer(t: Team) {
  const authorized: KnowledgeTopicId[] = [];
  const write = (input: Omit<TeamNoteWrite, "writer">, userId: UserId = t.mira) =>
    t.database.transaction().execute((transaction) =>
      writeTeamNote(transaction, { ...input, writer: { kind: "human", userId } }, async (id) => {
        authorized.push(id);
      }),
    );
  return { write, authorized };
}

describe("team knowledge store", () => {
  it("resolves topic access through nested groups and everyone, never letting agents manage", async () => {
    const t = await team();
    const pricing = await t.topic("pricing", [
      { subject: { kind: "group", groupId: t.revenue }, level: "write" },
    ]);
    const general = await t.topic("general", [{ subject: { kind: "everyone" }, level: "write" }]);
    const mine = await t.topic("mine", [
      { subject: { kind: "person", userId: t.mira }, level: "manage" },
    ]);
    expect(await t.rights(human(t.mira), pricing)).toEqual({
      read: true,
      write: true,
      manage: false,
    });
    expect(await t.rights(human(t.sam), pricing)).toEqual({
      read: false,
      write: false,
      manage: false,
    });
    expect(await t.rights(human(t.sam), general)).toEqual({
      read: true,
      write: true,
      manage: false,
    });
    // Owners and admins manage every topic, but read only what they are granted.
    for (const userId of [t.owner, t.ada])
      expect(await t.rights(human(userId), pricing)).toEqual({
        read: false,
        write: false,
        manage: true,
      });
    // An agent has its owner's read and write, never manage, even where the owner manages.
    expect(await t.rights(human(t.mira), mine)).toEqual({ read: true, write: true, manage: true });
    expect(await t.rights(agent(t.mira), mine)).toEqual({ read: true, write: true, manage: false });
    expect(await t.rights(agent(t.owner), pricing)).toEqual({
      read: false,
      write: false,
      manage: false,
    });
    // Archived topics stay readable and stop taking writes.
    await t.database
      .transaction()
      .execute((transaction) => updateTeamTopic(transaction, pricing, { archived: true }));
    expect(await t.rights(agent(t.mira), pricing)).toEqual({
      read: true,
      write: false,
      manage: false,
    });
    // Leaving a nested group, or a deleted group, takes access away.
    await t.database
      .updateTable("teamGroups")
      .set({ deletedAt: new Date() })
      .where("id", "=", t.sales)
      .execute();
    expect((await t.rights(agent(t.mira), pricing)).read).toBe(false);
    await t.database
      .updateTable("teamMembers")
      .set({ state: "removed" })
      .where("userId", "=", t.sam)
      .execute();
    expect((await t.rights(agent(t.sam), general)).read).toBe(false);
  });

  it("refuses an everyone manager and subjects outside the team, and changes a list only at its revision", async () => {
    const t = await team();
    const topicId = await t.topic("pricing", []);
    const set = (access: Parameters<typeof setTeamTopicGrants>[1]["access"], revision = "0") =>
      t.database.transaction().execute((transaction) =>
        setTeamTopicGrants(transaction, {
          topicId,
          expectedRevision: revision,
          access,
          changedBy: t.owner,
        }),
      );
    await expect(set([{ subject: { kind: "everyone" }, level: "manage" }])).rejects.toMatchObject({
      reason: "team-topic-everyone-manage",
    });
    await expect(
      set([{ subject: { kind: "person", userId: createId("user") }, level: "read" }]),
    ).rejects.toMatchObject({ reason: "team-topic-unknown-subject" });
    expect(
      await set([
        { subject: { kind: "person", userId: t.sam }, level: "read" },
        { subject: { kind: "person", userId: t.sam }, level: "write" },
      ]),
    ).toBe(true);
    expect(await t.rights(human(t.sam), topicId)).toMatchObject({ read: true, write: true });
    expect(await set([], "0")).toBe(false);
    expect((await t.rights(human(t.sam), topicId)).read).toBe(true);
  });

  it("counts who reads a topic and a channel through nested groups, everyone and active members", async () => {
    const t = await team();
    const pricing = await t.topic("pricing", [
      { subject: { kind: "group", groupId: t.revenue }, level: "read" },
      { subject: { kind: "person", userId: t.sam }, level: "read" },
    ]);
    const general = await t.topic("general", [{ subject: { kind: "everyone" }, level: "read" }]);
    const closed = await t.topic("closed", []);
    const readers = await teamTopicReaders(t.database, [pricing, general, closed]);
    expect(readers.get(general)).toBe("everyone");
    expect(readers.get(pricing)).toEqual(new Set([t.mira, t.sam]));
    expect(readers.get(closed)).toEqual(new Set());
    const { channelId } = await t.channel({
      name: "deals",
      kind: "private",
      access: [{ groupId: t.revenue, level: "post" }],
    });
    expect(await teamChannelReaders(t.database, channelId)).toEqual(new Set([t.mira]));
    await t.database
      .updateTable("teamMembers")
      .set({ state: "removed" })
      .where("userId", "=", t.mira)
      .execute();
    expect(await teamChannelReaders(t.database, channelId)).toEqual(new Set());
    expect((await teamTopicReaders(t.database, [pricing])).get(pricing)).toEqual(new Set([t.sam]));
  });

  it("keeps every version of a note: create, change, delete and restore", async () => {
    const t = await team();
    const topicId = await t.topic("support", [
      { subject: { kind: "person", userId: t.mira }, level: "write" },
    ]);
    const { write } = writer(t);
    const noteId = createId("knowledgeNote");
    expect(
      await write({ noteId, topicId, expectedVersion: null, title: "Refunds", body: "30 days" }),
    ).toEqual({ written: true, noteId, topicId, version: 1 });
    expect(await write({ noteId, expectedVersion: 1, body: "14 days" })).toMatchObject({
      version: 2,
    });
    expect(await write({ noteId, expectedVersion: 2, delete: true })).toMatchObject({
      version: 3,
    });
    const page = () =>
      teamNotesPage(t.database, { readerUserId: t.mira, topicId, limit: 10 }).then((p) =>
        p.notes.map((note) => note.id),
      );
    expect(await page()).toEqual([]);
    // Deleting a deleted note again changes nothing.
    expect(await write({ noteId, expectedVersion: 3, delete: true })).toMatchObject({
      version: 3,
    });
    expect(await write({ noteId, expectedVersion: 3, body: "21 days" })).toMatchObject({
      version: 4,
    });
    expect(await page()).toEqual([noteId]);
    const history = await teamNoteHistory(t.database, { noteId, limit: 10 });
    expect(history.versions.map((v) => [v.version, v.title, v.body, v.deleted])).toEqual([
      [4, "Refunds", "21 days", false],
      [3, "Refunds", "14 days", true],
      [2, "Refunds", "14 days", false],
      [1, "Refunds", "30 days", false],
    ]);
    expect(history.versions[0]!.writer).toEqual({ kind: "human", userId: t.mira, name: "Mira" });
    expect(
      (await teamNoteHistory(t.database, { noteId, before: 3, limit: 1 })).versions.map(
        (v) => v.version,
      ),
    ).toEqual([2]);
  });

  it("returns the current note to a stale writer, and replays only the same writer's same write", async () => {
    const t = await team();
    const topicId = await t.topic("support", [{ subject: { kind: "everyone" }, level: "write" }]);
    const other = await t.topic("other", [{ subject: { kind: "everyone" }, level: "write" }]);
    const { write, authorized } = writer(t);
    const noteId = createId("knowledgeNote");
    const create = { noteId, topicId, expectedVersion: null, title: "Refunds", body: "30 days" };
    await write(create);
    expect(await write(create)).toEqual({ written: true, noteId, topicId, version: 1 });
    // Someone else reusing the note's id, or a create naming another topic, is not a replay.
    expect(await write(create, t.sam)).toMatchObject({ written: false, current: { version: 1 } });
    expect(await write({ ...create, topicId: other })).toMatchObject({
      written: false,
      current: { topicId },
    });
    await write({ noteId, expectedVersion: 1, body: "14 days" });
    const versions = await t.versionCount();
    // A resent change returns its first outcome without another version.
    expect(await write({ noteId, expectedVersion: 1, body: "14 days" })).toEqual({
      written: true,
      noteId,
      topicId,
      version: 2,
    });
    // A different change from that version, or the same one by someone else, is stale.
    const stale = await write({ noteId, expectedVersion: 1, body: "7 days" });
    expect(stale).toMatchObject({
      written: false,
      current: { version: 2, body: "14 days", writer: { userId: t.mira } },
    });
    expect(await write({ noteId, expectedVersion: 1, body: "14 days" }, t.sam)).toMatchObject({
      written: false,
      current: { version: 2 },
    });
    expect(await t.versionCount()).toBe(versions);
    // A change is always authorized against the note's own topic, whatever it names.
    authorized.length = 0;
    await write({ noteId, topicId: other, expectedVersion: 2, body: "10 days" });
    expect(authorized).toEqual([topicId]);
    // After someone else edits on top, a resent write still answers with the version it made.
    await write({ noteId, expectedVersion: 3, body: "12 days" }, t.sam);
    expect(await write({ noteId, expectedVersion: 2, body: "10 days" })).toEqual({
      written: true,
      noteId,
      topicId,
      version: 3,
    });
    expect(await write({ noteId, expectedVersion: 2, body: "9 days" })).toMatchObject({
      written: false,
      current: { version: 4, body: "12 days" },
    });
    await expect(
      write({ noteId: createId("knowledgeNote"), expectedVersion: 1, body: "x" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("answers a create resent while the first is still committing with the first's outcome", async () => {
    const t = await team();
    const topicId = await t.topic("support", [{ subject: { kind: "everyone" }, level: "write" }]);
    const create = {
      noteId: createId("knowledgeNote"),
      topicId,
      expectedVersion: null,
      title: "Refunds",
      body: "30 days",
      writer: { kind: "agent" as const, userId: t.mira },
    };
    const inserted = Promise.withResolvers<void>();
    const commit = Promise.withResolvers<void>();
    const first = t.database.transaction().execute(async (transaction) => {
      const outcome = await writeTeamNote(transaction, create, async () => {});
      inserted.resolve();
      await commit.promise;
      return outcome;
    });
    await withTimeout(inserted.promise, 5000, {
      timeoutError: () => new Error("The first create never inserted its note"),
    });
    const resent = t.database
      .transaction()
      .execute((transaction) => writeTeamNote(transaction, create, async () => {}));
    await vi.waitFor(
      async () => {
        const { rows } = await sql<{
          waiting: boolean;
        }>`select exists(select 1 from pg_stat_activity
          where datname=current_database() and wait_event_type='Lock') as waiting`.execute(
          t.database,
        );
        expect(rows[0]?.waiting, "the resent create never waited on the first").toBe(true);
      },
      { timeout: 5000 },
    );
    commit.resolve();
    const expected = { written: true, noteId: create.noteId, topicId, version: 1 };
    expect(await first).toEqual(expected);
    expect(await resent).toEqual(expected);
    expect(await t.versionCount()).toBe(1);
  });

  it("searches current notes by word prefixes, only in topics the reader can read", async () => {
    const t = await team();
    const shared = await t.topic("shared", [{ subject: { kind: "everyone" }, level: "write" }]);
    const secret = await t.topic("secret", [
      { subject: { kind: "person", userId: t.mira }, level: "write" },
    ]);
    const { write } = writer(t);
    const add = (topicId: KnowledgeTopicId, title: string, body: string) =>
      write({ noteId: createId("knowledgeNote"), topicId, expectedVersion: null, title, body });
    await add(shared, "Refund policy", "Annual plans within thirty days");
    await add(shared, "Pricing", "Pro costs forty-nine dollars; refunds are rare");
    await add(secret, "Refund exceptions", "Globex gets ninety days");
    const removed = createId("knowledgeNote");
    await write({
      noteId: removed,
      topicId: shared,
      expectedVersion: null,
      title: "Old refund",
      body: "x",
    });
    await write({ noteId: removed, expectedVersion: 1, delete: true });
    const search = (readerUserId: UserId, query: string, topicId?: KnowledgeTopicId) =>
      teamNotesPage(t.database, {
        readerUserId,
        query,
        limit: 10,
        ...(topicId ? { topicId } : {}),
      }).then((page) => page.notes.map((note) => note.title));
    expect(await search(t.sam, "refu")).toEqual(
      expect.arrayContaining(["Refund policy", "Pricing"]),
    );
    expect(await search(t.sam, "refu")).toHaveLength(2);
    expect(await search(t.mira, "refund ninety")).toEqual(["Refund exceptions"]);
    expect(await search(t.mira, "REFUND", shared)).toHaveLength(2);
    // A match in the title outranks one in the body.
    expect((await search(t.sam, "refund"))[0]).toBe("Refund policy");
    expect(await search(t.sam, "ninety")).toEqual([]);
    expect(await search(t.sam, "%_'\"&|!:*")).toEqual([]);
    const first = await teamNotesPage(t.database, {
      readerUserId: t.mira,
      query: "refu",
      limit: 2,
    });
    expect(first.nextCursor).not.toBeNull();
    const second = await teamNotesPage(t.database, {
      readerUserId: t.mira,
      query: "refu",
      cursor: first.nextCursor!,
      limit: 2,
    });
    expect([...first.notes, ...second.notes].map((note) => note.title).toSorted()).toEqual([
      "Pricing",
      "Refund exceptions",
      "Refund policy",
    ]);
    expect(second.nextCursor).toBeNull();
  });

  it("pages recent notes without skipping ones changed within the same millisecond", async () => {
    const t = await team();
    const topicId = await t.topic("support", [{ subject: { kind: "everyone" }, level: "write" }]);
    const { write } = writer(t);
    const ids = [];
    for (let index = 0; index < 4; index++) {
      const noteId = createId("knowledgeNote");
      ids.push(noteId);
      await write({ noteId, topicId, expectedVersion: null, title: `Note ${index}`, body: "x" });
      await t.database
        .updateTable("teamNotes")
        .set({
          updatedAt: sql<Date>`timestamptz '2026-01-01 00:00:00.123' + ${index} * interval '1 microsecond'`,
        })
        .where("id", "=", noteId)
        .execute();
    }
    const seen = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const result = await teamNotesPage(t.database, {
        readerUserId: t.mira,
        topicId,
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...result.notes.map((note) => note.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    expect(seen).toEqual(ids.toReversed());
  });

  it("seeds one General topic everyone can write, once", async () => {
    const t = await team();
    await ensureTeamStarterTopic(t.database, createId("knowledgeTopic"));
    await ensureTeamStarterTopic(t.database, createId("knowledgeTopic"));
    const topics = await t.database.selectFrom("teamTopics").select(["id", "name"]).execute();
    expect(topics.map((topic) => topic.name)).toEqual(["General"]);
    expect(await t.rights(agent(t.sam), topics[0]!.id)).toEqual({
      read: true,
      write: true,
      manage: false,
    });
  });
});
