// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { workspaceHealth } from "./home-view.js";
import { MockHostClient } from "@opensteer/client/mock";
const shell = vi.hoisted(() => ({ dispatch: vi.fn(), error: vi.fn() }));
vi.mock("./app-shell.js", () => ({
  useShell: () => ({ hostClient: { dispatch: shell.dispatch }, reportActionError: shell.error }),
}));
it("shows relocation paths and explicit confirmation, and reports a refused adoption", async () => {
  const client = new MockHostClient({ latencyMs: 0 });
  const snapshot = client.getSnapshot();
  const workspace = snapshot.workspaces[0]!;
  const notice = workspaceHealth(
    {
      ...workspace,
      status: "failed",
      storageIssue: {
        code: "relocation-required",
        message: "Move /old/project to /main/Projects/research",
        occurredAt: new Date().toISOString(),
        retryable: false,
      },
    },
    snapshot,
  )!;
  expect(notice.body).toContain("/old/project");
  expect(notice.body).toContain("/main/Projects/research");
  const element = document.createElement("div");
  const root = createRoot(element);
  shell.dispatch.mockRejectedValueOnce(new Error("Target missing"));
  try {
    // Both folders stand on their own lines, whole, to be read and copied.
    await act(async () => root.render(notice.detail));
    expect([...element.querySelectorAll("code")].map((code) => code.textContent)).toEqual([
      "/old/project",
      "/main/Projects/research",
    ]);
    await act(async () => root.render(notice.action));
    expect(element.textContent).toBe("I moved it");
    await act(async () => element.querySelector("button")!.click());
    expect(shell.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "workspace.adoptRelocated", workspaceId: workspace.id }),
    );
    expect(shell.error).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Target missing" }),
    );
  } finally {
    await act(async () => root.unmount());
    client.dispose();
  }
});
