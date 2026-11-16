import { describe, expect, it } from "vitest";
import type { TabId } from "@opensteer/core";
import { TabStore } from "../host/tab-store.js";
import { tabFixture, tabStoreFixture } from "../test-support/tab-fixtures.js";
import { tabReferenceState } from "./links.js";

const tabId = "tab_00000000-0000-4000-8000-000000000001" as TabId;

describe("tab links", () => {
  it("is unavailable once the complete list lacks it, and never before", () => {
    const syncing = new TabStore();
    expect(tabReferenceState(syncing, tabId)).toEqual({ state: "unresolved" });
    const tab = tabFixture({ tabId, kind: "window" });
    const listed = tabStoreFixture([tab]);
    const first = tabReferenceState(listed, tabId);
    expect(first).toEqual({ state: "available", tab });
    expect(tabReferenceState(listed, tabId)).toBe(first);
    expect(tabReferenceState(tabStoreFixture([]), tabId)).toEqual({ state: "unavailable" });
  });
});
