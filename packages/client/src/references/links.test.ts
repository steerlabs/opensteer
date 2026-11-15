import { describe, expect, it } from "vitest";
import { tabReferenceHref, type TabId } from "@opensteer/core";
import { TabStore } from "../host/tab-store.js";
import { tabFixture, tabStoreFixture } from "../test-support/tab-fixtures.js";
import { classifyLink, tabReferenceState } from "./links.js";

const tabId = "tab_00000000-0000-4000-8000-000000000001" as TabId;

describe("tab links", () => {
  it("names a tab only by its exact encoded ID, and leaves every other link as it was", () => {
    expect(classifyLink(tabReferenceHref(tabId))).toEqual({ kind: "tab", tabId });
    expect(classifyLink("opensteer:tab/not%2")).toEqual({ kind: "none" });
    expect(classifyLink("opensteer:tab/")).toEqual({ kind: "none" });
    expect(classifyLink("https://example.com/").kind).toBe("web");
    expect(classifyLink("opensteer:thr_12345678-1234-4234-8234-123456789abc")).toMatchObject({
      kind: "reference",
      reference: { kind: "task" },
    });
  });

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
