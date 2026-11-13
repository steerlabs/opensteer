import { createId, KnowledgeTopicIdSchema, UserIdSchema } from "@opensteer/core";
import { TeamMemberSchema } from "@opensteer/protocol";
import { expect, it } from "vitest";
import { unwrapRpcResult } from "../host/host-session-client.js";
import {
  isNoteChangedConflict,
  isTopicAccessConflict,
  noteByline,
  noteDraftReady,
  noteWriteCommand,
} from "./knowledge.js";
import { MockTeamHost } from "./mock-team-host.js";

function team() {
  const host = new MockTeamHost();
  const leo = TeamMemberSchema.parse({
    ...host.bootstrap.member,
    userId: UserIdSchema.parse("usr_00000000-0000-4000-8000-000000000002"),
    displayName: "Leo Park",
    handle: "leo",
    role: "member",
  });
  host.members.push(leo);
  const dispatch = (command: Parameters<(typeof host.rpc)["commands.dispatch"]>[0]) =>
    host.rpc["commands.dispatch"](command).then(unwrapRpcResult);
  return { host, leo, dispatch };
}

it("keeps a stale draft out with the team Host's conflict, and saves it on the current version", async () => {
  const { host, leo, dispatch } = team();
  const topicId = host.knowledge.starterTopicId;
  const noteId = createId("knowledgeNote");
  const draft = { title: "Refunds", body: "Ask Maya." };
  expect(noteDraftReady(null, { title: "  ", body: "x" })).toBe(false);
  expect(noteDraftReady(null, draft)).toBe(true);
  await dispatch(noteWriteCommand({ noteId, topicId, base: null, draft }));
  const first = await host.rpc["team.knowledge.note.get"]({ noteId }).then(unwrapRpcResult);
  expect(noteDraftReady(first, { ...draft, title: " Refunds " })).toBe(false);

  host.knowledge.addVersion({
    noteId,
    topicId,
    title: "Refunds",
    body: "Ask Maya or Dana.",
    writer: { kind: "agent", userId: leo.userId, name: leo.displayName },
  });
  const mine = { title: "Refunds", body: "Ask Maya. Over $500 needs two." };
  const stale = await dispatch(
    noteWriteCommand({ noteId, topicId, base: first, draft: mine }),
  ).then(
    () => null,
    (error: unknown) => error,
  );
  expect(isNoteChangedConflict(stale)).toBe(true);
  expect(stale).toMatchObject({ message: "Leo Park changed this note while you were editing it." });

  const current = await host.rpc["team.knowledge.note.get"]({ noteId }).then(unwrapRpcResult);
  const saved = await dispatch(noteWriteCommand({ noteId, topicId, base: current, draft: mine }));
  expect(saved).toMatchObject({ version: 3 });
  // A retried write that already landed answers with its first outcome.
  await expect(
    dispatch(noteWriteCommand({ noteId, topicId, base: current, draft: mine })),
  ).resolves.toMatchObject({ version: 3 });

  await dispatch({ type: "team.knowledge.note.delete", noteId, expectedVersion: 3 });
  const page = await host.rpc["team.knowledge.notes.page"]({ topicId }).then(unwrapRpcResult);
  expect(page.notes).toEqual([]);
  const history = await host.rpc["team.knowledge.note.history"]({ noteId }).then(unwrapRpcResult);
  expect(history.versions.map((version) => [version.version, version.deleted])).toEqual([
    [4, true],
    [3, false],
    [2, false],
    [1, false],
  ]);
  expect(history.versions[0]).toMatchObject({ title: "Refunds", body: mine.body });
});

it("decides reads, writes and management from the list, roles and archiving", async () => {
  const { host, leo, dispatch } = team();
  const hidden = KnowledgeTopicIdSchema.parse(createId("knowledgeTopic"));
  host.knowledge.addTopic({
    id: hidden,
    name: "Hiring",
    description: "",
    access: [],
    createdBy: leo.userId,
  });
  // An owner manages every topic and sees its list, but reads only what they are granted.
  const topic = await host.rpc["team.knowledge.topic.get"]({ topicId: hidden }).then(
    unwrapRpcResult,
  );
  expect(topic).toMatchObject({ can: { read: false, write: false, manage: true }, noteCount: 0 });
  expect(topic.audience).toEqual({ everyone: false, people: 1 });
  const notes = await host.rpc["team.knowledge.notes.page"]({ topicId: hidden });
  expect(!notes.ok && notes.error).toMatchObject({
    code: "not_found",
    reason: "knowledge-topic-not-found",
  });

  const access = await host.rpc["team.knowledge.topic.access.get"]({ topicId: hidden }).then(
    unwrapRpcResult,
  );
  const everyoneReads = [
    ...access.entries,
    { subject: { kind: "everyone" }, level: "read" },
  ] as const;
  await dispatch({
    type: "team.knowledge.topic.access.set",
    topicId: hidden,
    expectedRevision: access.revision,
    access: [...everyoneReads],
  });
  const stale = await dispatch({
    type: "team.knowledge.topic.access.set",
    topicId: hidden,
    expectedRevision: access.revision,
    access: [...everyoneReads],
  }).catch((error: unknown) => error);
  expect(isTopicAccessConflict(stale)).toBe(true);
  expect(host.knowledge.can(hidden)).toEqual({ read: true, write: false, manage: true });
  expect(
    (await host.rpc["team.knowledge.topic.get"]({ topicId: hidden }).then(unwrapRpcResult))
      .audience,
  ).toEqual({ everyone: true, people: 2 });

  const general = host.knowledge.starterTopicId;
  await dispatch({ type: "team.knowledge.topic.archive", topicId: general });
  expect(host.knowledge.can(general)).toEqual({ read: true, write: false, manage: true });
  const refused = await dispatch(
    noteWriteCommand({
      noteId: createId("knowledgeNote"),
      topicId: general,
      base: null,
      draft: { title: "Late", body: "" },
    }),
  ).catch((error: unknown) => error);
  expect(refused).toMatchObject({ code: "forbidden", reason: "knowledge-topic-read-only" });
  expect(host.knowledge.can(general, leo.userId)).toEqual({
    read: true,
    write: false,
    manage: false,
  });
});

it("pages notes newest first and searches by word prefixes across readable topics", async () => {
  const { host } = team();
  host.knowledge.pageSize = 2;
  const topicId = host.knowledge.starterTopicId;
  const titles = ["Carrier claims", "Refunds over $500", "Opened bundles"];
  titles.forEach((title, index) =>
    host.knowledge.addVersion({
      noteId: createId("knowledgeNote"),
      topicId,
      title,
      body: `Note ${index}`,
      at: `2026-11-0${index + 1}T10:00:00.000Z`,
      writer: { kind: "human", userId: host.userId, name: "Maya" },
    }),
  );
  const first = await host.rpc["team.knowledge.notes.page"]({ topicId }).then(unwrapRpcResult);
  expect(first.notes.map((note) => note.title)).toEqual(["Opened bundles", "Refunds over $500"]);
  const second = await host.rpc["team.knowledge.notes.page"]({
    topicId,
    cursor: first.nextCursor!,
  }).then(unwrapRpcResult);
  expect(second).toMatchObject({ notes: [{ title: "Carrier claims" }], nextCursor: null });
  const found = await host.rpc["team.knowledge.notes.page"]({ query: "refu 500" }).then(
    unwrapRpcResult,
  );
  expect(found.notes.map((note) => note.title)).toEqual(["Refunds over $500"]);
});

it("words a note for lists in this viewer's words", () => {
  const writer = {
    kind: "agent",
    userId: UserIdSchema.parse("usr_00000000-0000-4000-8000-000000000001"),
    name: "Tim Jang",
  } as const;
  expect(noteByline({ version: 2, deleted: false, writer }, writer.userId)).toBe(
    "Edited by your agent",
  );
  expect(noteByline({ version: 1, deleted: false, writer }, "usr_other")).toBe(
    "Saved by Tim's agent",
  );
  expect(
    noteByline({ version: 3, deleted: true, writer: { ...writer, kind: "human" } }, writer.userId),
  ).toBe("Deleted by you");
});
