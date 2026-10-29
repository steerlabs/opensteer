// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { StreamedContextMenu } from "./streamed-context-menu.js";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it("offers only the runtime-authorized menu and dispatches the selected link action", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const action = vi.fn();
  act(() =>
    root.render(
      <StreamedContextMenu
        left={40}
        top={60}
        editable
        selection
        linkUrl="https://example.test/link"
        onAction={action}
        onDismiss={() => undefined}
      />,
    ),
  );
  expect(
    [...container.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent),
  ).toEqual(["Cut", "Copy", "Paste", "Select All", "Copy Link Address", "Open Link in New Tab"]);
  act(() => container.querySelectorAll<HTMLButtonElement>("button")[5]!.click());
  expect(action).toHaveBeenCalledExactlyOnceWith("open-link");
  act(() => root.unmount());
  container.remove();
});
