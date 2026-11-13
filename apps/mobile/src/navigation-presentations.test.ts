import { expect, test } from "vitest";
import { routeShown } from "./navigation-presentations.js";

const stack = (...names: string[]) => ({
  index: names.length - 1,
  routes: names.map((name, index) => ({ key: `${name}-${index}`, name })),
});

test("a page stays drawn under sheets, and under a modal only where the modal is a card", () => {
  const underTabs = stack("Home", "WorkspaceBrowser", "BrowserTabs");
  expect(routeShown(underTabs, "WorkspaceBrowser-1", "ios")).toBe(true);
  expect(routeShown(underTabs, "WorkspaceBrowser-1", "android")).toBe(true);
  expect(routeShown(underTabs, "Home-0", "ios")).toBe(false);

  const underComputer = stack("WorkspaceBrowser", "Computer");
  expect(routeShown(underComputer, "WorkspaceBrowser-0", "ios")).toBe(true);
  expect(routeShown(underComputer, "WorkspaceBrowser-0", "android")).toBe(false);

  // A page pushed over another, as a popup is, covers it; a sheet over that one does not uncover it.
  const underPopup = stack("WorkspaceBrowser", "WorkspaceBrowser", "BrowserTabs");
  expect(routeShown(underPopup, "WorkspaceBrowser-0", "ios")).toBe(false);
  expect(routeShown(underPopup, "WorkspaceBrowser-1", "ios")).toBe(true);
  expect(routeShown(underPopup, "Gone", "ios")).toBe(false);
});
