import { afterEach, expect, it, vi } from "vitest";
import { BrowserPresentationWait } from "./browser-presentation-wait.js";
afterEach(() => vi.useRealTimers());
it("expires native paint and streamed-frame waits under the original action deadline", async () => {
  vi.useFakeTimers();
  {
    const wait = new BrowserPresentationWait(Date.now() + 1000);
    const changed = vi.fn();
    const unsubscribe = wait.subscribe(changed);
    try {
      wait.start();
      await vi.advanceTimersByTimeAsync(1000);
      expect(wait.getSnapshot()).toBe("expired");
      expect(wait.presented(), "late pixels cannot dismiss the error").toBe(false);
      wait.retry();
      expect(wait.getSnapshot()).toBe("waiting");
      expect(wait.presented()).toBe(true);
      await vi.advanceTimersByTimeAsync(25_000);
      expect(wait.getSnapshot()).toBe("presented");
    } finally {
      unsubscribe();
      wait.dispose();
    }
  }
});
it("checks elapsed time on foreground render before a suspended timer runs", () => {
  vi.useFakeTimers();
  const wait = new BrowserPresentationWait(Date.now() + 1000);
  try {
    wait.start();
    vi.setSystemTime(Date.now() + 1000);
    expect(wait.getSnapshot()).toBe("expired");
    expect(wait.presented()).toBe(false);
  } finally {
    wait.dispose();
  }
});
it("starts an existing page's viewing wait when viewing starts, not when it mounts hidden", async () => {
  vi.useFakeTimers();
  const wait = new BrowserPresentationWait(undefined);
  try {
    await vi.advanceTimersByTimeAsync(60_000);
    expect(wait.getSnapshot()).toBe("waiting");
    wait.start();
    await vi.advanceTimersByTimeAsync(24_999);
    expect(wait.getSnapshot()).toBe("waiting");
    expect(wait.presented()).toBe(true);
  } finally {
    wait.dispose();
  }
});
