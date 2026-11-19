import { afterEach, expect, it, vi } from "vitest";
import { createReturnHintRefresh } from "./personal-return-hints.js";

afterEach(() => {
  vi.useRealTimers();
});

it("keeps a failed republish owed until a pass succeeds", async () => {
  vi.useFakeTimers();
  const republish = vi
    .fn<(scopes: readonly string[]) => Promise<void>>()
    .mockRejectedValueOnce(new Error("commit failed"))
    .mockResolvedValue(undefined);
  const refresh = createReturnHintRefresh({
    watched: () => ["thread:viewed"],
    republish,
    onError: () => undefined,
  });
  try {
    refresh(new Set(["settings"]));
    await vi.advanceTimersByTimeAsync(0);
    expect(republish).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(republish).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(republish).toHaveBeenCalledTimes(2);
  } finally {
    refresh.close();
  }
});

it("ignores resources the return hint does not read", async () => {
  const republish = vi.fn(async () => undefined);
  const refresh = createReturnHintRefresh({
    watched: () => ["thread:viewed"],
    republish,
    onError: () => undefined,
  });
  refresh(new Set(["tab", "browser-availability"]));
  await Promise.resolve();
  expect(republish).not.toHaveBeenCalled();
  refresh.close();
});

it("arms nothing after close, even for a pass that fails as the Host shuts down", async () => {
  vi.useFakeTimers();
  const pass = Promise.withResolvers<void>();
  const republish = vi.fn(() => pass.promise);
  const refresh = createReturnHintRefresh({
    watched: () => ["thread:viewed"],
    republish,
    onError: () => undefined,
  });
  refresh(new Set(["settings"]));
  await vi.advanceTimersByTimeAsync(0);
  refresh.close();
  pass.reject(new Error("database closed"));
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
  refresh(new Set(["settings"]));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(republish).toHaveBeenCalledTimes(1);
});
