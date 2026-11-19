import { expect, it, vi } from "vitest";
import { createId, type RunId } from "../packages/core/src/index.js";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { TeamRunEvents } from "../apps/host/src/runtime/team-run-events.js";

const finished = (runId: RunId) => ({
  type: "runFinished" as const,
  runId,
  threadId: createId("thread"),
  attemptId: null,
  bindingGeneration: null,
  outcome: "completed" as const,
});

it("serializes and coalesces Run changes while retaining only safe step kinds and counts", async () => {
  const runId = createId("run"),
    gate = Promise.withResolvers<void>(),
    started = Promise.withResolvers<void>();
  const updates: unknown[] = [];
  const onError = vi.fn();
  let active = 0,
    maximum = 0;
  const publisher = new TeamRunEvents({
    publish: async (id, steps) => {
      active += 1;
      maximum = Math.max(maximum, active);
      updates.push({ id, steps });
      if (updates.length === 1) {
        started.resolve();
        await withTimeout(gate.promise, 1000, {
          timeoutError: () => new Error("Run publication was never released"),
        });
      }
      active -= 1;
    },
    onError,
  });
  publisher.observe({ type: "teamStep", runId, toolName: "browser_open", isIntegration: false });
  await withTimeout(started.promise, 1000, {
    timeoutError: () => new Error("Run publication never started"),
  });
  publisher.observe({
    type: "teamStep",
    runId,
    toolName: "opensteer_team_search",
    isIntegration: false,
  });
  publisher.observe({ type: "runChanged", runId });
  publisher.observe({
    type: "requestChanged",
    requestId: createId("request"),
    threadId: createId("thread"),
    kind: "harness.approval",
    status: "pending",
    opened: true,
    runId,
  });
  publisher.observe(finished(runId));
  gate.resolve();
  await publisher.close();
  expect(maximum).toBe(1);
  expect(onError).not.toHaveBeenCalled();
  expect(updates).toEqual([
    { id: runId, steps: [{ kind: "browsed", count: 1 }] },
    {
      id: runId,
      steps: [
        { kind: "browsed", count: 1 },
        { kind: "searched_team", count: 1 },
        { kind: "asked_you", count: 1 },
      ],
    },
  ]);
});

it("still reconciles a terminal event after a publication fails and stops on close", async () => {
  const runId = createId("run"),
    onError = vi.fn();
  let publisher: TeamRunEvents;
  const publish = vi.fn(async () => {
    if (publish.mock.calls.length === 1) {
      publisher.observe(finished(runId));
      throw new Error("private response sentinel");
    }
  });
  publisher = new TeamRunEvents({ publish, onError });
  publisher.observe({ type: "runChanged", runId });
  await publisher.close();
  expect(publish).toHaveBeenCalledTimes(2);
  expect(onError).toHaveBeenCalledExactlyOnceWith();
  publisher.observe(finished(runId));
  expect(publish).toHaveBeenCalledTimes(2);
});
