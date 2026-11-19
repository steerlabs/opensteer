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

it("retries a finished Run's team delivery with backoff until it is recorded", async () => {
  let now = 0;
  const timers = new Set<{ at: number; run: () => void }>();
  const clock = {
    now: () => now,
    schedule(run: () => void, milliseconds: number) {
      const timer = { at: now + milliseconds, run };
      timers.add(timer);
      return () => timers.delete(timer);
    },
  };
  const advance = async (milliseconds: number) => {
    now += milliseconds;
    for (const timer of [...timers].filter(({ at }) => at <= now)) {
      timers.delete(timer);
      timer.run();
    }
    await vi.waitFor(() => expect(publish.mock.calls.length).toBeGreaterThan(0));
  };
  // A call timed out on a healthy link twice; the third attempt is recorded.
  const publish = vi
    .fn<() => Promise<"pending" | void>>()
    .mockResolvedValueOnce("pending")
    .mockRejectedValueOnce(new Error("timeout"))
    .mockResolvedValue(undefined);
  const events = new TeamRunEvents({ publish, onError: () => undefined, clock });
  const runId = createId("run");
  events.observe({
    type: "runFinished",
    runId,
    threadId: createId("thread"),
    attemptId: createId("runAttempt"),
    bindingGeneration: 1,
    outcome: "completed",
  });
  await vi.waitFor(() => expect([...timers].map(({ at }) => at - now)).toEqual([1_000]));
  await advance(1_000);
  await vi.waitFor(() => expect([...timers].map(({ at }) => at - now)).toEqual([2_000]));
  await advance(2_000);
  await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(3));
  await events.close();
  expect(timers.size).toBe(0);
});
