import { expect, it } from "vitest";
import { isThreadUnread } from "./thread-unread.js";
it("only the latest completed run after a visit is unread", () => {
  expect(isThreadUnread({ latestRunCompletedAt: null, lastVisitedAt: null })).toBe(false);
  expect(isThreadUnread({ latestRunCompletedAt: "2026-01-02", lastVisitedAt: null })).toBe(true);
  expect(isThreadUnread({ latestRunCompletedAt: "2026-01-02", lastVisitedAt: "2026-01-02" })).toBe(
    false,
  );
  expect(isThreadUnread({ latestRunCompletedAt: "2026-01-02", lastVisitedAt: "2026-01-01" })).toBe(
    true,
  );
});
