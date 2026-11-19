import { afterEach, expect, it, vi } from "vitest";
import { RequestDeadlines, settleEach } from "./request-deadlines.js";

afterEach(() => {
  vi.useRealTimers();
});

it("settles startup work and arms only the next deadline", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-17T12:00:00Z"));
  const deadlines = [Date.now() - 1, Date.now() + 200, Date.now() + 500];
  const next = vi.fn(async () => (deadlines.length ? new Date(deadlines[0]!) : null));
  const settle = vi.fn(async (now: Date) => {
    let settled = 0;
    while (deadlines.length && deadlines[0]! <= now.getTime()) {
      deadlines.shift();
      settled++;
    }
    return settled;
  });
  const onError = vi.fn();
  const scheduler = new RequestDeadlines({ next, settle, onError });
  try {
    await scheduler.settle();
    expect(settle).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(199);
    expect(next).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(settle).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(settle).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    expect(onError).not.toHaveBeenCalled();
  } finally {
    await scheduler.close();
  }
});

it("replaces a later alarm when an earlier deadline commits", async () => {
  vi.useFakeTimers();
  const now = Date.now();
  let deadline: Date | null = new Date(now + 500);
  const settle = vi.fn(async () => {
    deadline = null;
    return 1;
  });
  const scheduler = new RequestDeadlines({ next: async () => deadline, settle, onError: vi.fn() });
  try {
    await scheduler.settle();
    deadline = new Date(now + 100);
    await scheduler.settle();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(settle).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(400);
    expect(settle).toHaveBeenCalledOnce();
  } finally {
    await scheduler.close();
  }
});

it.each(["read", "settlement"])("retries a failed deadline %s, then goes idle", async (failure) => {
  vi.useFakeTimers();
  let due: Date | null = new Date(Date.now() - 1);
  const error = new Error("database unavailable");
  const next = vi.fn(async () => due);
  const settle = vi.fn(async () => {
    due = null;
    return 1;
  });
  if (failure === "read") next.mockRejectedValueOnce(error);
  else settle.mockRejectedValueOnce(error);
  const onError = vi.fn();
  const scheduler = new RequestDeadlines({ next, settle, onError });
  try {
    await scheduler.settle();
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(due).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(due).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await scheduler.close();
  }
});

it("observes a deadline committed during an in-flight read", async () => {
  vi.useFakeTimers();
  const first = Promise.withResolvers<Date | null>();
  let nextDeadline: Date | null = null;
  const next = vi.fn(async () => nextDeadline).mockImplementationOnce(() => first.promise);
  const settle = vi.fn(async () => {
    nextDeadline = null;
    return 1;
  });
  const scheduler = new RequestDeadlines({ next, settle, onError: vi.fn() });
  try {
    const idle = scheduler.settle();
    nextDeadline = new Date(Date.now() + 100);
    scheduler.wake();
    first.resolve(null);
    await idle;
    expect(next).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(settle).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    first.resolve(null);
    await scheduler.close();
  }
});

it("gives every settler its turn when one keeps failing, then reports the failure", async () => {
  const later = vi.fn(async () => 2);
  await expect(
    settleEach([
      async () => {
        throw new Error("password broker down");
      },
      later,
    ]),
  ).rejects.toThrow("Settling due Requests failed");
  expect(later).toHaveBeenCalledOnce();
  expect(await settleEach([async () => 1, later])).toBe(3);
});
