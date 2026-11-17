import { afterEach, expect, it, vi } from "vitest";
import { RequestDeadlines } from "./request-deadlines.js";

afterEach(() => {
  vi.useRealTimers();
});

it("settles startup work and arms only the next deadline", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-17T12:00:00Z"));
  const deadlines = [Date.now() - 1, Date.now() + 200, Date.now() + 500];
  const next = vi.fn(async () => (deadlines.length ? new Date(deadlines[0]!) : null));
  const settle = vi.fn(async (now: Date) => {
    while (deadlines.length && deadlines[0]! <= now.getTime()) deadlines.shift();
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
