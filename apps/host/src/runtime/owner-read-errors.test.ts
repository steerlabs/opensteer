import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
import { RequestDeadlines } from "../agents/request-deadlines.js";
import { ContinuationService } from "../agents/continuation-service.js";
import { createHarnessCatalogConvergence } from "../agents/harness-catalogs.js";
import { ChannelService } from "../channels/channel-service.js";
import { AutomationFailureService } from "../triggers/automation-failure-service.js";
import { TriggerScheduleLoop } from "../triggers/trigger-service.js";
import { assignmentReturnPass } from "./assignment-return-pass.js";
import { DeadlineDrain } from "./deadline-drain.js";
import { executionLeaseDrain } from "./execution-leases.js";

/*
 * Every durable owner, when the read of what it owes throws: the error is
 * reported and the owner re-arms with backoff (5 s), never sleeping until an
 * unrelated wake. Each read fails once, then answers "nothing owed".
 */
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

interface Owner {
  start(): void;
  close(): Promise<void>;
}

function failingOnce<T>(nothing: T) {
  let calls = 0;
  const read = vi.fn(async (..._args: unknown[]): Promise<T> => {
    if (++calls === 1) throw new Error("database connection lost");
    return nothing;
  });
  return read;
}

const owners: readonly [string, () => { owner: Owner; read: ReturnType<typeof vi.fn> }][] = [
  [
    "Request deadlines",
    () => {
      const read = failingOnce<Date | null>(null);
      const owner = new RequestDeadlines({ next: read, settle: async () => 0, onError: () => {} });
      return { owner, read };
    },
  ],
  [
    "execution leases",
    () => {
      const read = failingOnce<Date | null>(null);
      const owner = executionLeaseDrain(
        { nextExecutionDeadline: read } as never,
        () => undefined,
        () => undefined,
      );
      return { owner, read };
    },
  ],
  [
    "channel ingress",
    () => {
      const read = failingOnce<null>(null);
      const owner = new ChannelService({
        channels: {
          claimIngress: read,
          nextIngressDeadline: async () => null,
          pruneHistory: async () => undefined,
        } as never,
        credentials: {} as never,
        bridgeTools: () => ({ callTool: async () => ({}) }),
        relay: {} as never,
        store: { listEnvironments: async () => [] } as never,
      });
      return { owner, read };
    },
  ],
  [
    "trigger schedules",
    () => {
      const read = failingOnce({ occurrences: [], changed: false, failures: [] });
      const owner = new TriggerScheduleLoop({
        onChanged: () => undefined,
        onError: () => undefined,
        onOccurrenceQueued: () => undefined,
        store: { claimDueSchedules: read, nextScheduleAt: async () => null } as never,
      });
      return { owner, read };
    },
  ],
  [
    "continuations",
    () => {
      const read = failingOnce<[]>([]);
      const owner = new ContinuationService({
        commands: {} as never,
        integrations: {} as never,
        onError: () => undefined,
        requests: {
          listPendingContinuations: read,
          nextContinuationDeadline: async () => null,
        } as never,
      });
      return { owner, read };
    },
  ],
  [
    "automation notices",
    () => {
      const read = failingOnce<[]>([]);
      const owner = new AutomationFailureService({
        commands: {} as never,
        onError: () => undefined,
        store: { listDue: read, nextDeadline: async () => null } as never,
      });
      return { owner, read };
    },
  ],
  [
    "catalog convergence",
    () => {
      const read = failingOnce<[]>([]);
      const convergence = createHarnessCatalogConvergence({
        connectedEnvironmentIds: async () => [createId("environment")],
        catalogs: { listHarnessInstances: read, listHarnessCatalogs: async () => [] } as never,
        runners: {} as never,
        captureTimeoutMs: 1_000,
        onCommitted: () => undefined,
        onError: () => undefined,
      });
      return { owner: { start: () => convergence.wake(), close: convergence.close }, read };
    },
  ],
  [
    "assignment returns",
    () => {
      const read = failingOnce({
        failures: [],
        waiting: 0,
        held: 0,
        heldUntil: null,
        settled: 0,
        more: false,
      });
      const owner = new DeadlineDrain({
        drain: () => assignmentReturnPass(read as never, () => undefined),
        onError: () => undefined,
      });
      return { owner, read };
    },
  ],
];

it.each(owners)("%s: a failed read of owed work re-arms with backoff", async (_, make) => {
  const { owner, read } = make();
  owner.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(4_999);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(2);
  await owner.close();
  expect(vi.getTimerCount()).toBe(0);
});
