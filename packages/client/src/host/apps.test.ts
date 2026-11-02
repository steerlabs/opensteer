import { createId, AgentEventViewSchema, SequenceSchema } from "@opensteer/core";
import { expect, it } from "vitest";
import { foldTranscriptEvent } from "./transcript.js";
import { conversationRows, groupTranscriptEntries } from "./agent-activity-model.js";
it("restores an app at each publication point, idempotently, including conversation mode", () => {
  const event = AgentEventViewSchema.parse({
    type: "app.published",
    eventId: createId("event"),
    sequence: "1",
    workspaceId: createId("workspace"),
    threadId: createId("thread"),
    environmentId: createId("environment"),
    runId: createId("run"),
    createdAt: new Date().toISOString(),
    data: { appId: "app_11111111-1111-4111-8111-111111111111", version: 1, title: "Budget" },
  });
  if (event.type !== "app.published") throw new Error("Expected app publication");
  const first = foldTranscriptEvent([], event);
  expect(foldTranscriptEvent(first, event)).toEqual(first);
  expect(first[0]).toMatchObject({
    kind: "app",
    appId: event.data.appId,
    version: 1,
    title: "Budget",
    runId: event.runId,
  });
  const next = foldTranscriptEvent(first, {
    ...event,
    eventId: createId("event"),
    sequence: SequenceSchema.parse("2"),
    data: { ...event.data, version: 2 },
  });
  const rows = conversationRows(groupTranscriptEntries(next), {
    live: true,
    atComputer: () => false,
  });
  expect(rows.map((row) => row.group.kind)).toEqual(["app", "app"]);
  expect(rows.map((row) => row.key)).toEqual(next.map((entry) => entry.id));
});
