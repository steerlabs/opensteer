import { beforeEach, expect, it, vi } from "vitest";
import type { TabRoute } from "../browser/surface-route.js";
import { tabId } from "../../test-support/mock-tabs.js";
import { navigationRef } from "../navigation-ref.js";
import { show } from "./navigation.js";
const ref = vi.hoisted(() => ({
  isReady: vi.fn(() => true),
  getCurrentRoute: vi.fn(),
  getRootState: vi.fn(),
  dispatch: vi.fn(),
}));
vi.mock("@react-navigation/native", () => ({
  createNavigationContainerRef: () => ref,
  CommonActions: {
    reset: (payload: object) => ({ type: "RESET", payload }),
    setParams: (params: object) => ({ type: "SET_PARAMS", payload: { params } }),
  },
  StackActions: {
    push: (name: string, params: object) => ({ type: "PUSH", payload: { name, params } }),
    popTo: (name: string, params: object) => ({ type: "POP_TO", payload: { name, params } }),
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(navigationRef.dispatch).mockReset();
  ref.getRootState.mockImplementation(() => ({
    index: 1,
    routes: [{ key: "home", name: "Home", params: { deploymentId: "d" } }, ref.getCurrentRoute()],
  }));
});
const tab = (name: string) => ({ kind: "tab" as const, tabId: tabId(name) });

it("reports failure when navigation is not ready", () => {
  vi.mocked(navigationRef.isReady).mockReturnValueOnce(false);
  expect(show("d", { kind: "thread", threadId: "t" })).toBe(false);
  expect(show(null, { kind: "thread", threadId: "t" })).toBe(false);
});
it("does not push an already visible task or exact tab", () => {
  vi.mocked(navigationRef.getCurrentRoute).mockReturnValue({
    key: "task",
    name: "Thread",
    params: { deploymentId: "d", threadId: "t" },
  });
  expect(show("d", { kind: "thread", threadId: "t" })).toBe(false);
  expect(navigationRef.dispatch).not.toHaveBeenCalled();
  vi.mocked(navigationRef.getCurrentRoute).mockReturnValue({
    key: "tab",
    name: "WorkspaceBrowser" as const,
    params: { deploymentId: "d", tabId: tabId("one") },
  });
  expect(show("d", tab("one"))).toBe(false);
  expect(navigationRef.dispatch).not.toHaveBeenCalled();
  expect(show("d", tab("two"))).toBe(true);
  expect(navigationRef.dispatch).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: "SET_PARAMS", source: "tab" }),
  );
});

it("changes A to B to C in place, preserving the Thread below and clearing transient state", () => {
  const below = {
    key: "thread",
    name: "Thread" as const,
    params: { deploymentId: "d", threadId: "t" },
  };
  const browser: { key: string; name: "WorkspaceBrowser"; params: TabRoute } = {
    key: "browser",
    name: "WorkspaceBrowser",
    params: { deploymentId: "d", editAddress: true, popup: true, tabId: tabId("A"), threadId: "t" },
  };
  const routes = [below, browser];
  vi.mocked(navigationRef.getCurrentRoute).mockImplementation(() => browser);
  vi.mocked(navigationRef.dispatch).mockImplementation((action) => {
    if (typeof action === "function") throw new Error("Expected an action");
    expect(action.type).toBe("SET_PARAMS");
    expect(action.source).toBe(browser.key);
    browser.params = {
      ...browser.params,
      ...(action.payload as { params: Partial<TabRoute> }).params,
    };
  });
  for (const name of ["B", "C"]) {
    expect(show("d", tab(name))).toBe(true);
    expect(browser.params).toMatchObject({ deploymentId: "d", tabId: tabId(name), threadId: "t" });
    expect(browser.params.popup).toBeFalsy();
    expect(browser.params.editAddress).toBeFalsy();
  }
  expect(routes).toEqual([below, browser]);
  expect(show("d", tab("C"))).toBe(false);
  expect(navigationRef.dispatch).toHaveBeenCalledTimes(2);
  vi.mocked(navigationRef.dispatch).mockReset();
});
it("pushes the first tab from a Thread or a different deployment", () => {
  for (const route of [
    { key: "thread", name: "Thread" as const, params: { deploymentId: "d", threadId: "t" } },
    {
      key: "browser",
      name: "WorkspaceBrowser" as const,
      params: { deploymentId: "other", tabId: tabId("A") },
    },
  ]) {
    vi.mocked(navigationRef.getCurrentRoute).mockReturnValue(route);
    expect(show("d", tab("B"))).toBe(true);
    expect(navigationRef.dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "PUSH" }),
    );
  }
});
it("opens a task from a team's screen through the Tasks side", () => {
  ref.getCurrentRoute.mockReturnValue({
    key: "channel",
    name: "TeamChannel",
    params: { teamId: "team", channelId: "general" },
  });
  expect(show("d", { kind: "thread", threadId: "t" })).toBe(true);
  expect(navigationRef.dispatch).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: "RESET" }),
  );
});
