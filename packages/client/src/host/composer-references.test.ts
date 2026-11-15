import { expect, it } from "vitest";
import { createId } from "@opensteer/core";
import { MockHostClient } from "../mock/mock-host-client.js";
import { composerReferenceCandidates, teamReferenceCandidates } from "./composer-references.js";

const fixture = new MockHostClient({ latencyMs: 0 });
const base = fixture.getSnapshot();
fixture.dispose();
it("offers held personal tasks, automations and computers once each", () => {
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
    activeTasks: [{ thread: task, failure: null, lastReply: null }],
    doneTasks: {},
    threadAutomations: { [task.id]: [automation] },
    machines: [machine],
  };
  expect(composerReferenceCandidates(snapshot, "ferry").map(({ markdown }) => markdown)).toEqual([
    `[Recent ferry](opensteer:${task.id})`,
    `[Ferry schedule](opensteer:${automation.id})`,
    `[Ferry computer](opensteer:${machine.id})`,
  ]);
});
it("offers team channels and knowledge as team URLs, never DMs, archived pages or personal links", () => {
  const channelId = createId("teamChannel"),
    topicId = createId("knowledgeTopic"),
    noteId = createId("knowledgeNote");
  const team = {
    origin: "https://team.example",
    channels: [
      { id: channelId, kind: "public" as const, name: "ferry-ops", archivedAt: null },
      { id: createId("teamChannel"), kind: "dm" as const, name: "ferry", archivedAt: null },
      {
        id: createId("teamChannel"),
        kind: "public" as const,
        name: "ferry-old",
        archivedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    topics: [
      { id: topicId, name: "Ferry", archivedAt: null },
      { id: createId("knowledgeTopic"), name: "Buses", archivedAt: null },
    ],
    // The team already searched notes for this query; a body match keeps its title.
    notes: [{ id: noteId, topicId, title: "Timetable" }],
  };
  const result = teamReferenceCandidates(team, "ferry");
  expect(result.map(({ markdown }) => markdown)).toEqual([
    `[ferry-ops](https://team.example/c/${channelId})`,
    `[Ferry](https://team.example/knowledge/${topicId})`,
    `[Timetable](https://team.example/knowledge/${topicId}?note=${noteId})`,
  ]);
  expect(result.map(({ category }) => category)).toEqual(["Channels", "Knowledge", "Knowledge"]);
  expect(teamReferenceCandidates(team, "")).toHaveLength(4);
});
