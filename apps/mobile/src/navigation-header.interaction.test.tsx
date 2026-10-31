// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * The Menu in a sidebar destination's bar. What can go wrong:
 * - a docked sidebar offers a control that hides it, so a person can lose the
 *   one place to switch between tasks and tabs;
 * - with the sidebar a drawer, the Menu is missing, so it can be opened only
 *   by a swipe nobody knows about;
 * - it is a drawn view rather than a native bar item, so it is not in the
 *   vertical bar, has no label for VoiceOver, and is not a keyboard target;
 * - questions waiting are not said in its name while they show on its badge.
 */

const harness = vi.hoisted(() => ({
  attention: 0,
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
vi.mock("./ui/mobile-client-context.js", () => ({ useHostValue: () => harness.attention }));
vi.mock("./ui/primitives.js", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("./ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("./browser/browser-button.js", () => ({ BrowserButton: () => null }));

import { browserHeaderActions, useSidebarMenu } from "./navigation-header.js";
import { SidebarControlContext, SidebarDockedContext } from "./sidebar/sidebar-context.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  harness.attention = 0;
  harness.options = {};
  harness.open.mockReset();
});

function Destination(): ReactNode {
  useSidebarMenu(null);
  return null;
}

function mount(docked: boolean) {
  const root = createRoot(document.createElement("div"));
  roots.push(root);
  const render = (next: boolean) =>
    act(() =>
      root.render(
        <SidebarControlContext.Provider value={{ close: vi.fn(), open: harness.open }}>
          <SidebarDockedContext.Provider value={next}>
            <Destination />
          </SidebarDockedContext.Provider>
        </SidebarControlContext.Provider>,
      ),
    );
  render(docked);
  return render;
}

interface NativeItem {
  readonly accessibilityLabel: string;
  readonly badge?: { readonly value: string };
  readonly icon?: { readonly name: string; readonly type: string };
  readonly label: string;
  readonly onPress: () => void;
  readonly type: string;
}

function leadingItems(): readonly NativeItem[] {
  const items = harness.options["unstable_headerLeftItems"];
  return typeof items === "function" ? (items as () => NativeItem[])() : [];
}

describe("the Menu in a sidebar destination's bar", () => {
  it("is a native bar item that opens the drawer, and says the questions waiting", () => {
    harness.attention = 2;
    mount(false);
    expect(harness.options["headerBackVisible"]).toBe(false);
    expect(leadingItems()).toEqual([
      expect.objectContaining({
        accessibilityLabel: "Menu, 2 questions need you",
        badge: expect.objectContaining({ value: "2" }),
        icon: { name: "line.3.horizontal", type: "sfSymbol" },
        label: "Menu",
        type: "button",
      }),
    ]);
    act(() => leadingItems()[0]!.onPress());
    expect(harness.open).toHaveBeenCalledOnce();
  });

  it("is absent beside a docked sidebar, which has no control to hide it, and returns as the window narrows", () => {
    const render = mount(true);
    expect(leadingItems()).toEqual([]);
    expect((harness.options["headerLeft"] as () => ReactNode)()).toBeNull();
    expect(harness.options["headerBackVisible"]).toBe(false);
    render(false);
    expect(leadingItems().map((item) => item.label)).toEqual(["Menu"]);
  });
});

describe("the conversation bar's family and tabs", () => {
  it("keeps separate native items with accessible counts and an attention tint", () => {
    const open = vi.fn();
    const options = browserHeaderActions(false, true, vi.fn(), {
      action: {
        icon: "arrow.triangle.branch",
        label: "2 · ◷ 1",
        badge: "2 · ◷ 1",
        accessibilityLabel: "2 tasks running, Needs you, 1 automation",
        tintColor: "#amber",
        onPress: open,
      },
      content: null,
    });
    const items = options.unstable_headerRightItems?.({ tintColor: "white", canGoBack: true });
    expect(items).toEqual([
      expect.objectContaining({
        icon: { name: "arrow.triangle.branch", type: "sfSymbol" },
        accessibilityLabel: "2 tasks running, Needs you, 1 automation",
        tintColor: "#amber",
        badge: expect.objectContaining({ value: "2 · ◷ 1" }),
      }),
      expect.objectContaining({ accessibilityLabel: "Tabs" }),
    ]);
    if (items?.[0]?.type === "button") items[0].onPress();
    expect(open).toHaveBeenCalledOnce();
  });
});
