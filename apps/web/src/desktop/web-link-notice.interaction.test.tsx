// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { DesktopWebLinkFailureNotice } from "../components/app-shell.js";
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
it.each(["Retry", "Dismiss"])("offers a visible %s action for an open failure", async (label) => {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const actions = { retry: vi.fn(async () => undefined), dismiss: vi.fn(async () => undefined) };
  const clear = vi.fn();
  try {
    await act(async () =>
      root.render(
        <DesktopWebLinkFailureNotice
          message="Browser unavailable"
          actions={actions}
          onResolve={clear}
        />,
      ),
    );
    expect(node.querySelector('[role="alert"]')?.textContent).toContain("Browser unavailable");
    const buttons = Array.from(node.querySelectorAll("button"));
    expect(buttons.map((button) => button.textContent)).toEqual(["Retry", "Dismiss"]);
    await act(async () => buttons.find((button) => button.textContent === label)!.click());
    expect(label === "Retry" ? actions.retry : actions.dismiss).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    node.remove();
  }
});
