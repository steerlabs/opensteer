// @vitest-environment happy-dom
import { act } from "react";
import { expect, it, vi, type MockInstance } from "vitest";
import { placeList } from "@opensteer/client/host";
import { HostClientRequestError } from "@opensteer/client/host";
import type { MockHostClient } from "@opensteer/client/mock";
import { client, element, history, mount } from "./workspace.interaction.test-support.js";

/*
 * Open again on the person's own window tab whose window is gone is what testers did by hand:
 * New tab → Apps & devices → the app, then close the dead tab. One click, the same door.
 */
async function deadWindowTab() {
  let tabId = "";
  let open!: MockInstance<MockHostClient["openTab"]>;
  let close!: MockInstance<MockHostClient["closeTabs"]>;
  await mount((source) => {
    const window = placeList(source.getSnapshot()).find(
      (place) => place.kind === "window" && place.availability === "ready",
    )!;
    tabId = window.key;
    open = vi.spyOn(source, "openTab");
    close = vi.spyOn(source, "closeTabs");
    return `/?panel=browser&tab=${tabId}`;
  });
  await vi.waitFor(() => expect(element(".owner-view").textContent).not.toContain("Opening"));
  const tab = client.getSnapshot().tabs.get(tabId as never)!;
  expect(tab.openedBy).toBe("person");
  // The app quit: the Home says the tab's window closed.
  await act(async () => client.closeWindowTab(tabId as never));
  await vi.waitFor(() =>
    expect(element(".owner-view").textContent).toContain("has no open window"),
  );
  return { tabId, tab, open, close };
}
const openAgain = () =>
  [...document.querySelectorAll<HTMLButtonElement>(".owner-view button")].find(
    (button) => button.textContent?.trim() === "Open again",
  )!;

it("opens the app afresh in the dead tab's place and closes it, in one click", async () => {
  const { tabId, tab, open, close } = await deadWindowTab();
  await act(async () => openAgain().click());
  await vi.waitFor(() => expect(close).toHaveBeenCalledWith([tabId]));
  expect(open).toHaveBeenCalledExactlyOnceWith({
    kind: "window",
    computerId: tab.computer.computerId,
    bundleId: tab.bundleId,
  });
  const opened = (await open.mock.results[0]!.value) as { tabId: string };
  // The new tab takes the middle in the dead tab's place, in the same history entry.
  await vi.waitFor(() => expect(history.at(-1)?.search).toContain(`tab=${opened.tabId}`));
  expect(document.querySelector(`.side-tab[data-place-key="${tabId}"]`)).toBeNull();
  await vi.waitFor(() =>
    expect(element(".owner-view").textContent).not.toContain("has no open window"),
  );
});

it("leaves the dead tab and its words when the fresh open is refused, closing nothing", async () => {
  const { tabId, open, close } = await deadWindowTab();
  open.mockRejectedValueOnce(
    new HostClientRequestError({ code: "not_found", status: 404, message: "Window closed" }),
  );
  await act(async () => openAgain().click());
  await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
  for (let turn = 0; turn < 4; turn++) await act(async () => {});
  expect(close).not.toHaveBeenCalled();
  expect(element(`.side-tab[data-place-key="${tabId}"]`)).toBeTruthy();
  expect(element(".owner-view").textContent).toContain("has no open window");
});
