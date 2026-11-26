import type { Tab } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import { openWindowTabAgain, opensWindowAgain } from "./window-tab-again.js";

const tab = {
  tabId: "tab_dead",
  kind: "window",
  title: "Notes",
  appName: "Notes",
  bundleId: "com.apple.Notes",
  computer: { computerId: "dev_mac", name: "Mac" },
  groupId: "tgr_work",
  state: "open",
  openedBy: "person",
  usedBy: [],
  createdAt: "2026-11-26T00:00:00Z",
  updatedAt: "2026-11-26T00:00:00Z",
} as unknown as Tab;

describe("Open again on a window tab whose window is gone", () => {
  it("opens afresh only the person's own window tab, and only when its window is gone", () => {
    expect(opensWindowAgain(tab, "window-closed")).toBe(true);
    expect(opensWindowAgain(tab, "window-identity-lost")).toBe(true);
    expect(opensWindowAgain(tab, "capture-timeout")).toBe(false);
    expect(opensWindowAgain(tab, null)).toBe(false);
    expect(
      opensWindowAgain(
        { ...tab, state: "unavailable", unavailableCode: "window-closed" } as Tab,
        "closed",
      ),
    ).toBe(true);
    // A task's tab keeps the window its Run observed.
    expect(
      opensWindowAgain({ ...tab, openedBy: { taskId: "thr_x" } } as Tab, "window-closed"),
    ).toBe(false);
    expect(opensWindowAgain({ ...tab, kind: "phone" } as Tab, "window-closed")).toBe(false);
  });

  it("opens the same app on the same device, shows it, puts it in place and only then closes the dead tab", async () => {
    const calls: string[] = [];
    const client = {
      openTab: vi.fn(async () => {
        calls.push("open");
        return { ...tab, tabId: "tab_new" } as Tab;
      }),
      organizeTabs: vi.fn(async () => {
        calls.push("organize");
        return { tabs: [], groups: [] } as never;
      }),
      closeTabs: vi.fn(async () => {
        calls.push("close");
        return { closed: [], failed: [] } as never;
      }),
    };
    await openWindowTabAgain(client, tab, () => calls.push("show"));
    expect(calls).toEqual(["open", "show", "organize", "close"]);
    expect(client.openTab).toHaveBeenCalledWith({
      kind: "window",
      computerId: "dev_mac",
      bundleId: "com.apple.Notes",
    });
    expect(client.organizeTabs).toHaveBeenCalledWith({
      tabIds: ["tab_new"],
      group: { groupId: "tgr_work" },
      beforeTabId: "tab_dead",
    });
    expect(client.closeTabs).toHaveBeenCalledWith(["tab_dead"]);
  });

  it("closes nothing when the fresh open is refused", async () => {
    const client = {
      openTab: vi.fn(async () => {
        throw new Error("Window closed");
      }),
      organizeTabs: vi.fn(),
      closeTabs: vi.fn(),
    };
    const show = vi.fn();
    await expect(openWindowTabAgain(client, tab, show)).rejects.toThrow("Window closed");
    expect(show).not.toHaveBeenCalled();
    expect(client.closeTabs).not.toHaveBeenCalled();
  });
});
