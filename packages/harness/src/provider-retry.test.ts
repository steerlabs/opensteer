import { describe, expect, it, vi } from "vitest";
import {
  ProviderRetryTracker,
  formatRetryBudgetMessage,
  providerRetryBudgetMs,
  type HarnessDurableEvent,
  type ProviderRetryRecord,
} from "./index.js";

describe("ProviderRetryTracker", () => {
  it("emits retrying, tracks attempt counts, and clears cleanly on recover", () => {
    vi.useFakeTimers();
    try {
      const events: HarnessDurableEvent[] = [];
      const expired: ProviderRetryRecord[] = [];
      const logs: Array<{
        level: string;
        message: string;
        fields: Readonly<Record<string, unknown>> | undefined;
      }> = [];
      const tracker = new ProviderRetryTracker({
        publish: (event) => events.push(event),
        onBudgetExceeded: (record) => expired.push(record),
        budgetMs: 60_000,
        log: (level, message, fields) => logs.push({ level, message, fields }),
      });

      // O(1) no-op when no retry episode is active.
      tracker.recover();
      expect(events).toEqual([]);

      tracker.noteRetry({
        attempt: 1,
        maxAttempts: 5,
        retryDelayMs: 7_000,
        code: "model_capacity",
        message: "Selected model is at capacity.",
      });

      expect(tracker.current).toMatchObject({
        attempt: 1,
        maxAttempts: 5,
        retryDelayMs: 7_000,
        code: "model_capacity",
        message: "Selected model is at capacity.",
      });
      expect(events).toEqual([
        {
          type: "run.retry",
          data: {
            status: "retrying",
            attempt: 1,
            maxAttempts: 5,
            retryDelayMs: 7_000,
            code: "model_capacity",
            message: "Selected model is at capacity.",
          },
        },
      ]);
      expect(logs).toHaveLength(1);
      expect(logs[0]?.level).toBe("warn");

      // Second retry without explicit attempt increments from previous.
      tracker.noteRetry({
        message: "Selected model is at capacity.",
      });
      expect(events[1]).toEqual({
        type: "run.retry",
        data: {
          status: "retrying",
          attempt: 2,
          maxAttempts: null,
          message: "Selected model is at capacity.",
        },
      });

      tracker.recover();
      expect(tracker.current).toBeNull();
      expect(events[2]).toEqual({
        type: "run.retry",
        data: {
          status: "recovered",
          attempt: 2,
          maxAttempts: null,
          message: "Selected model is at capacity.",
        },
      });

      // Subsequent recover is a no-op and budget timer is cancelled.
      tracker.recover();
      expect(events).toHaveLength(3);
      vi.advanceTimersByTime(120_000);
      expect(expired).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("anchors the wall-clock budget to the first retry so repeated notices cannot extend it", () => {
    vi.useFakeTimers();
    try {
      const events: HarnessDurableEvent[] = [];
      const expired: ProviderRetryRecord[] = [];
      const tracker = new ProviderRetryTracker({
        publish: (event) => events.push(event),
        onBudgetExceeded: (record) => expired.push(record),
        budgetMs: 10_000,
      });

      tracker.noteRetry({ attempt: 1, maxAttempts: 5, message: "At capacity (1)" });
      vi.advanceTimersByTime(6_000);
      tracker.noteRetry({ attempt: 2, maxAttempts: 5, message: "At capacity (2)" });
      vi.advanceTimersByTime(3_999);
      expect(expired).toEqual([]);

      // Fires at exactly 10_000ms from retry #1, reporting the latest retry record.
      vi.advanceTimersByTime(1);
      expect(expired).toHaveLength(1);
      expect(expired[0]).toMatchObject({
        attempt: 2,
        maxAttempts: 5,
        message: "At capacity (2)",
      });

      // Further notices after expiry are ignored.
      tracker.noteRetry({ attempt: 3, maxAttempts: 5, message: "Late notice" });
      expect(events).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts a fresh budget window on a later retry episode after recovery", () => {
    vi.useFakeTimers();
    try {
      const expired: ProviderRetryRecord[] = [];
      const tracker = new ProviderRetryTracker({
        publish: () => {},
        onBudgetExceeded: (record) => expired.push(record),
        budgetMs: 5_000,
      });

      tracker.noteRetry({ attempt: 1, message: "Transient 1" });
      vi.advanceTimersByTime(4_000);
      tracker.recover();
      vi.advanceTimersByTime(2_000);
      expect(expired).toEqual([]);

      tracker.noteRetry({ attempt: 1, message: "Transient 2" });
      vi.advanceTimersByTime(4_999);
      expect(expired).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(expired).toHaveLength(1);
      expect(expired[0]?.message).toBe("Transient 2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels pending expiry timer on dispose without emitting recovered", () => {
    vi.useFakeTimers();
    try {
      const events: HarnessDurableEvent[] = [];
      const expired: ProviderRetryRecord[] = [];
      const tracker = new ProviderRetryTracker({
        publish: (event) => events.push(event),
        onBudgetExceeded: (record) => expired.push(record),
        budgetMs: 5_000,
      });

      tracker.noteRetry({ attempt: 1, message: "Overloaded" });
      tracker.dispose();
      vi.advanceTimersByTime(10_000);
      expect(expired).toEqual([]);
      expect(events).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("formats budget expiry messages cleanly", () => {
    expect(providerRetryBudgetMs).toBe(10 * 60 * 1_000);
    expect(
      formatRetryBudgetMessage(
        { message: "Selected model is at capacity." },
        providerRetryBudgetMs,
      ),
    ).toBe("Provider stayed in retries for 10 minutes: Selected model is at capacity.");
    expect(formatRetryBudgetMessage({ message: "" }, 60_000)).toBe(
      "Provider stayed in retries for 1 minute",
    );
    expect(formatRetryBudgetMessage({ message: "Overloaded" }, 15_000)).toBe(
      "Provider stayed in retries for 15s: Overloaded",
    );
  });

  it("byte-bounds long multi-byte retry messages and contains expiry handler errors", () => {
    vi.useFakeTimers();
    try {
      const events: HarnessDurableEvent[] = [];
      const errors: string[] = [];
      const tracker = new ProviderRetryTracker({
        publish: (event) => events.push(event),
        onBudgetExceeded: () => {
          throw new Error("buffer overflow");
        },
        budgetMs: 1_000,
        log: (level, message) => {
          if (level === "warn" && message === "Provider retry budget handler failed") {
            errors.push(message);
          }
        },
      });

      // 200 CJK chars = 600 UTF-8 bytes; must be clamped to <= 256 UTF-8 bytes.
      tracker.noteRetry({ message: "限".repeat(200) });
      expect(events[0]?.type).toBe("run.retry");
      if (events[0]?.type === "run.retry") {
        expect(Buffer.byteLength(events[0].data.message, "utf8")).toBeLessThanOrEqual(256);
      }

      // Timer callback throwing must be caught and logged, never escaping as an uncaught exception.
      expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
      expect(errors).toEqual(["Provider retry budget handler failed"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("isolates retry episodes per source so unrelated output cannot clear another source's deadline", () => {
    vi.useFakeTimers();
    try {
      const events: HarnessDurableEvent[] = [];
      const expired: ProviderRetryRecord[] = [];
      const tracker = new ProviderRetryTracker({
        publish: (event) => events.push(event),
        onBudgetExceeded: (record) => expired.push(record),
        budgetMs: 10_000,
      });

      tracker.noteRetry({
        source: "child-1",
        attempt: 1,
        maxAttempts: 5,
        message: "Child at capacity",
      });
      vi.advanceTimersByTime(3_000);
      // Root output must NOT clear child-1's active retry or timer.
      tracker.recover("root");
      expect(events).toHaveLength(1);
      expect(tracker.current?.source).toBe("child-1");

      // Root also starts retrying at t=3s.
      tracker.noteRetry({
        source: "root",
        attempt: 1,
        maxAttempts: 5,
        message: "Root at capacity",
      });
      vi.advanceTimersByTime(2_000);
      // Root recovers at t=5s; child-1 is still retrying, so we republish child-1 (not recovered!).
      tracker.recover("root");
      expect(events.at(-1)).toEqual({
        type: "run.retry",
        data: {
          status: "retrying",
          attempt: 1,
          maxAttempts: 5,
          message: "Child at capacity",
        },
      });

      // Child-1's deadline still expires at t=10s (5s later).
      vi.advanceTimersByTime(5_000);
      expect(expired).toHaveLength(1);
      expect(expired[0]?.source).toBe("child-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("scrubs proxy passwords from retry events, warn logs, and budget-handler error logs (G7)", async () => {
    const { networkCredentialSecrets } = await import("@opensteer/shared/safeMessage");
    vi.useFakeTimers();
    try {
      const proxy = "http://alice:p@ss/word-g7@proxy.invalid:8080";
      const password = "p@ss/word-g7";
      const events: HarnessDurableEvent[] = [];
      const logs: Array<{
        readonly level: "info" | "warn";
        readonly message: string;
        readonly fields: Readonly<Record<string, unknown>> | undefined;
      }> = [];
      const tracker = new ProviderRetryTracker({
        publish: (event) => events.push(event),
        onBudgetExceeded: () => {
          throw new Error(`Abort failed via ${proxy}`);
        },
        budgetMs: 1_000,
        log: (level, message, fields) => {
          logs.push({ fields, level, message });
        },
        secrets: networkCredentialSecrets({ HTTPS_PROXY: proxy }),
      });

      tracker.noteRetry({ message: `Retrying via ${proxy}` });
      vi.advanceTimersByTime(1_000);

      expect(events[0]).toMatchObject({
        data: { message: "Retrying via http://[REDACTED]@proxy.invalid:8080" },
        type: "run.retry",
      });
      expect(JSON.stringify(events)).not.toContain(password);
      expect(JSON.stringify(logs)).not.toContain(password);
      expect(logs).toContainEqual(
        expect.objectContaining({
          fields: expect.objectContaining({
            error: "Abort failed via http://[REDACTED]@proxy.invalid:8080",
          }),
          message: "Provider retry budget handler failed",
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
