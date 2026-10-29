// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * The docked sidebar's own control over a task. What can go wrong:
 * - a reader who hid the sidebar over a task has no way to show it again but
 *   leaving the task for Chat;
 * - the control replaces Back, so the task cannot be left the platform's way;
 * - it is a drawn view rather than a native bar item, so it is not in the
 *   vertical bar, has no label for VoiceOver, and is not a keyboard target;
 * - it says the wrong thing — Show when the sidebar is shown — or appears
 *   where the window has no room to dock, where it would do nothing useful;
 * - pressing it opens the drawer or dismisses the keyboard instead of
 *   toggling the docked column.
 */

const harness = vi.hoisted(() => ({
  options: {} as Record<string, unknown>,
  open: vi.fn(),
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  Pressable: ({
    accessibilityLabel,
    children,
    onPress,
  }: {
    accessibilityLabel?: string;
    children?: ReactNode;
    onPress?: () => void;
  }) => (
    <button aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </button>
  ),
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@react-navigation/native", () => {
  const navigation = {
    setOptions: (options: Record<string, unknown>) => {
      harness.options = { ...harness.options, ...options };
    },
  };
  return { useNavigation: () => navigation };
});
vi.mock("./ui/mobile-client-context.js", () => ({ useHostValue: () => 0 }));
vi.mock("./ui/primitives.js", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("./ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("./browser/browser-button.js", () => ({ BrowserButton: () => null }));

import { useSidebarToggle } from "./navigation-header.js";
import {
  SidebarControlContext,
  SidebarDockContext,
  type SidebarDock,
} from "./sidebar/sidebar-context.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  harness.options = {};
  harness.open.mockReset();
});

function Task(): ReactNode {
  useSidebarToggle();
  return null;
}

function mount(dock: SidebarDock) {
  const root = createRoot(document.createElement("div"));
  roots.push(root);
  const render = (next: SidebarDock) =>
    act(() =>
      root.render(
        <SidebarControlContext.Provider value={{ close: vi.fn(), open: harness.open }}>
          <SidebarDockContext.Provider value={next}>
            <Task />
          </SidebarDockContext.Provider>
        </SidebarControlContext.Provider>,
      ),
    );
  render(dock);
  return render;
}

interface NativeItem {
  readonly accessibilityLabel: string;
  readonly icon?: { readonly name: string; readonly type: string };
  readonly label: string;
  readonly onPress: () => void;
  readonly type: string;
}

function leadingItems(): readonly NativeItem[] {
  const items = harness.options["unstable_headerLeftItems"];
  return typeof items === "function" ? (items as () => NativeItem[])() : [];
}

describe("the sidebar's control over a task", () => {
  it("is a native bar item beside Back that names what it will do, and toggles the docked column", () => {
    const render = mount("hidden");
    expect(harness.options["headerBackVisible"]).toBe(true);
    expect(leadingItems()).toEqual([
      expect.objectContaining({
        accessibilityLabel: "Show sidebar",
        icon: { name: "sidebar.left", type: "sfSymbol" },
        label: "Show sidebar",
        type: "button",
      }),
    ]);
    act(() => leadingItems()[0]!.onPress());
    expect(harness.open).toHaveBeenCalledOnce();

    render("shown");
    expect(leadingItems()).toEqual([
      expect.objectContaining({ accessibilityLabel: "Hide sidebar", label: "Hide sidebar" }),
    ]);
    expect(harness.options["headerBackVisible"]).toBe(true);
  });

  it("is absent where the window has no room to dock, leaving Back alone", () => {
    const render = mount("shown");
    render("unavailable");
    expect(leadingItems()).toEqual([]);
    expect(harness.options["headerLeft"]).toBeUndefined();
    expect(harness.options["headerBackVisible"]).toBe(true);
  });
});
