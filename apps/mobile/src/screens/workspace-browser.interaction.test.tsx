import { scopedTranscriptFixture } from "@opensteer/client/test-support";
import { mockBrowserPoolReport } from "@opensteer/client/mock";
import { DeviceIdSchema } from "@opensteer/core";
// @vitest-environment happy-dom

import { act, StrictMode, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserEditingStore,
  TabStore,
  type BrowserSessionSummary,
  type HostSnapshot,
  type PlaceActivity,
  type PlaceOccupant,
} from "@opensteer/client/host";
import { Alert } from "react-native";
import * as Clipboard from "expo-clipboard";
import { fitOffer, pictureBox, pinched, slideFor } from "../browser/browser-page.js";
import {
  BrowserPageContentPartSchema,
  TabIdSchema,
  type App,
  type Tab,
  type TabId,
} from "@opensteer/core";
import type { BrowserViewerSurface } from "@opensteer/protocol/browser-tabs";
import {
  MemoryPrivateFilesystem,
  tabFixture,
  testHostConnection,
} from "@opensteer/client/test-support";
import type { TabRoute } from "../browser/surface-route.js";
import type { TabViewer } from "@opensteer/protocol";
import {
  createThreadDraftStore,
  newTaskDraftKey,
  type ThreadDraftStore,
} from "../client/thread-drafts.js";
import { homeDraftId } from "../home/home-draft.js";
import { WorkspaceBrowserScreen } from "./workspace-browser.js";

/*
 * One tab, app or phone, by route. What can go wrong: a link's tab is swapped
 * for whatever tab is active; an ended browser is replaced by another; Chrome
 * sign-in is lost; another person's or deployment's tabs are shown; anything
 * but the person's own Open wakes a phone; moving between pages of one browser
 * blanks the page; the bar names an agent from the route rather than the page's
 * occupants, or pushes a second copy of the Thread under it; Ask loses the
 * page; the route's origin changes what the screen shows.
 */

const state = vi.hoisted(() => ({
  snapshot: null as HostSnapshot | null,
  deploymentId: "deployment-a",
  focused: true,
  /** Whether the page is still drawn: only sheets over it, as the stack says. */
  drawn: true,
  /** Whether this page is still the screen in front, as the stack says when an answer arrives. */
  navigationFocused: true,
  refresh: vi.fn(async () => {}),
  realAppView: false,
  hostClient: {} as Record<string, unknown>,
  dispatch: vi.fn(),
  goBack: vi.fn(),
  openSidebar: vi.fn(),
  /** Opened from the sidebar, so the page is top-level and its bar leads with the Menu. */
  topLevel: false,
  pinch: null as null | {
    readonly onActivate: (event: { focalX: number; focalY: number }) => void;
    readonly onDeactivate: () => void;
    readonly onUpdate: (event: { focalX: number; focalY: number; scale: number }) => void;
  },
  swipe: null as null | {
    readonly failOffsetY?: unknown;
    readonly onDeactivate: (event: { translationX: number }) => void;
  },
  safeArea: { bottom: 0, left: 0, right: 0, top: 0 },
  setOptions: vi.fn(),
  setParams: vi.fn(),
  routes: [] as { key?: string; name: string; params?: object }[],
  /** The pair's own measured surface, as its reserved-regions provider reports it. */
  pair: { height: 760, width: 390 },
  /** What every laid-out view measures, once a test lays the screen out. */
  layout: null as { height: number; width: number } | null,
  regions: [] as import("react-native-reserved-regions").ReservedRegion[],
  regionsReady: true,
  keyboard: false,
  /** The native field holding the keyboard, as a composer beside a page does. */
  focusedInput: null as object | null,
  fontScale: 1,
  foreground: true,
  /** This phone's own device in the Deployment, when it is one. */
  hereId: null as string | null,
  conversationMounts: 0,
  /** How the conversation beside the page shows one of its tabs there, as its live card does. */
  besideShowTab: null as ((tab: { sessionId: string; tabId: string }) => void) | null,
  pageMounts: 0,
  /** Every claim of the active Thread a pane beside the page made. */
  conversationClaims: [] as string[],
  drafts: null as ThreadDraftStore | null,
  /** Tabs besides the pages the snapshot's browsers list, such as apps and windows. */
  extraTabs: [] as Tab[],
  /** The Host has sent its whole tab list. */
  tabsComplete: true,
  /** What the Host's activation answers for a tab, when a test decides it. */
  activate: null as null | ((tabId: string) => Promise<TabViewer>),
  /** Told on every render, as the native stack tells a screen its focus changed. */
  focusListeners: new Set<() => void>(),
  focusEpoch: 0,
  popupFollow: null as {
    readonly tab: { readonly sessionId: string; readonly tabId: string } | null;
    readonly follow: (tabId: string) => void;
  } | null,
}));

vi.mock("@react-navigation/native", async () => {
  const { useSyncExternalStore } = await vi.importActual<typeof import("react")>("react");
  const subscribe = (listener: () => void) => {
    state.focusListeners.add(listener);
    return () => state.focusListeners.delete(listener);
  };
  return {
    StackActions: {
      pop: (count: number) => ({ type: "POP", count }),
      popTo: (name: string, params: object) => ({ name, params, type: "POP_TO" }),
      popToTop: () => ({ type: "POP_TO_TOP" }),
      push: (name: string, params: object) => ({ name, params, type: "PUSH" }),
      replace: (name: string, params: object) => ({ name, params, type: "REPLACE" }),
    },
    // Read through a store, so a memoized screen part hears focus change as it does natively.
    useIsFocused: () => {
      useSyncExternalStore(subscribe, () => state.focusEpoch);
      return state.focused;
    },
    // The page's own stack: a screen over it while it is not drawn, and Home
    // under it when a test opens it top-level, straight from the sidebar.
    useNavigationState: (select: (navigation: object) => unknown) => {
      const routes = [
        ...(state.topLevel ? [{ key: "home", name: "Home" }] : []),
        { key: "page", name: "WorkspaceBrowser" },
        ...(state.drawn ? [] : [{ key: "over", name: "Thread" }]),
      ];
      return select({ index: routes.length - 1, routes });
    },
    useRoute: () => ({ key: "page" }),
    useNavigation: () => ({
      canGoBack: () => true,
      dispatch: state.dispatch,
      getState: () => ({ key: "stack", index: state.routes.length - 1, routes: state.routes }),
      goBack: state.goBack,
      isFocused: () => state.navigationFocused,
      setOptions: state.setOptions,
      setParams: state.setParams,
    }),
  };
});
vi.mock("@react-navigation/elements", () => ({ useHeaderHeight: () => 88 }));
vi.mock("./external-agent-mark.js", () => ({ ExternalAgentMark: () => null }));
vi.mock("expo-haptics", () => ({
  ImpactFeedbackStyle: { Heavy: "heavy" },
  impactAsync: vi.fn(async () => undefined),
  NotificationFeedbackType: { Success: "success", Warning: "warning" },
  notificationAsync: vi.fn(async () => undefined),
}));
vi.mock("../client/mobile-client.js", () => ({
  operationDetail: (_error: unknown, fallback: string) => fallback,
}));
vi.mock("react-native-webview", () => ({
  WebView: (props: { source: { uri: string }; style: unknown; onError?: () => void }) => (
    <div
      data-style={JSON.stringify(flatten(props.style))}
      data-testid="app-webview"
      data-uri={props.source.uri}
    >
      <button onClick={props.onError}>Fail app load</button>
    </div>
  ),
}));
// The screen's own hooks run for real over the fake client; only the snapshot
// reads, the app view and the popup follow stand in.
vi.mock("@opensteer/client/react", async () => {
  const actual =
    await vi.importActual<typeof import("@opensteer/client/react")>("@opensteer/client/react");
  return {
    ...actual,
    useAppView: (...args: Parameters<typeof actual.useAppView>) =>
      state.realAppView
        ? actual.useAppView(...args)
        : {
            failed: false,
            retry: () => undefined,
            view: {
              app: { title: "Budget" },
              url: `https://host.test/v1/apps/${args[1]}/dark/token/`,
            },
          },
    useBrowserPopupFollow: (
      _client: unknown,
      tab: { sessionId: string; tabId: string } | null,
      follow: (tabId: string) => void,
    ) => {
      state.popupFollow = { tab, follow };
    },
    useHostSelector: (_client: unknown, selector: (snapshot: HostSnapshot) => unknown) =>
      selector(currentSnapshot()!),
    useHostSnapshot: () => ({
      snapshot: currentSnapshot(),
      loadError: null,
      reload: state.refresh,
    }),
    useBrowserTabAwake: () => true,
  };
});
vi.mock("../ui/mobile-client-context.js", () => ({
  useHostValue: () => 0,
  useMobileClient: () => ({ drafts: state.drafts }),
  useMobileState: () => ({
    selection: { deploymentId: state.deploymentId, hostClient: state.hostClient },
  }),
  useSelectedHostClient: () => null,
}));
vi.mock("../sidebar/sidebar-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sidebar/sidebar-context.js")>()),
  useSidebarControl: () => ({ close: vi.fn(), open: state.openSidebar }),
}));
vi.mock("../phone-browser/runtime.js", () => ({ usePhoneBrowserManager: () => null }));
vi.mock("react-native", () => ({
  PixelRatio: { get: () => 3 },
  AccessibilityInfo: { announceForAccessibility: vi.fn(async () => undefined) },
  ActivityIndicator: () => null,
  Alert: { alert: vi.fn() },
  Image: () => null,
  Linking: { openURL: vi.fn(async () => undefined) },
  Share: { share: vi.fn(async () => ({ action: "sharedAction" })) },
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => {} }) },
  I18nManager: { isRTL: false },
  KeyboardAvoidingView: ({
    accessibilityElementsHidden,
    children,
    enabled,
    importantForAccessibility,
    pointerEvents,
    style,
    testID,
  }: {
    accessibilityElementsHidden?: boolean;
    children?: ReactNode;
    enabled?: boolean;
    importantForAccessibility?: string;
    pointerEvents?: string;
    style?: unknown;
    testID?: string;
  }) => (
    <div
      aria-hidden={accessibilityElementsHidden === true || undefined}
      data-a11y={importantForAccessibility}
      data-pointer-events={pointerEvents}
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
  TextInput: Object.assign(
    ({
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
    { State: { currentlyFocusedInput: () => state.focusedInput } },
  ),
  StyleSheet: { create: (styles: object) => styles, flatten, hairlineWidth: 1 },
  useWindowDimensions: () => ({ fontScale: state.fontScale, height: 844, width: 390 }),
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
  useSafeAreaInsets: () => state.safeArea,
}));
vi.mock("../ui/keyboard.js", () => ({ useKeyboardVisible: () => state.keyboard }));
vi.mock("../ui/foreground.js", () => ({ useAppForeground: () => state.foreground }));
vi.mock(
  "../browser/toolbar.js",
  async () => (await import("../../test-support/native-chrome.js")).toolbar,
);
vi.mock("../ui/glass.js", async () => (await import("../../test-support/native-chrome.js")).glass);
vi.mock("react-native-gesture-handler", async () => ({
  ...(await import("../../test-support/native-chrome.js")).gestureHandler,
  usePinchGesture: (config: typeof state.pinch) => {
    state.pinch = config;
    return {};
  },
  // The address bar's sideways swipe between tabs.
  usePanGesture: (config: NonNullable<typeof state.swipe>) => {
    if ("failOffsetY" in config) state.swipe = config;
    return {};
  },
}));
vi.mock(
  "react-native-worklets",
  async () => (await import("../../test-support/native-chrome.js")).worklets,
);
vi.mock(
  "react-native-reanimated",
  async () => (await import("../../test-support/native-chrome.js")).reanimated,
);
vi.mock("../ui/motion.js", () => ({
  appear: undefined,
  duration: { enter: 0, exit: 0 },
  enter: undefined,
  exit: undefined,
  move: undefined,
}));
vi.mock("expo-clipboard", () => ({
  setStringAsync: vi.fn(async () => true),
  getStringAsync: vi.fn(async () => "clipboard"),
}));
vi.mock("../ui/sheet.js", () => ({
  Sheet: ({ children, title }: { children?: ReactNode; title: string }) => (
    <section aria-label={title}>{children}</section>
  ),
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
vi.mock("../voice/controls.js", () => ({ VoiceDock: () => null }));
vi.mock("../voice/use-voice-value.js", () => ({ useVoiceValue: () => false }));
vi.mock("../computers/here-device.js", () => ({ useHereDeviceId: () => state.hereId }));
vi.mock(
  "../ui/action-line.js",
  async () => (await import("../../test-support/tab-screen-mocks.js")).actionLine,
);
vi.mock(
  "../ui/connection-gate.js",
  async () => (await import("../../test-support/tab-screen-mocks.js")).connectionGate,
);
vi.mock(
  "../ui/route-gate.js",
  async () => (await import("../../test-support/tab-screen-mocks.js")).routeGate,
);
vi.mock(
  "../ui/placeholder.js",
  async () => (await import("../../test-support/tab-screen-mocks.js")).placeholder,
);
vi.mock("./deployment-gate.js", () => ({
  DeploymentGate: () => <p data-gate="deployment">Deployment gate</p>,
}));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("../ui/agent-orb.js", () => ({ AgentOrb: () => null }));
vi.mock("../ui/task-mark.js", () => ({ TaskMark: () => null }));
interface MenuOption {
  readonly disabled?: boolean;
  readonly selected?: boolean;
  readonly id: string;
  readonly label: string;
  readonly onPress: () => void;
}
vi.mock("../thread/composer-menu.js", () => ({
  NativeMenu: (props: {
    readonly accessibilityLabel: string;
    readonly title?: string;
    readonly options: readonly (MenuOption | readonly MenuOption[])[];
  }) => (
    <div aria-label={props.accessibilityLabel} data-menu-title={props.title}>
      {props.options.flat().map((option) => (
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
vi.mock("../../modules/remote-text-input/src/remote-text-input.js", () => ({
  RemoteTextInput: (props: {
    focused: boolean;
    softKeyboard: boolean;
    onEvent(event: { type: "blur" }): void;
  }) => (
    <div data-page-input data-focused={props.focused} data-soft-keyboard={props.softKeyboard}>
      <button onClick={() => props.onEvent({ type: "blur" })}>Release page keyboard</button>
    </div>
  ),
}));
vi.mock("../computers/phone-display-native.js", () => ({ nativePictureView: () => null }));
vi.mock("../browser/browser-stream.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../browser/browser-stream.js")>()),
  BrowserStream: ({
    onPresentedGeometry,
    onPointerDown,
    dragSelect,
    onDragEnd,
    session,
    active,
    onTap,
    tabId,
  }: {
    onPresentedGeometry?: (revision: number | null) => void;
    onPointerDown?: () => void;
    dragSelect?: boolean;
    onDragEnd?: () => void;
    session: BrowserSessionSummary;
    active: boolean;
    onTap?: () => void;
    tabId: string;
  }) => {
    useEffect(() => onPresentedGeometry?.(7), [onPresentedGeometry]);
    return (
      <PageProbe>
        <div
          data-drag-select={dragSelect}
          data-active={active}
          data-expected-surface={tabId ?? "current"}
        >
          Viewing {session.id}
          {/* Stands in for a tap the page took. */}
          <button
            onClick={() => {
              onPointerDown?.();
              onTap?.();
            }}
          >
            Tap the page
          </button>
          <button onClick={onPointerDown}>Contact the page</button>
          {dragSelect ? <button onClick={onDragEnd}>Finish selection</button> : null}
        </div>
      </PageProbe>
    );
  },
}));
vi.mock("../computers/phone-display.js", async () => {
  const { ToolbarAsk } =
    await vi.importActual<typeof import("../browser/place-bar.js")>("../browser/place-bar.js");
  return {
    ComputerDisplay: () => null,
    ComputerOwnerView: (props: { appKey: string | null; viewId: string; generation: number }) => (
      <div>
        {props.appKey === null ? "Phone" : `Mac app ${props.appKey}`} view {props.viewId}:
        {props.generation}
        <ToolbarAsk />
      </div>
    ),
  };
});
vi.mock("../thread/thread-pane.js", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  const { useContentInsets, usePaneInView } =
    await vi.importActual<typeof import("../ui/pane.js")>("../ui/pane.js");
  return {
    ThreadPane: (props: {
      threadId: string;
      onHeader?: (header: { title: string }) => void;
      withPage?: {
        page: { title: string } | null;
        showTab: ((tab: { sessionId: string; tabId: string }) => void) | null;
      };
    }) => {
      const insets = useContentInsets();
      const inView = usePaneInView();
      const { onHeader, threadId } = props;
      state.besideShowTab = props.withPage?.showTab ?? null;
      React.useEffect(() => {
        state.conversationMounts += 1;
      }, []);
      // As the real pane claims: only while its pane is in view.
      React.useEffect(() => {
        if (inView) state.conversationClaims.push(threadId);
      }, [inView, threadId]);
      // The bar's words for the Thread: here, its id.
      React.useEffect(() => onHeader?.({ title: threadId }), [onHeader, threadId]);
      return (
        <section
          data-in-view={inView}
          data-insets={JSON.stringify(insets)}
          data-testid="beside-thread"
        >
          {`Thread ${props.threadId} beside`}
          {props.withPage?.page ? ` with ${props.withPage.page.title}` : ""}
        </section>
      );
    },
  };
});
vi.mock("./thread-header.js", () => ({
  ThreadTitlePill: (props: {
    readonly extraActions?: readonly {
      readonly id: string;
      readonly label: string;
      readonly onPress: () => void;
    }[];
    readonly title: string;
  }) => (
    <div aria-label={`${props.title}. Actions`}>
      {props.extraActions?.map((action) => (
        <button key={action.id} onClick={action.onPress}>
          {action.label}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("./new-task.js", () => ({
  NewTaskPane: (props: { onStarted: (threadId: string) => boolean }) => (
    <section>
      New task beside
      <button onClick={() => props.onStarted("thread-started")}>Start the task</button>
    </section>
  ),
}));

const homeDraft = newTaskDraftKey(homeDraftId);

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
  state.realAppView = false;
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  state.snapshot = null;
  state.deploymentId = "deployment-a";
  state.focused = true;
  state.drawn = true;
  state.navigationFocused = true;
  state.refresh.mockClear();
  state.hostClient = {};
  state.dispatch.mockReset();
  state.goBack.mockReset();
  state.openSidebar.mockReset();
  state.topLevel = false;
  state.setOptions.mockReset();
  state.safeArea = { bottom: 0, left: 0, right: 0, top: 0 };
  state.setParams.mockReset();
  state.routes = [];
  state.pair = { height: 760, width: 390 };
  state.layout = null;
  state.regions = [];
  state.regionsReady = true;
  state.keyboard = false;
  state.foreground = true;
  state.hereId = null;
  state.focusedInput = null;
  state.fontScale = 1;
  state.conversationMounts = 0;
  state.besideShowTab = null;
  state.pageMounts = 0;
  state.conversationClaims = [];
  state.drafts = null;
  state.extraTabs = [];
  state.tabsComplete = true;
  state.activate = null;
  state.swipe = null;
  tabs = new TabStore();
  clientListeners.clear();
});

const agentHome = { computerId: "rnr_00000000-0000-4000-8000-000000000001", path: "/Users/alex" };
/** The computer every fixture tab is on. */
const studio = {
  computerId: DeviceIdSchema.parse("rnr_00000000-0000-4000-8000-00000000000a"),
  name: "Studio Mac",
};
const agentAt = "2026-10-13T00:00:00.000Z";
type Occupant = Partial<Omit<PlaceOccupant, "threadId">> & {
  readonly threadId: string;
};

/** One page of a fixture browser: its tab row, its viewer's surface, and who is in it. */
interface Page {
  readonly id: TabId;
  readonly title: string;
  readonly url: string;
  readonly occupants?: readonly Occupant[];
  readonly sizedByAgent?: boolean;
}
/** A browser session and the pages it holds, which become the Host's page tabs. */
type FixtureSession = BrowserSessionSummary & { readonly pages: readonly Page[] };
type PageInput = Omit<Page, "id"> & { readonly id: string };
const firstPage: PageInput = { id: "page-1", title: "Page", url: "https://example.com" };

function session(
  id: string,
  state: BrowserSessionSummary["state"] = "ready",
  pages: readonly PageInput[] = [firstPage],
): FixtureSession {
  return {
    access: "read-write",
    attachedRunIds: [],
    dialog: null,
    error: null,
    id,
    origin: "agent",
    placement: { kind: "runner", runnerId: "runner-a" },
    profileId: null,
    runtimeId: "runtime-a",
    state,
    viewerError: null,
    viewerState: "synchronized",
    pages: pages.map((page) => ({ ...page, id: TabIdSchema.parse(page.id) })),
  } as FixtureSession;
}

function snapshot(sessions: BrowserSessionSummary[]): HostSnapshot {
  return {
    assignments: {},
    browserPlacements: [],
    browserProfiles: [],
    activeTasks: [],
    browserSessions: sessions,
    browserUses: sessions.map((session) => ({
      sessionId: session.id,
      threadId: "thread-parent",
      runId: "run-parent",
      firstUsedAt: "2026-10-13T00:00:00.000Z",
      lastUsedAt: "2026-10-13T00:00:00.000Z",
    })),
    connection: "connected",
    deploymentShape: {},
    voiceThreadId: null,
    machines: [],
    network: "online",
    runQueue: [],
    session: "authenticated",
    tasks: null,
    threads: [],
    transcripts: {},
    user: { id: "user-a" },
    waitingRequests: [],
  } as unknown as HostSnapshot;
}

/** Every page the snapshot's browsers hold, with the browser holding it. */
function pagesOf(raw: HostSnapshot | null) {
  return (raw?.browserSessions ?? []).flatMap((held) =>
    ((held as Partial<FixtureSession>).pages ?? []).map((page) => ({ session: held, page })),
  );
}
function pageIn(sessionId: string, tabId: string): Page | undefined {
  return pagesOf(state.snapshot).find(
    (held) => held.session.id === sessionId && held.page.id === tabId,
  )?.page;
}

/** A page's tab row: who uses it, and when they were last there. */
function pageTab(page: Page): Tab {
  const occupants = page.occupants ?? [];
  const tab = tabFixture({
    tabId: page.id,
    title: page.title,
    url: page.url,
    computer: studio,
    updatedAt:
      occupants
        .map(({ lastActiveAt }) => lastActiveAt ?? agentAt)
        .sort()
        .at(-1) ?? agentAt,
  });
  // The fixture's task ids are words, not the Host's ids, so they skip its schema.
  const usedBy = [...new Set(occupants.map(({ threadId }) => threadId))]
    .sort()
    .map((taskId) => ({ taskId }));
  return { ...tab, usedBy } as unknown as Tab;
}
/** A Mac window or a phone the person opened as a tab. */
function nativeTab(phone: boolean, extra: Partial<Tab> = {}): Tab {
  return tabFixture({
    tabId: TabIdSchema.parse("tab_native"),
    computer: studio,
    ...(phone ? { kind: "phone", title: "Pixel" } : { kind: "window", title: "Notes" }),
    ...extra,
  });
}

/** The Host's one tab list on this device, kept up as each render's snapshot says. */
let tabs = new TabStore();
let tabsRevision = 0;
function syncTabs(): void {
  const listed = [
    ...new Map(
      [...pagesOf(state.snapshot).map(({ page }) => pageTab(page)), ...state.extraTabs].map(
        (tab) => [tab.tabId, tab],
      ),
    ).values(),
  ];
  const layout = {
    revision: ++tabsRevision,
    items: listed.map((tab) => ({ kind: "tab" as const, tabId: tab.tabId })),
  };
  tabs.replaceCurrent({ tabs: listed, layout, complete: state.tabsComplete });
}

const seededSnapshots = new WeakMap<object, HostSnapshot>();
function currentSnapshot(): HostSnapshot | null {
  const raw = state.snapshot;
  if (raw === null) return null;
  const held = seededSnapshots.get(raw);
  if (held) return held;
  const view = { ...raw, tabs } as HostSnapshot;
  seededSnapshots.set(raw, view);
  return view;
}

const nobodyActing: readonly PlaceActivity[] = [];
const activities = new WeakMap<object, Map<string, readonly PlaceActivity[]>>();
/** The Host's word for who acts in a tab now: its acting occupants. */
function placeActivity(tabId: string): readonly PlaceActivity[] {
  const raw = state.snapshot;
  if (raw === null) return nobodyActing;
  const held = activities.get(raw) ?? new Map<string, readonly PlaceActivity[]>();
  activities.set(raw, held);
  if (!held.has(tabId)) {
    const acting = pagesOf(raw)
      .filter(({ page }) => page.id === tabId)
      .flatMap(({ page }) => page.occupants ?? [])
      .filter(({ acting }) => acting === true)
      .map(({ threadId }) => ({ placeKey: tabId, threadId }) as unknown as PlaceActivity);
    held.set(tabId, acting.length ? acting : nobodyActing);
  }
  return held.get(tabId)!;
}

const surfaces = new WeakMap<Page, BrowserViewerSurface>();
/** The page as the viewer bound to its browser draws it; the same object while the page is. */
function viewerSurface(sessionId: string, tabId: string): BrowserViewerSurface | undefined {
  const page = pageIn(sessionId, tabId);
  if (page === undefined) return undefined;
  const held = surfaces.get(page);
  if (held) return held;
  const surface = {
    id: page.id,
    title: page.title,
    url: page.url,
    state: "live",
    documentId: `document-${page.id}`,
    geometryRevision: 1,
    loading: false,
    navigationFailed: false,
    sizedByAgent: page.sizedByAgent ?? false,
    favicon: null,
  } as unknown as BrowserViewerSurface;
  surfaces.set(page, surface);
  return surface;
}

const liveFeed = { status: "live", error: null, frame: null } as const;

/** Test route params: a tab's route, plus the browser a page test seeds it in. */
type TestRoute = Omit<Partial<TabRoute>, "tabId" | "threadId"> & {
  readonly sessionId?: string;
  readonly tabId?: string;
  /** Undefined says Tabs opened it: no conversation, not the default one. */
  readonly threadId?: string | undefined;
};

/** The Host's activation: a page in the browser listing it, an app as itself. */
async function activate(tabId: string): Promise<TabViewer> {
  if (state.activate) return state.activate(tabId);
  const tab = tabs.get(tabId);
  if (tab?.kind === "app") return { appId: tab.appId!, kind: "app" };
  const held = pagesOf(state.snapshot).find(({ page }) => page.id === tabId);
  const browser = held?.session ?? state.snapshot?.browserSessions[0];
  if (!browser) throw new Error("No browser holds this page.");
  return { kind: "page", sessionId: browser.id as never, surfaceId: tabId as TabId };
}
/** The Host's viewer for a Mac window or a phone, as its activation answers. */
function nativeViewer(phone: boolean, generation = 1): TabViewer {
  const view = {
    expiresAt: "2099-01-01T00:00:00.000Z",
    generation,
    machineId: "rnr_00000000-0000-4000-8000-00000000000a",
    state: "ready",
    unavailableReason: null,
    viewId: "owner-view",
    window: null,
    target: phone
      ? { kind: "phone", display: "main" }
      : {
          kind: "app",
          app: { bundleId: "com.apple.Notes", displayName: "Notes", teamId: null },
          windowId: "win_00000000-0000-4000-8000-000000000001",
        },
  };
  return (phone ? { kind: "phone", view } : { kind: "window", view }) as unknown as TabViewer;
}

/** Lets the Host's answers land: activation, and anything it started. */
async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await act(async () => undefined);
}

/** Who the fake client tells when the Host's snapshot changes. */
const clientListeners = new Set<() => void>();

async function setup(
  params: TestRoute = {},
  options: { strict?: boolean; snapshot?: HostSnapshot } = {},
) {
  state.hostClient.getSnapshot ??= currentSnapshot;
  const subscribe = (listener: () => void) => {
    clientListeners.add(listener);
    return () => clientListeners.delete(listener);
  };
  state.hostClient.subscribe ??= subscribe;
  Object.assign(
    state.hostClient,
    scopedTranscriptFixture(() => currentSnapshot()!, subscribe),
  );
  state.hostClient.connection ??= testHostConnection({
    getSnapshot: () =>
      ({
        ...(currentSnapshot() ?? {
          session: "checking",
          user: null,
          connection: "connecting",
          network: "unknown",
        }),
        deploymentId: state.deploymentId,
      }) as HostSnapshot,
    subscribe: (listener: () => void) => {
      clientListeners.add(listener);
      return () => clientListeners.delete(listener);
    },
  });
  state.hostClient.activateTab ??= vi.fn(activate);
  state.hostClient.browserViewerSurface ??= viewerSurface;
  state.hostClient.placeActivity ??= placeActivity;
  state.hostClient.subscribePlaceActivity ??= () => () => undefined;
  state.hostClient.runPlace ??= () => null;
  state.hostClient.subscribeRunPlace ??= () => () => undefined;
  state.hostClient.tabViewer ??= () => null;
  state.hostClient.getApp ??= async (appId: string) => {
    throw new Error(`No app ${appId}.`);
  };
  state.drafts ??= createThreadDraftStore({
    filePath: "/private/drafts.json",
    now: () => new Date("2026-10-13T00:00:00.000Z"),
    privateFiles: new MemoryPrivateFilesystem(),
  });
  state.hostClient.browserViewerState = () => liveFeed;
  state.hostClient.browserFrames ??= { subscribe: () => () => undefined };
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
    } as TestRoute,
  };
  const focus = () =>
    act(() => {
      state.focusEpoch += 1;
      for (const listener of state.focusListeners) listener();
    });
  const render = async () => {
    // As on a phone: what covers the page changes before the Host's next word arrives.
    focus();
    act(() => {
      syncTabs();
      for (const listener of clientListeners) listener();
    });
    act(() =>
      root.render(
        options.strict ? (
          <StrictMode>
            <WorkspaceBrowserScreen route={route as unknown as { params: TabRoute }} />
          </StrictMode>
        ) : (
          <WorkspaceBrowserScreen route={route as unknown as { params: TabRoute }} />
        ),
      ),
    );
    focus();
    await settle();
  };
  await render();
  return { container, render, route };
}

/** The page's own ⋯ menu, in its bar. */
function menu(): HTMLElement {
  const more = document.querySelector<HTMLElement>('[aria-label="More"]');
  if (more === null) throw new Error("The page has no menu.");
  return more;
}

/** Ask and who is here, on the place's own bar. */
function askMenu(): HTMLElement {
  const ask = document.querySelector<HTMLElement>('[aria-label="Ask"], [aria-label$=". Ask"]');
  if (ask === null) throw new Error("The place's bar has no Ask.");
  return ask;
}

/** The native bar as the screen last set it: a place with no bar of its own. */
function header(): HTMLElement {
  const options = state.setOptions.mock.calls
    .map(([value]) => value as { headerRight?: () => ReactNode; headerTitle?: () => ReactNode })
    .findLast((value) => typeof value.headerTitle === "function");
  if (!options?.headerTitle || !options.headerRight) throw new Error("The page set no bar.");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const { headerRight, headerTitle } = options;
  act(() =>
    root.render(
      <>
        {headerTitle()}
        {headerRight()}
      </>,
    ),
  );
  return container;
}

function mailSession(id: string): FixtureSession {
  return session(id, "ready", [
    {
      id: "srf_00000000-0000-4000-8000-000000000001",
      title: "Mail",
      url: "https://mail.example.com/inbox",
    },
  ]);
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

/** A browser whose one page holds these occupants, as a Host that names who is in a tab lists them. */
function occupied(id: string, occupants: readonly Occupant[], pageId = "page-1"): FixtureSession {
  return session(id, "ready", [
    {
      ...firstPage,
      id: pageId,
      occupants: occupants.map((occupant) => ({
        acting: false,
        holding: true,
        lastActiveAt: agentAt,
        ...occupant,
      })),
    },
  ]);
}

/** A snapshot whose directory holds the agents' Threads and Agent home. */
function withAgents(sessions: BrowserSessionSummary[]): HostSnapshot {
  return {
    ...snapshot(sessions),
    voiceThreadId: null,
    personalSettings: { agentHome: agentHome },
    threads: [
      { color: null, icon: null, id: "thread-agent", title: "Compare hotels" },
      { color: null, icon: null, id: "thread-trip", title: "Tokyo trip" },
    ],
  } as unknown as HostSnapshot;
}

function element(container: HTMLElement, label: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
}

/** Whether the native bar is shown, as the screen last set it. */
function headerShown(): boolean {
  const set = state.setOptions.mock.calls
    .map(([value]) => value as { headerShown?: boolean })
    .findLast((value) => value.headerShown !== undefined);
  return set?.headerShown ?? true;
}

/** Close, from the menu of the pill over the Thread beside the page. */
function closeBeside(container: HTMLElement, title: string) {
  const pill = element(container, `${title}. Actions`);
  if (pill === null) throw new Error(`No pill for ${title}.`);
  press(pill, "Close");
}

describe("mobile pages", () => {
  /** Two pages of one browser, listed in that order. */
  function twoPages(): HostSnapshot {
    return snapshot([
      session("chosen", "ready", [
        firstPage,
        { id: "page-2", title: "Next", url: "https://next.example.com" },
      ]),
    ]);
  }

  it("keeps a failed page on screen with its detail and no navigation", async () => {
    const { container, render } = await setup({ sessionId: "chosen" });
    state.snapshot = snapshot([
      { ...session("chosen", "failed"), error: "The computer disconnected." },
    ]);
    await render();
    expect(container.textContent).toContain("This page stopped working");
    expect(container.textContent).toContain("The computer disconnected.");
    expect(state.dispatch).not.toHaveBeenCalled();
    expect(state.goBack).not.toHaveBeenCalled();
  });

  it("keeps a closed exact page unavailable without activating a sibling", async () => {
    state.hostClient = { sendBrowserCommand: vi.fn() };
    const { container, render } = await setup({ sessionId: "chosen", tabId: "missing-page" });
    state.snapshot = snapshot([mailSession("chosen")]);
    await render();
    expect(container.textContent).toContain("This tab was closed");
    expect(container.textContent).not.toContain("View this browser");
    expect(state.dispatch).not.toHaveBeenCalled();
    expect(state.hostClient.sendBrowserCommand).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Back to tabs");
  });

  it("opens a popup the person's input opened over its page, ready to go back", async () => {
    const chosen = mailSession("chosen");
    const tabId = chosen.pages[0]!.id;
    const { render } = await setup({ sessionId: chosen.id, tabId });
    state.snapshot = snapshot([chosen]);
    await render();
    expect(state.popupFollow?.tab).toEqual({ sessionId: chosen.id, tabId });
    state.popupFollow?.follow("popup-tab");
    expect(state.dispatch).toHaveBeenLastCalledWith({
      type: "PUSH",
      name: "WorkspaceBrowser",
      params: {
        deploymentId: "deployment-a",
        popup: true,
        tabId: "popup-tab",
        threadId: "thread-parent",
      },
    });
  });

  it("leaves a followed popup that ended, to the page under it, once it is in front again", async () => {
    const { render } = await setup({ popup: true, sessionId: "chosen" }, { snapshot: twoPages() });
    state.focused = false;
    state.navigationFocused = false;
    state.snapshot = snapshot([mailSession("chosen")]);
    await render();
    expect(state.goBack).not.toHaveBeenCalled();
    state.focused = true;
    state.navigationFocused = true;
    await render();
    // A popup returns to the page that opened it, not to the tab beside it.
    expect(state.goBack).toHaveBeenCalledOnce();
    expect(state.setParams).not.toHaveBeenCalled();
  });

  it("views a linked inactive page without activating it and targets its navigation", async () => {
    const sendBrowserCommand = vi.fn();
    state.hostClient = {
      sendBrowserCommand,
      browserViewerState: () => liveFeed,
      browserFrames: { subscribe: () => () => undefined },
    };
    const chosen = mailSession("chosen");
    const target = "srf_00000000-0000-4000-8000-000000000002";
    const { container, render } = await setup({ sessionId: chosen.id, tabId: target });
    state.snapshot = snapshot([
      session(chosen.id, "ready", [
        ...chosen.pages,
        { ...chosen.pages[0]!, id: target, title: "Second page" },
      ]),
    ]);
    await render();
    expect(
      container.querySelector("[data-expected-surface]")?.getAttribute("data-expected-surface"),
    ).toBe(target);
    expect(sendBrowserCommand).not.toHaveBeenCalled();
    press(container, "Reload");
    expect(sendBrowserCommand).toHaveBeenCalledExactlyOnceWith(chosen.id, {
      type: "navigation.reload",
      surfaceId: target,
    });
  });

  it("says nothing of the connection when a page refuses a control, then says the page refused it", async () => {
    const sendBrowserCommand = vi.fn(() => {
      throw new Error("The targeted browser control is not synchronized.");
    });
    state.hostClient = { sendBrowserCommand };
    const chosen = mailSession("chosen");
    const { container, render } = await setup({
      sessionId: chosen.id,
      tabId: chosen.pages[0]!.id,
    });
    let feed: object = { ...liveFeed, admissionId: "admission-1" };
    state.hostClient.browserViewerState = () => feed;
    state.snapshot = snapshot([chosen]);
    await render();
    expect(() => press(container, "Reload")).not.toThrow();
    expect(container.textContent).not.toContain("reconnecting");
    expect(container.textContent).not.toContain("Page unavailable");
    feed = {
      ...liveFeed,
      admissionId: "admission-2",
      inputError: { code: "rejected", action: "send that to the page", done: "sent" },
    };
    await render();
    expect(container.textContent).toContain("Couldn't send that to the page.");
  });

  it("closes the page keyboard when the page refuses what was typed, and types afresh after", async () => {
    let refuse = false;
    const sendBrowserCommand = vi.fn(() => {
      if (refuse) throw new Error("The targeted browser control is not synchronized.");
    });
    state.hostClient = { sendBrowserCommand };
    const chosen = mailSession("chosen");
    const { container, render } = await setup({
      sessionId: chosen.id,
      tabId: chosen.pages[0]!.id,
    });
    state.snapshot = snapshot([chosen]);
    await render();
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
    const surfaceId = chosen.pages[0]!.id;
    expect(sendBrowserCommand.mock.calls).toEqual([
      [
        chosen.id,
        { type: "clipboard.paste", surfaceId, text: "saved", contextId: expect.any(String) },
      ],
      [chosen.id, { type: "clipboard.paste", surfaceId, text: "!", contextId: expect.any(String) }],
      [chosen.id, { type: "clipboard.paste", surfaceId, text: "x", contextId: expect.any(String) }],
    ]);
  });

  it("closes from the page's menu by taking the tab off the list, then shows the tab beside it", async () => {
    const closeTabs = vi.fn(async (tabIds: readonly string[]) => ({ closed: tabIds, failed: [] }));
    state.hostClient = { closeTabs };
    const { render } = await setup({ sessionId: "chosen" }, { snapshot: twoPages() });
    // An agent at work in the page is not asked about: closing never stops it.
    await pressAsync(menu(), "Close tab");
    expect(closeTabs).toHaveBeenCalledExactlyOnceWith(["page-1"]);
    state.snapshot = snapshot([
      session("chosen", "ready", [
        { id: "page-2", title: "Next", url: "https://next.example.com" },
      ]),
    ]);
    await render();
    expect(state.setParams).toHaveBeenCalledExactlyOnceWith({
      editAddress: false,
      popup: false,
      tabId: "page-2",
    });
    expect(state.goBack).not.toHaveBeenCalled();
  });

  it("lands on a tab still listed when its neighbour closed along with it", async () => {
    const third = { id: "page-3", title: "Third", url: "https://third.example.com" };
    const { render } = await setup(
      { sessionId: "chosen" },
      {
        snapshot: snapshot([
          session("chosen", "ready", [
            firstPage,
            { id: "page-2", title: "Next", url: "https://next.example.com" },
            third,
          ]),
        ]),
      },
    );
    // Another device closes this tab and the one after it at once.
    state.snapshot = snapshot([session("chosen", "ready", [third])]);
    await render();
    expect(state.setParams).toHaveBeenCalledExactlyOnceWith({
      editAddress: false,
      popup: false,
      tabId: "page-3",
    });
  });

  it("goes back when the closed tab had nothing beside it, and says nothing of a sibling", async () => {
    const { container, render } = await setup(
      { sessionId: "chosen" },
      { snapshot: snapshot([session("chosen")]) },
    );
    expect(container.textContent).toContain("Viewing chosen");
    state.snapshot = snapshot([mailSession("other")]);
    await render();
    expect(state.goBack).toHaveBeenCalledOnce();
    expect(state.setParams).not.toHaveBeenCalled();
  });

  it("keeps its selection by tabId through a catalog replacement, and asks the Host only once", async () => {
    const { container, render } = await setup({ sessionId: "chosen" }, { snapshot: twoPages() });
    state.tabsComplete = false;
    state.snapshot = snapshot([]);
    await render();
    expect(container.textContent).toContain("Opening…");
    state.tabsComplete = true;
    state.snapshot = twoPages();
    await render();
    expect(container.textContent).toContain("Viewing chosen");
    expect(state.setParams).not.toHaveBeenCalled();
    expect(state.goBack).not.toHaveBeenCalled();
    expect(state.hostClient.activateTab).toHaveBeenCalledOnce();
  });

  it("swipes to the next page of its browser in list order, and keeps it drawn while that opens", async () => {
    const { container, render, route } = await setup(
      { sessionId: "chosen" },
      { snapshot: twoPages() },
    );
    // The first page has nothing before it.
    act(() => state.swipe!.onDeactivate({ translationX: 200 }));
    expect(state.setParams).not.toHaveBeenCalled();
    act(() => state.swipe!.onDeactivate({ translationX: -200 }));
    expect(state.setParams).toHaveBeenCalledExactlyOnceWith({
      editAddress: false,
      popup: false,
      tabId: "page-2",
    });
    const opening = Promise.withResolvers<TabViewer>();
    state.activate = () => opening.promise;
    route.params = { ...route.params, tabId: "page-2" };
    await render();
    expect(container.textContent).not.toContain("Opening…");
    expect(container.textContent).toContain("Viewing chosen");
    await act(async () =>
      opening.resolve({ kind: "page", sessionId: "chosen" as never, surfaceId: "page-2" as TabId }),
    );
    expect(
      container.querySelector("[data-expected-surface]")?.getAttribute("data-expected-surface"),
    ).toBe("page-2");
  });

  it("stays on the page and explains a failed close", async () => {
    const closeTabs = vi.fn(async () => ({
      closed: [],
      failed: [{ tabId: "page-1", error: { code: "conflict", message: "Try again.", next: null } }],
    }));
    state.hostClient = { closeTabs };
    const { container } = await setup({ sessionId: "chosen" }, { snapshot: twoPages() });
    await pressAsync(menu(), "Close tab");
    // The Host's own sentence is never shown; the refusal is said in the app's words.
    expect(container.textContent).toContain("Couldn't close this tab.");
    expect(container.textContent).not.toContain("Try again.");
    expect(state.setParams).not.toHaveBeenCalled();
    expect(state.goBack).not.toHaveBeenCalled();
  });

  it("opens New tab in the page's own profile over the page, so Back returns to it", async () => {
    const openTab = vi.fn(async () => ({ tabId: "new-page" }));
    state.hostClient = { openTab };
    await setup({ sessionId: "chosen" }, { snapshot: twoPages() });
    state.dispatch.mockImplementation((action: { type: string; name: string; params: object }) => {
      if (action.type === "PUSH")
        state.routes.push({ key: "opening", name: action.name, params: action.params });
    });
    await pressAsync(menu(), "New tab");
    expect(openTab).toHaveBeenCalledExactlyOnceWith({
      computerId: "rnr_00000000-0000-4000-8000-00000000000a",
      guest: true,
      kind: "page",
      url: "about:blank",
    });
    expect(state.dispatch).toHaveBeenLastCalledWith({
      type: "REPLACE",
      source: "opening",
      target: "stack",
      name: "WorkspaceBrowser",
      params: { deploymentId: "deployment-a", tabId: "new-page", threadId: "thread-parent" },
    });
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
      retainBrowserViewer: () => () => undefined,
      rpc: {},
      sendBrowserCommand,
    };
    state.hostClient.browserViewerState = () => liveFeed;
    state.hostClient.browserFrames ??= { subscribe: () => () => undefined };
    const { container, render } = await setup({
      sessionId: "delegate",
      tabId: "srf_00000000-0000-4000-8000-000000000001",
    });
    state.snapshot = snapshot([mailSession("delegate")]);
    await render();
    // Not a permanent block under the page: it is asked for.
    expect(
      container
        .querySelector('[data-testid="browser-page"]')
        ?.textContent?.replace(menu().textContent ?? "", ""),
    ).not.toContain("Sign in with Chrome");

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
    state.hostClient.browserFrames ??= { subscribe: () => () => undefined };
    const { container, render } = await setup({
      sessionId: "delegate",
      tabId: "srf_00000000-0000-4000-8000-000000000001",
    });
    state.snapshot = snapshot([mailSession("delegate")]);
    await render();

    press(menu(), "Sign in with Chrome");
    // The site is remembered for the Workspace, which the action says before any tap.
    expect(container.textContent).toContain("Your agent will be able to use example.com as you.");
    await pressAsync(container, "Sign in with Chrome");
    expect(inspect).toHaveBeenCalledWith({ url: "https://mail.example.com/inbox" });
    expect(container.textContent).toContain("Choose the Chrome to use for example.com");

    await pressAsync(container, "Work Chrome");
    expect(dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ sourceId: "bsr_work", type: "browser.session.sign-in" }),
    );
    expect(container.textContent).toContain("Work Chrome is offline");
    expect(container.textContent).toContain("Open that browser on its computer.");
    expect(sendBrowserCommand).not.toHaveBeenCalled();
  });

  it("keeps an exact browser link when the session ends, and never shows another browser", async () => {
    const { container, render } = await setup({ sessionId: "chosen" });
    state.snapshot = snapshot([mailSession("other"), session("chosen")]);
    await render();
    expect(container.textContent).toContain("Viewing chosen");
    state.snapshot = snapshot([mailSession("other"), session("chosen", "closed")]);
    await render();
    expect(container.textContent).toContain("This page is asleep");
    expect(container.textContent).not.toContain("Viewing other");
    await pressAsync(container, "Open again");
    // Open again is the person's own Open.
    expect(state.hostClient.activateTab).toHaveBeenCalledTimes(2);
    expect(state.hostClient.activateTab).toHaveBeenLastCalledWith("page-1", { wake: true });
    expect(container.textContent).not.toContain("Viewing other");
    expect(state.dispatch).not.toHaveBeenCalled();
  });

  it("refreshes coming back into view, not out from under a sheet, and keeps the exact view while other browsers arrive", async () => {
    const { container, render } = await setup({ sessionId: "chosen" });
    expect(state.refresh).toHaveBeenCalledTimes(0);
    state.snapshot = snapshot([session("chosen"), session("new")]);
    await render();
    expect(container.textContent).toContain("Viewing chosen");
    expect(container.textContent).not.toContain("Viewing new");
    state.focused = false;
    await render();
    state.focused = true;
    await render();
    expect(state.refresh).toHaveBeenCalledTimes(0);
    state.focused = false;
    state.drawn = false;
    await render();
    state.focused = true;
    state.drawn = true;
    await render();
    expect(state.refresh).toHaveBeenCalledTimes(0);
  });

  it("gates another deployment and a signed-out viewer, showing neither the page", async () => {
    const { container, render } = await setup({ sessionId: "chosen" });
    state.snapshot = snapshot([session("chosen")]);
    state.deploymentId = "deployment-b";
    await render();
    expect(container.querySelector('[data-gate="deployment"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Viewing chosen");
    state.deploymentId = "deployment-a";
    state.snapshot = { ...state.snapshot, session: "authentication-required", user: null };
    await render();
    expect(container.querySelector('[data-gate="connection"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Viewing chosen");
  });
});

/*
 * Who is in the page, on its bar. What can go wrong: an agent is picked from
 * the route rather than the page's occupants; tapping the agent pushes a
 * second copy of the Thread already under the page; several agents are not
 * offered as a choice; an older Host's anonymous acting is dropped or made
 * tappable; Ask loses the page on its way to a new task; the route's
 * origin changes what the screen shows.
 */
describe("the page's bar", () => {
  const sessionId = "bsn_00000000-0000-4000-8000-0000000000aa";
  async function openPage(occupants: readonly Occupant[], params: Partial<TestRoute> = {}) {
    const opened = await setup({ sessionId, tabId: "page-1", ...params } as Partial<TestRoute>);
    state.snapshot = withAgents([occupied(sessionId, occupants)]);
    await opened.render();
    return opened;
  }

  it("opens the one agent's Thread, and goes back to it when it is the screen under the page", async () => {
    const { container } = await openPage([{ acting: true, threadId: "thread-trip" }]);
    expect(container.querySelector('[data-testid="conversation-slot"]')).toBeNull();
    press(askMenu(), "Tokyo trip · Working here");
    expect(state.dispatch).toHaveBeenCalledExactlyOnceWith({
      name: "Thread",
      params: { deploymentId: "deployment-a", threadId: "thread-trip" },
      type: "PUSH",
    });
    state.dispatch.mockClear();
    state.routes = [
      { name: "Home" },
      { name: "Thread", params: { deploymentId: "deployment-a", threadId: "thread-trip" } },
      { name: "WorkspaceBrowser", params: { sessionId, tabId: "page-1" } },
    ];
    press(askMenu(), "Tokyo trip · Working here");
    expect(state.goBack).toHaveBeenCalledOnce();
    expect(state.dispatch).not.toHaveBeenCalled();
  });

  it("offers several agents as a menu, working first, then most recent", async () => {
    await openPage([
      { lastActiveAt: "2026-10-13T00:05:00.000Z", threadId: "thread-trip" },
      { acting: true, lastActiveAt: "2026-10-13T00:01:00.000Z", threadId: "thread-agent" },
    ]);
    const ask = askMenu();
    expect(ask.getAttribute("aria-label")).toBe("2 agents, 1 working. Ask");
    expect([...ask.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "Compare hotels · Working here",
      "Tokyo trip · Idle",
      "New task",
    ]);
    press(ask, "Tokyo trip · Idle");
    expect(state.dispatch).toHaveBeenCalledExactlyOnceWith({
      name: "Thread",
      params: { deploymentId: "deployment-a", threadId: "thread-trip" },
      type: "PUSH",
    });
  });

  it("updates live occupants while keeping the companion after its agent departs", async () => {
    state.pair = { height: 1000, width: 744 };
    const { container, render } = await openPage([
      { acting: true, threadId: "thread-trip" },
      { threadId: "thread-agent" },
    ]);
    const agentRows = () =>
      [...menu().querySelectorAll("button")]
        .map((button) => button.textContent)
        .filter((words) => words?.includes(" · "));
    expect(agentRows()[0]).toContain("Tokyo trip");
    state.snapshot = withAgents([
      occupied(sessionId, [
        { threadId: "thread-trip" },
        { acting: true, threadId: "thread-agent" },
      ]),
    ]);
    await render();
    expect(agentRows()[0]).toContain("Compare hotels");
    expect(container.querySelector('[data-testid="conversation-slot"]')?.textContent).toContain(
      "Thread thread-trip beside",
    );
    state.snapshot = withAgents([occupied(sessionId, [])]);
    await render();
    expect(agentRows()).toEqual([]);
    expect(menu().textContent).toContain("New task");
    expect(container.querySelector('[data-testid="conversation-slot"]')?.textContent).toContain(
      "Thread thread-trip beside",
    );
    press(container, "Tabs, 1");
    expect(state.dispatch).toHaveBeenLastCalledWith({
      name: "BrowserTabs",
      params: { deploymentId: "deployment-a", tabId: "page-1", threadId: "thread-trip" },
      type: "PUSH",
    });
    closeBeside(container, "thread-trip");
    expect(container.querySelector('[data-testid="conversation-slot"]')).toBeNull();
    press(container, "Tabs, 1");
    expect(state.dispatch).toHaveBeenLastCalledWith({
      name: "BrowserTabs",
      params: { deploymentId: "deployment-a", tabId: "page-1" },
      type: "PUSH",
    });
  });

  it("pushes an agent deeper in the stack", async () => {
    await openPage([{ threadId: "thread-trip" }]);
    state.routes = [
      { name: "Thread", params: { threadId: "thread-trip" } },
      { name: "Thread", params: { threadId: "thread-agent" } },
      { name: "WorkspaceBrowser" },
    ];
    press(askMenu(), "Tokyo trip · Idle");
    expect(state.goBack).not.toHaveBeenCalled();
    expect(state.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "PUSH" }));
  });

  it("offers New task offline", async () => {
    const { render } = await openPage([]);
    state.snapshot = { ...state.snapshot!, network: "offline" };
    await render();
    const ask = askMenu();
    press(ask, "New task");
    expect(state.dispatch).toHaveBeenCalledWith({ type: "POP_TO_TOP" });
  });

  it("names nobody in an empty tab, and leaves Ask", async () => {
    const { container } = await openPage([]);
    expect(container.querySelector('[data-testid="page-toolbar"]')).not.toBeNull();
    // A streamed page keeps its bar standing; only a page on this phone floats one.
    expect(container.querySelector('[data-testid="local-page"]')).toBeNull();
    const ask = askMenu();
    expect(ask.getAttribute("aria-label")).toBe("Ask");
    expect([...ask.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "New task",
    ]);
  });

  it("asks in Home's new task with the page on its one draft, this reader's alone", async () => {
    await openPage([]);
    const ask = askMenu();
    expect(ask.dataset["menuTitle"]).toBe("Ask about this page");
    const page = {
      sessionId,
      tabId: "page-1",
      title: "Page",
      type: "browser-page",
      url: "https://example.com",
    };
    const drafts = state.drafts!;
    press(ask, "New task");
    expect(state.dispatch).toHaveBeenLastCalledWith({ type: "POP_TO_TOP" });
    expect(drafts.readDraft("deployment-a", "user-a", homeDraft)).toMatchObject({ page });
    // Whoever signs in next on this Deployment has drafts of their own.
    expect(drafts.readDraft("deployment-a", "user-b", homeDraft)).toBeNull();
  });

  it.each([false, true])(
    "Ask on a native surface includes no invented web page (phone: %s)",
    async (phone) => {
      state.extraTabs = [nativeTab(phone)];
      state.activate = async () => nativeViewer(phone);
      const opened = await setup({ tabId: "tab_native" });
      state.snapshot = withAgents([]);
      await opened.render();
      // A page an earlier Ask left on Home's draft does not stand for this one;
      // the words beside it stay.
      const earlier = BrowserPageContentPartSchema.parse({
        sessionId: "bsn_00000000-0000-4000-8000-0000000000aa",
        tabId: "page-1",
        title: "Earlier page",
        type: "browser-page",
        url: "https://example.com",
      });
      await act(async () => {
        await state.drafts!.writeDraft("deployment-a", "user-a", homeDraft, "Earlier words");
        await state.drafts!.writeDraftPage("deployment-a", "user-a", homeDraft, earlier);
      });
      press(askMenu(), "New task");
      expect(state.dispatch).toHaveBeenCalledWith({ type: "POP_TO_TOP" });
      await vi.waitFor(
        () =>
          expect(
            state.drafts!.readDraft("deployment-a", "user-a", homeDraft)?.page,
            "the earlier page never came off Home's draft",
          ).toBeUndefined(),
        { timeout: 2_000 },
      );
      expect(state.drafts!.readDraft("deployment-a", "user-a", homeDraft)?.text).toBe(
        "Earlier words",
      );
    },
  );

  it("shows the same page whichever way it was reached", async () => {
    const occupants = [{ acting: true, threadId: "thread-trip" }];
    const fromTask = await openPage(occupants, { threadId: "thread-agent" });
    const fromTabs = await openPage(occupants, {
      scope: "tabs",
      // A previous release's route from Tabs still named a conversation.
      threadId: "thread-agent",
    } as unknown as Partial<TestRoute>);
    expect(fromTabs.container.innerHTML).toBe(fromTask.container.innerHTML);
    // Who is here is the page's occupant, never the conversation the route names.
    expect(element(fromTabs.container, "Tokyo trip, working here. Ask")).not.toBeNull();
    expect(fromTabs.container.textContent).not.toContain("Compare hotels");
  });
});

/*
 * An Opensteer App as a tab. What can go wrong: the view address reaches the
 * route; there is no way to close it, or a failed close loses the tab; closing
 * stops its server; a tab closed elsewhere keeps running; the keyboard lifts
 * the wrong pane.
 */
describe("an app open as a tab", () => {
  const appId = "app_11111111-1111-4111-8111-111111111111" as Tab["appId"] & string;
  const budget = () =>
    tabFixture({
      tabId: TabIdSchema.parse("tab_budget"),
      kind: "app",
      appId,
      title: "Budget",
      computer: studio,
    });
  /** The app open as its tab; `taskId` is the conversation the app record says made it. */
  async function openApp(taskId: string | null = null) {
    const closeTabs = vi.fn(async (tabIds: readonly string[]) => ({ closed: tabIds, failed: [] }));
    const viewApp = vi.fn(async () => ({
      app: { title: "Budget" },
      url: `https://host.test/v1/apps/${appId}/dark/token/`,
    }));
    const getApp = vi.fn(async () => ({ appId, name: "Budget", taskId }) as unknown as App);
    const stopApp = vi.fn();
    state.hostClient = { closeTabs, getApp, stopApp, viewApp };
    state.extraTabs = [budget()];
    const opened = await setup({ tabId: "tab_budget" });
    state.snapshot = withAgents([]);
    await opened.render();
    return { ...opened, closeTabs, getApp, stopApp, viewApp };
  }
  const webView = () => document.querySelector("[data-testid='app-webview']");
  /** The app's menu, behind its name in the native bar. */
  const appMenu = () => {
    const pill = element(header(), "Budget. Actions");
    if (pill === null) throw new Error("The bar has no app menu.");
    return pill;
  };

  it("fills the page under its name in the native bar, with no bar of its own", async () => {
    await openApp();
    expect(state.setOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ headerTransparent: true, title: "Budget" }),
    );
    expect(JSON.parse(webView()!.getAttribute("data-style")!)).toMatchObject({ flex: 1 });
    expect(document.querySelector("[data-testid='page-toolbar']")).toBeNull();
    expect(webView()?.getAttribute("data-uri")).toContain(appId);
  });

  it("asks in and opens the conversation that made it, as its record says, and neither once that is gone", async () => {
    const { getApp, render } = await openApp("thread-app");
    const made = {
      name: "Thread",
      params: { deploymentId: "deployment-a", threadId: "thread-app" },
      type: "PUSH",
    };
    press(appMenu(), "Open its conversation");
    expect(state.dispatch).toHaveBeenLastCalledWith(made);
    state.dispatch.mockClear();
    press(appMenu(), "Ask about this app");
    expect(state.dispatch).toHaveBeenCalledExactlyOnceWith(made);
    // The conversation is deleted: the app's next record names none.
    getApp.mockResolvedValue({ appId, name: "Budget", taskId: null } as unknown as App);
    state.snapshot = { ...state.snapshot!, appsRevision: 1 } as HostSnapshot;
    await render();
    expect(appMenu().textContent).not.toContain("Open its conversation");
    expect(appMenu().textContent).not.toContain("Ask about this app");
    expect(appMenu().textContent).toContain("New task");
  });

  it("closes only its tab from the bar, never its server, and leaves once the list drops it", async () => {
    const { closeTabs, render, stopApp } = await openApp();
    await pressAsync(appMenu(), "Close tab");
    expect(closeTabs).toHaveBeenCalledExactlyOnceWith(["tab_budget"]);
    expect(stopApp).not.toHaveBeenCalled();
    state.extraTabs = [];
    state.snapshot = withAgents([]);
    await render();
    expect(state.goBack).toHaveBeenCalledOnce();
  });

  it("stays and explains a failed close, with the app back and a way to retry", async () => {
    const { container, closeTabs } = await openApp();
    closeTabs.mockRejectedValueOnce(new Error("The Host refused."));
    await pressAsync(appMenu(), "Close tab");
    expect(container.textContent).toContain("Couldn't confirm this tab closed.");
    expect(webView()).not.toBeNull();
    await pressAsync(container, "Try again");
    expect(closeTabs).toHaveBeenCalledTimes(2);
  });

  it("retries a failed app load from the tab's Reload menu", async () => {
    state.realAppView = true;
    const { container, viewApp } = await openApp();
    const first = webView();
    expect(first).not.toBeNull();
    await pressAsync(container, "Fail app load");
    expect(webView()).toBeNull();
    expect(container.textContent).toContain("Could not load this app");
    await pressAsync(appMenu(), "Reload");
    expect(viewApp).toHaveBeenCalledTimes(2);
    expect(webView()).not.toBeNull();
    expect(webView()).not.toBe(first);
  });

  it("destroys the WebView when another screen covers its app page", async () => {
    const { render } = await openApp();
    const first = webView();
    expect(first).not.toBeNull();
    state.focused = false;
    await render();
    expect(webView()).toBeNull();
    state.focused = true;
    await render();
    expect(webView()).not.toBeNull();
    expect(webView()).not.toBe(first);
  });

  it("keeps the WebView when the phone locks or another app comes forward", async () => {
    const { render } = await openApp();
    const first = webView();
    expect(first).not.toBeNull();
    state.foreground = false;
    await render();
    expect(webView()).toBe(first);
  });

  it("waits for the tab list before declaring a cold app route closed", async () => {
    state.tabsComplete = false;
    const { container } = await setup({ tabId: "tab_budget" }, { snapshot: withAgents([]) });
    expect(container.textContent).not.toContain("This tab was closed");
    expect(container.textContent).toContain("Opening…");
    expect(webView()).toBeNull();
  });

  it("lifts for a field in the app, but not for a composer beside it", async () => {
    state.pair = { height: 760, width: 1100 };
    const { render } = await openApp();
    const slot = () => document.querySelector("[data-testid='page-slot']")!;
    state.keyboard = true;
    await render();
    expect(slot().getAttribute("data-avoids")).toBe("true");
    state.focusedInput = {};
    state.keyboard = false;
    await render();
    state.keyboard = true;
    await render();
    expect(slot().getAttribute("data-avoids")).toBe("false");
  });
});

/*
 * Every kind by its tabId: a Mac window and a phone show exactly the owner view
 * the Host's activation answered, a closed tab offers Reopen and never a
 * sibling, and an unavailable one says why.
 */
describe("any kind of tab, by its tabId", () => {
  it.each([false, true])(
    "shows the exact owner view the Host opened for it (phone: %s)",
    async (phone) => {
      state.extraTabs = [nativeTab(phone)];
      state.activate = vi.fn(async () => nativeViewer(phone, 7));
      const { container, render } = await setup(
        { tabId: "tab_native" },
        { snapshot: withAgents([]) },
      );
      expect(container.textContent).toContain(
        `${phone ? "Phone" : "Mac app com.apple.notes"} view owner-view:7`,
      );
      // Only the person's Open may wake a phone: asking again on return to the foreground may not.
      expect(state.hostClient.activateTab).toHaveBeenCalledExactlyOnceWith("tab_native", {
        wake: true,
      });
      state.foreground = false;
      await render();
      state.foreground = true;
      await render();
      expect(state.hostClient.activateTab).toHaveBeenCalledTimes(2);
      expect(state.hostClient.activateTab).toHaveBeenLastCalledWith("tab_native", {
        wake: false,
      });
      expect(container.textContent).toContain("view owner-view:7");
    },
  );

  it("offers Reopen for a closed tab, and never shows another in its place", async () => {
    const reopenTab = vi.fn(async () => {
      state.extraTabs = [nativeTab(false)];
      state.snapshot = withAgents([session("other")]);
      return state.extraTabs[0]!;
    });
    state.hostClient = { reopenTab };
    state.activate = async () => nativeViewer(false);
    const { container, render } = await setup(
      { tabId: "tab_native" },
      { snapshot: withAgents([session("other")]) },
    );
    expect(container.textContent).toContain("This tab was closed");
    expect(container.textContent).not.toContain("Viewing other");
    expect(state.goBack).not.toHaveBeenCalled();
    await pressAsync(container, "Reopen");
    expect(reopenTab).toHaveBeenCalledExactlyOnceWith("tab_native");
    await render();
    expect(container.textContent).toContain("Mac app com.apple.notes view owner-view:1");
  });

  it.each([true, false])(
    "never wakes a phone that comes back on its own (open first: %s)",
    async (openFirst) => {
      const offline = nativeTab(true, {
        state: "unavailable",
        unavailableCode: "computer-offline",
        unavailableReason: "This phone is offline.",
      });
      state.extraTabs = [openFirst ? nativeTab(true) : offline];
      state.activate = vi.fn(async () => nativeViewer(true, 7));
      const { container, render } = await setup(
        { tabId: "tab_native" },
        { snapshot: withAgents([]) },
      );
      if (openFirst) {
        expect(state.hostClient.activateTab).toHaveBeenCalledExactlyOnceWith("tab_native", {
          wake: true,
        });
        // Its computer drops off and the viewer goes with it.
        state.extraTabs = [offline];
        await render();
      }
      expect(container.textContent).toContain("This phone is offline.");
      expect(container.textContent).not.toContain("Try again");
      state.extraTabs = [nativeTab(true)];
      await render();
      expect(container.textContent).toContain("Phone view owner-view:7");
      expect(state.hostClient.activateTab).toHaveBeenCalledTimes(openFirst ? 2 : 1);
      expect(state.hostClient.activateTab).toHaveBeenLastCalledWith("tab_native", {
        wake: false,
      });
    },
  );

  it("asks a paused phone again only when the person says so, and that may wake it", async () => {
    state.extraTabs = [
      nativeTab(true, {
        state: "unavailable",
        unavailableCode: "paused",
        unavailableReason: "This phone is paused.",
      }),
    ];
    state.activate = vi.fn(async () => {
      state.extraTabs = [nativeTab(true)];
      return nativeViewer(true, 2);
    });
    const { container, render } = await setup(
      { tabId: "tab_native" },
      { snapshot: withAgents([]) },
    );
    expect(container.textContent).toContain("This phone is paused.");
    expect(container.textContent).toContain("Close tab");
    expect(state.hostClient.activateTab).not.toHaveBeenCalled();
    await pressAsync(container, "Try again");
    expect(state.hostClient.activateTab).toHaveBeenCalledExactlyOnceWith("tab_native", {
      wake: true,
    });
    await render();
    expect(container.textContent).toContain("Phone view owner-view:2");
    expect(state.hostClient.activateTab).toHaveBeenLastCalledWith("tab_native", { wake: false });
  });

  it("says why an unavailable tab cannot open, and asks the Host nothing", async () => {
    state.extraTabs = [
      nativeTab(false, {
        state: "unavailable",
        unavailableCode: "window-closed",
        unavailableReason: "Window closed",
      }),
    ];
    const { container } = await setup({ tabId: "tab_native" }, { snapshot: withAgents([]) });
    expect(container.textContent).toContain("Window closed");
    expect(container.querySelector("button")?.textContent).toContain("Close tab");
    expect(state.hostClient.activateTab).not.toHaveBeenCalled();
  });
});

/*
 * A page beside its agent's Thread as the window changes shape. What can go
 * wrong: the page's live channel remounts; a geometry change navigates; the
 * keyboard lifts the pane nobody is typing in; tabletop's fixed halves leave
 * the composer no room once the keyboard is up; a fold that has not been
 * measured yet is straddled; a phone draws a second pane.
 */
describe("a page beside its agent's thread", () => {
  /** One live page with an acting agent, opened, with the address field open when asked. */
  async function openPage(editAddress = false, occupants?: readonly Occupant[]) {
    const opened = await setup({ editAddress, sessionId: "browser-child", tabId: "page-1" });
    state.snapshot = withAgents([
      occupied("browser-child", occupants ?? [{ acting: true, threadId: "thread-agent" }]),
    ]);
    await opened.render();
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

  const second = (container: HTMLElement) =>
    container.querySelector('[data-testid="conversation-slot"]')?.textContent ?? null;

  it("keeps the page mounted, and the agent's thread once beside it, shown only where two fit", async () => {
    const { container, render } = await openPage();
    expect(arrangement(container)).toBe("stacked");
    // A phone that has never had room for two never draws the thread.
    expect(second(container)).toBeNull();
    expect(state.conversationMounts).toBe(0);

    state.pair = { height: 1000, width: 744 };
    await render();
    expect(arrangement(container)).toBe("side");
    expect(second(container)).toContain("Thread thread-agent beside");

    state.pair = { height: 900, width: 900 };
    state.regions = [
      { frame: { height: 20, width: 900, x: 0, y: 420 }, kind: "division", occludesContent: false },
    ];
    await render();
    expect(arrangement(container)).toBe("tabletop");
    expect(slot(container, "page").style).toMatchObject({ height: 420 });

    state.pair = { height: 760, width: 390 };
    state.regions = [];
    await render();
    expect(arrangement(container)).toBe("stacked");
    // Too narrow for two, the thread stays mounted out of view, and inert.
    const hidden = container.querySelector<HTMLElement>('[data-testid="conversation-slot"]')!;
    expect(hidden.getAttribute("aria-hidden")).toBe("true");
    expect(hidden.dataset["a11y"]).toBe("no-hide-descendants");
    expect(hidden.dataset["pointerEvents"]).toBe("none");
    expect(hidden.dataset["avoids"]).toBe("false");
    expect(JSON.parse(hidden.dataset["style"]!)).toMatchObject({
      opacity: 0,
      position: "absolute",
    });
    expect(
      container.querySelector<HTMLElement>('[data-testid="beside-thread"]')?.dataset["inView"],
    ).toBe("false");
    const claims = state.conversationClaims.length;

    state.pair = { height: 1000, width: 744 };
    await render();
    expect(arrangement(container)).toBe("side");
    expect(second(container)).toContain("Thread thread-agent beside");
    expect(
      container.querySelector<HTMLElement>('[data-testid="beside-thread"]')?.dataset["inView"],
    ).toBe("true");
    expect(slot(container, "conversation").style).not.toHaveProperty("opacity");
    // Out of view it claimed nothing; back in view it claims its Thread again.
    expect(state.conversationClaims.slice(claims)).toEqual(["thread-agent"]);

    // Its draft, stream and scroll were never lost: it was never mounted again.
    expect(state.conversationMounts).toBe(1);
    expect(state.pageMounts).toBe(1);
    expect(state.dispatch).not.toHaveBeenCalled();
    expect(state.goBack).not.toHaveBeenCalled();
  });

  it("uses hysteresis at the pair boundary and collapses for large text without remounting the page", async () => {
    state.pair = { height: 1000, width: 744 };
    const { container, render } = await openPage();
    expect(arrangement(container)).toBe("side");
    state.pair = { height: 1000, width: 700 };
    await render();
    expect(arrangement(container)).toBe("side");
    state.fontScale = 2;
    await render();
    expect(arrangement(container)).toBe("stacked");
    state.fontScale = 1;
    await render();
    expect(arrangement(container)).toBe("stacked");
    state.pair = { height: 1000, width: 744 };
    await render();
    expect(arrangement(container)).toBe("side");
    expect(state.pageMounts).toBe(1);
  });

  it("chooses whose thread is beside the page from the page's own menu", async () => {
    state.pair = { height: 1000, width: 744 };
    const { container } = await openPage(false, [
      { lastActiveAt: "2026-10-13T00:05:00.000Z", threadId: "thread-trip" },
      { acting: true, threadId: "thread-agent" },
    ]);
    // The acting agent by default; nobody is pushed.
    expect(second(container)).toContain("Thread thread-agent beside");
    expect(menu().querySelector('button[aria-pressed="true"]')?.textContent).toBe(
      "Compare hotels · Working here",
    );
    press(menu(), "Tokyo trip · Idle");
    expect(second(container)).toContain("Thread thread-trip beside");
    expect(state.dispatch).not.toHaveBeenCalled();
    // Closing keeps the companion away even while an agent is still present.
    closeBeside(container, "thread-trip");
    expect(second(container)).toBeNull();
  });

  it("draws one bar with the way out, on a phone and beside a thread", async () => {
    const { container, render } = await openPage();
    expect(headerShown()).toBe(false);
    // Ask stands in a phone's bar; the way out is its one chevron, the page's history is in More.
    expect(askMenu().textContent).toContain("New task");
    expect(menu().textContent).not.toContain("New task");
    expect(element(container, "Previous page")).toBeNull();
    press(menu(), "Back");
    expect(state.goBack).not.toHaveBeenCalled();
    press(container, "Back");
    expect(state.goBack).toHaveBeenCalledOnce();

    state.pair = { height: 1000, width: 744 };
    await render();
    expect(headerShown()).toBe(false);
    // Beside a Thread, Ask is in More, and the row keeps the page's address room.
    expect(document.querySelector('[aria-label$=". Ask"]')).toBeNull();
    expect(menu().textContent).toContain("New task");
    press(container, "Back");
    expect(state.goBack).toHaveBeenCalledTimes(2);
  });

  it("leads with the Menu where the page was chosen from the sidebar, which has nothing to go back to", async () => {
    state.topLevel = true;
    const { container } = await openPage();
    expect(element(container, "Back")).toBeNull();
    press(container, "Menu");
    expect(state.openSidebar).toHaveBeenCalledOnce();
    expect(state.goBack).not.toHaveBeenCalled();
  });

  it("leaves Back and Ask to the vertical bar, with no row over the page, and only there", async () => {
    const lastOptions = () =>
      Object.assign({}, ...state.setOptions.mock.calls.map(([value]) => value as object)) as {
        readonly headerTitle: () => ReactNode;
        readonly headerTransparent: boolean;
        readonly unstable_headerRightItems: () => readonly { readonly label: string }[];
      };
    state.safeArea = { bottom: 34, left: 0, right: 84, top: 0 };
    const { container, render } = await openPage();
    expect(headerShown()).toBe(true);
    expect(lastOptions().headerTransparent).toBe(true);
    expect(lastOptions().headerTitle()).toBeNull();
    expect(
      lastOptions()
        .unstable_headerRightItems()
        .map(({ label }) => label),
    ).toEqual(["Ask"]);
    // Back here is the vertical bar's; the page's history stays in its own More.
    expect(element(container, "Back")).toBeNull();
    expect(document.querySelector('[aria-label="Ask"], [aria-label$=". Ask"]')).toBeNull();
    expect(menu().textContent).toContain("Back");

    // A notch insets both sides, and the page's own bar carries them again.
    state.safeArea = { bottom: 21, left: 59, right: 59, top: 0 };
    await render();
    expect(headerShown()).toBe(false);
    expect(lastOptions().headerTransparent).toBe(false);
    expect(element(container, "Back")).not.toBeNull();
    expect(askMenu()).not.toBeNull();
  });

  it("gives the native bar back when a tab has no page to draw, so it can still be left", async () => {
    const { container, render } = await openPage();
    expect(headerShown()).toBe(false);
    state.snapshot = withAgents([session("browser-child", "closed")]);
    await render();
    expect(container.textContent).toContain("This page is asleep");
    expect(container.querySelector('[data-testid="page-toolbar"]')).toBeNull();
    expect(headerShown()).toBe(true);
  });

  it("follows the agent in place, stops for the person, and picks up again from the live card", async () => {
    vi.useFakeTimers();
    try {
      state.pair = { height: 1000, width: 744 };
      const { container, render, route } = await openPage();
      const agentOn = (tabId: string) =>
        withAgents([
          session(
            "browser-child",
            "ready",
            ["page-1", "page-2"].map((id) => ({
              id,
              occupants:
                id === tabId
                  ? [{ acting: true, lastActiveAt: agentAt, threadId: "thread-agent" }]
                  : [],
              title: id === "page-1" ? "Page" : "Flights",
              url: "https://example.com",
            })),
          ),
        ]);
      const showTab = async (tabId: string) => {
        route.params = {
          deploymentId: "deployment-a",
          sessionId: "browser-child",
          tabId,
          threadId: "thread-parent",
        };
        await render();
      };
      state.snapshot = agentOn("page-1");
      await render();
      expect(element(container, "Address, example.com. Following the agent")).not.toBeNull();

      // The agent moves on; the page keeps up in place.
      state.snapshot = agentOn("page-2");
      await render();
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(state.setParams).toHaveBeenCalledExactlyOnceWith({
        editAddress: false,
        popup: false,
        tabId: "page-2",
      });
      await showTab("page-2");
      expect(element(container, "Address, example.com. Following the agent")).not.toBeNull();

      // The person goes back to the first tab: following stops, and the page stays theirs.
      state.setParams.mockClear();
      await showTab("page-1");
      expect(element(container, "Address, example.com")).not.toBeNull();
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(state.setParams).not.toHaveBeenCalled();

      // The conversation's live card shows the agent's tab in place, and following picks up there.
      act(() => state.besideShowTab?.({ sessionId: "browser-child", tabId: "page-2" }));
      expect(state.setParams).toHaveBeenCalledExactlyOnceWith({
        editAddress: false,
        popup: false,
        tabId: "page-2",
      });
      await showTab("page-2");
      expect(element(container, "Address, example.com. Following the agent")).not.toBeNull();
      expect(state.conversationMounts).toBe(1);

      // The tab sheet holds the page under it, and following catches up once it closes.
      state.setParams.mockClear();
      press(container, "Tabs, 2");
      state.focused = false;
      state.snapshot = agentOn("page-1");
      await render();
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(state.setParams).not.toHaveBeenCalled();
      state.focused = true;
      await render();
      expect(state.setParams).toHaveBeenCalledExactlyOnceWith({
        editAddress: false,
        popup: false,
        tabId: "page-1",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the automatic companion across in-place tab changes and departure, until closed", async () => {
    state.pair = { height: 1000, width: 744 };
    const { container, render, route } = await openPage();
    const mounts = state.conversationMounts;
    route.params = {
      deploymentId: "deployment-a",
      threadId: "thread-parent",
      sessionId: "other-browser",
      tabId: "page-1",
    };
    state.snapshot = withAgents([
      occupied("other-browser", [{ acting: true, threadId: "thread-trip" }]),
    ]);
    await render();
    expect(second(container)).toContain("Thread thread-agent beside");
    expect(state.conversationMounts).toBe(mounts);
    expect(menu().textContent).toContain("Tokyo trip · Working here");
    state.snapshot = withAgents([occupied("other-browser", [])]);
    await render();
    expect(second(container)).toContain("Thread thread-agent beside");
    closeBeside(container, "thread-agent");
    expect(second(container)).toBeNull();
    state.snapshot = withAgents([
      occupied("other-browser", [{ acting: true, threadId: "thread-trip" }]),
    ]);
    await render();
    expect(second(container)).toBeNull();
    press(askMenu(), "Tokyo trip · Working here");
    expect(second(container)).toContain("Thread thread-trip beside");
  });

  it("gives the page the whole surface with no agent, until Ask opens a new task beside it", async () => {
    state.pair = { height: 1000, width: 744 };
    const opened = await setup({
      sessionId: "bsn_00000000-0000-4000-8000-0000000000aa",
      tabId: "page-1",
    });
    state.snapshot = withAgents([occupied("bsn_00000000-0000-4000-8000-0000000000aa", [])]);
    await opened.render();
    const { container } = opened;
    expect(arrangement(container)).toBe("side");
    expect(second(container)).toBeNull();
    expect(slot(container, "page").style).toMatchObject({ flex: 1, minHeight: 0 });

    press(askMenu(), "New task");
    expect(second(container)).toContain("New task beside");
    // Beside the page is Home's own draft, not another one.
    expect(state.drafts!.readDraft("deployment-a", "user-a", homeDraft)?.page?.title).toBe("Page");
    press(container, "Start the task");
    expect(second(container)).toContain("Thread thread-started beside with Page");
    expect(state.dispatch).not.toHaveBeenCalled();
    closeBeside(container, "thread-started");
    expect(second(container)).toBeNull();
  });

  it("puts the bar away while typing into the page, and keeps it mounted", async () => {
    const { container, render } = await openPage(true);
    press(container, "Tap the page");
    press(container, "Keyboard");
    state.keyboard = true;
    await render();
    expect(container.querySelector('[data-testid="page-toolbar"]')).toBeNull();
    expect(container.querySelector('[data-testid="page-typing"]')).not.toBeNull();
    expect(state.pageMounts).toBe(1);
  });

  it("stays a single page until the pair's own surface is measured", async () => {
    state.regionsReady = false;
    state.pair = { height: 1000, width: 744 };
    const { container, render } = await openPage();
    expect(arrangement(container)).toBe("stacked");
    expect(second(container)).toBeNull();
    state.regionsReady = true;
    await render();
    expect(arrangement(container)).toBe("side");
    expect(state.conversationMounts).toBe(1);
  });

  it("lifts only the pane being typed in", async () => {
    state.pair = { height: 1000, width: 744 };
    // The address field is open, so the page is what the keyboard is for.
    const typingPage = await openPage(true);
    state.keyboard = true;
    await typingPage.render();
    expect(slot(typingPage.container, "page").avoids).toBe(true);
    expect(slot(typingPage.container, "conversation").avoids).toBe(false);

    // A page's own prompt takes the keyboard for its answer, as the address does.
    const prompted = await openPage();
    expect(slot(prompted.container, "page").avoids).toBe(false);
    const [browser] = state.snapshot!.browserSessions;
    state.snapshot = {
      ...state.snapshot!,
      browserSessions: [
        {
          ...browser!,
          dialog: { id: "dialog-1", message: "Your name?", surfaceId: "page-1", type: "prompt" },
        } as BrowserSessionSummary,
      ],
    };
    await prompted.render();
    expect(slot(prompted.container, "page").avoids).toBe(true);
    expect(slot(prompted.container, "conversation").avoids).toBe(false);
  });

  it("lifts the thread for its composer, and leaves the page where it is", async () => {
    state.pair = { height: 1000, width: 744 };
    state.keyboard = true;
    const { container } = await openPage();
    expect(slot(container, "page").avoids).toBe(false);
    expect(slot(container, "conversation").avoids).toBe(true);
  });

  it("gives up the page's half in tabletop when the composer needs the keyboard, and keeps both mounted", async () => {
    state.pair = { height: 900, width: 900 };
    state.regions = [
      { frame: { height: 20, width: 900, x: 0, y: 420 }, kind: "division", occludesContent: false },
    ];
    const { container, render } = await openPage();
    expect(slot(container, "page").style).toMatchObject({ height: 420 });
    state.keyboard = true;
    await render();
    const page = slot(container, "page").style;
    expect(page["height"]).toBeUndefined();
    expect(page).toMatchObject({ flexShrink: 1, maxHeight: 420, minHeight: 0 });
    expect(slot(container, "conversation").style).toMatchObject({ flexGrow: 1, flexShrink: 0 });
    expect(slot(container, "conversation").avoids).toBe(true);
    state.keyboard = false;
    await render();
    expect(slot(container, "page").style).toMatchObject({ height: 420 });
    expect(state.conversationMounts).toBe(1);
    expect(state.pageMounts).toBe(1);
  });
});

/*
 * The status row under a page opened from a conversation. What can go wrong:
 * it speaks for whichever agent ranks first in the tab rather than the
 * conversation the page was opened from; its Stop reaches another Run; opened
 * from Tabs, it offers no Stop for the agent at work there; it shows with
 * nothing to say; it repeats a
 * conversation already on screen beside the page; Answer answers anything
 * itself rather than returning to the conversation.
 */
describe("the status row", () => {
  const sessionId = "browser-child";

  /** The page, opened from `thread-agent`, with both agents in it and these at work. */
  async function openWatched(
    working: readonly string[],
    params: Partial<TestRoute> = { threadId: "thread-agent" },
    waiting: readonly string[] = [],
  ) {
    state.hostClient.stopRun = vi.fn(async () => undefined);
    const opened = await setup({ sessionId, tabId: "page-1", ...params } as Partial<TestRoute>);
    const base = withAgents([
      occupied(sessionId, [
        { acting: true, lastActiveAt: "2026-10-13T00:00:02.000Z", threadId: "thread-trip" },
        { threadId: "thread-agent" },
      ]),
    ]);
    state.snapshot = {
      ...base,
      runQueue: working.map((threadId) => ({
        createdAt: agentAt,
        id: `run-${threadId}`,
        runOrdinal: 1,
        status: "running",
        threadId,
      })),
      threads: base.threads.map((thread) => ({
        ...thread,
        role: "work",
        status: working.includes(thread.id) ? "running" : "idle",
      })),
      waitingRequests: waiting.map((threadId) => ({
        assignments: [],
        request: { id: `request-${threadId}`, originatingThreadId: threadId },
      })),
    } as unknown as HostSnapshot;
    await opened.render();
    return opened;
  }

  const row = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('[data-testid="place-status"]');

  it("speaks only for the conversation it was opened from, and stops that conversation's Run", async () => {
    const { container } = await openWatched(["thread-agent", "thread-trip"]);
    // Tokyo trip is acting and ranks first in the tab; the row is still Compare hotels'.
    expect(row(container)?.querySelector('[aria-label="Compare hotels: Working"]')).not.toBeNull();
    press(row(container)!, "Stop this run");
    expect(state.hostClient.stopRun).toHaveBeenCalledExactlyOnceWith("thread-agent");
  });

  it("speaks on a page opened from Tabs for the agent at work in it, with that task's own Stop", async () => {
    // Tabs names no conversation.
    const fromTabs = await openWatched(["thread-agent"], { threadId: undefined });
    // Tokyo trip ranks first but is idle; Compare hotels is the one at work here.
    expect(row(fromTabs.container)).not.toBeNull();
    expect(
      row(fromTabs.container)!.querySelector('[aria-label="Compare hotels: Working"]'),
    ).not.toBeNull();
    press(row(fromTabs.container)!, "Stop this run");
    expect(state.hostClient.stopRun).toHaveBeenCalledExactlyOnceWith("thread-agent");
    for (const root of roots.splice(0)) act(() => root.unmount());
    // Nobody at work and nothing waiting: nothing to say.
    const quiet = await openWatched([], { threadId: undefined });
    expect(row(quiet.container)).toBeNull();
  });

  it("says nothing while the conversation it was opened from has nothing to say", async () => {
    // Another agent at work in the tab is not this conversation at work.
    const idle = await openWatched(["thread-trip"]);
    expect(row(idle.container)).toBeNull();
  });

  it("says when the conversation needs the person, and Answer returns to it to answer there", async () => {
    const { container } = await openWatched([], { threadId: "thread-agent" }, ["thread-agent"]);
    expect(row(container)?.textContent).toContain("Needs you");
    expect(element(row(container)!, "Stop this run")).toBeNull();
    state.routes = [
      { name: "Home" },
      { name: "Thread", params: { deploymentId: "deployment-a", threadId: "thread-agent" } },
      { name: "WorkspaceBrowser", params: { sessionId, tabId: "page-1" } },
    ];
    press(row(container)!, "Answer");
    expect(state.goBack).toHaveBeenCalledOnce();
    expect(state.dispatch).not.toHaveBeenCalled();
  });

  it("keeps Stop beside Answer while the conversation's Run waits on the person", async () => {
    const { container } = await openWatched(["thread-agent"], { threadId: "thread-agent" }, [
      "thread-agent",
    ]);
    expect(row(container)?.textContent).toContain("Needs you");
    expect(element(row(container)!, "Answer")).not.toBeNull();
    press(row(container)!, "Stop this run");
    expect(state.hostClient.stopRun).toHaveBeenCalledExactlyOnceWith("thread-agent");
  });

  it("leaves the row out while its conversation is beside the page, and only then", async () => {
    state.pair = { height: 1000, width: 744 };
    const working = ["thread-trip", "thread-agent"];
    const { container } = await openWatched(working, { threadId: "thread-trip" });
    // Tokyo trip, first in the tab, is the conversation beside the page.
    expect(container.querySelector('[data-testid="beside-thread"]')?.textContent).toContain(
      "thread-trip",
    );
    expect(row(container)).toBeNull();
    for (const root of roots.splice(0)) act(() => root.unmount());
    // Opened from Compare hotels, whose conversation is not the one beside the page.
    const other = await openWatched(working);
    expect(row(other.container)).not.toBeNull();
  });
});

describe("a page and its agent's thread around what the system reserves", () => {
  async function openPage() {
    const opened = await setup({ sessionId: "browser-child", tabId: "page-1" });
    state.snapshot = withAgents([
      occupied("browser-child", [{ acting: true, threadId: "thread-agent" }]),
    ]);
    await opened.render();
    return opened;
  }
  function styleOf(container: HTMLElement, selector: string): Record<string, unknown> {
    const found = container.querySelector<HTMLElement>(selector);
    if (found === null) throw new Error(`Nothing matches ${selector}.`);
    return JSON.parse(found.dataset["style"] ?? "{}") as Record<string, unknown>;
  }
  const conversationInsets = (container: HTMLElement) =>
    JSON.parse(container.querySelector<HTMLElement>("[data-insets]")?.dataset["insets"] ?? "{}");

  it("keeps the page's own address, dialogs and picture clear of an obstruction over the page", async () => {
    state.pair = { height: 1000, width: 744 };
    state.regions = [{ frame: { height: 30, width: 30, x: 0, y: 300 }, kind: "occlusion" }];
    const { container } = await openPage();
    expect(styleOf(container, '[data-testid="page-content"]')).toMatchObject({
      paddingBottom: 0,
      paddingLeft: 30,
      paddingRight: 0,
      paddingTop: 0,
    });
  });

  it("keeps the stacked pair to one side of a fold it cannot split at", async () => {
    state.pair = { height: 900, width: 720 };
    state.regions = [
      { frame: { height: 900, width: 20, x: 350, y: 0 }, kind: "division", occludesContent: true },
    ];
    const { container } = await openPage();
    expect(styleOf(container, '[data-testid="pair-stacked"]')).toMatchObject({
      paddingBottom: 0,
      paddingEnd: 370,
      paddingStart: 0,
      paddingTop: 0,
    });
  });

  it("keeps a page with nobody beside it to one side of a hinge the pair would be split at", async () => {
    state.pair = { height: 900, width: 1000 };
    state.regions = [
      { frame: { height: 900, width: 20, x: 480, y: 0 }, kind: "division", occludesContent: true },
    ];
    const opened = await setup({ sessionId: "browser-child", tabId: "page-1" });
    state.snapshot = withAgents([occupied("browser-child", [])]);
    await opened.render();
    expect(opened.container.querySelector('[data-testid="conversation-slot"]')).toBeNull();
    // Room for two at the hinge, but alone the page takes the larger side of it whole.
    expect(styleOf(opened.container, '[data-testid="pair-side"]')).toMatchObject({
      paddingBottom: 0,
      paddingEnd: 0,
      paddingStart: 500,
      paddingTop: 0,
    });
  });

  it("clears an obstruction from where the conversation is while tabletop gives way to the keyboard", async () => {
    state.pair = { height: 900, width: 900 };
    state.regions = [
      { frame: { height: 20, width: 900, x: 0, y: 420 }, kind: "division", occludesContent: false },
      { frame: { height: 40, width: 40, x: 0, y: 430 }, kind: "occlusion" },
    ];
    const { container, render } = await openPage();
    // Below the fold the obstruction is at the conversation's top edge.
    expect(conversationInsets(container)).toMatchObject({ left: 0, top: 30 });
    // The composer types and the page gives up its half: the conversation is no
    // longer where the fold put it, so the obstruction is cleared from its side.
    state.keyboard = true;
    await render();
    expect(conversationInsets(container)).toMatchObject({ left: 40 });
  });
});

describe("native page layout and controls", () => {
  it("pins a wide page to the top and fits a tall page by height, centred", async () => {
    expect(pictureBox({ width: 400, height: 800 }, 2)).toEqual({
      width: 400,
      height: 200,
      left: 0,
    });
    expect(pictureBox({ width: 400, height: 800 }, 0.25)).toEqual({
      width: 200,
      height: 800,
      left: 100,
    });
  });

  it("offers Fit in the room a page leaves under or beside it, and never over the page", async () => {
    const room = { height: 560, width: 870 };
    // A page fitted by its height, with real gutters: the words fit beside it.
    expect(fitOffer(room, { height: 560, left: 165, width: 540 })).toEqual({
      place: "side",
      words: true,
    });
    // A narrower gutter holds only the glyph, and one too narrow for it offers nothing.
    expect(fitOffer(room, { height: 560, left: 80, width: 710 })).toEqual({
      place: "side",
      words: false,
    });
    expect(fitOffer({ height: 300, width: 300 }, { height: 300, left: 40, width: 220 })).toBeNull();
    // A sliver either way is not worth resizing a page for.
    expect(fitOffer(room, { height: 560, left: 20, width: 830 })).toBeNull();
    expect(fitOffer(room, { height: 520, left: 0, width: 870 })).toBeNull();
    expect(fitOffer(room, { height: 300, left: 0, width: 870 })).toEqual({
      place: "below",
      words: true,
    });
  });

  it("leaves a visible caret alone and clamps sliding to the page foot", async () => {
    expect(slideFor({ x: 0.5, y: 0.2, height: 0.02 }, 800, 400)).toBe(0);
    expect(slideFor({ x: 0.5, y: 0.95, height: 0.02 }, 800, 400)).toBe(-400);
    expect(slideFor({ x: 0.5, y: 0.9, height: 0.02 }, 200, 400)).toBe(0);
  });

  it("keeps the point under a pinch under the fingers as they spread and move, inside the page", async () => {
    const size = { height: 300, width: 400 };
    const start = { focalX: 200, focalY: 100, scale: 1, x: 0, y: 0 };
    // Spread in place: the page point under the fingers stays put.
    expect(pinched(start, { focalX: 200, focalY: 100, scale: 2 }, size)).toEqual({
      scale: 2,
      x: -200,
      y: -100,
    });
    // Spread and moved left together: the same point follows the fingers.
    expect(pinched(start, { focalX: 150, focalY: 100, scale: 2 }, size)).toEqual({
      scale: 2,
      x: -250,
      y: -100,
    });
    // A pinch begun already zoomed in measures from where the page is, not from its own size.
    expect(
      pinched(
        { ...start, scale: 2, x: -200, y: -100 },
        { focalX: 200, focalY: 100, scale: 1.5 },
        size,
      ),
    ).toEqual({ scale: 3, x: -400, y: -200 });
    // No gap ever opens at an edge, and it stops at its furthest zoom.
    // Fingers spread from the corner and dragged inward would pull the page off its corner.
    expect(
      pinched({ ...start, focalX: 0, focalY: 0 }, { focalX: 100, focalY: 50, scale: 10 }, size),
    ).toEqual({
      scale: 4,
      x: 0,
      y: 0,
    });
    expect(pinched(start, { focalX: 400, focalY: 300, scale: 1 }, size)).toEqual({
      scale: 1,
      x: 0,
      y: 0,
    });
  });

  async function open() {
    const send = vi.fn();
    state.hostClient = { sendBrowserCommand: send, browserPreferences: {} };
    const chosen = mailSession("chosen");
    const opened = await setup({
      sessionId: chosen.id,
      tabId: chosen.pages[0]!.id,
    });
    state.snapshot = snapshot([chosen]);
    await opened.render();
    return { ...opened, chosen, send };
  }

  function changeAddress(container: HTMLElement, text: string) {
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Website address"]');
    if (!input) throw new Error("Address editor did not open");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    return input;
  }

  it.each([
    ["coffee near me", "https://www.google.com/search?q=coffee%20near%20me"],
    ["example.org", "https://example.org/"],
  ])("navigates %s from the address editor", async (text, url) => {
    const { container, chosen, send } = await open();
    press(container, "Address, mail.example.com");
    const input = changeAddress(container, text);
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(send).toHaveBeenCalledExactlyOnceWith(chosen.id, {
      type: "navigation.go",
      surfaceId: chosen.pages[0]!.id,
      typed: true,
      url,
    });
  });

  it("cancels a draft address and switches a suggested tab in the page route", async () => {
    const { container, chosen, render, send } = await open();
    const other = {
      id: "srf_00000000-0000-4000-8000-000000000002",
      title: "Other",
      url: "https://other.example",
    };
    state.snapshot = snapshot([session(chosen.id, "ready", [...chosen.pages, other])]);
    await render();
    press(container, "Address, mail.example.com");
    changeAddress(container, "discard this");
    press(container, "Cancel");
    press(container, "Address, mail.example.com");
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="Website address"]')?.value,
    ).toBe(chosen.pages[0]!.url);
    changeAddress(container, "Other");
    press(container, "Other, other.example");
    expect(state.setParams).toHaveBeenCalledExactlyOnceWith({
      editAddress: false,
      popup: false,
      tabId: other.id,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("offers Fit only for a wide band outside address editing and fits the stage", async () => {
    state.layout = { width: 400, height: 800 };
    const { container, send, chosen, render } = await open();
    expect(element(container, "Fit to screen")).not.toBeNull();
    press(container, "Fit to screen");
    expect(send).toHaveBeenCalledExactlyOnceWith(chosen.id, {
      type: "viewport.set",
      surfaceId: chosen.pages[0]!.id,
      width: 400,
      height: 800,
    });
    press(container, "Address, mail.example.com");
    expect(element(container, "Fit to screen")).toBeNull();
    press(container, "Cancel");
    state.layout = { width: 400, height: 225 };
    await render();
    expect(element(container, "Fit to screen")).toBeNull();
  });

  it("takes Fit away while a pinched page may reach into the room it stands in", async () => {
    state.layout = { width: 400, height: 800 };
    const { container } = await open();
    expect(element(container, "Fit to screen")).not.toBeNull();
    const at = { focalX: 100, focalY: 100 };
    act(() => state.pinch!.onActivate(at));
    expect(element(container, "Fit to screen")).toBeNull();
    act(() => state.pinch!.onUpdate({ ...at, scale: 2 }));
    act(() => state.pinch!.onDeactivate());
    expect(element(container, "Fit to screen")).toBeNull();
    // Pinched back to its own size, the room is free again.
    act(() => state.pinch!.onActivate(at));
    act(() => state.pinch!.onUpdate({ ...at, scale: 0.5 }));
    act(() => state.pinch!.onDeactivate());
    expect(element(container, "Fit to screen")).not.toBeNull();
  });

  it("asks before fitting an agent-sized page, cancels without sending, and applies on Fit", async () => {
    vi.mocked(Alert.alert).mockClear();
    state.layout = { width: 400, height: 800 };
    const { container, send, chosen, render } = await open();
    state.snapshot = snapshot([
      session(chosen.id, "ready", [{ ...chosen.pages[0]!, sizedByAgent: true }]),
    ]);
    await render();
    press(container, "Fit to screen");
    const buttons = vi.mocked(Alert.alert).mock.calls.at(-1)?.[2];
    expect(buttons?.map(({ text }) => text)).toEqual(["Cancel", "Fit"]);
    act(() => {
      buttons?.[0]?.onPress?.();
    });
    expect(send).not.toHaveBeenCalled();
    act(() => {
      buttons?.[1]?.onPress?.();
    });
    expect(send).toHaveBeenCalledExactlyOnceWith(chosen.id, {
      type: "viewport.set",
      surfaceId: chosen.pages[0]!.id,
      width: 400,
      height: 800,
    });
  });

  // A page's viewer does not say whether history exists, so Back and Forward are always offered.
  it("offers the page's history in More on a phone, and beside the address where it is wide", async () => {
    const { container, chosen, send, render } = await open();
    const item = (label: string) =>
      [...menu().querySelectorAll("button")].find((button) => button.textContent === label);
    // A phone's address keeps its room: the page's history is in More, beside Forward.
    expect(element(container, "Previous page")).toBeNull();
    expect(item("Back")?.disabled).toBe(false);
    expect(item("Forward")?.disabled).toBe(false);
    press(menu(), "Back");
    press(menu(), "Forward");
    expect(send.mock.calls).toEqual([
      [chosen.id, { type: "navigation.back", surfaceId: chosen.pages[0]!.id }],
      [chosen.id, { type: "navigation.forward", surfaceId: chosen.pages[0]!.id }],
    ]);

    // Where the page is wide, Back and Forward stand beside the address, as Safari's do on iPad.
    state.layout = { height: 900, width: 700 };
    await render();
    expect(item("Back")).toBeUndefined();
    expect(item("Forward")).toBeUndefined();
    press(container, "Previous page");
    press(container, "Next page");
    expect(send).toHaveBeenCalledTimes(4);
  });

  it("keeps page hardware focus without a field and hands focus to app controls", async () => {
    const editing = new BrowserEditingStore(vi.fn());
    editing.negotiate("chosen", 1);
    state.hostClient = { browserFrames: { editing, subscribe: () => () => undefined } };
    const chosen = mailSession("chosen");
    const { container, render } = await setup({
      sessionId: chosen.id,
      tabId: chosen.pages[0]!.id,
    });
    state.snapshot = snapshot([chosen]);
    await act(async () => await render());
    const input = () => container.querySelector<HTMLElement>("[data-page-input]");
    expect(input()?.dataset.focused).toBe("true");
    expect(input()?.dataset.softKeyboard).toBe("false");
    expect(container.querySelector('[data-testid="page-typing"]')).toBeNull();
    press(container, "Release page keyboard");
    expect(input()?.dataset.focused).toBe("false");
    press(container, "Drag/select");
    press(container, "Contact the page");
    expect(input()?.dataset.focused).toBe("true");
    expect(input()?.dataset.softKeyboard).toBe("false");
    press(container, "Finish selection");
    press(container, "Release page keyboard");
    expect(input()?.dataset.focused).toBe("false");
    press(container, "Tap the page");
    expect(input()?.dataset.focused).toBe("true");
    act(() =>
      editing.receive(chosen.id, {
        type: "browser.editing",
        surfaceId: chosen.pages[0]!.id,
        context: {
          contextId: "00000000-0000-4000-8000-000000000001",
          field: { kind: "text", multiline: false, sensitive: false },
          caret: null,
        },
      }),
    );
    expect(input()?.dataset.softKeyboard).toBe("true");
    press(container, "Done");
    expect(input()?.dataset.focused).toBe("true");
    expect(input()?.dataset.softKeyboard).toBe("false");
    state.focused = false;
    await render();
    expect(input()).toBeNull();
  });

  it("opens the keyboard after a tapped negotiated page reports a field", async () => {
    const editing = new BrowserEditingStore(vi.fn());
    editing.negotiate("chosen", 1);
    state.hostClient = { browserFrames: { editing, subscribe: () => () => undefined } };
    const chosen = mailSession("chosen");
    const { container, render } = await setup({
      sessionId: chosen.id,
      tabId: chosen.pages[0]!.id,
    });
    state.snapshot = snapshot([chosen]);
    await render();
    press(container, "Tap the page");
    expect(element(container, "Keyboard")).toBeNull();
    expect(container.querySelector('[data-testid="page-typing"]')).toBeNull();
    act(() =>
      editing.receive(chosen.id, {
        type: "browser.editing",
        surfaceId: chosen.pages[0]!.id,
        context: {
          contextId: "00000000-0000-4000-8000-000000000001",
          field: { kind: "text", multiline: false, sensitive: false },
          caret: null,
        },
      }),
    );
    expect(container.querySelector('[data-testid="page-typing"]')).not.toBeNull();
    expect(element(container, "Keyboard")).toBeNull();
  });
});

it("opens controller page actions only from matching streamed facts and offers one-shot Drag/select", async () => {
  const wire = vi.fn();
  const editing = new BrowserEditingStore(wire);
  editing.negotiate("chosen", 1);
  state.hostClient = {
    sendBrowserCommand: vi.fn(),
    browserFrames: { editing, subscribe: () => () => undefined },
  };
  const chosen = mailSession("chosen");
  const surfaceId = chosen.pages[0]!.id;
  const { container, render } = await setup({ sessionId: chosen.id, tabId: surfaceId });
  state.snapshot = snapshot([chosen]);
  await render();
  expect(container.querySelector('section[aria-label="Page actions"]')).toBeNull();
  press(container, "Drag/select");
  expect(container.querySelector('[data-drag-select="true"]')).not.toBeNull();
  press(container, "Finish selection");
  expect(container.querySelector('[data-drag-select="true"]')).toBeNull();
  // The page's context, with no field focused: a page publishes one from the start.
  const contextId = "00000000-0000-4000-8000-000000000002";
  act(() =>
    editing.receive(chosen.id, {
      type: "browser.editing",
      surfaceId,
      context: { contextId, field: null, caret: null },
    }),
  );
  const menu = {
    type: "browser.contextmenu" as const,
    surfaceId,
    editable: false,
    selection: false,
    x: 0.5,
    y: 0.5,
  };
  act(() => editing.receive(chosen.id, { ...menu, geometryRevision: 6 }));
  expect(container.querySelector('section[aria-label="Page actions"]')).toBeNull();
  act(() => editing.receive(chosen.id, { ...menu, geometryRevision: 7 }));
  expect(container.querySelector('section[aria-label="Page actions"]')).not.toBeNull();
  press(container, "Select all");
  expect(wire).toHaveBeenCalledWith(chosen.id, surfaceId, {
    type: "input.command",
    surfaceId,
    command: "selectAll",
    contextId,
  });
  expect(container.querySelector('section[aria-label="Page actions"]')).toBeNull();
  act(() => editing.receive(chosen.id, { ...menu, geometryRevision: 7 }));
  press(container, "Reload");
  expect(container.querySelector('section[aria-label="Page actions"]')).toBeNull();
});

it("fences a menu clipboard read when another page contact changes its destination", async () => {
  const wire = vi.fn();
  const editing = new BrowserEditingStore(wire);
  editing.negotiate("chosen", 2);
  state.hostClient = { browserFrames: { editing, subscribe: () => () => undefined } };
  const chosen = mailSession("chosen");
  const surfaceId = chosen.pages[0]!.id;
  const { container, render } = await setup({ sessionId: chosen.id, tabId: surfaceId });
  state.snapshot = snapshot([chosen]);
  await render();
  // The page's own context, as a page publishes one from the start: what its paste is made for.
  act(() =>
    editing.receive(chosen.id, {
      type: "browser.editing",
      surfaceId,
      context: {
        contextId: "00000000-0000-4000-8000-000000000003",
        field: { kind: "text", multiline: false, sensitive: false },
        caret: null,
      },
    }),
  );
  const menu = () =>
    act(() =>
      editing.receive(chosen.id, {
        type: "browser.contextmenu",
        surfaceId,
        geometryRevision: 7,
        editable: true,
        selection: false,
        x: 0.5,
        y: 0.5,
      }),
    );
  const read = Promise.withResolvers<string>();
  vi.mocked(Clipboard.getStringAsync).mockReturnValueOnce(read.promise);
  menu();
  press(container, "Paste");
  press(container, "Tap the page");
  await act(async () => {
    read.resolve("wrong destination");
    await read.promise;
  });
  expect(wire).not.toHaveBeenCalled();
  menu();
  await pressAsync(container, "Paste");
  expect(wire).toHaveBeenCalledExactlyOnceWith(chosen.id, surfaceId, {
    type: "clipboard.paste",
    surfaceId,
    text: "clipboard",
    contextId: "00000000-0000-4000-8000-000000000003",
  });
});

vi.mock("../report-mail.js", () => ({ contactSupport: vi.fn() }));

describe("a Cloud Computer's browser", () => {
  /** What the Home reports about the browser holding the first page. */
  function pooled(scene: Parameters<typeof mockBrowserPoolReport>[0]): HostSnapshot {
    const raw = snapshot([session("chosen")]);
    const tab = tabs.get(TabIdSchema.parse(firstPage.id));
    if (tab?.kind !== "page") throw new Error("The first page is not listed");
    return {
      ...raw,
      browserPools: [mockBrowserPoolReport(scene, tab.computer.computerId, firstPage.id)],
    } as HostSnapshot;
  }
  const lastAlert = () => vi.mocked(Alert.alert).mock.calls.at(-1);

  it("stands in for its page when it could not start, tabs and sign-ins kept", async () => {
    vi.mocked(Alert.alert).mockClear();
    const { container, render } = await setup({ sessionId: "chosen" });
    // The page is listed first, as a Home lists it before reporting its browser.
    state.snapshot = snapshot([session("chosen")]);
    await render();
    state.snapshot = pooled("failed");
    await render();
    expect(container.textContent).toContain("Your browser couldn’t start");
    expect(container.textContent).toContain(
      "Your tabs and sign-ins are kept. Try again in a moment.",
    );
    expect(container.textContent).not.toContain("Contact support");
    await pressAsync(container, "Try again");
    expect(lastAlert()?.slice(0, 2)).toEqual([
      "Your browser couldn’t start",
      "Your Cloud Computer can’t restart its browser yet. Nothing was changed.",
    ]);
    state.snapshot = pooled("failed-again");
    await render();
    expect(container.textContent).toContain(
      "Your tabs and sign-ins are kept. If this keeps happening, contact support.",
    );
    expect(container.textContent).toContain("Contact support");
  });

  it("offers Restart browser in More, asks once with exactly what it does, and is refused plainly", async () => {
    vi.mocked(Alert.alert).mockClear();
    const { container, render } = await setup({ sessionId: "chosen" });
    state.snapshot = snapshot([session("chosen")]);
    await render();
    expect(menu().textContent).not.toContain("Restart browser");
    state.snapshot = pooled("awake");
    await render();
    await pressAsync(menu(), "Restart browser");
    const [title, body, buttons] = lastAlert() ?? [];
    expect([title, body]).toEqual([
      "Restart browser?",
      "Every page in your Cloud Computer’s browser closes and opens again from its address. Your tabs and sign-ins stay. Anything typed and not sent may be lost.",
    ]);
    expect(buttons?.map(({ text, style }) => [text, style])).toEqual([
      ["Cancel", "cancel"],
      ["Restart browser", "destructive"],
    ]);
    await act(async () => buttons?.[1]?.onPress?.());
    expect(lastAlert()?.slice(0, 2)).toEqual([
      "Couldn’t restart your browser",
      "Your Cloud Computer can’t restart its browser yet. Nothing was changed.",
    ]);
    expect(container.textContent).not.toContain("Restarting");
  });

  it("says once that a page reloaded, and the note leaves when dismissed", async () => {
    const { container, render } = await setup({ sessionId: "chosen" });
    // The page is listed first, as a Home lists it before reporting its browser.
    state.snapshot = snapshot([session("chosen")]);
    await render();
    state.snapshot = pooled("reloaded-typed");
    await render();
    expect(container.textContent).toContain("This page reloaded");
    expect(container.textContent).toContain(
      "Your browser restarted, so text you hadn’t sent may be gone.",
    );
    await pressAsync(container, "Dismiss");
    expect(container.textContent).not.toContain("This page reloaded");
  });

  it("tells a page that could not be restored apart from one that reloaded", async () => {
    const { container, render } = await setup({ sessionId: "chosen" });
    // The page is listed first, as a Home lists it before reporting its browser.
    state.snapshot = snapshot([session("chosen")]);
    await render();
    state.snapshot = pooled("lost");
    await render();
    expect(container.textContent).toContain("This page couldn’t be restored");
    expect(container.textContent).toContain(
      "It didn’t come back as you left it. Reload to open it again.",
    );
  });
});
