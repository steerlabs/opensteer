import { describe, expect, it } from "vitest";
import { toolsFor, opensteerAgentSkillNames } from "@opensteer/agent-tools";
import { RunAgentToolsPlanSchema } from "@opensteer/protocol";
import { agentToolsPlanForRun } from "./agent-tools-plan.js";

describe("Host Run tools plan", () => {
  it("ships the registry's Run inventory with role and reach instructions and bundled skills", () => {
    const input = {
      url: "https://host.test/internal/v1/mcp",
      token: "run-token",
      role: "work" as const,
      accessMode: "full-access" as const,
      reach: "workspace" as const,
    };
    const plan = agentToolsPlanForRun(input);
    expect(RunAgentToolsPlanSchema.parse(plan)).toEqual(plan);
    expect(plan.tools).toEqual(
      toolsFor({ kind: "run", accessMode: input.accessMode, reach: { kind: input.reach } }).map(
        ({ name }) => name,
      ),
    );
    expect(plan.tools).toContain("integration_call");
    const cautious = agentToolsPlanForRun({ ...input, accessMode: "approval-required" });
    expect(cautious.tools).not.toContain("settings_write");
    expect(cautious.toolsRevision).not.toBe(plan.toolsRevision);
    expect(agentToolsPlanForRun({ ...input, reach: "lineage" }).tools).not.toContain(
      "computer_list",
    );
    expect(plan.skills).toEqual(
      opensteerAgentSkillNames.filter(
        (name) => name !== "opensteer:memory" && name !== "opensteer:knowledge",
      ),
    );
    expect(plan.instructions).toContain("Role: work");
    expect(plan.instructions).not.toContain("opensteer:projects");
    expect(agentToolsPlanForRun({ ...input, token: "refreshed" }).toolsRevision).toBe(
      plan.toolsRevision,
    );
    const chat = agentToolsPlanForRun({ ...input, role: "conversation" });
    expect(chat.instructions).toContain("Keep Chat responsive");
    expect(chat.toolsRevision).not.toBe(plan.toolsRevision);
    const main = agentToolsPlanForRun({ ...input, reach: "user" });
    expect(main.instructions).toContain("opensteer:projects");
    expect(main.skills).toEqual(
      opensteerAgentSkillNames.filter((name) => name !== "opensteer:knowledge"),
    );
    expect(agentToolsPlanForRun({ ...input, reach: "lineage" }).skills).not.toContain(
      "opensteer:memory",
    );
    expect(main.toolsRevision).not.toBe(plan.toolsRevision);
    // Profiles belong to the person: agents ask for one and never create it themselves.
    expect(main.tools).toContain("browser_profile_request");
    expect(main.tools).not.toContain("browser_profile_create");
    expect(agentToolsPlanForRun({ ...input, reach: "lineage" }).instructions).toContain(
      "PLUGIN_DATA",
    );
    expect(
      RunAgentToolsPlanSchema.safeParse({
        ...plan,
        tools: Array.from({ length: 257 }, (_, i) => `tool_${i}`),
      }).success,
    ).toBe(false);
    expect(
      RunAgentToolsPlanSchema.safeParse({ ...plan, tools: ["duplicate", "duplicate"] }).success,
    ).toBe(false);
  });
});

it("offers sql and its skill only to Main-inheriting Runs on a Host serving the trial", () => {
  const input = {
    url: "https://host.test/mcp",
    token: "token",
    role: "conversation",
    accessMode: "full-access",
  } as const;
  const offered = (reach: "user" | "workspace" | "lineage", knowledge: boolean) => {
    const plan = agentToolsPlanForRun({ ...input, reach, knowledge });
    return [plan.tools.includes("sql"), plan.skills.includes("opensteer:knowledge")];
  };
  expect(offered("user", true)).toEqual([true, true]);
  expect(offered("user", false)).toEqual([false, false]);
  expect(offered("workspace", true)).toEqual([false, false]);
  expect(offered("lineage", true)).toEqual([false, false]);
  for (const kind of ["program", "connection"] as const)
    expect(
      toolsFor({ kind, accessMode: "full-access", reach: { kind: "user" }, knowledge: true }).map(
        ({ name }) => name,
      ),
    ).not.toContain("sql");
});

it("gives a call every tool, and tells it replies are spoken", () => {
  const input = {
    url: "https://host.test/mcp",
    token: "token",
    role: "conversation",
    accessMode: "full-access",
    reach: "user",
  } as const;
  const plan = agentToolsPlanForRun({ ...input, voiceCall: true });
  expect(plan.tools).toEqual(agentToolsPlanForRun(input).tools);
  expect(plan.instructions).toContain("Voice call:");
});
