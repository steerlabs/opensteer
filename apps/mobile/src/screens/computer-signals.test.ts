import { expect, it } from "vitest";
import { attentionReads, computerBadge, homeLine, sameAttention } from "./computer-signals.js";

it("reads every other computer that can answer once, never the one on screen", () => {
  const rows = [
    { deploymentId: "dep_shown", status: "connected" },
    { deploymentId: "dep_work", status: "signed-in" },
    { deploymentId: "dep_asleep", status: "offline" },
    { deploymentId: "dep_new", status: "needs-sign-in" },
    { deploymentId: "dep_old", status: "update-required" },
  ] as const;
  expect(attentionReads(rows, "dep_shown")).toEqual(["dep_work", "dep_asleep"]);
});

it("shows each computer's own signals, and nothing for a computer that didn't answer", () => {
  const work = { needsYou: 2, unread: true };
  // The shown computer speaks from its live snapshot, never from a read.
  expect(
    computerBadge({ current: true, shown: { needsYou: 0, unread: true }, read: work }),
  ).toEqual({
    kind: "unread",
  });
  expect(computerBadge({ current: false, shown: null, read: work })).toEqual({
    kind: "needs-you",
    count: 2,
  });
  // Not answered yet, unreachable or refused, or nothing waiting: no badge.
  expect(computerBadge({ current: false, shown: null, read: undefined })).toBeNull();
  expect(computerBadge({ current: false, shown: null, read: null })).toBeNull();
  expect(
    computerBadge({ current: false, shown: null, read: { needsYou: 0, unread: false } }),
  ).toBeNull();
});

it("names Home when it adds to the row, republishes a rename, and does without it on an older Host", () => {
  const studio = { homeName: "Mac mini", needsYou: 0, unread: false };
  expect(homeLine(studio, "Studio")).toBe("Home: Mac mini");
  expect(homeLine(studio, "Mac mini")).toBeNull();
  expect(sameAttention(studio, { ...studio, homeName: "Mac Studio" })).toBe(false);
  const older = { needsYou: 0, unread: false };
  expect(homeLine(older, "Studio")).toBeNull();
  expect(homeLine(null, "Studio")).toBeNull();
  expect(sameAttention(older, { ...older, homeName: null })).toBe(true);
});
