import { createId, OpensteerError } from "@opensteer/core";
import type { PendingAutomationFailure } from "@opensteer/database";
import type { CommandService } from "@opensteer/orchestration";
import { expect, it, vi } from "vitest";
import { AutomationFailureService } from "./automation-failure-service.js";

it("drains on startup and commit, and retries at the durable deadline", async () => {
  vi.useFakeTimers();
  const threadId = createId("thread");
  const notice: PendingAutomationFailure = {
    anchorThreadId: threadId,
    anchorThreadTitle: "Task",
    attempts: 0,
    createdBy: createId("user"),
    detail: "Service unavailable",
    destinationThreadId: threadId,
    id: crypto.randomUUID(),
    reason: "final-occurrence-failed",
    triggerId: createId("trigger"),
    triggerName: "Check for updates",
  };
  let due: Date | null = new Date();
  const temporary = new Error("Connection refused");
  const permanent = new OpensteerError({ code: "not_found", message: "The task has been removed" });
  const enqueueThreadInput = vi
    .fn<CommandService["enqueueThreadInput"]>()
    .mockRejectedValueOnce(temporary)
    .mockRejectedValue(permanent);
  const store = {
    listDue: vi.fn(async () => (due && due.getTime() <= Date.now() ? [notice] : [])),
    nextDeadline: async () => due,
    retryLater: vi.fn(async () => {
      due = new Date(Date.now() + 5_000);
    }),
    settle: vi.fn(async () => {
      due = null;
    }),
  };
  const onError = vi.fn();
  const service = new AutomationFailureService({
    commands: { enqueueThreadInput },
    onError,
    store,
  });
  try {
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.retryLater).toHaveBeenCalledWith({ id: notice.id, error: temporary.message });
    expect(onError).toHaveBeenCalledWith(temporary);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(store.listDue).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(enqueueThreadInput).toHaveBeenCalledTimes(2);
    expect(store.settle).toHaveBeenCalledWith({ id: notice.id, reason: permanent.message });
    expect(vi.getTimerCount()).toBe(0);

    due = new Date();
    service.notify();
    await vi.advanceTimersByTimeAsync(0);
    expect(enqueueThreadInput).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await service.close();
    vi.useRealTimers();
  }
});

it("backs off when a due notice cannot be listed, instead of spinning", async () => {
  vi.useFakeTimers();
  let reads = 0;
  const store = {
    listDue: vi.fn(async () => []),
    // Due by the deadline query, never by the listing; null after 20 reads so
    // a spinning owner stops and the assertion can report it.
    nextDeadline: async () => (++reads > 20 ? null : new Date(Date.now())),
    retryLater: vi.fn(async () => undefined),
    settle: vi.fn(async () => undefined),
  };
  const service = new AutomationFailureService({
    commands: { enqueueThreadInput: vi.fn() },
    onError: () => undefined,
    store,
  });
  try {
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.listDue).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(store.listDue).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(store.listDue).toHaveBeenCalledTimes(2);
  } finally {
    await service.close();
    vi.useRealTimers();
  }
});
