import { createId } from "@opensteer/core";
import { expect, it, vi } from "vitest";
import { TeamRunEvents } from "./team-run-events.js";

it("publishes the typed Request, integration and finish reactions to the team status writer", async () => {
  const runId = createId("run");
  const threadId = createId("thread");
  const request = {
    type: "requestChanged",
    kind: "plugin.input",
    requestId: createId("request"),
    runId,
    threadId,
  } as const;
  const publish = vi.fn(async () => {});
  const onError = vi.fn();
  const events = new TeamRunEvents({ publish, onError });
  events.observe({ ...request, opened: true, status: "pending" });
  events.observe({ ...request, opened: false, status: "fulfilled" });
  events.observe({ type: "teamStep", runId, toolName: "pair", isIntegration: true });
  events.observe({
    type: "runFinished",
    runId,
    threadId,
    attemptId: createId("runAttempt"),
    bindingGeneration: 1,
    outcome: "completed",
  });
  await events.close();
  expect(onError).not.toHaveBeenCalled();
  expect(publish.mock.calls).toEqual([
    [runId, [{ kind: "asked_you", count: 1 }]],
    [
      runId,
      [
        { kind: "asked_you", count: 1 },
        { kind: "used_integration", count: 1 },
      ],
    ],
  ]);
});
