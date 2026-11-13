import { expect, it, vi } from "vitest";
import { createId, type AgentEvent, type RunId } from "../packages/core/src/index.js";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { TeamRunEvents } from "../apps/host/src/runtime/team-run-events.js";

const event = (runId: RunId, type: string, data: unknown = {}): AgentEvent =>
  ({ runId, type, data }) as unknown as AgentEvent;

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
  publisher.observe(
    event(runId, "tool.started", {
      tool: { namespace: "opensteer", name: "browser_open" },
      arguments: { path: "/private/sentinel", token: "credential-sentinel" },
    }),
  );
  await withTimeout(started.promise, 1000, {
    timeoutError: () => new Error("Run publication never started"),
  });
  publisher.observe(
    event(runId, "tool.started", {
      tool: { namespace: "opensteer", name: "team_search" },
      arguments: { query: "private query sentinel" },
    }),
  );
  publisher.observe(event(runId, "run.delivery-updated", { delivery: { state: "sent" } }));
  publisher.observe(event(runId, "request.opened", { prompt: "private question sentinel" }));
  publisher.observe(event(runId, "run.completed", { reply: "private answer sentinel" }));
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
  expect(JSON.stringify(updates)).not.toContain("sentinel");
});

it("still reconciles a terminal event after a publication fails and stops on close", async () => {
  const runId = createId("run"),
    onError = vi.fn();
  let publisher: TeamRunEvents;
  const publish = vi.fn(async () => {
    if (publish.mock.calls.length === 1) {
      publisher.observe(event(runId, "run.completed"));
      throw new Error("private response sentinel");
    }
  });
  publisher = new TeamRunEvents({ publish, onError });
  publisher.observe(event(runId, "run.started"));
  publisher.observe(event(runId, "assistant.message", { content: "private live text sentinel" }));
  await publisher.close();
  expect(publish).toHaveBeenCalledTimes(2);
  expect(onError).toHaveBeenCalledExactlyOnceWith();
  publisher.observe(event(runId, "run.completed"));
  expect(publish).toHaveBeenCalledTimes(2);
});
