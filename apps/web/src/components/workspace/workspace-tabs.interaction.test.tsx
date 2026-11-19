// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { placeList, type TabStrip } from "@opensteer/client/host";
import {
  client,
  click,
  element,
  history,
  mount,
  until,
} from "./workspace.interaction.test-support.js";

/*
 * Ways the one tab list can fail a person: kinds are sorted apart instead of
 * kept in the Host's order; a shortcut walks a different order than the list
 * shows; closing the tab in the middle leaves a dead page or jumps elsewhere;
 * a closed tab comes back somewhere else; a group menu loses tabs; an app's
 * page reloads whenever another tab is shown.
 */

const strip = (): TabStrip => client.getSnapshot().tabs.strip;
/** Each row the list draws, in order: a group's own row, then its open members. */
const expectedRows = () =>
  strip().entries.flatMap((entry) =>
    entry.kind === "tab"
      ? [entry.tabId]
      : [entry.group.groupId, ...(entry.group.collapsed ? [] : entry.tabIds)],
  );
const drawnRows = () =>
  [...document.querySelectorAll<HTMLElement>(".side-section--tabs .side-tab")]
    .filter((row) => !row.classList.contains("side-tab--start"))
    .map((row) => row.dataset.tabGroupId ?? row.dataset.placeKey);
const row = (key: string) => element<HTMLElement>(`.side-tab[data-place-key="${key}"]`);
const main = (key: string) => element<HTMLButtonElement>(".side-tab__main", row(key));
const shown = () => document.querySelector<HTMLElement>(".place:not([hidden])")?.dataset.placeKey;
const groupId = () => {
  const group = strip().entries.find((entry) => entry.kind === "group");
  if (group?.kind !== "group") throw new Error("Missing seeded group");
  return group.group.groupId;
};
/** Presses a shortcut and waits until `done` holds: what the shortcut is for. */
async function key(init: KeyboardEventInit, done: () => void) {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  });
  await until(`${JSON.stringify(init)} never took effect`, done);
}

afterEach(() => vi.unstubAllGlobals());

describe("one tab list", () => {
  it("draws every kind of tab in the Host's one order, a group's members under it, New tab last", async () => {
    await mount("/");
    expect(drawnRows()).toEqual(expectedRows());
    const members = strip().entries.find((entry) => entry.kind === "group")!;
    if (members.kind !== "group") throw new Error("Missing seeded group");
    expect(new Set(members.tabIds.map((id) => row(id).dataset.kind))).toEqual(
      new Set(["page", "window", "phone", "app"]),
    );
    expect(element(".side-section--tabs .side-list").lastElementChild?.className).toContain(
      "side-new",
    );
    // A tab the Host cannot show says why, in its row.
    const closed = placeList(client.getSnapshot()).find(
      (place) => place.availability === "unavailable",
    )!;
    expect(row(closed.key).classList.contains("is-unavailable")).toBe(true);
    expect(main(closed.key).title).toContain(closed.unavailableReason!);
  });

  it("walks that same order with ⌃Tab and ⌘1–9, passing over a collapsed group", async () => {
    vi.stubGlobal("opensteerDesktop", {
      getLocalVisibility: async () => true,
      onLocalVisibilityChanged: () => () => undefined,
      setBadgeCount: vi.fn(async () => undefined),
    });
    await mount("/");
    const visible = strip().visible;
    await click(main(visible[0]!));
    expect(shown()).toBe(visible[0]);
    await key({ key: "Tab", ctrlKey: true }, () => expect(shown()).toBe(visible[1]));
    await key({ key: "Tab", ctrlKey: true, shiftKey: true }, () =>
      expect(shown()).toBe(visible[0]),
    );
    await key({ key: "9", metaKey: true }, () => expect(shown()).toBe(visible.at(-1)));
    await key({ key: "3", metaKey: true }, () => expect(shown()).toBe(visible[2]));

    await click(element(`[data-tab-group-id="${groupId()}"] .side-tab-group__main`));
    const collapsed = strip().visible;
    expect(collapsed.length).toBeLessThan(visible.length);
    expect(drawnRows()).toEqual(expectedRows());
    await key({ key: "1", metaKey: true }, () => expect(shown()).toBe(collapsed[0]));
    await key({ key: "Tab", ctrlKey: true }, () => expect(shown()).toBe(collapsed[1]));
  });

  it("closing the tab in the middle shows the tab after it, else before it, and ⌘⇧T puts it back", async () => {
    vi.stubGlobal("opensteerDesktop", {
      getLocalVisibility: async () => true,
      onLocalVisibilityChanged: () => () => undefined,
      setBadgeCount: vi.fn(async () => undefined),
    });
    await mount("/");
    const visible = strip().visible;
    const middle = visible[1]!;
    await click(main(middle));
    const before = history.length;
    await click(element(".side-tab__close", row(middle)));
    expect(document.querySelector(`.side-tab[data-place-key="${middle}"]`)).toBeNull();
    expect(shown()).toBe(visible[2]);
    expect(history.length).toBe(before + 1);
    expect(history.at(-1)?.type).toBe("REPLACE");

    await key({ key: "t", metaKey: true, shiftKey: true }, () => {
      expect(strip().visible).toEqual(visible);
      expect(shown()).toBe(middle);
    });

    const last = visible.at(-1)!;
    await click(main(last));
    await key({ key: "w", metaKey: true }, () => expect(shown()).toBe(visible.at(-2)));
  });

  it("a group's menu renames and ungroups it, keeping every tab where it was", async () => {
    await mount("/");
    const order = strip().ordered;
    const group = groupId();
    await act(async () => {
      element(`[data-tab-group-id="${group}"]`).dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      );
    });
    const title = await until("The group's menu never offered its title", () =>
      element<HTMLInputElement>('[aria-label="Group title"]'),
    );
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        title,
        "Launch week",
      );
      title.dispatchEvent(new Event("input", { bubbles: true }));
      title.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    });
    await until("The group never took its new title", () =>
      expect(element(`[data-tab-group-id="${group}"] .side-tab-group__chip`).textContent).toBe(
        "Launch week",
      ),
    );
    await act(async () => {
      element(`[data-tab-group-id="${group}"]`).dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      );
    });
    const ungroup = await until("The group's menu never offered Ungroup", () => {
      const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((node) =>
        node.textContent?.includes("Ungroup"),
      );
      expect(item).toBeDefined();
      return item!;
    });
    await click(ungroup);
    await until("Ungroup never removed the group", () =>
      expect(document.querySelector(`[data-tab-group-id="${group}"]`)).toBeNull(),
    );
    expect(strip().ordered).toEqual(order);
    expect(drawnRows()).toEqual(order);
  });
});

describe("an app tab", () => {
  const frames = () => [
    ...document.querySelectorAll<HTMLIFrameElement>(".place--opensteer-app iframe"),
  ];

  it("keeps one running frame through other tabs and Talk until it is closed", async () => {
    vi.spyOn(HTMLIFrameElement.prototype, "contentWindow", "get").mockReturnValue({
      postMessage: vi.fn(),
    } as unknown as Window);
    let app = "";
    await mount((source) => {
      const place = placeList(source.getSnapshot()).find(
        (item) => item.kind === "app" && item.availability === "ready",
      )!;
      app = place.key;
      vi.spyOn(source, "viewApp").mockImplementation(async (appId) => ({
        title: "App",
        url: `https://host.test/v1/apps/${appId}/dark/token/`,
      }));
      return `/?panel=browser&tab=${app}`;
    });
    await vi.waitFor(() => expect(frames()).toHaveLength(1), { timeout: 2_000 });
    const running = frames()[0]!;
    const page = placeList(client.getSnapshot()).find((item) => item.kind === "window")!;
    await click(main(page.key));
    expect(frames()).toEqual([running]);
    expect(running.closest<HTMLElement>(".place")?.hidden).toBe(true);
    await click(main(app));
    expect(frames()).toEqual([running]);
    expect(running.closest<HTMLElement>(".place")?.hidden).toBe(false);
    await click(element(".side-tab__close", row(app)));
    expect(running.isConnected).toBe(false);
    expect(frames()).toEqual([]);
  });
});
