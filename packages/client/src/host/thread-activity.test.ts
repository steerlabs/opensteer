import { describe, expect, it } from "vitest";
import type { EnvironmentSummary, RunQueueEntry } from "./client.js";
import { threadStartHold, threadStartsRunForMessage } from "./thread-activity.js";

const thread = { id: "thr_1", inputQueuePaused: false, status: "idle" as const };
const run = (status: RunQueueEntry["status"]): RunQueueEntry => ({
  createdAt: "2026-11-18T00:00:00.000Z",
  id: "run_1",
  runOrdinal: 1,
  status,
  threadId: thread.id,
});

describe("threadStartsRunForMessage", () => {
  // A pending bubble was drawn as the next Run's message while the Host,
  // still running maintenance on an idle task, would hold it as a waiting input.
  it("holds a message behind a Run the idle task is still running", () => {
    expect(threadStartsRunForMessage({ runQueue: [], thread })).toBe(true);
    expect(threadStartsRunForMessage({ runQueue: [run("running")], thread })).toBe(false);
    expect(threadStartsRunForMessage({ runQueue: [run("starting")], thread })).toBe(false);
    expect(
      threadStartsRunForMessage({
        runQueue: [{ ...run("running"), threadId: "thr_other" }],
        thread,
      }),
    ).toBe(true);
    expect(
      threadStartsRunForMessage({ runQueue: [], thread: { ...thread, inputQueuePaused: true } }),
    ).toBe(false);
    expect(
      threadStartsRunForMessage({ runQueue: [], thread: { ...thread, status: "running" } }),
    ).toBe(false);
  });
});

describe("threadStartHold", () => {
  it("says a queued task waits because agents are stopped on its computer, until they resume", () => {
    const environment = {
      capabilities: [],
      connected: true,
      harnessAuthenticationAllowed: true,
      harnessCatalogs: [],
      harnessDrivers: [],
      id: "env_studio",
      kind: "personal",
      name: "Studio Mac",
      runnerId: "rnr_studio",
      status: "connected",
      can: { executeTasks: true },
      agentsStoppedSince: "2026-11-20T10:42:00.000Z",
    } as unknown as EnvironmentSummary;
    const input = {
      environments: [environment],
      runQueue: [{ ...run("queued"), threadId: "thr_1" }],
      thread: {
        ...thread,
        status: "running" as const,
        environmentId: "env_studio",
        harnessInstanceId: "hin_1",
        harnessLabel: "Codex",
      },
    };
    expect(threadStartHold(input)).toBe(
      "Waiting: agents are stopped on Studio Mac. This starts when they’re resumed there.",
    );
    expect(
      threadStartHold({ ...input, environments: [{ ...environment, agentsStoppedSince: null }] }),
    ).toBeNull();
  });
});
