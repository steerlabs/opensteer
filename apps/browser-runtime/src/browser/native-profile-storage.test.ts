import { describe, expect, it } from "vitest";
import { matchRestoredTabs, type TabRestoreSidecarEntry } from "./native-profile-storage.js";
import type { ChromiumTabEntry } from "./tab-lifecycle-extension.js";

function restored(
  tabId: number,
  index: number,
  url: string,
  windowId = 1,
): ChromiumTabEntry {
  return {
    tabId,
    windowId,
    index,
    url,
    title: "",
    active: false,
    discarded: true,
    status: "complete",
    targetId: null,
  };
}

function sidecar(
  index: number,
  surfaceId: string,
  url: string,
  lineageId = "profile-1",
): TabRestoreSidecarEntry {
  return { index, surfaceId, url, lineageId };
}

describe("matchRestoredTabs", () => {
  it("keeps A2's exact slot and closes A1 when [A1, A2] share a URL and A1 was deleted while down", () => {
    const result = matchRestoredTabs(
      [restored(10, 0, "https://dup.test/a"), restored(11, 1, "https://dup.test/a")],
      [sidecar(0, "surf-A1", "https://dup.test/a"), sidecar(1, "surf-A2", "https://dup.test/a")],
      { savedTabIds: new Set(["surf-A2"]), lineageId: "profile-1" },
    );

    expect([...result.matched.entries()]).toEqual([
      ["surf-A2", { tab: expect.objectContaining({ tabId: 11 }), lineageId: "profile-1" }],
    ]);
    expect(result.orphans.map((t) => t.tabId)).toEqual([10]);
  });

  it("refuses duplicate URLs when a stale sidecar has shifted or mismatched slots, while recovering unique URLs", () => {
    // Stale sidecar after SIGKILL: an extra tab shifted indices.
    const shifted = matchRestoredTabs(
      [
        restored(20, 0, "https://extra.test/"),
        restored(21, 1, "https://dup.test/a"),
        restored(22, 2, "https://dup.test/a"),
        restored(23, 3, "https://unique.test/u"),
      ],
      [
        sidecar(0, "surf-A1", "https://dup.test/a"),
        sidecar(1, "surf-A2", "https://dup.test/a"),
        sidecar(2, "surf-U", "https://unique.test/u"),
      ],
      { savedTabIds: new Set(["surf-A1", "surf-A2", "surf-U"]), lineageId: "profile-1" },
    );

    expect([...shifted.matched.keys()]).toEqual(["surf-U"]);
    expect(shifted.matched.get("surf-U")?.tab.tabId).toBe(23);
    expect(shifted.orphans.map((t) => t.tabId)).toEqual([20, 21, 22]);

    // Same length, but a middle slot changed URL: duplicate URLs must NOT be guessed even at index 0.
    const middleMismatch = matchRestoredTabs(
      [
        restored(30, 0, "https://dup.test/a"),
        restored(31, 1, "https://changed.test/"),
        restored(32, 2, "https://dup.test/a"),
      ],
      [
        sidecar(0, "surf-A1", "https://dup.test/a"),
        sidecar(1, "surf-B", "https://original.test/"),
        sidecar(2, "surf-A2", "https://dup.test/a"),
      ],
      { savedTabIds: new Set(["surf-A1", "surf-B", "surf-A2"]), lineageId: "profile-1" },
    );

    expect(middleMismatch.matched.size).toBe(0);
    expect(middleMismatch.orphans.map((t) => t.tabId)).toEqual([30, 31, 32]);
  });

  it("never crosses lineages or confuses a person tab with an unrecorded agent tab on the same URL", () => {
    // Two distinct lineages on the same URL in the sidecar: lineage-B must never claim lineage-A's tab.
    const crossLineage = matchRestoredTabs(
      [restored(40, 0, "https://same.test/"), restored(41, 1, "https://same.test/")],
      [
        sidecar(0, "surf-person", "https://same.test/", "lineage-person"),
        sidecar(1, "surf-other", "https://same.test/", "lineage-other"),
      ],
      { savedTabIds: new Set(["surf-person", "surf-other"]), lineageId: "lineage-person" },
    );

    expect([...crossLineage.matched.keys()]).toEqual(["surf-person"]);
    expect(crossLineage.matched.get("surf-person")?.tab.tabId).toBe(40);
    expect(crossLineage.orphans.map((t) => t.tabId)).toEqual([41]);

    // Person tab in sidecar + unrecorded agent tab on the SAME URL after SIGKILL:
    // ambiguous duplicate -> neither matches, both closed as orphans, never crosses lineages.
    const personPlusAgent = matchRestoredTabs(
      [restored(50, 0, "https://same.test/"), restored(51, 1, "https://same.test/")],
      [sidecar(0, "surf-person", "https://same.test/", "lineage-person")],
      { savedTabIds: new Set(["surf-person"]), lineageId: "lineage-person" },
    );

    expect(personPlusAgent.matched.size).toBe(0);
    expect(personPlusAgent.orphans.map((t) => t.tabId)).toEqual([50, 51]);
  });
});
