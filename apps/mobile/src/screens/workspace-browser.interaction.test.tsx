// @vitest-environment happy-dom

import { act, StrictMode, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  conversationSurfaces,
  placeList,
  type BrowserSessionSummary,
  type HostSnapshot,
  type WorkspaceSummary,
} from "@opensteer/client/host";
import type { MachineSummary } from "@opensteer/protocol";
import type { SurfacesRoute } from "../browser/surface-route.js";
import { WorkspaceBrowserScreen } from "./workspace-browser.js";

/*
 * A conversation's tabs, by route: the grid, or exactly one tab. What can go
 * wrong: the grid shows a browser the conversation never used, or picks one
 * by recency; opening a tile replaces the grid instead of going over it; a
 * link's tab is swapped for whatever tab is active; an ended browser is
 * replaced by another; Chrome sign-in is lost; another person's or
 * deployment's tabs are shown; a saved tab's lineage moving to a new session
 * remounts the conversation or leaves the page on the old session; a lineage
 * the bounded catalog leaves out is read more than once or replaced by a
 * sibling; a task's grid opens another task's session of the same app; a page
 * opened from Tabs before Chat exists draws a conversation.
 */

const state = vi.hoisted(() => ({
  snapshot: null as HostSnapshot | null,
  deploymentId: "deployment-a",
  focused: true,
  /** Whether this page is still the screen in front, as the stack says when an answer arrives. */
  navigationFocused: true,
  refresh: vi.fn(async () => {}),
  hostClient: {} as Record<string, unknown>,
  dispatch: vi.fn(),
  goBack: vi.fn(),
  setOptions: vi.fn(),
  setParams: vi.fn(),
  routes: [] as { name: string; params?: object }[],
  /** The pair's own measured surface, as its reserved-regions provider reports it. */
  pair: { height: 760, width: 390 },
  /** What every laid-out view measures, once a test lays the screen out. */
  layout: null as { height: number; width: number } | null,
  regions: [] as import("react-native-reserved-regions").ReservedRegion[],
  regionsReady: true,
  keyboard: false,
  conversationMounts: 0,
  pageMounts: 0,
}));

vi.mock("@react-navigation/native", () => ({
  StackActions: {
    pop: (count: number) => ({ type: "POP", count }),
    push: (name: string, params: object) => ({ name, params, type: "PUSH" }),
    replace: (name: string, params: object) => ({ name, params, type: "REPLACE" }),
  },
  useIsFocused: () => state.focused,
  useNavigation: () => ({
    dispatch: state.dispatch,
    getState: () => ({ index: state.routes.length - 1, routes: state.routes }),
    goBack: state.goBack,
    isFocused: () => state.navigationFocused,
    setOptions: state.setOptions,
    setParams: state.setParams,
  }),
}));
vi.mock("@react-navigation/elements", () => ({ useHeaderHeight: () => 88 }));
vi.mock("expo-haptics", () => ({
  NotificationFeedbackType: { Success: "success", Warning: "warning" },
  notificationAsync: vi.fn(async () => undefined),
}));
vi.mock("../client/mobile-client.js", () => ({
  operationDetail: (_error: unknown, fallback: string) => fallback,
}));
vi.mock("@opensteer/client/react", async () => ({
  useActionReview: (
    await vi.importActual<typeof import("@opensteer/client/react")>("@opensteer/client/react")
  ).useActionReview,
  useHostSelector: (_client: unknown, selector: (snapshot: HostSnapshot) => unknown) =>
    selector(state.snapshot!),
  useHostSnapshot: () => ({ snapshot: state.snapshot, loadError: null, reload: state.refresh }),
  useConversationSurfaces: (_client: unknown, threadId: string) => {
    if (state.snapshot === null) throw new Error("Missing snapshot fixture");
    return conversationSurfaces(state.snapshot, threadId);
  },
  usePlaceList: () => {
    if (state.snapshot === null) throw new Error("Missing snapshot fixture");
    return placeList(state.snapshot);
  },
}));
vi.mock("../ui/mobile-client-context.js", () => ({
  useMobileState: () => ({
    selection: { deploymentId: state.deploymentId, hostClient: state.hostClient },
  }),
}));
vi.mock("react-native", () => ({
  PixelRatio: { get: () => 3 },
  AccessibilityInfo: { announceForAccessibility: vi.fn(async () => undefined) },
  ActivityIndicator: () => null,
  Alert: { alert: vi.fn() },
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => {} }) },
  I18nManager: { isRTL: false },
  KeyboardAvoidingView: ({
    children,
    enabled,
    style,
    testID,
  }: {
    children?: ReactNode;
    enabled?: boolean;
    style?: unknown;
    testID?: string;
  }) => (
    <div
      data-avoids={enabled !== false}
      data-style={JSON.stringify(flatten(style))}
      data-testid={testID}
    >
      {children}
    </div>
  ),
  PanResponder: { create: () => ({ panHandlers: {} }) },
  Platform: { OS: "ios" },
  Pressable: ({
    accessibilityLabel,
    accessibilityState,
    children,
    disabled,
    onPress,
  }: {
    accessibilityLabel?: string;
    accessibilityState?: { selected?: boolean };
    children?: ReactNode | ((state: { pressed: boolean }) => ReactNode);
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button
      aria-label={accessibilityLabel}
      aria-pressed={accessibilityState?.selected}
      disabled={disabled}
      onClick={onPress}
    >
      {typeof children === "function" ? children({ pressed: false }) : children}
    </button>
  ),
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  FlatList: ({
    data,
    renderItem,
    keyExtractor,
    ListEmptyComponent,
    ListHeaderComponent,
  }: {
    data: { key: string }[];
    renderItem: (item: { item: { key: string }; index: number }) => ReactNode;
    keyExtractor: (item: { key: string }) => string;
    ListEmptyComponent?: ReactNode;
    ListHeaderComponent?: ReactNode;
  }) => (
    <div>
      {ListHeaderComponent}
      {data.length
        ? data.map((item, index) => (
            <div key={keyExtractor(item)}>{renderItem({ item, index })}</div>
          ))
        : ListEmptyComponent}
    </div>
  ),
  TextInput: ({
    accessibilityLabel,
    value,
    onChangeText,
    onSubmitEditing,
  }: {
    accessibilityLabel?: string;
    value?: string;
    onChangeText?: (text: string) => void;
    onSubmitEditing?: () => void;
  }) => (
    <input
      aria-label={accessibilityLabel}
      value={value}
      onChange={(event) => onChangeText?.(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onSubmitEditing?.();
      }}
    />
  ),
  StyleSheet: { create: (styles: object) => styles, flatten, hairlineWidth: 1 },
  useWindowDimensions: () => ({ fontScale: 1, height: 844, width: 390 }),
  View: ({
    children,
    accessibilityLabel,
    onLayout,
    style,
    testID,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
    onLayout?: (event: { nativeEvent: { layout: { height: number; width: number } } }) => void;
    style?: unknown;
    testID?: string;
  }) => (
    <div
      ref={(node) => {
        if (node && onLayout && state.layout) onLayout({ nativeEvent: { layout: state.layout } });
      }}
      aria-label={accessibilityLabel}
      data-style={JSON.stringify(flatten(style))}
      data-testid={testID}
    >
      {children}
    </div>
  ),
}));
vi.mock("react-native-reserved-regions", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    ReservedRegionsProvider: (props: {
      children?: ReactNode;
      onLayout?: (event: { nativeEvent: { layout: { height: number; width: number } } }) => void;
      style?: unknown;
      testID?: string;
    }) => {
      const { height, width } = state.pair;
      const { onLayout } = props;
      React.useEffect(() => {
        onLayout?.({ nativeEvent: { layout: { height, width } } });
      }, [height, onLayout, width]);
      return (
        <div data-style={JSON.stringify(flatten(props.style))} data-testid={props.testID}>
          {props.children}
        </div>
      );
    },
    useReservedRegions: () => state.regions,
    useReservedRegionsReady: () => state.regionsReady,
  };
});
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaProvider: ({ children, style }: { children?: ReactNode; style?: unknown }) => (
    <div data-pane-style={JSON.stringify(flatten(style))}>{children}</div>
  ),
  useSafeAreaFrame: () => ({ height: 844, width: 390, x: 0, y: 0 }),
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));
vi.mock("../ui/keyboard.js", () => ({ useKeyboardVisible: () => state.keyboard }));
vi.mock("../ui/sheet.js", () => ({
  Sheet: ({ children }: { children?: ReactNode }) => <section>{children}</section>,
}));
vi.mock("../ui/primitives.js", () => ({
  AppText: ({
    children,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
  }) => <span aria-label={accessibilityLabel}>{children}</span>,
  Notice: ({
    title,
    detail,
    action,
  }: {
    title: string;
    detail?: string;
    action?: { label: string; onPress: () => void };
  }) => (
    <div>
      <span>{title}</span>
      <span>{detail}</span>
      {action ? <button onClick={action.onPress}>{action.label}</button> : null}
    </div>
  ),
  SecondaryButton: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));
vi.mock("../ui/screen.js", () => ({
  Screen: ({ children }: { children?: ReactNode }) => <main>{children}</main>,
}));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("../thread/composer-menu.js", () => ({
  NativeMenu: (props: {
    readonly options: readonly {
      readonly disabled?: boolean;
      readonly selected?: boolean;
      readonly id: string;
      readonly label: string;
      readonly onPress: () => void;
    }[];
  }) => (
    <div aria-label="More">
      {props.options.map((option) => (
        <button
          aria-pressed={option.selected}
          disabled={option.disabled}
          key={option.id}
          onClick={option.onPress}
        >
          {option.label}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("../computers/phone-display-native.js", () => ({ nativePictureView: () => null }));
vi.mock("../browser/browser-stream.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../browser/browser-stream.js")>()),
  BrowserStream: ({
    session,
    active,
    onTap,
    tabId,
  }: {
    session: BrowserSessionSummary;
    active: boolean;
    onTap?: () => void;
    tabId: string;
  }) => (
    <PageProbe>
      <div data-active={active} data-expected-surface={tabId ?? "current"}>
        Viewing {session.id}
        {/* Stands in for a tap the page took. */}
        <button onClick={onTap}>Tap the page</button>
      </div>
    </PageProbe>
  ),
}));
vi.mock("../computers/mac-app-view.js", () => ({
  MacAppPreview: () => null,
  MacAppView: () => <div>Mac app</div>,
}));
vi.mock("../thread/thread-pane.js", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  const { useContentInsets } =
    await vi.importActual<typeof import("../ui/pane.js")>("../ui/pane.js");
  return {
    ThreadPane: (props: { withPage?: { kind: string; onShowConversation?: () => void } }) => {
      const insets = useContentInsets();
      React.useEffect(() => {
        state.conversationMounts += 1;
      }, []);
      return (
        <section data-insets={JSON.stringify(insets)}>
          {props.withPage?.kind === "beside" ? "Conversation beside" : "Conversation docked"}
          <button onClick={() => props.withPage?.onShowConversation?.()}>
            Open the conversation
          </button>
        </section>
      );
    },
  };
});

function PageProbe(props: { children?: ReactNode }): ReactNode {
  useEffect(() => {
    state.pageMounts += 1;
  }, []);
  return <>{props.children}</>;
}

/** Style arrays as React Native merges them, so a test can read the result. */
function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  return typeof style === "object" && style !== null ? (style as Record<string, unknown>) : {};
}

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  state.snapshot = null;
  state.deploymentId = "deployment-a";
  state.focused = true;
  state.navigationFocused = true;
  state.refresh.mockClear();
  state.hostClient = {};
  state.dispatch.mockReset();
  state.goBack.mockReset();
  state.setOptions.mockReset();
  state.setParams.mockReset();
  state.routes = [];
  state.pair = { height: 760, width: 390 };
  state.layout = null;
  state.regions = [];
  state.regionsReady = true;
  state.keyboard = false;
  state.conversationMounts = 0;
  state.pageMounts = 0;
});

const source = { id: "workspace-parent", name: "Parent" } as WorkspaceSummary;
const child = { id: "workspace-child", name: "Research" } as WorkspaceSummary;
const unrelated = { id: "workspace-unrelated", name: "Unrelated" } as WorkspaceSummary;

function session(
  id: string,
  workspaceId: string,
  state: BrowserSessionSummary["state"] = "ready",
): BrowserSessionSummary {
  return {
    access: "full-control",
    attachedRunIds: [],
    uses:
      workspaceId === unrelated.id
        ? []
        : [
            {
              threadId: "thread-parent",
              runId: "run-parent",
              firstUsedAt: "2026-10-13T00:00:00.000Z",
              lastUsedAt: "2026-10-13T00:00:00.000Z",
            },
          ],
    dialog: null,
    error: null,
    id,
    origin: "agent",
    placement: { kind: "runner", runnerId: "runner-a" },
    profileId: null,
    runtimeId: "runtime-a",
    state,
    tabs: [
      { active: true, id: "page-1", title: "Page", url: "https://example.com" },
    ] as BrowserSessionSummary["tabs"],
    viewerError: null,
    viewerState: "synchronized",
    workspaceId,
  };
}

function snapshot(sessions: BrowserSessionSummary[]): HostSnapshot {
  return {
    assignments: {},
    browserPlacements: [],
    browserProfiles: [],
    activeTasks: [],
    browserSessions: sessions,
    connection: "connected",
    deploymentShape: {},
    homeThreadId: null,
    machines: [],
    network: "online",
    session: "authenticated",
    tasks: null,
    threads: [],
    user: { id: "user-a" },
    workspaces: [source, child, unrelated],
    workspaceTasks: {},
  } as unknown as HostSnapshot;
}

const liveFeed = { status: "live", error: null, frame: null } as const;
function setup(
  params: Partial<SurfacesRoute> = {},
  options: { strict?: boolean; snapshot?: HostSnapshot } = {},
) {
  state.hostClient.prepareBrowserProfile ??= vi.fn();
  state.hostClient.browserViewerState = () => liveFeed;
  state.hostClient.browserFrames = { subscribe: () => () => undefined };
  state.snapshot = options.snapshot ?? snapshot([]);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const route = {
    key: "browser",
    name: "WorkspaceBrowser" as const,
    params: {
      deploymentId: "deployment-a",
      threadId: "thread-parent",
      ...(params.sessionId ? { tabId: "page-1" } : {}),
      ...params,
    } as SurfacesRoute,
  };
  const render = () =>
    act(() =>
      root.render(
        options.strict ? (
          <StrictMode>
            <WorkspaceBrowserScreen route={route} />
          </StrictMode>
        ) : (
          <WorkspaceBrowserScreen route={route} />
        ),
      ),
    );
  render();
  return { container, render, route };
}

/** The bar's ⋯ menu as the page last set it. */
function menu(): HTMLElement {
  const options = state.setOptions.mock.calls
    .map(([value]) => value as { headerRight?: () => ReactNode })
    .findLast((value) => typeof value.headerRight === "function");
  if (!options?.headerRight) throw new Error("The page set no menu.");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const draw = options.headerRight;
  act(() => root.render(<>{draw()}</>));
  return container;
}

function mailSession(id: string): BrowserSessionSummary {
  return {
    ...session(id, child.id),
    tabs: [
      {
        active: true,
        id: "srf_00000000-0000-4000-8000-000000000001",
        title: "Mail",
        url: "https://mail.example.com/inbox",
      },
    ] as BrowserSessionSummary["tabs"],
  };
}

async function pressAsync(container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent?.includes(label) || item.getAttribute("aria-label") === label,
  );
  if (!button) throw new Error(`Missing ${label}`);
  await act(async () => button.click());
  for (let index = 0; index < 4; index += 1) await act(async () => undefined);
}

function press(container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent?.includes(label) || item.getAttribute("aria-label") === label,
  );
  if (!button) throw new Error(`Missing ${label}`);
  act(() => button.click());
}

describe("mobile conversation pages", () => {
  it("waits for the first bootstrap before saying a conversation has no pages", () => {
    const { container, render } = setup();
    state.snapshot = { ...snapshot([]), deploymentShape: null };
    render();
    expect(container.textContent).toContain("Finding tabs…");
    expect(container.textContent).not.toContain("No tabs yet");
    state.snapshot = snapshot([]);
    render();
    expect(container.textContent).toContain("No tabs yet");
  });

  it("keeps the conversation's browsers when its run history cannot be read", () => {
    const { container, render } = setup();
    state.snapshot = {
      ...snapshot([session("known-one", child.id), session("known-two", child.id)]),
      browserUsage: { "thread-parent": { loading: false, error: "History service unavailable." } },
    };
    render();
    expect(container.textContent).toContain("Viewing known-one");
    expect(container.textContent).toContain("Viewing known-two");
    expect(container.textContent).not.toContain("History service unavailable.");
  });

  it("shows only the conversation's own browsers and opens a tile over the grid, never by recency", () => {
    const { container, render } = setup();
    const foreign = { ...session("foreign", source.id), uses: [] };
    state.snapshot = snapshot([foreign, session("delegate", child.id), session("home", source.id)]);
    render();
    expect(container.textContent).toContain("Viewing delegate");
    expect(container.textContent).toContain("Viewing home");
    expect(container.textContent).not.toContain("Viewing foreign");
    expect(container.textContent).not.toContain("This conversation");
    expect(container.textContent).not.toContain("All browsers");
    // Nothing is chosen until the reader chooses.
    expect(state.dispatch).not.toHaveBeenCalled();
    press(container, "Viewing delegate");
    // A tile names the exact page.
    expect(state.dispatch).toHaveBeenCalledExactlyOnceWith({
      name: "WorkspaceBrowser",
      params: {
        deploymentId: "deployment-a",
        sessionId: "delegate",
        threadId: "thread-parent",
        tabId: "page-1",
      },
      type: "PUSH",
    });
  });

  it("shows profile marks only when pages use different identities, never separate session groups", () => {
    const { container, render } = setup();
    const first = { ...mailSession("one"), profileId: "work-profile" };
    const second = { ...mailSession("two"), profileId: "work-profile" };
    state.snapshot = {
      ...snapshot([first, second]),
      browserProfiles: [{ id: "work-profile", name: "Work" }] as HostSnapshot["browserProfiles"],
    };
    render();
    expect(container.querySelectorAll("[data-expected-surface]")).toHaveLength(2);
    expect(
      [...container.querySelectorAll("button")].some((button) =>
        button.getAttribute("aria-label")?.includes("Work"),
      ),
    ).toBe(false);
    state.snapshot = { ...state.snapshot, browserSessions: [first, second, mailSession("guest")] };
    render();
    expect(container.querySelectorAll("[data-expected-surface]")).toHaveLength(3);
    const labels = [...container.querySelectorAll("button")].map((button) =>
      button.getAttribute("aria-label"),
    );
    expect(labels.filter((label) => label?.includes("Work"))).toHaveLength(2);
    expect(labels.filter((label) => label?.includes("Guest"))).toHaveLength(1);
    expect(
      [...container.querySelectorAll("span")].filter((span) => span.textContent === "W"),
    ).toHaveLength(2);
  });

  it("keeps a failed page on screen with its detail and no navigation", () => {
    const { container, render } = setup({ sessionId: "chosen" });
    state.snapshot = snapshot([
      { ...session("chosen", child.id, "failed"), error: "The computer disconnected." },
    ]);
    render();
    expect(container.textContent).toContain("This page stopped working");
    expect(container.textContent).toContain("The computer disconnected.");
    expect(state.dispatch).not.toHaveBeenCalled();
    expect(state.goBack).not.toHaveBeenCalled();
  });

  it("keeps a closed exact page unavailable without activating a sibling", () => {
    state.hostClient = { sendBrowserCommand: vi.fn() };
    const { container, render } = setup({ sessionId: "chosen", tabId: "missing-page" });
    state.snapshot = snapshot([mailSession("chosen")]);
    render();
    expect(container.textContent).toContain("This tab was closed");
    expect(container.textContent).not.toContain("View this browser");
    expect(state.dispatch).not.toHaveBeenCalled();
    expect(state.hostClient.sendBrowserCommand).not.toHaveBeenCalled();
    press(container, "Back to tabs");
    expect(state.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "REPLACE" }));
  });

  it("views a linked inactive page without activating it and targets its navigation", () => {
    const sendBrowserCommand = vi.fn();
    state.hostClient = {
      sendBrowserCommand,
      browserViewerState: () => liveFeed,
      browserFrames: { subscribe: () => () => undefined },
    };
    const chosen = mailSession("chosen");
    const target =
      "srf_00000000-0000-4000-8000-000000000002" as BrowserSessionSummary["tabs"][number]["id"];
    const { container, render } = setup({ sessionId: chosen.id, tabId: target });
    state.snapshot = snapshot([
      {
        ...chosen,
        tabs: [
          ...chosen.tabs,
          { ...chosen.tabs[0]!, id: target, active: false, title: "Second page" },
        ],
      },
    ]);
    render();
    expect(
      container.querySelector("[data-expected-surface]")?.getAttribute("data-expected-surface"),
    ).toBe(target);
    expect(sendBrowserCommand).not.toHaveBeenCalled();
    press(menu(), "Reload");
    expect(sendBrowserCommand).toHaveBeenCalledExactlyOnceWith(chosen.id, {
      type: "navigation.reload",
      surfaceId: target,
    });
  });

  it("says a page refused an action until its feed is admitted again, then gives the page's reason", () => {
    const sendBrowserCommand = vi.fn(() => {
      throw new Error("The targeted browser control is not synchronized.");
    });
    state.hostClient = { sendBrowserCommand };
    const chosen = mailSession("chosen");
    const { container, render } = setup({ sessionId: chosen.id, tabId: chosen.tabs[0]!.id });
    let feed: object = { ...liveFeed, admissionId: "admission-1" };
    state.hostClient.browserViewerState = () => feed;
    state.snapshot = snapshot([chosen]);
    render();
    expect(() => press(menu(), "Reload")).not.toThrow();
    expect(container.textContent).toContain("The page is reconnecting");
    feed = { ...liveFeed, admissionId: "admission-2", inputError: "A dialog is open on the page." };
    render();
    expect(container.textContent).not.toContain("The page is reconnecting");
    expect(container.textContent).toContain("A dialog is open on the page.");
  });

  it("closes the page keyboard when the page refuses what was typed, and types afresh after", () => {
    let refuse = false;
    const sendBrowserCommand = vi.fn(() => {
      if (refuse) throw new Error("The targeted browser control is not synchronized.");
    });
    state.hostClient = { sendBrowserCommand };
    const chosen = mailSession("chosen");
    const { container, render } = setup({ sessionId: chosen.id, tabId: chosen.tabs[0]!.id });
    state.snapshot = snapshot([chosen]);
    render();
    const field = () =>
      container.querySelector<HTMLInputElement>('input[aria-label="Type into the page"]');
    const type = (text: string) =>
      act(() => {
        const input = field();
        if (!input) throw new Error("The page keyboard is closed.");
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
          input,
          text,
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    press(container, "Tap the page");
    press(container, "Keyboard");
    type("saved");
    refuse = true;
    type("saved!");
    expect(field()).toBeNull();
    refuse = false;
    press(container, "Tap the page");
    press(container, "Keyboard");
    type("x");
    const surfaceId = chosen.tabs[0]!.id;
    expect(sendBrowserCommand.mock.calls).toEqual([
      [chosen.id, { type: "clipboard.paste", surfaceId, text: "saved" }],
      [chosen.id, { type: "clipboard.paste", surfaceId, text: "!" }],
      [chosen.id, { type: "clipboard.paste", surfaceId, text: "x" }],
    ]);
  });

  it("lists each page across sessions", () => {
    const { container, render } = setup();
    const first = mailSession("first");
    const secondTab = {
      ...first.tabs[0]!,
      id: "page-2" as BrowserSessionSummary["tabs"][number]["id"],
      active: false,
      title: "Second page",
    };
    state.snapshot = snapshot([
      { ...first, tabs: [...first.tabs, secondTab] },
      mailSession("second"),
    ]);
    render();
    expect(container.querySelectorAll("[data-expected-surface]")).toHaveLength(3);
  });

  it("selects a local pending tab immediately and keeps a later result from stealing focus", async () => {
    const gate = Promise.withResolvers<{ sessionId: string; tabId: string }>();
    const beginBrowserTabOpen = vi.fn(() => ({
      idempotencyKey: "phone-open",
      result: gate.promise,
    }));
    state.hostClient = {
      beginBrowserTabOpen,
      browserViewerState: () => liveFeed,
      browserFrames: { subscribe: () => () => undefined },
    };
    const { render, route, container } = setup({ sessionId: "chosen" });
    state.snapshot = snapshot([session("chosen", child.id)]);
    render();
    await pressAsync(menu(), "New tab");
    expect(beginBrowserTabOpen).toHaveBeenCalledOnce();
    expect(state.dispatch).toHaveBeenCalledExactlyOnceWith({
      type: "REPLACE",
      name: "WorkspaceBrowser",
      params: {
        deploymentId: "deployment-a",
        threadId: "thread-parent",
        pendingBrowserTab: "phone-open",
      },
    });
    route.params = {
      deploymentId: "deployment-a",
      threadId: "thread-parent",
      pendingBrowserTab: "phone-open",
    };
    state.snapshot = {
      ...state.snapshot!,
      pendingBrowserTabs: [
        {
          idempotencyKey: "phone-open",
          target: { sessionId: "chosen" },
          url: "https://waiting.example/",
          state: "opening",
        },
      ],
    };
    render();
    expect(container.textContent).toContain("Opening");
    expect(container.textContent).toContain("waiting.example");
    expect(container.textContent).not.toContain("https://waiting.example/");
    expect(container.querySelector('[aria-label="https://waiting.example/"]')).not.toBeNull();
    state.navigationFocused = false;
    state.routes = [
      { name: "Thread", params: { deploymentId: "deployment-a", threadId: "other" } },
    ];
    await act(async () => gate.resolve({ sessionId: "chosen", tabId: "new-page" }));
    expect(state.dispatch).toHaveBeenCalledOnce();
  });

  it("keeps an ambiguous opening's address and completes it on the chosen available computer", async () => {
    const gate = Promise.withResolvers<{ sessionId: string; tabId: string }>();
    const beginBrowserTabOpen = vi.fn(() => ({
      idempotencyKey: "chosen-computer",
      result: gate.promise,
    }));
    const dismissPendingBrowserTab = vi.fn();
    state.hostClient = { beginBrowserTabOpen, dismissPendingBrowserTab };
    const ambiguousSnapshot: HostSnapshot = {
      ...snapshot([]),
      browserPlacements: [
        {
          runnerId: "available",
          label: "Available Mac",
          available: true,
          kind: "runner",
          runtimeId: null,
          environmentIds: [],
        },
        {
          runnerId: "offline",
          label: "Offline Mac",
          available: false,
          kind: "runner",
          runtimeId: null,
          environmentIds: [],
        },
      ],
      pendingBrowserTabs: [
        {
          idempotencyKey: "ambiguous",
          target: { identity: { kind: "guest" } },
          url: "https://waiting.example/",
          state: "failed",
          typed: true,
          viewport: { width: 390, height: 612 },
          error: {
            code: "browser-placement-ambiguous",
            message: "Choose a computer to browse on.",
          },
        },
      ],
    };
    const { container } = setup(
      { pendingBrowserTab: "ambiguous" },
      { snapshot: ambiguousSnapshot },
    );
    expect(container.textContent).toContain("waiting.example");
    expect(container.textContent).not.toContain("https://waiting.example/");
    expect(container.querySelector('[aria-label="https://waiting.example/"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Open on Offline Mac");
    await pressAsync(container, "Open on Available Mac");
    expect(beginBrowserTabOpen).toHaveBeenCalledExactlyOnceWith(
      { identity: { kind: "guest" }, placement: { kind: "runner", runnerId: "available" } },
      { url: "https://waiting.example/", typed: true, viewport: { width: 390, height: 612 } },
    );
    expect(dismissPendingBrowserTab).toHaveBeenCalledExactlyOnceWith("ambiguous");
    state.routes = [
      {
        name: "WorkspaceBrowser",
        params: {
          deploymentId: "deployment-a",
          threadId: "thread-parent",
          pendingBrowserTab: "chosen-computer",
        },
      },
    ];
    await act(async () => gate.resolve({ sessionId: "chosen", tabId: "new-page" }));
    expect(state.dispatch).toHaveBeenLastCalledWith({
      type: "REPLACE",
      name: "WorkspaceBrowser",
      params: {
        deploymentId: "deployment-a",
        threadId: "thread-parent",
        sessionId: "chosen",
        tabId: "new-page",
        editAddress: true,
      },
    });
  });

  it.each([false, true])(
    "opens at the valid page size and replaces only the selected pending route (oversized=%s)",
    async (oversized) => {
      state.layout = { height: 612.4, width: oversized ? 8000 : 389.6 };
      const gate = Promise.withResolvers<{ sessionId: string; tabId: string }>();
      const beginBrowserTabOpen = vi.fn(() => ({
        idempotencyKey: "phone-open",
        result: gate.promise,
      }));
      state.hostClient = {
        beginBrowserTabOpen,
        browserViewerState: () => liveFeed,
        browserFrames: { subscribe: () => () => undefined },
      };
      const { container, render, route } = setup({ sessionId: "chosen" });
      state.snapshot = snapshot([session("chosen", child.id)]);
      render();
      await pressAsync(menu(), "New tab");
      expect(beginBrowserTabOpen).toHaveBeenCalledExactlyOnceWith(
        { sessionId: "chosen" },
        oversized ? undefined : { viewport: { height: 612, width: 390 } },
      );
      state.routes = [
        {
          name: "WorkspaceBrowser",
          params: {
            deploymentId: "deployment-a",
            threadId: "thread-parent",
            pendingBrowserTab: "phone-open",
          },
        },
      ];
      await act(async () => gate.resolve({ sessionId: "chosen", tabId: "new-page" }));
      expect(state.dispatch).toHaveBeenLastCalledWith({
        type: "REPLACE",
        name: "WorkspaceBrowser",
        params: {
          deploymentId: "deployment-a",
          threadId: "thread-parent",
          sessionId: "chosen",
          tabId: "new-page",
          editAddress: true,
        },
      });
      route.params = {
        deploymentId: "deployment-a",
        threadId: "thread-parent",
        sessionId: "chosen",
        tabId: "new-page",
        editAddress: true,
      };
      state.snapshot = snapshot([
        {
          ...session("chosen", child.id),
          tabs: [
            { id: "new-page", active: false, title: "", url: "about:blank" },
          ] as BrowserSessionSummary["tabs"],
        },
      ]);
      render();
      expect(
        container.querySelector<HTMLInputElement>('input[aria-label="Website address"]')?.value,
      ).toBe("");
    },
  );

  it.each([false, true])(
    "returns after a successful close, reviewing held work: %s",
    async (held) => {
      const chosen = session("chosen", child.id);
      const closeBrowserTab = vi.fn(async () => ({}));
      state.hostClient = {
        getSnapshot: () => state.snapshot,
        subscribe: () => () => undefined,
        closeBrowserTab,
      };
      const { container, render } = setup({ sessionId: "chosen" });
      state.routes = [
        { name: "Thread" },
        {
          name: "WorkspaceBrowser",
          params: { deploymentId: "deployment-a", threadId: "thread-parent", sessionId: "chosen" },
        },
      ];
      state.snapshot = snapshot([
        {
          ...chosen,
          attachedRunIds: held ? ["run-1"] : [],
          tabCatalog: {
            generation: 1,
            revision: 1,
            tabs: [
              { id: "page-1", title: "Page", site: "https://example.com", order: 0, occupants: [] },
            ],
          } as unknown as NonNullable<BrowserSessionSummary["tabCatalog"]>,
        },
      ]);
      render();
      await pressAsync(menu(), "Close tab");
      if (held) {
        expect(closeBrowserTab).not.toHaveBeenCalled();
        expect(container.textContent).toContain(
          "An agent is working here. This tab closes for you and for the agent.",
        );
        await pressAsync(container, "Close tab");
      }
      expect(closeBrowserTab).toHaveBeenCalledExactlyOnceWith("chosen", "page-1", {
        generation: 1,
        revision: 1,
        inventoryRevision: 1,
      });
      expect(state.goBack).not.toHaveBeenCalled();
      expect(state.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "POP", count: 1 });
    },
  );

  it("returns to the conversation past an earlier closed page when its last page closes", async () => {
    const closeBrowserTab = vi.fn(async () => ({}));
    state.hostClient = {
      getSnapshot: () => state.snapshot,
      subscribe: () => () => undefined,
      closeBrowserTab,
    };
    const { render } = setup({ sessionId: "chosen" });
    // A transcript chip on page A pushed page B; A has since closed elsewhere.
    state.routes = [
      { name: "Thread" },
      {
        name: "WorkspaceBrowser",
        params: {
          deploymentId: "deployment-a",
          threadId: "thread-parent",
          sessionId: "earlier",
          tabId: "page-1",
        },
      },
      {
        name: "WorkspaceBrowser",
        params: {
          deploymentId: "deployment-a",
          threadId: "thread-parent",
          sessionId: "chosen",
          tabId: "page-1",
        },
      },
    ];
    state.snapshot = snapshot([
      {
        ...session("chosen", child.id),
        tabCatalog: {
          generation: 1,
          revision: 1,
          tabs: [
            { id: "page-1", title: "Page", site: "https://example.com", order: 0, occupants: [] },
          ],
        } as unknown as NonNullable<BrowserSessionSummary["tabCatalog"]>,
      },
    ]);
    render();
    await pressAsync(menu(), "Close tab");
    expect(state.goBack).not.toHaveBeenCalled();
    expect(state.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "POP", count: 2 });
  });

  it("leaves the person where they are when a close completes after they opened another page", async () => {
    let complete: (() => void) | undefined;
    const closeBrowserTab = vi.fn(
      () =>
        new Promise((resolve) => {
          complete = () => resolve({});
        }),
    );
    state.hostClient = {
      getSnapshot: () => state.snapshot,
      subscribe: () => () => undefined,
      closeBrowserTab,
    };
    const { render } = setup({ sessionId: "chosen" });
    state.snapshot = snapshot([
      {
        ...session("chosen", child.id),
        tabCatalog: {
          generation: 1,
          revision: 1,
          tabs: [
            { id: "page-1", title: "Page", site: "https://example.com", order: 0, occupants: [] },
          ],
        } as unknown as NonNullable<BrowserSessionSummary["tabCatalog"]>,
      },
      session("other", child.id),
    ]);
    render();
    await pressAsync(menu(), "Close tab");
    expect(closeBrowserTab).toHaveBeenCalledOnce();
    // Another page was pushed over this one before the Host answered.
    state.navigationFocused = false;
    await act(async () => complete?.());
    expect(state.goBack).not.toHaveBeenCalled();
    expect(state.dispatch).not.toHaveBeenCalled();
  });

  it("returns to Tabs when another tab remains and bypasses an empty grid after close", async () => {
    const chosen = session("chosen", child.id);
    const closeBrowserTab = vi.fn(async () => ({}));
    state.hostClient = {
      getSnapshot: () => state.snapshot,
      subscribe: () => () => undefined,
      closeBrowserTab,
    };
    const { render } = setup({ sessionId: "chosen" });
    const catalog = {
      generation: 1,
      revision: 1,
      tabs: [{ id: "page-1", title: "Page", site: "https://example.com", order: 0, occupants: [] }],
    } as unknown as NonNullable<BrowserSessionSummary["tabCatalog"]>;
    state.snapshot = snapshot([{ ...chosen, tabCatalog: catalog }, session("other", child.id)]);
    state.routes = [
      { name: "Thread" },
      {
        name: "WorkspaceBrowser",
        params: { deploymentId: "deployment-a", threadId: "thread-parent" },
      },
      { name: "WorkspaceBrowser", params: { sessionId: "chosen" } },
    ];
    render();
    await pressAsync(menu(), "Close tab");
    expect(state.goBack).toHaveBeenCalledOnce();
    state.goBack.mockClear();
    state.snapshot = snapshot([{ ...chosen, tabCatalog: catalog }]);
    render();
    let complete: (() => void) | undefined;
    closeBrowserTab.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = () => resolve({});
        }),
    );
    await pressAsync(menu(), "Close tab");
    expect(state.goBack).not.toHaveBeenCalled();
    state.snapshot = snapshot([]);
    render();
    await act(async () => complete?.());
    expect(state.dispatch).toHaveBeenCalledWith({ type: "POP", count: 2 });
  });

  it("stays on the page and explains a failed close", async () => {
    const chosen = session("chosen", child.id);
    state.hostClient = {
      getSnapshot: () => state.snapshot,
      subscribe: () => () => undefined,
      closeBrowserTab: vi.fn(async () => {
        throw new Error("Offline");
      }),
    };
    const { container, render } = setup({ sessionId: "chosen" });
    state.snapshot = snapshot([
      {
        ...chosen,
        tabCatalog: {
          generation: 1,
          revision: 1,
          tabs: [
            { id: "page-1", occupants: [], order: 0, site: "https://example.com", title: "Page" },
          ],
        } as unknown as NonNullable<BrowserSessionSummary["tabCatalog"]>,
      },
    ]);
    render();
    await pressAsync(menu(), "Close tab");
    expect(state.goBack).not.toHaveBeenCalled();
    expect(state.dispatch).not.toHaveBeenCalled();
    expect(container.textContent).toContain("This tab could not be closed.");
  });

  it("signs the page's site in with Chrome from the page's menu and reloads the page", async () => {
    const outcome = {
      profileName: null,
      site: "https://example.com",
      sourceName: "Chrome on Mac",
      status: "applied",
    };
    const dispatch = vi.fn(async () => ({ outcome, type: "browser.session.sign-in" }));
    const sendBrowserCommand = vi.fn();
    state.hostClient = {
      dispatch,
      getSnapshot: () => state.snapshot,
      retainBrowserViewer: () => () => undefined,
      rpc: {},
      sendBrowserCommand,
      subscribe: () => () => undefined,
    };
    state.hostClient.browserViewerState = () => liveFeed;
    state.hostClient.browserFrames = { subscribe: () => () => undefined };
    const { container, render } = setup({
      sessionId: "delegate",
      tabId: "srf_00000000-0000-4000-8000-000000000001",
    });
    state.snapshot = snapshot([mailSession("delegate")]);
    render();
    // Not a permanent block under the page: it is asked for.
    expect(container.textContent).not.toContain("Sign in with Chrome");

    press(menu(), "Sign in with Chrome");
    await pressAsync(container, "Sign in with Chrome");
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({
      idempotencyKey: expect.any(String),
      sessionId: "delegate",
      sourceId: null,
      type: "browser.session.sign-in",
      url: "https://mail.example.com/inbox",
    });
    expect(sendBrowserCommand).toHaveBeenCalledWith("delegate", {
      type: "navigation.reload",
      surfaceId: "srf_00000000-0000-4000-8000-000000000001",
    });
    expect(container.textContent).toContain("Signed in to example.com with Chrome on Mac.");
  });

  it("asks which Chrome when several are signed in, and says how to fix an offline one", async () => {
    const dispatch = vi
      .fn()
      .mockResolvedValueOnce({
        outcome: {
          problem: "choose-source",
          site: "https://example.com",
          sourceName: null,
          status: "problem",
        },
        type: "browser.session.sign-in",
      })
      .mockResolvedValueOnce({
        outcome: {
          problem: "chrome-offline",
          site: "https://example.com",
          sourceName: "Work Chrome",
          status: "problem",
        },
        type: "browser.session.sign-in",
      });
    const inspect = vi.fn(async () => ({
      data: {
        candidates: [
          { name: "Chrome on Mac", sourceId: "bsr_mac", status: "available" },
          { name: "Work Chrome", sourceId: "bsr_work", status: "available" },
        ],
        site: "https://example.com",
      },
      ok: true,
    }));
    const sendBrowserCommand = vi.fn();
    state.hostClient = {
      dispatch,
      rpc: { "browser.sources.inspect": inspect },
      sendBrowserCommand,
    };
    state.hostClient.browserViewerState = () => liveFeed;
    state.hostClient.browserFrames = { subscribe: () => () => undefined };
    const { container, render } = setup({
      sessionId: "delegate",
      tabId: "srf_00000000-0000-4000-8000-000000000001",
    });
    state.snapshot = snapshot([mailSession("delegate")]);
    render();

    press(menu(), "Sign in with Chrome");
    // The site is remembered for the Workspace, which the action says before any tap.
    expect(container.textContent).toContain(
      "Agents in Research will be able to use example.com as you.",
    );
    await pressAsync(container, "Sign in with Chrome");
    expect(inspect).toHaveBeenCalledWith({ url: "https://mail.example.com/inbox" });
    expect(container.textContent).toContain("Choose the Chrome to use for example.com");

    await pressAsync(container, "Work Chrome");
    expect(dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ sourceId: "bsr_work", type: "browser.session.sign-in" }),
    );
    expect(container.textContent).toContain("Work Chrome is offline");
    expect(container.textContent).toContain("Open Chrome on that computer.");
    expect(sendBrowserCommand).not.toHaveBeenCalled();
  });

  it("keeps an exact browser link when the session ends or disappears, and returns to the grid on request", () => {
    const { container, render } = setup({ sessionId: "chosen" });
    state.snapshot = snapshot([session("other", child.id), session("chosen", child.id)]);
    render();
    expect(container.textContent).toContain("Viewing chosen");
    expect(container.textContent).toContain("Conversation docked");
    state.snapshot = snapshot([session("other", child.id), session("chosen", child.id, "closed")]);
    render();
    expect(container.textContent).toContain("This tab was closed");
    expect(container.textContent).not.toContain("Viewing other");
    state.snapshot = snapshot([session("other", child.id)]);
    render();
    expect(container.textContent).toContain("This tab was closed");
    expect(container.textContent).not.toContain("Viewing other");
    // Opened from a link, there is no grid beneath: the grid takes this page's place.
    press(container, "Back to tabs");
    expect(state.dispatch).toHaveBeenCalledWith({
      name: "WorkspaceBrowser",
      params: { deploymentId: "deployment-a", threadId: "thread-parent" },
      type: "REPLACE",
    });
    state.routes = [
      {
        name: "WorkspaceBrowser",
        params: { deploymentId: "deployment-a", threadId: "thread-parent" },
      },
      { name: "WorkspaceBrowser", params: { deploymentId: "deployment-a", sessionId: "chosen" } },
    ];
    press(container, "Back to tabs");
    expect(state.goBack).toHaveBeenCalledOnce();
  });

  it("offers the switcher only with siblings, marks current and acting choices, and replaces the route", () => {
    const { render } = setup({ sessionId: "chosen", tabId: "page-1" });
    state.snapshot = snapshot([session("chosen", child.id)]);
    render();
    const nativeItems = () => {
      const options = state.setOptions.mock.calls
        .map(
          ([value]) =>
            value as {
              unstable_headerRightItems?: () => {
                label: string;
                menu?: {
                  items: {
                    label: string;
                    description?: string;
                    state?: string;
                    icon?: object;
                    onPress: () => void;
                  }[];
                };
              }[];
            },
        )
        .findLast((value) => value.unstable_headerRightItems !== undefined);
      return options?.unstable_headerRightItems?.() ?? [];
    };
    expect(nativeItems().some((item) => item.label === "Tabs")).toBe(false);
    const other = {
      ...session("other", child.id),
      tabs: [
        { active: true, id: "page-2", title: "Second page", url: "https://second.example.com" },
      ],
    } as BrowserSessionSummary;
    other.tabCatalog = {
      generation: 1,
      revision: 1,
      tabs: [
        {
          ...other.tabs[0]!,
          order: 0,
          openerId: null,
          iconRef: null,
          availability: "ready",
          documentId: null,
          site: "second.example.com",
          occupants: [
            {
              threadId: "thread-parent",
              home: false,
              holding: true,
              acting: true,
              lastActiveAt: "2026-10-13T00:00:00.000Z",
            },
          ],
        },
      ],
    } as unknown as NonNullable<BrowserSessionSummary["tabCatalog"]>;

    state.snapshot = snapshot([session("chosen", child.id), other]);
    render();
    const choices = nativeItems().find((item) => item.label === "Tabs")?.menu?.items;
    expect(choices).toEqual([
      expect.objectContaining({
        label: "Page",
        state: "on",
        icon: { type: "sfSymbol", name: "globe" },
        description: "example.com",
      }),
      expect.objectContaining({ label: "Second page", state: "off", description: "Agent working" }),
      expect.objectContaining({ label: "All Tabs" }),
    ]);
    const android = menu();
    expect(android.querySelector('button[aria-pressed="true"]')?.textContent).toBe("Page");
    expect(android.textContent).toContain("Second page · Agent working");
    act(() => choices![1]!.onPress());
    expect(state.dispatch).toHaveBeenLastCalledWith({
      type: "REPLACE",
      name: "WorkspaceBrowser",
      params: {
        deploymentId: "deployment-a",
        threadId: "thread-parent",
        sessionId: "other",
        tabId: "page-2",
      },
    });
    act(() => choices![2]!.onPress());
    expect(state.dispatch).toHaveBeenLastCalledWith({
      type: "REPLACE",
      name: "WorkspaceBrowser",
      params: { deploymentId: "deployment-a", threadId: "thread-parent" },
    });
  });

  it("refreshes on focus and keeps the exact view while other browsers arrive", () => {
    const { container, render } = setup({ sessionId: "chosen" });
    expect(state.refresh).toHaveBeenCalledTimes(1);
    state.snapshot = snapshot([session("chosen", child.id), session("new", child.id)]);
    render();
    expect(container.textContent).toContain("Viewing chosen");
    expect(container.textContent).not.toContain("Viewing new");
    state.focused = false;
    render();
    state.focused = true;
    render();
    expect(state.refresh).toHaveBeenCalledTimes(2);
  });

  it("refuses another deployment and a signed-out viewer", () => {
    const { container, render } = setup({ sessionId: "chosen" });
    state.snapshot = snapshot([session("chosen", child.id)]);
    state.deploymentId = "deployment-b";
    render();
    expect(container.textContent).toContain("This deployment is no longer open");
    expect(container.textContent).not.toContain("Viewing chosen");
    state.deploymentId = "deployment-a";
    state.snapshot = { ...state.snapshot, session: "authentication-required", user: null };
    render();
    expect(container.textContent).toContain("Sign in to view this page");
    expect(container.textContent).not.toContain("Viewing chosen");
  });
});

/*
 * A page beside its conversation as the window changes shape. What can go
 * wrong: the page's live channel or the conversation remounts, so a draft or
 * stream is lost; a geometry change navigates; the keyboard
 * lifts the pane nobody is typing in; tabletop's fixed halves leave the
 * conversation's composer no room once the keyboard is up; a fold that has
 * not been measured yet is straddled.
 */
describe("a page beside its conversation", () => {
  /** One live page of the conversation, opened, with the address field open when asked. */
  function openPage(editAddress = false) {
    const opened = setup({ editAddress, sessionId: "browser-child", tabId: "page-1" });
    state.snapshot = snapshot([session("browser-child", child.id)]);
    opened.render();
    return opened;
  }

  function slot(container: HTMLElement, name: "page" | "conversation") {
    const found = container.querySelector<HTMLElement>(`[data-testid="${name}-slot"]`);
    if (found === null) throw new Error(`No ${name} slot.`);
    return {
      avoids: found.dataset["avoids"] === "true",
      style: JSON.parse(found.dataset["style"] ?? "{}") as Record<string, unknown>,
    };
  }

  function arrangement(container: HTMLElement): string {
    const pair = container.querySelector<HTMLElement>('[data-testid^="pair-"]');
    return pair?.dataset["testid"]?.slice("pair-".length) ?? "";
  }

  it("keeps the page and the conversation mounted, as the pair changes shape", () => {
    const { container, render } = openPage();
    expect(arrangement(container)).toBe("stacked");
    expect(container.textContent).toContain("Conversation docked");

    state.pair = { height: 1000, width: 744 };
    render();
    expect(arrangement(container)).toBe("side");
    // Beside the page there is room for all of it: the conversation is open.
    expect(container.textContent).toContain("Conversation beside");

    state.pair = { height: 900, width: 900 };
    state.regions = [
      { frame: { height: 20, width: 900, x: 0, y: 420 }, kind: "division", occludesContent: false },
    ];
    render();
    expect(arrangement(container)).toBe("tabletop");
    expect(slot(container, "page").style).toMatchObject({ height: 420 });

    state.pair = { height: 760, width: 390 };
    state.regions = [];
    render();
    expect(arrangement(container)).toBe("stacked");
    expect(container.textContent).toContain("Conversation docked");

    expect(state.conversationMounts).toBe(1);
    expect(state.pageMounts).toBe(1);
    expect(state.dispatch).not.toHaveBeenCalled();
    expect(state.goBack).not.toHaveBeenCalled();
  });

  it("hides the dock while typing into the stacked page and keeps it mounted", () => {
    const { container, render } = openPage(true);
    state.keyboard = true;
    render();
    expect(slot(container, "conversation").style).toMatchObject({ display: "none" });
    expect(state.conversationMounts).toBe(1);
    expect(state.pageMounts).toBe(1);
  });

  it("gives the stacked page definite space and sizes the dock and its Pane by content", () => {
    const { container } = openPage();
    // The page has what the dock leaves, with no floor that would push the
    // composer under the keyboard on a short screen.
    expect(slot(container, "page").style).toMatchObject({ flex: 1, minHeight: 0 });
    // The dock is its content's height, and gives way (its content scrolls) before the page does.
    expect(slot(container, "conversation").style).toMatchObject({ flexShrink: 1 });
    for (const name of ["page", "conversation"] as const) {
      expect(slot(container, name).style["position"]).not.toBe("absolute");
    }
    const pane = container.querySelector<HTMLElement>(
      '[data-testid="conversation-slot"] > [data-pane-style]',
    );
    expect(JSON.parse(pane?.dataset["paneStyle"] ?? "null")).toMatchObject({
      flex: 0,
      flexShrink: 1,
    });
  });

  it("opens the conversation past its intervening page and grid", () => {
    const { container } = openPage();
    state.routes = [
      { name: "Thread", params: { threadId: "thread-parent" } },
      { name: "WorkspaceBrowser", params: { threadId: "thread-parent" } },
      {
        name: "WorkspaceBrowser",
        params: { threadId: "thread-parent", sessionId: "browser-child", tabId: "page-1" },
      },
    ];
    press(container, "Open the conversation");
    expect(state.dispatch).toHaveBeenCalledWith({ type: "POP", count: 2 });
  });

  it("stays stacked until the pair's own surface is measured", () => {
    state.regionsReady = false;
    state.pair = { height: 1000, width: 744 };
    const { container, render } = openPage();
    expect(arrangement(container)).toBe("stacked");
    state.regionsReady = true;
    render();
    expect(arrangement(container)).toBe("side");
    expect(state.conversationMounts).toBe(1);
  });

  it("lifts only the pane being typed in", () => {
    state.pair = { height: 1000, width: 744 };
    // The address field is open, so the page is what the keyboard is for.
    const typingPage = openPage(true);
    state.keyboard = true;
    typingPage.render();
    expect(slot(typingPage.container, "page").avoids).toBe(true);
    expect(slot(typingPage.container, "conversation").avoids).toBe(false);
    // Side by side, typing in the page keeps the conversation in view.
    expect(slot(typingPage.container, "conversation").style).not.toMatchObject({
      display: "none",
    });
  });

  it("lifts the conversation for its composer, and leaves the page where it is", () => {
    state.pair = { height: 1000, width: 744 };
    state.keyboard = true;
    const { container } = openPage();
    expect(slot(container, "page").avoids).toBe(false);
    expect(slot(container, "conversation").avoids).toBe(true);
  });

  it("gives up the page's half in tabletop when the composer needs the keyboard, and keeps both mounted", () => {
    state.pair = { height: 900, width: 900 };
    state.regions = [
      { frame: { height: 20, width: 900, x: 0, y: 420 }, kind: "division", occludesContent: false },
    ];
    const { container, render } = openPage();
    expect(slot(container, "page").style).toMatchObject({ height: 420 });
    state.keyboard = true;
    render();
    const page = slot(container, "page").style;
    expect(page["height"]).toBeUndefined();
    expect(page).toMatchObject({ flexShrink: 1, maxHeight: 420, minHeight: 0 });
    expect(slot(container, "conversation").style).toMatchObject({ flexGrow: 1, flexShrink: 0 });
    expect(slot(container, "conversation").avoids).toBe(true);
    state.keyboard = false;
    render();
    expect(slot(container, "page").style).toMatchObject({ height: 420 });
    expect(state.conversationMounts).toBe(1);
    expect(state.pageMounts).toBe(1);
  });
});

describe("a page and its conversation around what the system reserves", () => {
  function openPage() {
    const opened = setup({ sessionId: "browser-child", tabId: "page-1" });
    state.snapshot = snapshot([session("browser-child", child.id)]);
    opened.render();
    return opened;
  }
  function styleOf(container: HTMLElement, selector: string): Record<string, unknown> {
    const found = container.querySelector<HTMLElement>(selector);
    if (found === null) throw new Error(`Nothing matches ${selector}.`);
    return JSON.parse(found.dataset["style"] ?? "{}") as Record<string, unknown>;
  }
  const conversationInsets = (container: HTMLElement) =>
    JSON.parse(container.querySelector<HTMLElement>("[data-insets]")?.dataset["insets"] ?? "{}");

  it("keeps the page's own address, dialogs and picture clear of an obstruction over the page", () => {
    state.pair = { height: 1000, width: 744 };
    state.regions = [{ frame: { height: 30, width: 30, x: 0, y: 300 }, kind: "occlusion" }];
    const { container } = openPage();
    expect(styleOf(container, '[data-testid="page-content"]')).toMatchObject({
      paddingBottom: 0,
      paddingLeft: 30,
      paddingRight: 0,
      paddingTop: 0,
    });
  });

  it("keeps the stacked pair to one side of a fold it cannot split at", () => {
    state.pair = { height: 900, width: 720 };
    state.regions = [
      { frame: { height: 900, width: 20, x: 350, y: 0 }, kind: "division", occludesContent: true },
    ];
    const { container } = openPage();
    expect(styleOf(container, '[data-testid="pair-stacked"]')).toMatchObject({
      paddingBottom: 0,
      paddingEnd: 370,
      paddingStart: 0,
      paddingTop: 0,
    });
  });

  it("clears an obstruction from where the conversation is while tabletop gives way to the keyboard", () => {
    state.pair = { height: 900, width: 900 };
    state.regions = [
      { frame: { height: 20, width: 900, x: 0, y: 420 }, kind: "division", occludesContent: false },
      { frame: { height: 40, width: 40, x: 0, y: 430 }, kind: "occlusion" },
    ];
    const { container, render } = openPage();
    // Below the fold the obstruction is at the conversation's top edge.
    expect(conversationInsets(container)).toMatchObject({ left: 0, top: 30 });
    // The composer types and the page gives up its half: the conversation is no
    // longer where the fold put it, so the obstruction is cleared from its side.
    state.keyboard = true;
    render();
    expect(conversationInsets(container)).toMatchObject({ left: 40 });
  });
});

describe("saved tabs, global scope and native authority (hand-built snapshots)", () => {
  const placement = { kind: "runner" as const, runnerId: "runner-a" };
  function lineage(
    sessionId: string,
    tabs: readonly { id: string; sessionId: string; state: "live" | "suspended" }[],
  ) {
    return {
      createdAt: "2026-10-13T00:00:00.000Z",
      id: "lineage-a",
      revision: 1,
      session: { ...session(sessionId, child.id), placement },
      tabs: tabs.map((tab, order) => ({
        ...tab,
        kind: "browser" as const,
        openerId: null,
        order,
        site: "https://example.com",
        title: "Saved page",
      })),
    };
  }
  function catalogued(id: string): BrowserSessionSummary {
    return {
      ...session(id, child.id),
      placement,
      tabCatalog: {
        generation: 1,
        inventoryRevision: 1,
        revision: 1,
        tabs: [
          {
            availability: "ready",
            documentId: "document-1",
            iconRef: null,
            id: "page-1",
            occupants: [],
            openerId: null,
            order: 0,
            site: "https://example.com",
            title: "Saved page",
          },
        ],
      },
      workspaceTabRestoreVersion: 1,
    } as unknown as BrowserSessionSummary;
  }

  it("follows a saved tab's lineage to its new session without remounting the conversation", () => {
    const { container, render } = setup({ sessionId: "old" });
    state.snapshot = {
      ...snapshot([catalogued("new")]),
      browserPlacements: [{ available: true, label: "Mac mini", runnerId: "runner-a" }],
      workspaceTabRestoreVersion: 1,
      workspaceTabs: [lineage("new", [{ id: "page-1", sessionId: "new", state: "live" }])],
    } as unknown as HostSnapshot;
    render();
    expect(container.textContent).toContain("Viewing new");
    expect(state.setParams).toHaveBeenCalledWith({ sessionId: "new" });
    expect(state.conversationMounts).toBe(1);
    render();
    expect(state.conversationMounts).toBe(1);
    expect(state.dispatch).not.toHaveBeenCalled();
  });

  it("reads a lineage the bounded catalog leaves out once, and calls it closed without a sibling", async () => {
    const readWorkspaceTabs = vi.fn(async () => ({ ...lineage("old", []), tabs: [] }));
    state.hostClient = {
      browserFrames: { subscribe: () => () => undefined },
      browserViewerState: () => liveFeed,
      readWorkspaceTabs,
    };
    const { container, render } = setup({ sessionId: "old" });
    state.snapshot = {
      ...snapshot([catalogued("sibling")]),
      workspaceTabRestoreVersion: 1,
      workspaceTabs: [],
    } as unknown as HostSnapshot;
    render();
    await act(async () => undefined);
    await act(async () => undefined);
    expect(readWorkspaceTabs).toHaveBeenCalledExactlyOnceWith("old");
    expect(container.textContent).toContain("This tab was closed");
    expect(container.textContent).not.toContain("Viewing sibling");
    render();
    await act(async () => undefined);
    expect(readWorkspaceTabs).toHaveBeenCalledOnce();
    expect(state.dispatch).not.toHaveBeenCalled();
    expect(state.setParams).not.toHaveBeenCalled();
  });

  // A restarted effect must still observe its pending lookup; a failed lookup
  // must offer a real retry instead of claiming the tab is unavailable.
  it("finishes a bounded lookup when React restarts the mounted screen effects", async () => {
    const readWorkspaceTabs = vi.fn(async () => ({ ...lineage("old", []), tabs: [] }));
    state.hostClient = { readWorkspaceTabs };
    const { container } = setup(
      { sessionId: "old" },
      {
        strict: true,
        snapshot: { ...snapshot([]), workspaceTabRestoreVersion: 1, workspaceTabs: [] },
      },
    );
    await act(async () => undefined);
    expect(readWorkspaceTabs).toHaveBeenCalledExactlyOnceWith("old");
    expect(container.textContent).toContain("This tab was closed");
    expect(container.textContent).not.toContain("Looking for this tab");
  });

  it("shows a failed bounded lookup and retries the same tab", async () => {
    const readWorkspaceTabs = vi
      .fn()
      .mockRejectedValueOnce(new Error("The tab lookup was interrupted."))
      .mockResolvedValueOnce({ ...lineage("old", []), tabs: [] });
    state.hostClient = { readWorkspaceTabs };
    const { container } = setup(
      { sessionId: "old" },
      {
        snapshot: { ...snapshot([]), workspaceTabRestoreVersion: 1, workspaceTabs: [] },
      },
    );
    await act(async () => undefined);
    expect(container.textContent).toContain("The tab lookup was interrupted.");
    await pressAsync(container, "Try again");
    expect(readWorkspaceTabs.mock.calls).toEqual([["old"], ["old"]]);
    expect(container.textContent).toContain("This tab was closed");
    expect(state.dispatch).not.toHaveBeenCalled();
  });

  it("shows a page opened from Tabs alone, even when the route still names a conversation", () => {
    // A route a previous release built carried the conversation Tabs was opened from.
    const { container, render } = setup({
      scope: "workspace",
      sessionId: "chosen",
      threadId: "thread-a",
    } as unknown as Partial<SurfacesRoute>);
    state.snapshot = snapshot([session("chosen", child.id)]);
    render();
    expect(container.textContent).toContain("Viewing chosen");
    expect(container.textContent).not.toContain("Conversation docked");
    expect(container.querySelector('[data-testid="conversation-slot"]')).toBeNull();
    expect(state.conversationMounts).toBe(0);
  });

  it("opens task B's own session of an app task A also holds", () => {
    const { container, render } = setup({ threadId: "thread-b" } as Partial<SurfacesRoute>);
    const notes = { bundleId: "com.apple.Notes", displayName: "Notes", teamId: null };
    const hold = (sessionId: string, threadId: string) => ({
      actingAppKeys: [],
      apps: [notes],
      display: false,
      openedAt: "2026-10-13T00:00:00.000Z",
      runId: `run-${threadId}`,
      sessionId,
      threadId,
    });
    state.snapshot = {
      ...snapshot([]),
      machines: [
        {
          computerUse: {
            displayStreamSupported: true,
            ownerViews: [],
            sessions: [hold("session-a", "thread-a"), hold("session-b", "thread-b")],
            state: "ready",
          },
          id: "mac-a",
          name: "Mac mini",
          status: "online",
        } as unknown as MachineSummary,
      ],
    };
    render();
    press(container, "Notes, Mac mini");
    expect(state.dispatch).toHaveBeenCalledExactlyOnceWith({
      name: "WorkspaceBrowser",
      params: {
        appKey: "com.apple.notes",
        computerSessionId: "session-b",
        deploymentId: "deployment-a",
        machineId: "mac-a",
        threadId: "thread-b",
      },
      type: "PUSH",
    });
  });
});
