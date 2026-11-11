import { createId } from "@opensteer/core";
import { expect, it } from "vitest";
import { projectHarnessSession } from "./project-session.js";
import type {
  EngineHarnessSession,
  ProjectHarnessEvent,
  ProjectHarnessSessionContext,
} from "./types.js";

it("withholds person-only subagent stopping from the Project session and its events", async () => {
  const nodeId = createId("executionNode");
  const engine: EngineHarnessSession = {
    providerSessionReference: "native",
    events: (async function* () {
      yield {
        type: "node.started" as const,
        data: {
          nodeId,
          kind: "subagent" as const,
          model: null,
          nativeRef: "child",
          originCallId: null,
          parentNodeId: null,
          prompt: null,
          sessionRef: null,
          title: "Child",
          stopSupported: true,
        },
      };
      yield {
        type: "node.updated" as const,
        data: { nodeId, stopSupported: true, stopping: true },
      };
    })(),
    execute: async () => {},
    interrupt: async () => {},
    resolveRequest: async () => {},
    refuseRequest: async () => {},
    stop: async () => {},
    stopNode: async () => {},
  };
  const session = projectHarnessSession(engine, {} as ProjectHarnessSessionContext);
  expect("stopNode" in session).toBe(false);
  const events: ProjectHarnessEvent[] = [];
  for await (const event of session.events) events.push(event);
  expect(events.map((event) => event.data)).toEqual([
    expect.objectContaining({ nodeId, stopSupported: false }),
    { nodeId, stopSupported: false },
  ]);
});
