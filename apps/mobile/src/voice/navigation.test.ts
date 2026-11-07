import { beforeEach, expect, it, vi } from "vitest";
import { paramsDestination, type SurfacesRoute } from "../browser/surface-route.js";
import { navigationRef } from "../navigation-ref.js";
import { show } from "./navigation.js";
vi.mock("@react-navigation/native", () => ({
  CommonActions: {
    setParams: (params: object) => ({ type: "SET_PARAMS", payload: { params } }),
  },
  StackActions: {
    push: (name: string, params: object) => ({ type: "PUSH", payload: { name, params } }),
    popTo: (name: string, params: object) => ({ type: "POP_TO", payload: { name, params } }),
  },
}));
vi.mock("../navigation-ref.js", () => ({
  navigationRef: {
    isReady: vi.fn(() => true),
    getCurrentRoute: vi.fn(),
    dispatch: vi.fn(),
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(navigationRef.dispatch).mockReset();
});
it("reports failure when navigation is not ready", () => {
  vi.mocked(navigationRef.isReady).mockReturnValueOnce(false);
  expect(show("d", { kind: "chat" })).toBe(false);
  expect(show(null, { kind: "chat" })).toBe(false);
});
it("does not push an already visible task or exact tab and pops to the existing Home root", () => {
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
    params: { deploymentId: "d", scope: "workspace", sessionId: "s", tabId: "one" },
  });
  expect(
    show("d", { kind: "place", destination: { kind: "browser", sessionId: "s", tabId: "one" } }),
  ).toBe(false);
  expect(navigationRef.dispatch).not.toHaveBeenCalled();
  expect(
    show("d", { kind: "place", destination: { kind: "browser", sessionId: "s", tabId: "two" } }),
  ).toBe(true);
  expect(navigationRef.dispatch).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: "SET_PARAMS", source: "tab" }),
  );
  expect(show("d", { kind: "chat" })).toBe(true);
  expect(navigationRef.dispatch).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: "POP_TO",
      payload: { name: "Home", params: { deploymentId: "d" } },
    }),
  );
});

it("changes A to B to C in place, preserving the Thread below and clearing transient state", () => {
  const below = {
    key: "thread",
    name: "Thread" as const,
    params: { deploymentId: "d", threadId: "t" },
  };
  const browser = {
    key: "browser",
    name: "WorkspaceBrowser" as const,
    params: {
      deploymentId: "d",
      threadId: "t",
      sessionId: "s",
      tabId: "A",
      popup: true,
      editAddress: true,
      pendingBrowserTab: "pending",
    } as SurfacesRoute,
  };
  const routes = [below, browser];
  vi.mocked(navigationRef.getCurrentRoute).mockImplementation(() => browser);
  vi.mocked(navigationRef.dispatch).mockImplementation((action) => {
    if (typeof action === "function") throw new Error("Expected an action");
    expect(action.type).toBe("SET_PARAMS");
    expect(action.source).toBe(browser.key);
    browser.params = {
      ...browser.params,
      ...(action.payload as { params: Partial<SurfacesRoute> }).params,
    } as SurfacesRoute;
  });
  for (const tabId of ["B", "C"]) {
    expect(
      show("d", { kind: "place", destination: { kind: "browser", sessionId: "s", tabId } }),
    ).toBe(true);
    expect(browser.params).toMatchObject({ deploymentId: "d", threadId: "t", tabId });
    expect(browser.params["scope"]).toBeUndefined();
    expect(browser.params["popup"]).toBeFalsy();
    expect(browser.params["editAddress"]).toBeFalsy();
    expect(browser.params["pendingBrowserTab"]).toBeUndefined();
  }
  expect(routes).toEqual([below, browser]);
  expect(
    show("d", { kind: "place", destination: { kind: "browser", sessionId: "s", tabId: "C" } }),
  ).toBe(false);
  expect(navigationRef.dispatch).toHaveBeenCalledTimes(2);
  vi.mocked(navigationRef.dispatch).mockReset();
});
it("pushes the first place from a Thread or a different deployment", () => {
  for (const route of [
    { key: "thread", name: "Thread" as const, params: { deploymentId: "d", threadId: "t" } },
    {
      key: "browser",
      name: "WorkspaceBrowser" as const,
      params: { deploymentId: "other", scope: "workspace" as const, sessionId: "s", tabId: "A" },
    },
  ]) {
    vi.mocked(navigationRef.getCurrentRoute).mockReturnValue(route);
    expect(
      show("d", { kind: "place", destination: { kind: "browser", sessionId: "s", tabId: "B" } }),
    ).toBe(true);
    expect(navigationRef.dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "PUSH" }),
    );
  }
});

it("replaces all destination fields when showing a different kind of place", () => {
  const browser = {
    key: "browser",
    name: "WorkspaceBrowser" as const,
    params: {
      deploymentId: "d",
      scope: "workspace",
      sessionId: "s",
      tabId: "A",
      popup: true,
    } as SurfacesRoute,
  };
  vi.mocked(navigationRef.getCurrentRoute).mockImplementation(() => browser);
  vi.mocked(navigationRef.dispatch).mockImplementation((action) => {
    if (typeof action === "function") throw new Error("Expected an action");
    expect(action.type).toBe("SET_PARAMS");
    browser.params = {
      ...browser.params,
      ...(action.payload as { params: Partial<SurfacesRoute> }).params,
    } as SurfacesRoute;
  });
  const destinations = [
    { kind: "phone", machineId: "phone" },
    { kind: "app", machineId: "mac", appKey: "notes", computerSessionId: "session" },
    { kind: "opensteer-app", appId: "app_11111111-1111-4111-8111-111111111111" },
    { kind: "browser", sessionId: "s", tabId: "B" },
  ] as const;
  for (const destination of destinations) {
    expect(show("d", { kind: "place", destination })).toBe(true);
    expect(paramsDestination(browser.params)).toEqual(destination);
    expect(browser.params.scope).toBe("workspace");
    expect(browser.params.popup).toBe(false);
    expect(show("d", { kind: "place", destination })).toBe(false);
  }
});
