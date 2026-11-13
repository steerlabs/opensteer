// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * The Menu in a top-level screen's bar. What can go wrong:
 * - a docked sidebar offers a control that hides it, so a person can lose the
 *   one place to switch between tasks and tabs;
 * - with the sidebar a drawer, the Menu is missing, so it can be opened only
 *   by a swipe nobody knows about;
 * - a drill-in gets the Menu over its Back, so Back to the task it came from
 *   is lost;
 * - it is a drawn view rather than a native bar item, so it is not in the
 *   vertical bar, has no label for VoiceOver, and is not a keyboard target;
 * - questions waiting are not said in its name while they show on its badge.
 */

const harness = vi.hoisted(() => ({
  attention: 0,
  options: {} as Record<string, unknown>,
  open: vi.fn(),
  routeKey: "thread-a",
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  Pressable: ({
    accessibilityLabel,
    children,
    onPress,
    style,
  }: {
    accessibilityLabel?: string;
    children?: ReactNode;
    onPress?: () => void;
    style?: (state: { pressed: boolean }) => unknown;
  }) => (
    <button
      aria-label={accessibilityLabel}
      data-style={JSON.stringify(style?.({ pressed: false }))}
      onClick={onPress}
    >
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
  // A task top-level over Home, with a subagent drilled into over it.
  const state = {
    index: 2,
    routes: [
      { key: "home", name: "Home" },
      { key: "thread-a", name: "Thread" },
      { key: "subagent", name: "Subagent" },
    ],
  };
  return {
    useNavigation: () => navigation,
    useNavigationState: (select: (value: typeof state) => unknown) => select(state),
    useRoute: () => ({ key: harness.routeKey }),
  };
});
vi.mock("./ui/mobile-client-context.js", () => ({
  useHostValue: () => harness.attention,
  useSelectedHostClient: () => null,
}));
vi.mock("./ui/primitives.js", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("./ui/symbol.js", () => ({
  Symbol: ({ name, tint }: { name: string; tint: string }) => (
    <span data-symbol={name} data-tint={tint} />
  ),
}));

import { TopLevelMenu } from "./navigation-header.js";
import { SidebarControlContext, SidebarDockedContext } from "./sidebar/sidebar-context.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  harness.attention = 0;
  harness.options = {};
  harness.open.mockReset();
  harness.routeKey = "thread-a";
});

function mount(docked: boolean) {
  const root = createRoot(document.createElement("div"));
  roots.push(root);
  const render = (next: boolean) =>
    act(() =>
      root.render(
        <SidebarControlContext.Provider value={{ close: vi.fn(), open: harness.open }}>
          <SidebarDockedContext.Provider value={next}>
            <TopLevelMenu />
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

describe("the Menu in a top-level screen's bar", () => {
  it("is a native bar item that opens the drawer, and says the questions waiting", () => {
    harness.attention = 2;
    mount(false);
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
    render(false);
    expect(leadingItems().map((item) => item.label)).toEqual(["Menu"]);
  });

  it("leaves a drill-in's bar to its Back", () => {
    harness.routeKey = "subagent";
    mount(false);
    expect(harness.options).toEqual({});
  });
});
