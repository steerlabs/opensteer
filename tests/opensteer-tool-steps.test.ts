import { expect, it } from "vitest";
import { agentTools, integrationTools } from "../packages/agent-tools/src/tools/index.js";
import {
  humanizeToolName,
  toolPresentation,
} from "../packages/client/src/host/agent-activity-model.js";

// Failure mode: a tool added to the catalog reaches a person's transcript as
// its own name ("Browser tab write") with its first argument beside it.
it("reads every Opensteer product tool as what it did, never by its name", () => {
  const gateways = new Set<string>(integrationTools.map(({ name }) => name));
  const names = agentTools.filter(({ name }) => !gateways.has(name)).map(({ name }) => name);
  for (const name of names) {
    const presentation = toolPresentation({
      arguments: {},
      callId: `call-${name}`,
      completedAt: null,
      createdAt: "2026-10-30T15:47:00.000Z",
      id: `tool:run:${name}`,
      integration: null,
      isError: false,
      kind: "tool",
      output: undefined,
      runId: "run",
      state: "running",
      streamText: "",
      tool: { name, namespace: "opensteer" },
    });
    expect(presentation.label, name).not.toBe(humanizeToolName(name));
    expect(presentation.activeLabel, name).not.toBe(humanizeToolName(name));
  }
});
