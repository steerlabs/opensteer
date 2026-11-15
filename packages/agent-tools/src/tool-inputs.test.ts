import { describe, it, expect } from "vitest";
import { createId } from "@opensteer/core";
import { z } from "zod";
import { agentTools, type AgentToolName } from "./tools/index.js";
function tool(name: AgentToolName) {
  const spec = agentTools.find((t) => t.name === name);
  if (!spec) throw new Error(name);
  return spec;
}
describe("Opensteer tool inputs", () => {
  it("accepts the current Run place without caller-supplied native identities", () => {
    const schema = tool("show_to_person").input;
    expect(schema.parse({ target: { current: true } })).toEqual({ target: { current: true } });
    expect(schema.safeParse({ target: { current: false } }).success).toBe(false);
    expect(schema.safeParse({ target: { current: true, tabId: "another-tab" } }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({
        target: { place: { kind: "phone", machineId: "arbitrary", display: "main" } },
      }).success,
    ).toBe(false);
  });
  it("refuses the removed home alias", () => {
    expect(tool("opensteer_task_read").input.safeParse({ taskId: "home", limit: 1 }).success).toBe(
      false,
    );
  });
  it("names exactly one conversation, subagent or task target", () => {
    const subagentId = createId("executionNode");
    const delegationId = createId("delegation");
    const read = tool("opensteer_task_read").input;
    const cancel = tool("opensteer_delegation_cancel").input;
    expect(tool("opensteer_subagent_read").input.safeParse({ subagentId }).success).toBe(true);
    expect(read.safeParse({}).success).toBe(true);
    expect(read.safeParse({ taskId: "home", subagentId }).success).toBe(false);
    expect(read.safeParse({ subagentId, query: "text" }).success).toBe(false);
    expect(tool("opensteer_subagent_stop").input.safeParse({ subagentId }).success).toBe(true);
    expect(cancel.safeParse({ delegationId }).success).toBe(true);
    expect(cancel.safeParse({}).success).toBe(false);
    expect(cancel.safeParse({ delegationId, subagentId }).success).toBe(false);
  });
  it("requires itemId for text offsets and refuses removed history fields", () => {
    const schema = tool("opensteer_task_read").input;
    expect(schema.safeParse({ taskId: "home", textOffset: 2 }).success).toBe(false);
    expect(schema.safeParse({ itemId: "item", textOffset: 2 }).success).toBe(true);
    expect(schema.safeParse({ itemId: "item", before: "cursor" }).success).toBe(false);
    expect(schema.safeParse({ taskId: "home", maxMessages: 1 }).success).toBe(false);
    expect(schema.safeParse({ taskId: "home", view: "activity", query: "text" }).success).toBe(
      false,
    );
  });
  it("keeps both Trigger tool input schemas union-free", () => {
    for (const name of ["opensteer_automation_list", "opensteer_automation_create"] as const) {
      const json = JSON.stringify(
        z.toJSONSchema(tool(name).input, { io: "input", target: "draft-7" }),
      );
      expect(json).not.toContain('"anyOf"');
      expect(json).not.toContain('"oneOf"');
    }
  });
  it("requires an explicit thread message delivery policy", () => {
    const schema = tool("opensteer_task_send").input;
    const base = {
      message: "A self-contained update",
      taskId: "thr_00000000-0000-4000-a000-000000000000",
    };

    expect(schema.safeParse(base).success).toBe(false);
    expect(schema.safeParse({ ...base, delivery: "report" }).success).toBe(true);
    expect(schema.safeParse({ ...base, delivery: "queue" }).success).toBe(true);
    expect(schema.safeParse({ ...base, delivery: "steer" }).success).toBe(true);
    expect(schema.safeParse({ ...base, delivery: "trigger" }).success).toBe(false);
    expect(schema.safeParse({ ...base, delivery: "turn" }).success).toBe(false);
    expect(schema.safeParse({ ...base, delivery: "notify" }).success).toBe(false);
  });
  it("requires version 4 for authored automation programs", () => {
    const input = tool("opensteer_automation_create").input;
    for (const version of [1, 2, 3])
      expect(
        input.safeParse({
          name: "test",
          program: {
            language: "javascript",
            source: "export default () => {}",
            toolContractVersion: version,
          },
          source: { kind: "webhook" },
        }).success,
      ).toBe(false);
  });
});
