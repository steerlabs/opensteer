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

it("describes outcome-unknown notices as lost contact rather than interrupted (Z5 / Finding 9)", async () => {
  vi.useFakeTimers();
  const threadId = createId("thread");
  const notice: PendingAutomationFailure = {
    anchorThreadId: threadId,
    anchorThreadTitle: "Task",
    attempts: 0,
    createdBy: createId("user"),
    detail: "Outcome unknown: the computer reconnected without this firing.",
    destinationThreadId: threadId,
    id: crypto.randomUUID(),
    reason: "outcome-unknown",
    triggerId: createId("trigger"),
    triggerName: "Nightly backup",
  };
  let delivered = false;
  const enqueueThreadInput = vi.fn<CommandService["enqueueThreadInput"]>(
    async () =>
      ({
        disposition: "queued",
        inputId: createId("message"),
        runId: null,
      }) as never,
  );
  const service = new AutomationFailureService({
    commands: { enqueueThreadInput },
    onError: () => undefined,
    store: {
      listDue: vi.fn(async () => (delivered ? [] : [notice])),
      nextDeadline: async () => null,
      retryLater: vi.fn(async () => undefined),
      settle: vi.fn(async () => {
        delivered = true;
      }),
    },
  });
  try {
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(enqueueThreadInput).toHaveBeenCalledOnce();
    const text = enqueueThreadInput.mock.calls[0]?.[0]?.content
      .map((part) => ("text" in part ? part.text : ""))
      .join("");
    expect(text).toMatch(/lost contact/iu);
    expect(text).toMatch(/outcome is unknown/iu);
    expect(text).not.toMatch(/was interrupted/iu);
  } finally {
    await service.close();
    vi.useRealTimers();
  }
});

it("does not promise schedule retries in started-failing notices (AA14.8)", async () => {
  vi.useFakeTimers();
  const threadId = createId("thread");
  const notice: PendingAutomationFailure = {
    anchorThreadId: threadId,
    anchorThreadTitle: "Task",
    attempts: 0,
    createdBy: createId("user"),
    detail: "exit 1",
    destinationThreadId: threadId,
    id: crypto.randomUUID(),
    reason: "started-failing",
    triggerId: createId("trigger"),
    triggerName: "Deploy webhook",
  };
  let delivered = false;
  const enqueueThreadInput = vi.fn<CommandService["enqueueThreadInput"]>(
    async () =>
      ({
        disposition: "queued",
        inputId: createId("message"),
        runId: null,
      }) as never,
  );
  const service = new AutomationFailureService({
    commands: { enqueueThreadInput },
    onError: () => undefined,
    store: {
      listDue: vi.fn(async () => (delivered ? [] : [notice])),
      nextDeadline: async () => null,
      retryLater: vi.fn(async () => undefined),
      settle: vi.fn(async () => {
        delivered = true;
      }),
    },
  });
  try {
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    const text = enqueueThreadInput.mock.calls[0]?.[0]?.content
      .map((part) => ("text" in part ? part.text : ""))
      .join("");
    expect(text).toContain("It is still active.");
    expect(text).not.toContain("will keep trying on its schedule");
  } finally {
    await service.close();
    vi.useRealTimers();
  }
});

it("describes started-failing, overran-schedule, and watch-crash-loop without claiming the automation was paused (T8/T9/Y10)", async () => {
  vi.useFakeTimers();
  const threadId = createId("thread");
  const triggerId = createId("trigger");
  const cases: readonly {
    readonly reason: PendingAutomationFailure["reason"];
    readonly detail: string;
    readonly match: RegExp;
  }[] = [
    { reason: "started-failing", detail: "exit 1", match: /started failing/iu },
    { reason: "overran-schedule", detail: "still running", match: /still running/iu },
    { reason: "watch-crash-loop", detail: "exit 137", match: /keeps stopping/iu },
  ];
  try {
    for (const item of cases) {
      let delivered = false;
      const enqueueThreadInput = vi.fn<CommandService["enqueueThreadInput"]>(
        async () =>
          ({
            disposition: "queued",
            inputId: createId("message"),
            runId: null,
          }) as never,
      );
      const service = new AutomationFailureService({
        commands: { enqueueThreadInput },
        onError: () => undefined,
        store: {
          listDue: vi.fn(async () =>
            delivered
              ? []
              : [
                  {
                    anchorThreadId: threadId,
                    anchorThreadTitle: "Task",
                    attempts: 0,
                    createdBy: createId("user"),
                    detail: item.detail,
                    destinationThreadId: threadId,
                    id: crypto.randomUUID(),
                    reason: item.reason,
                    triggerId,
                    triggerName: "Check inbox",
                  },
                ],
          ),
          nextDeadline: async () => null,
          retryLater: vi.fn(async () => undefined),
          settle: vi.fn(async () => {
            delivered = true;
          }),
        },
      });
      try {
        service.start();
        await vi.advanceTimersByTimeAsync(0);
        const text = enqueueThreadInput.mock.calls[0]?.[0]?.content
          .map((part) => ("text" in part ? part.text : ""))
          .join("");
        expect(text).toMatch(item.match);
        expect(text).not.toMatch(/was paused/iu);
      } finally {
        await service.close();
      }
    }
  } finally {
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

it("gives every due notice its turn when one notice's write keeps failing", async () => {
  vi.useFakeTimers();
  const notice = (id: string): PendingAutomationFailure => ({
    anchorThreadId: createId("thread"),
    anchorThreadTitle: "Task",
    attempts: 0,
    createdBy: createId("user"),
    detail: "Service unavailable",
    destinationThreadId: createId("thread"),
    id,
    reason: "final-occurrence-failed",
    triggerId: createId("trigger"),
    triggerName: id,
  });
  const [stuck, healthy] = [notice("stuck"), notice("healthy")];
  let pending = [stuck, healthy];
  const store = {
    // Oldest first, so the stuck notice leads every batch.
    listDue: vi.fn(async () => pending),
    nextDeadline: async () => (pending.length ? new Date(Date.now()) : null),
    // Neither write can be recorded for the stuck notice.
    retryLater: vi.fn(async ({ id }: { id: string }) => {
      if (id === "stuck") throw new Error("constraint violated");
    }),
    settle: vi.fn(async ({ id }: { id: string }) => {
      if (id === "stuck") throw new Error("constraint violated");
      pending = pending.filter((candidate) => candidate.id !== id);
    }),
  };
  const enqueueThreadInput = vi.fn(async () => ({ disposition: "pending" }));
  const errors: unknown[] = [];
  const service = new AutomationFailureService({
    commands: { enqueueThreadInput } as never,
    onError: (error) => errors.push(error),
    store,
  });
  try {
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.settle.mock.calls.map(([input]) => input.id)).toEqual(["stuck", "healthy"]);
    expect(pending).toEqual([stuck]);
    // The failure owes a retry with backoff, not a spin.
    expect(errors).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
  } finally {
    await service.close();
    vi.useRealTimers();
  }
});
