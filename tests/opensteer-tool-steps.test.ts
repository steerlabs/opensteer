import { z } from "zod";
import { mcpPresentationTool } from "../packages/client/src/test-support/mcp-presentation-scenarios.js";
import { expect, it } from "vitest";
import { agentTools } from "../packages/agent-tools/src/tools/index.js";
import {
  humanizeToolName,
  toolPresentation,
} from "../packages/client/src/host/agent-activity-model.js";

// Failure mode: a tool added to the catalog reaches a person's transcript as
// its own name ("Browser tab write") with its first argument beside it.
it("reads every Opensteer product tool as what it did, never by its name", () => {
  const names = agentTools.map(({ name }) => name);
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

// New actions must not silently fall back to the generic tool summary.
it("names every current administration and Thread action in running and completed rows", () => {
  const names = new Set([
    "project_write",
    "settings_write",
    "computer_write",
    "integration_manage",
    "channel_manage",
    "plugin_manage",
    "browser_profile_write",
    "thread_update",
    "thread_configure",
    "thread_queue",
  ]);
  for (const spec of agentTools) {
    if (!names.has(spec.name) || !("action" in spec.input.shape)) continue;
    const action = spec.input.shape.action;
    if (!(action instanceof z.ZodEnum)) throw new Error(`${spec.name} needs action coverage`);
    const fallback = toolPresentation(mcpPresentationTool(spec.name, {}, true));
    for (const value of action.options) {
      const presentation = toolPresentation(
        mcpPresentationTool(spec.name, { action: value }, true),
      );
      expect(presentation.activeLabel, `${spec.name}:${value}`).not.toBe(fallback.activeLabel);
      expect(presentation.label, `${spec.name}:${value}`).not.toBe(fallback.label);
    }
  }
});

it.each([["browser_profile_save", "Saving the browser profile", "Saved the browser profile"]])(
  "keeps removed %s calls readable",
  (name, active, done) => {
    const presentation = toolPresentation(mcpPresentationTool(name, {}, false));
    expect(presentation.activeLabel).toBe(active);
    expect(presentation.label).toBe(done);
  },
);
