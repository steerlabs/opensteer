// @vitest-environment happy-dom

import { act, useEffect, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReservedRegion } from "react-native-reserved-regions";

/*
 * The shell around the one native stack, as the window changes shape. What
 * can go wrong:
 * - unfolding or folding the sidebar remounts the stack, so a draft,
 *   a scroll position, a composition in progress or a stream is lost;
 * - a geometry change navigates, so the reader is moved without asking;
 * - a sidebar docked beside the conversation counts as covering it, so read
 *   markers stop and alerts about what is on screen interrupt;
 * - an unmeasured fold is straddled because the column showed before the
 *   regions arrived;
 * - choosing a task or a tab from the docked sidebar piles screens up behind
 *   Back, or rebuilds Chat instead of returning to the mounted one;
 * - a page in front keeps the docked sidebar, so the page and its agent's
 *   Thread make three panes;
 * - a page is handed different folds depending on how it was reached, so one
 *   from Tabs cannot use tabletop that the same page from its Thread can;
 * - a tab chosen from the sidebar, or Tabs opened over a task, carries the
 *   conversation that happened to be in front, so the page is shown under it;
 * - docking dismisses the keyboard or moves focus;
 * - the docked sidebar steals screen-reader focus on every fold.
 */

const harness = vi.hoisted(() => ({
  bounds: { height: 844, width: 390 },
  ready: true,
  regions: [] as ReservedRegion[],
  fontScale: 1,
  dismiss: vi.fn(),
  sendAccessibilityEvent: vi.fn(),
  dispatch: vi.fn(),
  panels: [] as {
    docked: boolean;
    selectedThreadId: string | null;
    openThreadId: string | null;
    visible: boolean;
    actions: {
      onOpenPlace: (destination: object) => void;
      onOpenTask: (deploymentId: string, threadId: string) => void;
      onTabs: () => void;
      onSchedules: () => void;
      onChat: () => void;
    };
    scroll: { offset: number };
    shelves: { list: unknown };
  }[],
  drawer: { lock: "", panel: null as ReactNode },
  openDrawer: vi.fn(),
  closeDrawer: vi.fn(),
}));

vi.mock("react-native", () => ({
  AccessibilityInfo: { sendAccessibilityEvent: harness.sendAccessibilityEvent },
  BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
  I18nManager: { isRTL: false },
  Keyboard: { dismiss: harness.dismiss },
  Platform: { OS: "ios" },
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  useWindowDimensions: () => ({
    fontScale: harness.fontScale,
    height: harness.bounds.height,
    width: harness.bounds.width,
  }),
}));
vi.mock("@react-navigation/native", () => ({
  CommonActions: {
    reset: (payload: object) => ({ payload, type: "RESET" }),
  },
  StackActions: {
    popToTop: () => ({ type: "POP_TO_TOP" }),
    push: (name: string, params?: object) => ({ payload: { name, params }, type: "PUSH" }),
    replace: (name: string, params?: object) => ({ payload: { name, params }, type: "REPLACE" }),
  },
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: ({ children }: { children?: ReactNode }) => <div>{children}</div> },
}));
vi.mock("../ui/motion.js", () => ({ appear: {}, exit: {}, move: undefined }));
vi.mock("react-native-reserved-regions", () => ({
  ReservedRegionsProvider: (props: {
    children?: ReactNode;
    onLayout?: (event: { nativeEvent: { layout: typeof harness.bounds } }) => void;
  }) => {
    const { height, width } = harness.bounds;
    const { onLayout } = props;
    useEffect(() => {
      onLayout?.({ nativeEvent: { layout: { height, width } } });
    }, [height, onLayout, width]);
    return <div data-surface="shell">{props.children}</div>;
  },
  useReservedRegions: () => harness.regions,
  useReservedRegionsReady: () => harness.ready,
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaProvider: ({
    children,
    style,
    testID,
  }: {
    children?: ReactNode;
    style?: unknown;
    testID?: string;
  }) => (
    <div data-pane data-style={JSON.stringify(flatten(style))} data-testid={testID}>
      {children}
    </div>
  ),
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));

/** Style arrays as React Native merges them, so a test can read the result. */
function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  return typeof style === "object" && style !== null ? (style as Record<string, unknown>) : {};
}
vi.mock("react-native-gesture-handler/ReanimatedDrawerLayout", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    default: React.forwardRef(function Drawer(
      props: {
        children?: ReactNode;
        drawerLockMode: string;
        renderNavigationView: () => ReactNode;
      },
      ref,
    ) {
      React.useImperativeHandle(ref, () => ({
        closeDrawer: harness.closeDrawer,
        openDrawer: harness.openDrawer,
      }));
      harness.drawer.lock = props.drawerLockMode;
      return (
        <div>
          <aside>{props.renderNavigationView()}</aside>
          {props.children}
        </div>
      );
    }),
    DrawerKeyboardDismissMode: { ON_DRAG: "on-drag" },
    DrawerLockMode: { LOCKED_CLOSED: "locked-closed", UNLOCKED: "unlocked" },
    DrawerPosition: { LEFT: "left" },
    DrawerState: { IDLE: "idle" },
    DrawerType: { FRONT: "front", SLIDE: "slide" },
  };
});
vi.mock("../ui/mobile-client-context.js", () => ({
  useHostUserId: () => "user-a",
  useMobileClient: () => ({}),
  useSelectedHostClient: () => null,
}));
vi.mock("./sidebar-panel.js", () => ({
  SidebarPanel: (props: (typeof harness.panels)[number]) => {
    harness.panels.push(props);
    return (
      <nav data-docked={props.docked} data-visible={props.visible}>
        <button onClick={() => props.actions.onOpenTask("deployment-a", "thread-b")}>Task B</button>
        <button onClick={() => props.actions.onOpenPlace(tabB)}>Tab B</button>
        <button onClick={props.actions.onTabs}>Tabs</button>
        <button onClick={props.actions.onSchedules}>Schedules</button>
        <button onClick={props.actions.onChat}>Chat</button>
      </nav>
    );
  },
}));

import { SidebarShell } from "./sidebar-shell.js";
import { useSidebarControl, useSidebarDocked, useSidebarVisible } from "./sidebar-context.js";

const tabB = { kind: "browser", sessionId: "session-b", tabId: "tab-b" } as const;
/** Tab B as a route names it. */
const tabBRoute = {
  deploymentId: "deployment-a",
  scope: "workspace",
  sessionId: tabB.sessionId,
  tabId: tabB.tabId,
};

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  harness.bounds = { height: 844, width: 390 };
  harness.ready = true;
  harness.regions = [];
  harness.fontScale = 1;
  harness.panels = [];
  harness.dismiss.mockReset();
  harness.sendAccessibilityEvent.mockReset();
  harness.dispatch.mockReset();
  harness.openDrawer.mockReset();
  harness.closeDrawer.mockReset();
});

const mounts = { count: 0, unmounts: 0 };

/** Stands in for the navigator: it counts its own lifetime and holds local state. */
function Stack(): ReactNode {
  const [draft, setDraft] = useState("");
  const covered = useSidebarVisible();
  const control = useSidebarControl();
  const docked = useSidebarDocked();
  useEffect(() => {
    mounts.count += 1;
    return () => {
      mounts.unmounts += 1;
    };
  }, []);
  return (
    <main data-covered={covered} data-docked={docked}>
      <input aria-label="Draft" onChange={(event) => setDraft(event.target.value)} value={draft} />
      <button onClick={() => control?.open()}>Menu</button>
    </main>
  );
}

const home = { key: "home-key", name: "Home", params: { deploymentId: "deployment-a" } };
const threadA = {
  key: "thread-a-key",
  name: "Thread",
  params: { deploymentId: "deployment-a", threadId: "thread-a" },
};

type Route = { readonly key: string; readonly name: string; readonly params?: object };

async function mount(routes: readonly Route[] = [home]) {
  mounts.count = 0;
  mounts.unmounts = 0;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  let state = { index: routes.length - 1, routes };
  /** Draws the shell again, over a different stack when one is given. */
  const render = async (next: readonly Route[] = state.routes) => {
    state = { index: next.length - 1, routes: next };
    await act(async () =>
      root.render(
        <SidebarShell navigation={{ dispatch: harness.dispatch }} state={state}>
          <Stack />
        </SidebarShell>,
      ),
    );
    await act(async () => undefined);
  };
  await render();
  return { container, render };
}

function main(container: HTMLElement): HTMLElement {
  const found = container.querySelector("main");
  if (found === null) throw new Error("The stack is not mounted.");
  return found;
}

function press(container: HTMLElement, label: string) {
  const target = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (!target) throw new Error(`No control named ${label}`);
  act(() => target.click());
}

function typeDraft(container: HTMLElement, words: string) {
  const field = container.querySelector<HTMLInputElement>('input[aria-label="Draft"]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, words);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const lastPanel = () => harness.panels.at(-1)!;

function stackStyle(container: HTMLElement): Record<string, unknown> {
  const column = container.querySelector<HTMLElement>('[data-testid="stack-column"]');
  if (column === null) throw new Error("No stack column.");
  return JSON.parse(column.dataset["style"] ?? "{}") as Record<string, unknown>;
}

describe("the sidebar as the window changes shape", () => {
  it("allows drawer drag on Schedules and replaces sidebar destinations without growing the stack", async () => {
    const schedules = {
      key: "schedules",
      name: "Schedules",
      params: { deploymentId: "deployment-a" },
    };
    const { container } = await mount([home, schedules]);
    expect(harness.drawer.lock).toBe("unlocked");
    press(container, "Schedules");
    expect(harness.dispatch).not.toHaveBeenCalled();
    press(container, "Tabs");
    expect(harness.dispatch).toHaveBeenLastCalledWith({
      type: "REPLACE",
      payload: { name: "Tabs", params: { deploymentId: "deployment-a" } },
    });
    press(container, "Chat");
    expect(harness.dispatch).toHaveBeenLastCalledWith({ type: "POP_TO_TOP" });
  });

  it("replaces Tabs with Schedules and resets deep screens to Chat plus Schedules", async () => {
    const { container } = await mount([
      home,
      { key: "tabs", name: "Tabs", params: { deploymentId: "deployment-a" } },
    ]);
    press(container, "Schedules");
    expect(harness.dispatch).toHaveBeenLastCalledWith({
      type: "REPLACE",
      payload: { name: "Schedules", params: { deploymentId: "deployment-a" } },
    });
    const deep = await mount([home, threadA, { key: "detail", name: "Schedule" }]);
    press(deep.container, "Schedules");
    expect(harness.dispatch).toHaveBeenLastCalledWith({
      type: "RESET",
      payload: {
        index: 1,
        routes: [home, { name: "Schedules", params: { deploymentId: "deployment-a" } }],
      },
    });
  });

  it("keeps the stack mounted with its draft, and navigates nowhere, through unfold and fold", async () => {
    const { container, render } = await mount([home, threadA]);
    typeDraft(container, "half a thought");
    expect(main(container).dataset["docked"]).toBe("false");
    expect(lastPanel().docked).toBe(false);

    harness.bounds = { height: 1133, width: 744 };
    await render();
    expect(lastPanel().docked).toBe(true);
    expect(main(container).dataset["docked"]).toBe("true");

    harness.bounds = { height: 844, width: 390 };
    await render();
    expect(lastPanel().docked).toBe(false);

    harness.bounds = { height: 1000, width: 980 };
    harness.regions = [
      {
        frame: { height: 1000, width: 24, x: 470, y: 0 },
        kind: "division",
        occludesContent: false,
      },
    ];
    await render();
    expect(lastPanel().docked).toBe(true);

    expect(mounts).toEqual({ count: 1, unmounts: 0 });
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Draft"]')?.value).toBe(
      "half a thought",
    );
    expect(harness.dispatch).not.toHaveBeenCalled();
  });

  it("does not dock before the surface is measured, then docks without remounting", async () => {
    harness.bounds = { height: 1133, width: 744 };
    harness.ready = false;
    const { render } = await mount();
    expect(lastPanel().docked).toBe(false);
    harness.ready = true;
    await render();
    expect(lastPanel().docked).toBe(true);
    expect(mounts).toEqual({ count: 1, unmounts: 0 });
  });

  it("does not count a docked sidebar as covering the conversation, and reads tasks while it shows", async () => {
    harness.bounds = { height: 1133, width: 744 };
    const { container } = await mount([home, threadA]);
    expect(main(container).dataset["covered"]).toBe("false");
    expect(lastPanel()).toMatchObject({
      docked: true,
      selectedThreadId: "thread-a",
      visible: true,
    });
    // Docking is not opening: nothing takes screen-reader focus as it appears.
    expect(harness.sendAccessibilityEvent).not.toHaveBeenCalled();
    expect(harness.drawer.lock).toBe("locked-closed");
  });

  it("puts a task chosen from the docked sidebar over the same mounted Chat, never behind another task", async () => {
    harness.bounds = { height: 1133, width: 744 };
    const { container } = await mount([home, threadA]);
    press(container, "Task B");
    expect(harness.dispatch).toHaveBeenCalledTimes(1);
    const action = harness.dispatch.mock.calls[0]![0] as {
      payload: { index: number; routes: { key?: string; name: string; params?: object }[] };
      type: string;
    };
    expect(action.type).toBe("RESET");
    expect(action.payload.index).toBe(1);
    expect(action.payload.routes[0]).toBe(home);
    expect(action.payload.routes[1]).toMatchObject({
      name: "Thread",
      params: { deploymentId: "deployment-a", threadId: "thread-b" },
    });
  });

  it("does nothing when the task chosen is the one already open", async () => {
    harness.bounds = { height: 1133, width: 744 };
    const { container } = await mount([
      home,
      { ...threadA, params: { deploymentId: "deployment-a", threadId: "thread-b" } },
    ]);
    press(container, "Task B");
    expect(harness.dispatch).not.toHaveBeenCalled();
  });

  it("leaves the docked sidebar where it is when the Menu is pressed, touching neither the keyboard nor the drawer", async () => {
    harness.bounds = { height: 1133, width: 744 };
    const { container, render } = await mount();
    press(container, "Menu");
    await render();
    expect(lastPanel().docked).toBe(true);
    expect(harness.dismiss).not.toHaveBeenCalled();
    expect(harness.openDrawer).not.toHaveBeenCalled();
  });

  it("opens the drawer from the Menu where there is no room to dock", async () => {
    const { container } = await mount();
    press(container, "Menu");
    expect(harness.openDrawer).toHaveBeenCalledTimes(1);
    expect(harness.dismiss).toHaveBeenCalledTimes(1);
  });

  it("gives a page in front the sidebar's room however it was reached, and docks it again behind", async () => {
    harness.bounds = { height: 900, width: 1200 };
    const { container, render } = await mount([home, threadA]);
    expect(lastPanel().docked).toBe(true);
    const sidebarColumn = () => container.querySelector('[data-testid="sidebar-column"]');
    const whole = { marginBottom: 0, marginStart: 0, marginTop: 0, width: 1200 };
    // Room for the sidebar beside a page and its agent's Thread, but that is three panes.
    const fromThread = {
      key: "owned-key",
      name: "WorkspaceBrowser",
      params: { deploymentId: "deployment-a", sessionId: "s", tabId: "t", threadId: "thread-a" },
    };
    await render([home, threadA, fromThread]);
    expect(lastPanel().docked).toBe(false);
    expect(sidebarColumn()).toBeNull();
    expect(main(container).dataset["docked"]).toBe("false");
    expect(stackStyle(container)).toMatchObject(whole);
    await render([home, { key: "tab-key", name: "WorkspaceBrowser", params: tabBRoute }]);
    expect(lastPanel().docked).toBe(false);
    expect(stackStyle(container)).toMatchObject(whole);

    // Back from the page, the sidebar is where room left it: a width inside the
    // threshold's margin keeps it docked, as it would have without the page.
    await render([home, threadA]);
    expect(lastPanel().docked).toBe(true);
    harness.bounds = { height: 900, width: 700 };
    await render();
    expect(lastPanel().docked).toBe(true);
    await render([home, threadA, fromThread]);
    expect(lastPanel().docked).toBe(false);
    await render([home, threadA]);
    expect(lastPanel().docked).toBe(true);

    expect(mounts).toEqual({ count: 1, unmounts: 0 });
    expect(harness.dispatch).not.toHaveBeenCalled();
  });

  it("puts a tab chosen from the docked sidebar over the mounted Chat in place of a task, naming no conversation", async () => {
    harness.bounds = { height: 1133, width: 744 };
    const { container } = await mount([home, threadA]);
    press(container, "Tab B");
    expect(harness.dispatch).toHaveBeenCalledTimes(1);
    const action = harness.dispatch.mock.calls[0]![0] as {
      payload: { index: number; routes: { name: string; params?: object }[] };
      type: string;
    };
    expect(action.type).toBe("RESET");
    expect(action.payload.index).toBe(1);
    expect(action.payload.routes[0]).toBe(home);
    expect(action.payload.routes[1]).toEqual({
      name: "WorkspaceBrowser",
      params: tabBRoute,
    });
  });

  it("pushes a tab chosen over Tabs, so Back returns to Tabs", async () => {
    const tabs = { key: "tabs-key", name: "Tabs", params: { deploymentId: "deployment-a" } };
    const { container } = await mount([home, tabs]);
    press(container, "Tab B");
    expect(harness.dispatch).toHaveBeenCalledExactlyOnceWith({
      payload: {
        name: "WorkspaceBrowser",
        params: tabBRoute,
      },
      type: "PUSH",
    });
  });

  it("opens Tabs over a task as the Deployment's tabs, carrying no conversation", async () => {
    harness.bounds = { height: 1133, width: 744 };
    const { container } = await mount([home, threadA]);
    press(container, "Tabs");
    const action = harness.dispatch.mock.calls[0]![0] as {
      payload: { routes: { name: string; params?: object }[] };
    };
    expect(action.payload.routes[1]).toEqual({
      name: "Tabs",
      params: { deploymentId: "deployment-a" },
    });
  });
});

describe("the shell around what the system reserves", () => {
  it("keeps the stack to one side of a fold the sidebar is not docked at, without remounting it", async () => {
    harness.bounds = { height: 900, width: 720 };
    harness.regions = [
      { frame: { height: 900, width: 20, x: 350, y: 0 }, kind: "division", occludesContent: true },
    ];
    const { container, render } = await mount([home, threadA]);
    expect(lastPanel().docked).toBe(false);
    expect(stackStyle(container)).toMatchObject({ marginStart: 0, marginTop: 0, width: 350 });

    // Unfolded: the sidebar docks on the leading side of the fold, the stack on the other.
    harness.bounds = { height: 1000, width: 1000 };
    harness.regions = [
      {
        frame: { height: 1000, width: 24, x: 470, y: 0 },
        kind: "division",
        occludesContent: false,
      },
    ];
    await render();
    expect(lastPanel().docked).toBe(true);
    expect(stackStyle(container)).toMatchObject({ marginStart: 24, width: 506 });
    expect(mounts).toEqual({ count: 1, unmounts: 0 });
    expect(harness.dispatch).not.toHaveBeenCalled();
  });

  it("hands a page every fold, the same whether it was reached from its Thread or from Tabs", async () => {
    harness.bounds = { height: 900, width: 900 };
    harness.regions = [
      { frame: { height: 20, width: 900, x: 0, y: 420 }, kind: "division", occludesContent: false },
    ];
    // A task keeps off the fold, on its larger side.
    const task = await mount([home, threadA]);
    expect(stackStyle(task.container)).toMatchObject({ marginBottom: 0, marginTop: 440 });
    // A page measures the fold itself, to arrange tabletop around it.
    const whole = { marginBottom: 0, marginStart: 0, marginTop: 0, width: 900 };
    const fromThread = await mount([
      home,
      threadA,
      {
        key: "page-key",
        name: "WorkspaceBrowser",
        params: { deploymentId: "deployment-a", sessionId: "s", tabId: "t", threadId: "thread-a" },
      },
    ]);
    expect(stackStyle(fromThread.container)).toMatchObject(whole);
    const tabs = { key: "tabs-key", name: "Tabs", params: { deploymentId: "deployment-a" } };
    const fromTabs = await mount([
      home,
      tabs,
      { key: "tab-key", name: "WorkspaceBrowser", params: tabBRoute },
    ]);
    expect(stackStyle(fromTabs.container)).toMatchObject(whole);
  });

  it("gives the drawer and the docked column one scroll position and one set of shelves, kept by the shell", async () => {
    const { render } = await mount();
    const drawerScroll = lastPanel().scroll;
    drawerScroll.offset = 480;
    // An unread Done task opened from Ready keeps its place through a fold.
    const shelves = lastPanel().shelves;
    const drawn = { ready: [{ threadId: "thread-a", done: true }] };
    shelves.list = drawn;
    harness.bounds = { height: 1133, width: 744 };
    await render();
    expect(lastPanel().docked).toBe(true);
    expect(lastPanel().scroll).toBe(drawerScroll);
    expect(lastPanel().shelves.list).toBe(drawn);
    harness.bounds = { height: 844, width: 390 };
    await render();
    expect(lastPanel().scroll).toBe(drawerScroll);
    expect(lastPanel().scroll.offset).toBe(480);
    expect(lastPanel().shelves.list).toBe(drawn);
  });
});
