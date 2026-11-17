import { describe, expect, it } from "vitest";
import { idleCompactionWindow, compactionReturnEligibleAt } from "./idle-compaction.js";

describe("idle compaction policy", () => {
  const snapshot = {
    usedTokens: 200_000,
    measuredAt: 1_000,
    requestStartedAt: 0,
    promptCacheTtlMs: 300_000 as const,
  };
  it("includes 200k and the opening edge, excludes expiry", () => {
    expect(idleCompactionWindow(snapshot, 179_999)).toEqual({ startMs: 180_000, endMs: 300_000 });
    expect(idleCompactionWindow(snapshot, 180_000)).not.toBeNull();
    expect(idleCompactionWindow(snapshot, 300_000)).toBeNull();
    expect(idleCompactionWindow({ ...snapshot, usedTokens: 199_999 }, 180_000)).toBeNull();
  });
  it("never invents a cache expiry from unknown evidence", () => {
    expect(idleCompactionWindow({ ...snapshot, requestStartedAt: null }, 180_000)).toBeNull();
    expect(idleCompactionWindow({ ...snapshot, promptCacheTtlMs: null }, 180_000)).toBeNull();
    expect(compactionReturnEligibleAt({ ...snapshot, promptCacheTtlMs: null })).toBe(4_201_000);
    expect(compactionReturnEligibleAt(snapshot)).toBe(300_000);
  });
});
