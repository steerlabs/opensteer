import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { agentTools } from "@opensteer/agent-tools";
import { parseCases } from "./cases.js";
import { grade } from "./grader.js";

const cases = parseCases(
  await readFile(new URL("./cases/orchestration.ndjson", import.meta.url), "utf8"),
);

describe("Project decision corpus", () => {
  it.each([
    ["work-personal-separation-creates-project", "project_create", "delegate_task"],
    ["one-off-task-does-not-create-project", "delegate_task", "project_create"],
  ])("requires the intended boundary in %s", (id, required, wrong) => {
    const testCase = cases.find((value) => value.id === id)!;
    const expected = testCase.expect.calls.find((value) => value.tool === required)!;
    const tool = agentTools
      .filter((tool) => tool.callers.some((kind) => kind === "run"))
      .find((value) => value.name === required)!;
    const args =
      required === "delegate_task"
        ? { workspaceId: "wsp_00000000-0000-4000-8000-000000000001", task: "Compare vendors" }
        : expected.args;
    expect(tool.input.safeParse(args).success).toBe(true);
    expect(
      grade(testCase.expect, [{ tool: required, args, valid: true }], "").every(
        (check) => check.pass,
      ),
    ).toBe(true);
    expect(
      grade(testCase.expect, [{ tool: wrong, args: {}, valid: true }], "").every(
        (check) => check.pass,
      ),
    ).toBe(false);
  });
});
