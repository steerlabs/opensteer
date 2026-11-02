import { expect, it, vi } from "vitest";
import { navigationRef } from "../navigation-ref.js";
import { show } from "./navigation.js";
vi.mock("@react-navigation/native", () => ({
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
    canGoBack: vi.fn(() => true),
    goBack: vi.fn(),
  },
}));
it("reports failure when navigation is not ready or Back has nowhere to go", () => {
  vi.mocked(navigationRef.isReady).mockReturnValueOnce(false);
  expect(show("d", { kind: "chat" })).toBe(false);
  expect(show(null, { kind: "chat" })).toBe(false);
  vi.mocked(navigationRef.canGoBack).mockReturnValueOnce(false);
  expect(show("d", { kind: "back" })).toBe(false);
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
    name: "WorkspaceBrowser",
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
    expect.objectContaining({ type: "PUSH" }),
  );
  expect(show("d", { kind: "chat" })).toBe(true);
  expect(navigationRef.dispatch).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: "POP_TO",
      payload: { name: "Home", params: { deploymentId: "d" } },
    }),
  );
});
