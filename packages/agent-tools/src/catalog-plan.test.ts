import {
  delegate_task,
  thread_read,
  thread_send,
  trigger_write,
  team_search,
  sql,
} from "./tools/index.js";
import { expect, it } from "vitest";
import { z } from "zod";
import { agentTools, platformGuideForRun, toolsFor, connectionInstructions } from "./index.js";
import { createId } from "@opensteer/core";
it("keeps the permanent team inventory out of ordinary tasks and every non-Run caller", () => {
  const names = (kind: "run" | "program" | "connection", teamBound: boolean) =>
    toolsFor({ kind, teamBound, accessMode: "full-access" }).map((t) => t.name);
  for (const name of ["team_read", "team_search", "team_reply", "sql"]) {
    expect(names("run", true)).toContain(name);
    expect(names("run", false)).not.toContain(name);
    expect(names("program", true)).not.toContain(name);
    expect(names("connection", true)).not.toContain(name);
  }
  for (const old of ["project_list", "project_create", "project_write"])
    expect(names("run", true)).not.toContain(old);
  expect(
    delegate_task.input.parse({
      task: "work",
      folder: { computerId: createId("runner"), path: "/chosen" },
    }).folder?.path,
  ).toBe("/chosen");
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
    team: platformGuideForRun({ purpose: "task", teamBound: true }),
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

it("requires provenance on empty team search and knowledge results", () => {
  expect(team_search.output.safeParse({ results: [], hasMore: false }).success).toBe(false);
  expect(
    sql.output.safeParse({ columns: [], rows: [], sources: [], truncated: false }).success,
  ).toBe(false);
});
