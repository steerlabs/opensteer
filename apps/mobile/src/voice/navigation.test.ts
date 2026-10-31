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
    isReady: () => true,
    getCurrentRoute: vi.fn(),
    dispatch: vi.fn(),
    canGoBack: () => true,
    goBack: vi.fn(),
  },
}));
it("does not push an already visible task or exact tab and pops to the existing Home root", () => {
  vi.mocked(navigationRef.getCurrentRoute).mockReturnValue({
    key: "task",
    name: "Thread",
    params: { deploymentId: "d", threadId: "t" },
  });
  show("d", { kind: "thread", threadId: "t" });
  expect(navigationRef.dispatch).not.toHaveBeenCalled();
  vi.mocked(navigationRef.getCurrentRoute).mockReturnValue({
    key: "tab",
    name: "WorkspaceBrowser",
    params: { deploymentId: "d", scope: "workspace", sessionId: "s", tabId: "one" },
  });
  show("d", { kind: "place", destination: { kind: "browser", sessionId: "s", tabId: "one" } });
  expect(navigationRef.dispatch).not.toHaveBeenCalled();
  show("d", { kind: "place", destination: { kind: "browser", sessionId: "s", tabId: "two" } });
  expect(navigationRef.dispatch).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: "PUSH" }),
  );
  show("d", { kind: "chat" });
  expect(navigationRef.dispatch).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: "POP_TO",
      payload: { name: "Home", params: { deploymentId: "d" } },
    }),
  );
});
