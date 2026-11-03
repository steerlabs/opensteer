import { describe, it, expect } from "vitest";
import { z } from "zod";
import { agentTools, type AgentToolName } from "./tools/index.js";
function tool(name: AgentToolName) {
  const spec = agentTools.find((t) => t.name === name);
  if (!spec) throw new Error(name);
  return spec;
}
describe("Opensteer tool inputs", () => {
  it("accepts the current Run place without caller-supplied native identities", () => {
    const schema = tool("person_show").input;
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
  it("keeps browser session identity explicit", () => {
    const schema = tool("browser_session_open").input;
    expect(schema.safeParse({ fresh: true }).success).toBe(true);
    expect(
      schema.safeParse({ profileId: "bpr_00000000-0000-4000-a000-000000000000" }).success,
    ).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
    expect(
      schema.safeParse({
        fresh: true,
        sessionId: "bsn_00000000-0000-4000-a000-000000000000",
      }).success,
    ).toBe(false);
  });
  it("lets a browser session name the machine that runs it", () => {
    const schema = tool("browser_session_open").input;
    expect(
      schema.safeParse({
        environmentId: "env_00000000-0000-4000-a000-000000000000",
        fresh: true,
      }).success,
    ).toBe(true);
    // A machine is not an identity, so naming one still leaves the identity
    // choice required.
    expect(
      schema.safeParse({ environmentId: "env_00000000-0000-4000-a000-000000000000" }).success,
    ).toBe(false);
    expect(schema.safeParse({ environmentId: "runner-1", fresh: true }).success).toBe(false);
  });
  it("keeps both Trigger tool input schemas union-free", () => {
    for (const name of ["trigger_read", "trigger_write"] as const) {
      const json = JSON.stringify(
        z.toJSONSchema(tool(name).input, { io: "input", target: "draft-7" }),
      );
      expect(json).not.toContain('"anyOf"');
      expect(json).not.toContain('"oneOf"');
    }
  });
  it("requires an explicit thread message delivery policy", () => {
    const schema = tool("thread_message").input;
    const base = {
      message: "A self-contained update",
      threadId: "thr_00000000-0000-4000-a000-000000000000",
    };

    expect(schema.safeParse(base).success).toBe(false);
    expect(schema.safeParse({ ...base, delivery: "report" }).success).toBe(true);
    expect(schema.safeParse({ ...base, delivery: "queue" }).success).toBe(true);
    expect(schema.safeParse({ ...base, delivery: "steer" }).success).toBe(true);
    expect(schema.safeParse({ ...base, delivery: "trigger" }).success).toBe(false);
    expect(schema.safeParse({ ...base, delivery: "turn" }).success).toBe(false);
    expect(schema.safeParse({ ...base, delivery: "notify" }).success).toBe(false);
  });
  it("loads the Trigger contract only for program authoring, not timing controls", () => {
    const write = tool("trigger_write");
    expect(write.description).toContain(
      "Before writing or changing a program, load opensteer:triggers",
    );
    expect(write.description).not.toContain("Trigger programs execute as Node.js ESM modules");
    const schema = JSON.stringify(write.input.toJSONSchema({ io: "input" }));
    expect(schema).not.toContain("Trigger programs execute as Node.js ESM modules");
    expect(schema).toContain('"toolContractVersion"');
    for (const requirement of [
      "Timing controls require anchor access no higher than yours",
      "archiving require full access",
      "set_status needs triggerId and status",
      "set_next_fire needs triggerId and future ISO nextFireAt",
      "run needs a non-archived schedule/webhook triggerId",
      "cancel needs triggerId and optional occurrenceId",
      "Started work keeps running",
    ]) {
      expect(write.description).toContain(requirement);
    }
  });
});
