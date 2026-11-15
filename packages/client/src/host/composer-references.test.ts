import { expect, it } from "vitest";
import { createId } from "@opensteer/core";
import { MockHostClient } from "../mock/mock-host-client.js";
import { composerReferenceCandidates } from "./composer-references.js";

const fixture = new MockHostClient({ latencyMs: 0 });
const base = fixture.getSnapshot();
fixture.dispose();
it("offers held personal tasks/automations/computers and preserves explicit context inclusion", () => {
  const task = {
    ...base.threads[0]!,
    id: createId("thread"),
    purpose: "task" as const,
    title: "Recent ferry",
  };
  const automation = {
    id: createId("trigger"),
    name: "Ferry schedule",
    kind: "schedule" as const,
    paused: false,
    ended: false,
    taskId: null,
    nextFireAt: null,
  };
  const machine = { ...base.machines[0]!, id: createId("runner"), name: "Ferry computer" };
  const snapshot = {
    ...base,
    threads: [task],
    tasks: null,
    activeTasks: [],
    doneTasks: {},
    threadAutomations: { [task.id]: [automation] },
    machines: [machine],
  };
  const candidates = composerReferenceCandidates(
    { kind: "personal", snapshot, places: [] },
    "ferry",
  );
  expect(candidates.map(({ kind }) => kind)).toEqual(["link", "link", "link"]);
  expect(candidates.map((candidate) => candidate.kind === "link" && candidate.markdown)).toEqual([
    `[Recent ferry](opensteer:${task.id})`,
    `[Ferry schedule](opensteer:${automation.id})`,
    `[Ferry computer](opensteer:${machine.id})`,
  ]);
  const context = composerReferenceCandidates(base, "").filter(({ kind }) => kind === "place");
  expect(context.length).toBeGreaterThan(0);
  expect(context.every(({ category }) => category === "Include context")).toBe(true);
});
it("filters loaded Recent tasks locally, deduplicates, and exposes More even with no title match", () => {
  const thread = { ...base.threads[0]!, id: createId("thread"), title: "Loaded" };
  const window = { hasMore: true, nextBefore: null, totalItems: 100, itemCount: 1, byteCount: 100 };
  const snapshot = {
    ...base,
    threads: [thread],
    activeTasks: [{ thread, failure: null, lastReply: null }],
    tasks: { entries: [{ thread, failure: null, lastReply: null }], window, sequence: "1" },
    doneTasks: {},
  };
  const loaded = composerReferenceCandidates({ kind: "personal", snapshot, places: [] }, "loaded");
  expect(loaded.filter(({ key }) => key === thread.id)).toHaveLength(1);
  expect(
    composerReferenceCandidates({ kind: "personal", snapshot, places: [] }, "not loaded anywhere"),
  ).toEqual([
    {
      kind: "more",
      key: "more:recent",
      label: "More",
      category: "Recent tasks",
      list: "recent",
      before: null,
    },
  ]);
});
it("keeps team URLs and mention intent separate, with no personal items or file browsing", () => {
  const topicId = createId("knowledgeTopic"),
    noteId = createId("knowledgeNote");
  const result = composerReferenceCandidates(
    {
      kind: "team",
      snapshot: {
        origin: "https://team.example",
        topics: [{ id: topicId, name: "Ferry" }],
        notes: [{ id: noteId, topicId, title: "Timetable" }],
      },
      people: [{ userId: createId("user"), displayName: "Maya", handle: "maya", state: "active" }],
      agents: [{ key: "maya", label: "Maya's agent", handle: "maya-agent" }],
    },
    "",
  );
  expect(result.map(({ kind }) => kind)).toEqual(["link", "link", "mention", "mention"]);
  expect(result.filter((row) => row.kind === "link").map(({ markdown }) => markdown)).toEqual([
    `[Ferry](https://team.example/knowledge/${topicId})`,
    `[Timetable](https://team.example/knowledge/${topicId}?note=${noteId})`,
  ]);
  expect(
    result.some(
      (candidate) => candidate.kind === "link" && candidate.markdown.includes("opensteer:"),
    ),
  ).toBe(false);
  expect(result.filter((row) => row.kind === "mention").map(({ actor }) => actor)).toEqual([
    "human",
    "agent",
  ]);
});
