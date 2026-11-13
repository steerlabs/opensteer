import { createId } from "@opensteer/core";
import {
  knowledge_write,
  thread_read,
  thread_send,
  trigger_write,
  team_search,
  team_read,
} from "./tools/index.js";
import { expect, it } from "vitest";
import { z } from "zod";
import { agentTools, platformGuideForRun, toolsFor, connectionInstructions } from "./index.js";
it("lists standing team tools when the owner has a link, and never for non-Run callers", () => {
  const names = (
    kind: "run" | "program" | "connection",
    teamsAvailable: boolean,
    knowledge = teamsAvailable,
  ) => toolsFor({ kind, teamsAvailable, knowledge, accessMode: "full-access" }).map((t) => t.name);
  for (const name of ["team_read", "team_search", "team_post"]) {
    expect(names("run", true)).toContain(name);
    expect(names("run", false, true)).not.toContain(name);
    expect(names("program", true)).not.toContain(name);
    expect(names("connection", true)).not.toContain(name);
  }
  // Knowledge follows the owner into private Runs, never into programs or connections.
  for (const name of ["knowledge_topics", "knowledge_read", "knowledge_write"]) {
    expect(names("run", false, true)).toContain(name);
    expect(names("run", true, false)).not.toContain(name);
    expect(names("program", true)).not.toContain(name);
    expect(names("connection", true)).not.toContain(name);
  }
  for (const old of ["project_list", "project_create", "project_write"])
    expect(names("run", true)).not.toContain(old);
  expect(thread_read.input.safeParse({ threadId: "home" }).success).toBe(false);
  expect(
    thread_send.input.safeParse({ threadId: "home", delivery: "queue", message: "go" }).success,
  ).toBe(false);
  expect(trigger_write.input.safeParse({ action: "create", anchorThreadId: "home" }).success).toBe(
    false,
  );
});
it("snapshots the personal/team guide and model-facing inventory", () => {
  const guides = {
    ordinary: platformGuideForRun({ purpose: "task" }),
    team: platformGuideForRun({ purpose: "task", teamsAvailable: true, knowledge: true }),
    connection: connectionInstructions,
  };
  expect(guides).toMatchSnapshot();
  expect(
    agentTools.map((tool) => ({
      name: tool.name,
      callers: tool.callers,
      access: tool.access,
      input: z.toJSONSchema(tool.input, { io: "input" }),
    })),
  ).toMatchSnapshot();
});

it("requires provenance on empty team search results", () => {
  expect(team_search.output.safeParse({ results: [], hasMore: false }).success).toBe(true);
});

it("accepts exactly the add, change and delete shapes of a knowledge write", () => {
  const topicId = createId("knowledgeTopic");
  const noteId = createId("knowledgeNote");
  const valid = (input: object) => knowledge_write.input.safeParse(input).success;
  expect(valid({ topicId, title: "Refunds", body: "Within 30 days." })).toBe(true);
  expect(valid({ noteId, version: 2, body: "Within 14 days." })).toBe(true);
  expect(valid({ noteId, version: 2, delete: true })).toBe(true);
  // A change without the version read would overwrite blind; a delete never carries text.
  expect(valid({ noteId, body: "Within 14 days." })).toBe(false);
  expect(valid({ noteId, version: 2, delete: true, body: "x" })).toBe(false);
  // A change stays in its topic; a new note always names one.
  expect(valid({ noteId, version: 2, topicId, body: "x" })).toBe(false);
  expect(valid({ title: "Refunds", body: "Within 30 days." })).toBe(false);
});

it("keeps team read destinations and paging selectors compatible", () => {
  const channelId = createId("teamChannel"),
    fileId = createId("teamBlob");
  expect(team_read.input.safeParse({ channelId, before: "10", after: "11" }).success).toBe(false);
  expect(team_read.input.safeParse({ fileId, channelId }).success).toBe(false);
  expect(team_read.input.safeParse({ after: "11" }).success).toBe(false);
  expect(
    team_read.input.safeParse({ teamId: createId("deployment"), after: channelId }).success,
  ).toBe(true);
  expect(team_read.input.safeParse({ channelId, after: "11" }).success).toBe(true);
});
