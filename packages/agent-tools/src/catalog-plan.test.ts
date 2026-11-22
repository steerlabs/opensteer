import {
  opensteer_task_read,
  opensteer_task_send,
  opensteer_automation_create,
} from "./tools/index.js";
import { expect, it } from "vitest";
import { z } from "zod";
import { agentTools, platformGuideForRun, toolsFor, connectionInstructions } from "./index.js";
it("never lists retired project tools and keeps task selectors strict", () => {
  const names = (kind: "run" | "program" | "connection") =>
    toolsFor({ kind, accessMode: "full-access" }).map((t) => t.name);
  for (const old of ["project_list", "project_create", "project_write"])
    expect(names("run")).not.toContain(old);
  expect(opensteer_task_read.input.safeParse({ threadId: "home" }).success).toBe(false);
  expect(
    opensteer_task_send.input.safeParse({ threadId: "home", delivery: "queue", message: "go" })
      .success,
  ).toBe(false);
  expect(
    opensteer_automation_create.input.safeParse({ action: "create", anchorThreadId: "home" })
      .success,
  ).toBe(false);
});
const allCapabilities = { tabs: true, pages: true, computerUse: true, apps: true };
it("snapshots the personal guide and model-facing inventory", () => {
  const guides = {
    ordinary: platformGuideForRun({ purpose: "task", capabilities: allCapabilities }),
    connection: connectionInstructions,
  };
  expect(guides).toMatchSnapshot();
  expect(
    agentTools.map((tool) => ({
      name: tool.name,
      callers: tool.callers,
      access: tool.access,
      description: tool.description,
      input: z.toJSONSchema(tool.input, { io: "input" }),
    })),
  ).toMatchSnapshot();
});
