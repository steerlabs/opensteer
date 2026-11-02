// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { BrowserPageMenu } from "./browser-page-menu.js";
vi.mock("../ui/sheet.js", () => ({
  Sheet: ({ children, title }: { children: ReactNode; title: string }) => (
    <section aria-label={title}>{children}</section>
  ),
}));
vi.mock("../ui/primitives.js", () => ({
  SecondaryButton: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios", Version: "26" },
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  StyleSheet: { create: (value: object) => value },
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it("shows only controller facts, prevents sensitive copying, and dispatches explicit page actions", () => {
  const rootElement = document.createElement("div");
  document.body.append(rootElement);
  const root = createRoot(rootElement);
  const action = vi.fn();
  const menu = { editable: true, selection: true, linkUrl: "https://example.test/link" };
  const render = (sensitive = false) =>
    act(() =>
      root.render(
        <BrowserPageMenu
          menu={menu}
          sensitive={sensitive}
          onAction={action}
          onDismiss={() => undefined}
        />,
      ),
    );
  render(true);
  const buttons = () => [...rootElement.querySelectorAll<HTMLButtonElement>("button")];
  expect(
    Object.fromEntries(buttons().map((button) => [button.textContent, button.disabled])),
  ).toMatchObject({ Copy: true, Cut: true, Paste: false });
  render();
  act(() =>
    buttons()
      .find((button) => button.textContent === "Open link in new tab")!
      .click(),
  );
  expect(action).toHaveBeenCalledExactlyOnceWith("open-link");
  act(() => root.unmount());
  rootElement.remove();
});
