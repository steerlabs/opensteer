// @vitest-environment happy-dom
import { act } from "react";
import { expect, it, vi } from "vitest";
import { placeList } from "@opensteer/client/host";
import { client, mount } from "./workspace.interaction.test-support.js";

/*
 * V10: while a sleeping tab wakes, the stage says "Waking this tab…" with its address, at once:
 * never an empty stage, and never "Starting browser…" (only a browser starts). The old stage was
 * empty for a second and then said the browser was starting.
 */
const stage = () => document.querySelector(".browser-stage")?.textContent ?? "";

it("says a sleeping tab is waking, with its address, before this device holds its page", async () => {
  let url = "";
  await mount((source) => {
    const page = placeList(source.getSnapshot()).find((place) => place.kind === "page")!;
    url = page.tab.url!;
    source.setBrowserTabState(page.key, "suspended");
    // The wake has not answered yet.
    vi.spyOn(source, "activateTab").mockReturnValue(new Promise(() => {}));
    return `/?panel=browser&tab=${page.key}`;
  });
  expect(stage()).toContain("Waking this tab…");
  expect(stage()).toContain(url);
  expect(stage()).not.toContain("Opening…");
});

it("says a tab that went to sleep under its shown page is waking, at once and until its picture", async () => {
  let tabId = "";
  let url = "";
  await mount((source) => {
    const page = placeList(source.getSnapshot()).find((place) => place.kind === "page")!;
    tabId = page.key;
    url = page.tab.url!;
    return `/?panel=browser&tab=${tabId}`;
  });
  // The tab sleeps under the shown page; this device asks again, and the wake has not answered.
  vi.useFakeTimers();
  try {
    const asking = vi.spyOn(client, "activateTab").mockReturnValue(new Promise(() => {}));
    await act(async () => client.setBrowserTabState(tabId, "suspended"));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(asking).toHaveBeenCalledOnce();
    expect(stage()).toContain("Waking this tab…");
    expect(stage()).toContain(url);
    // A second later it still says so, never that the browser is starting.
    await act(async () => vi.advanceTimersByTimeAsync(1_100));
    expect(stage()).toContain("Waking this tab…");
    expect(stage()).not.toContain("Starting browser…");
  } finally {
    vi.useRealTimers();
  }
});
