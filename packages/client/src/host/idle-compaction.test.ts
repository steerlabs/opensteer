import { afterEach, expect, it, vi } from "vitest";
import { CompactionReturnHintSchema } from "@opensteer/core";
import {
  compactionHintRevision,
  compactionOfferVisible,
  scheduleCompactionReveal,
} from "./idle-compaction.js";
import { createUsageNoticeDismissals } from "./usage-notice.js";
const hint = CompactionReturnHintSchema.parse({
  eligible: true,
  sessionRevision: "session-1",
  sourceRunId: "run_00000000-0000-4000-8000-000000000001",
  eligibleAt: 5000,
});
afterEach(() => vi.useRealTimers());
it("reveals at eligibility, cancels replaced timers and never schedules ineligible or dismissed hints", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const reveal = vi.fn();
  expect(compactionOfferVisible(hint, false, Date.now())).toBe(false);
  const cancel = scheduleCompactionReveal(hint, false, reveal);
  vi.advanceTimersByTime(3999);
  expect(reveal).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(reveal).toHaveBeenCalledExactlyOnceWith(5000);
  expect(compactionOfferVisible(hint, false, Date.now())).toBe(true);
  cancel();
  vi.setSystemTime(1000);
  reveal.mockClear();
  scheduleCompactionReveal(hint, false, reveal)();
  scheduleCompactionReveal({ ...hint, eligible: false }, false, reveal);
  scheduleCompactionReveal(hint, true, reveal);
  vi.advanceTimersByTime(5000);
  expect(reveal).not.toHaveBeenCalled();
});
it("keeps full-history dismissal on this device across remounts, scoped to the exact hint revision", () => {
  let stored: readonly string[] = [];
  const storage = {
    read: () => stored,
    write: (keys: readonly string[]) => {
      stored = keys;
    },
  };
  const store = createUsageNoticeDismissals(storage);
  store.dismiss(compactionHintRevision(hint, "host/user/task"));
  const restored = createUsageNoticeDismissals(storage);
  const hidden = (value: typeof hint, scope = "host/user/task") =>
    restored.getSnapshot()!.has(compactionHintRevision(value, scope));
  expect(compactionOfferVisible(hint, hidden(hint), 6000)).toBe(false);
  expect(
    compactionOfferVisible(
      { ...hint, sessionRevision: "session-2" },
      hidden({ ...hint, sessionRevision: "session-2" }),
      6000,
    ),
  ).toBe(true);
  expect(hidden(hint, "other/user/task")).toBe(false);
});
