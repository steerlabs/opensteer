import { readFileSync } from "node:fs";
import { describe, expect, it, test } from "vitest";
import { layoutRoute, presentedFrom, routesAbove, routeShown } from "./navigation-presentations.js";

const stack = (...names: string[]) => ({
  index: names.length - 1,
  routes: names.map((name, index) => ({ key: `${name}-${index}`, name })),
});

test("a page stays drawn under sheets, and under modals only where a modal is a card", () => {
  const underTabs = stack("Home", "WorkspaceBrowser", "BrowserTabs");
  expect(routeShown(underTabs, "WorkspaceBrowser-1", "ios")).toBe(true);
  expect(routeShown(underTabs, "WorkspaceBrowser-1", "android")).toBe(true);
  expect(routeShown(underTabs, "Home-0", "ios")).toBe(false);

  const underComputer = stack("WorkspaceBrowser", "Computer");
  expect(routeShown(underComputer, "WorkspaceBrowser-0", "ios")).toBe(true);
  expect(routeShown(underComputer, "WorkspaceBrowser-0", "android")).toBe(false);

  // A phone opened from Computer is presented as a modal too, as the native stack does.
  const phoneFromComputer = stack("WorkspaceBrowser", "Computer", "WorkspaceBrowser");
  expect(routeShown(phoneFromComputer, "WorkspaceBrowser-0", "ios")).toBe(true);
  expect(routeShown(phoneFromComputer, "WorkspaceBrowser-0", "android")).toBe(false);

  // A page pushed over another, as a popup is, covers it; a sheet over that one does not uncover it.
  const underPopup = stack("WorkspaceBrowser", "WorkspaceBrowser", "BrowserTabs");
  expect(routeShown(underPopup, "WorkspaceBrowser-0", "ios")).toBe(false);
  expect(routeShown(underPopup, "WorkspaceBrowser-1", "ios")).toBe(true);
  expect(routeShown(underPopup, "Gone", "ios")).toBe(false);
  expect(routesAbove(underPopup, "WorkspaceBrowser-0")).toBe(2);
  expect(routesAbove(underPopup, "Gone")).toBeNull();
});

test("every screen's presentation is named in the presentation map", () => {
  const source = readFileSync(new URL("./navigation.tsx", import.meta.url), "utf8");
  expect(source).not.toMatch(/presentation:\s*["']/);
});

/*
 * Where the presented flow over the stack begins. What can go wrong: a page
 * pushed inside a modal is taken for a screen of the stack, so leaving the
 * flow strands part of it, or the layout and the sidebar follow a page the
 * shell does not hold.
 */
describe("the presented flow", () => {
  it("starts at the first sheet or modal, and takes in every page pushed inside it", () => {
    expect(presentedFrom(stack("Home", "Thread"))).toBe(-1);
    expect(presentedFrom(stack("Home", "Thread", "Settings", "SettingsDevices"))).toBe(2);
    expect(presentedFrom(stack("Home", "QuietlyMoved"))).toBe(1);
    expect(presentedFrom(stack("Home", "AddDeployment", "AddServer"))).toBe(1);
  });

  it("leaves the screen beneath it in charge of the layout", () => {
    expect(layoutRoute(stack("Home", "Thread"))?.name).toBe("Thread");
    expect(layoutRoute(stack("Home", "Thread", "Settings", "SettingsDevices"))?.name).toBe(
      "Thread",
    );
    expect(layoutRoute(stack("Home", "Thread", "ThreadAround"))?.name).toBe("Thread");
  });
});
