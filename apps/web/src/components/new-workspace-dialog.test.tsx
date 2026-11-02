// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { NewWorkspaceDialog } from "./new-workspace-dialog.js";

const noOp = () => undefined;

describe("NewWorkspaceDialog", () => {
  it("asks only for name and icon and shows creation failures", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <NewWorkspaceDialog
          creating={false}
          error="Connect the computer holding Main"
          onClose={noOp}
          onCreate={noOp}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("Name");
    expect(html).toContain("Icon");
    expect(html).toContain("Connect the computer holding Main");
    expect(html).not.toContain("Computer");
    expect(html).not.toContain("radiogroup");
    expect(html).not.toContain("select");
  });
  it("submits the trimmed name without storage selectors", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onCreate = vi.fn();
    try {
      await act(async () =>
        root.render(
          <MemoryRouter>
            <NewWorkspaceDialog creating={false} error={null} onClose={noOp} onCreate={onCreate} />
          </MemoryRouter>,
        ),
      );
      const input = container.querySelector("input")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          input,
          " Research ",
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () =>
        container
          .querySelector("form")!
          .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      expect(onCreate).toHaveBeenCalledWith({ icon: null, name: "Research" });
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
