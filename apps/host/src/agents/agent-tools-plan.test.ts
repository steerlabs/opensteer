import { describe, expect, it } from "vitest";
import { agentToolDefinitions, opensteerAgentSkills } from "@opensteer/agent-tools";
import { integrationGatewayToolNames } from "@opensteer/integration-core";
import { RunAgentToolsPlanSchema } from "@opensteer/protocol";
import { agentToolsPlanForRun } from "./agent-tools-plan.js";

describe("Host Run tools plan", () => {
  it("ships one complete inventory with role instructions and bundled skills", () => {
    const input = {
      url: "https://host.test/internal/v1/mcp",
      token: "run-token",
      role: "work" as const,
    };
    const plan = agentToolsPlanForRun(input);
    expect(RunAgentToolsPlanSchema.parse(plan)).toEqual(plan);
    expect(plan.tools).toEqual([
      ...agentToolDefinitions.map(({ name }) => name),
      ...integrationGatewayToolNames,
    ]);
    expect(plan.skills).toEqual(opensteerAgentSkills.map(({ name }) => name));
    expect(plan.instructions).toContain("Role: work");
    expect(agentToolsPlanForRun({ ...input, token: "refreshed" }).toolsRevision).toBe(
      plan.toolsRevision,
    );
    const chat = agentToolsPlanForRun({ ...input, role: "conversation" });
    expect(chat.instructions).toContain("Keep Chat responsive");
    expect(chat.toolsRevision).not.toBe(plan.toolsRevision);
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
