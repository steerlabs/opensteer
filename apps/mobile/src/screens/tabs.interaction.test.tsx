// @vitest-environment happy-dom
import { withTimeout } from "@opensteer/shared/withTimeout";

import { DictationController } from "@opensteer/client/dictation";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  placeHasAgents,
  placeList,
  type HostClient,
  type HostSnapshot,
} from "@opensteer/client/host";
import { MockHostClient, mockBrowserSignInRequest } from "@opensteer/client/mock";
import { MemoryPrivateFilesystem } from "@opensteer/client/test-support";
import {
  act,
  createContext,
  useContext,
  useSyncExternalStore,
  type ReactNode,
  type Ref,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { useScopedThreadHeader, useThreadHeader } from "./thread-header.js";
import type { MobileClient } from "../client/mobile-client.js";
import { createThreadDraftStore, type ThreadDraftStore } from "../client/thread-drafts.js";

/*
 * Mobile Tabs, driven the way a person drives them: the real sidebar, the real
 * Tabs, task and page screens and the real conversation pane, over the real
 * MockHostClient, inside a small stand-in for the native stack that applies
 * exactly the actions the screens dispatch. Native views are DOM stand-ins that
 * keep their labels and presses; the video decoder and the page picture are
 * not drawn, so these journeys prove routing, authority, activation and
 * lifecycle, not pixels.
 *
 * What can go wrong, written before the code:
 *
 * J1 Global Tabs
 *   - the sidebar has no Tabs, or Tabs is not a destination (it piles up behind
 *     Back, keeps Back, or loses the Menu);
 *   - opening it from Chat, a task or Specialists carries a conversation into
 *     a standalone tab, or silently swaps the selected tab;
 *   - the list misses the person's own desktop tab, a task's tab, a delegated
 *     worker's, a saved tab, a task-held app, or the person's own Mac view;
 *   - it shows another person's tabs after the account changes;
 *   - places are not grouped by their computer, an app passes for a tab, or
 *     a group loses the person's own order;
 *   - the list asks for any picture, so opening Tabs on cellular streams
 *     every tab;
 *   - a row's marks are not the page pill's: an idle agent is ringed, an
 *     acting one is not, or a row names its agent in words on screen;
 *   - a sign-in waiting on the reader marks the wrong tab, or none;
 *   - a streamed token redraws the list;
 *   - being offline, a failed refresh or an empty Deployment says nothing,
 *     or Try again does nothing.
 * J2 A tab from Tabs is that tab
 *   - the page is shown under the conversation that happened to be in front
 *     (Chat, or task A), or the tab's occupying task, so on a narrow cover
 *     screen a conversation covers the page that was chosen;
 *   - the draft typed in Chat or A is gone after viewing a tab and returning;
 *   - viewing a tab creates a conversation, or shows a composer that would.
 * J3 Restoring a saved tab
 *   - it never asks, asks twice, or asks while the computer is offline or the
 *     tab can never open;
 *   - an error is swallowed, or Retry does nothing;
 *   - a late answer navigates a person who left, or another account;
 *   - a closed tab is replaced by a sibling;
 *   - restoring remounts the conversation, or leaves the page on the old
 *     session.
 * (A conversation's way to its places is Around, which
 * `thread/around.interaction.test.tsx` drives.)
 * J6 Native authority
 *   - a row for the person's own Mac view opens a task's session, or a task's
 *     row opens the person's view; a closed view falls back to a task;
 *   - the owner view is not kept alive while it is on screen;
 *   - Mac window video starts on iOS.
 * J7 Layout
 *   - a task's page opened from Tabs shows a thread beside it on a phone, or
 *     another thread than its occupant's where two panes fit;
 *   - stacked, side-by-side, tabletop or the keyboard remount the page or the
 *     occupant's conversation beside it.
 * J8 One sidebar for tasks and tabs
 *   - the docked sidebar lists no tabs, so a tab is reached only through
 *     Tabs, or it goes away while a page is in front;
 *   - choosing a tab there shows another conversation instead, or piles
 *     screens behind Back, or rebuilds Chat;
 *   - the open tab or task is not the one marked selected;
 *   - folding the window loses the page, or the tab chosen.
 */

const harness = vi.hoisted(() => ({
  platform: "ios" as "android" | "ios",
  frame: { height: 844, width: 390 },
  fontScale: 1,
  pair: { height: 760, width: 390 },
  regions: [] as import("react-native-reserved-regions").ReservedRegion[],
  keyboard: false,
  paneMounts: [] as string[],
  pageMounts: [] as string[],
  /** How often each line of text has been drawn, to tell a redraw from none. */
  draws: new Map<string, number>(),
  drawer: {
    onState: null as null | ((state: string, willShow: boolean) => void),
  },
  /** Made by the mocks below, from the one React the screens use. */
  contexts: {
    inPair: null as import("react").Context<boolean> | null,
    screen: null as import("react").Context<{ focused: boolean; navigation: never }> | null,
  },
}));

type Children = { readonly children?: ReactNode };

const dictation = new DictationController({ port: null, createId: () => crypto.randomUUID() });
vi.mock("../dictation/context.js", () => ({ useDictation: () => dictation }));

vi.mock("react-native", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  const flatten = (style: unknown): Record<string, unknown> =>
    Array.isArray(style)
      ? Object.assign({}, ...style.map(flatten))
      : typeof style === "object" && style !== null
        ? (style as Record<string, unknown>)
        : {};
  return {
    AccessibilityInfo: {
      announceForAccessibility: vi.fn(),
      announceForAccessibilityWithOptions: vi.fn(),
      sendAccessibilityEvent: vi.fn(),
      setAccessibilityFocus: vi.fn(),
    },
    ActivityIndicator: () => <i role="progressbar" />,
    Alert: { alert: vi.fn() },
    AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: "active" },
    BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
    FlatList: (props: {
      readonly data: readonly unknown[];
      readonly keyExtractor: (item: unknown) => string;
      readonly ListEmptyComponent?: ReactNode;
      readonly ListFooterComponent?: ReactNode;
      readonly ListHeaderComponent?: ReactNode;
      readonly numColumns?: number;
      readonly onViewableItemsChanged?: (info: {
        viewableItems: readonly { item: unknown }[];
      }) => void;
      readonly ref?: Ref<unknown>;
      readonly renderItem: (info: { readonly index: number; readonly item: unknown }) => ReactNode;
    }) => {
      React.useImperativeHandle(props.ref, () => ({
        scrollToIndex: () => undefined,
        scrollToOffset: () => undefined,
      }));
      const keys = props.data.map(props.keyExtractor).join("|");
      const { onViewableItemsChanged } = props;
      // Every tile the test draws is on screen.
      React.useEffect(() => {
        onViewableItemsChanged?.({ viewableItems: props.data.map((item) => ({ item })) });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [keys, onViewableItemsChanged]);
      return (
        <div data-columns={props.numColumns ?? 1} data-list>
          {props.ListHeaderComponent}
          {props.data.length === 0
            ? props.ListEmptyComponent
            : props.data.map((item, index) => (
                <div data-row={props.keyExtractor(item)} key={props.keyExtractor(item)}>
                  {props.renderItem({ index, item })}
                </div>
              ))}
          {props.ListFooterComponent}
        </div>
      );
    },
    SectionList: (props: {
      readonly keyExtractor: (item: unknown) => string;
      readonly ListEmptyComponent?: ReactNode;
      readonly ListHeaderComponent?: ReactNode;
      readonly renderItem: (info: {
        readonly index: number;
        readonly item: unknown;
        readonly section: { readonly data: readonly unknown[] };
      }) => ReactNode;
      readonly renderSectionHeader: (info: {
        readonly section: { readonly key: string; readonly data: readonly unknown[] };
      }) => ReactNode;
      readonly sections: readonly { readonly key: string; readonly data: readonly unknown[] }[];
    }) => (
      <div data-list>
        {props.ListHeaderComponent}
        {props.sections.length === 0
          ? props.ListEmptyComponent
          : props.sections.map((section) => (
              <div data-section={section.key} key={section.key}>
                {props.renderSectionHeader({ section })}
                {section.data.map((item, index) => (
                  <div key={props.keyExtractor(item)}>
                    {props.renderItem({ index, item, section })}
                  </div>
                ))}
              </div>
            ))}
      </div>
    ),
    findNodeHandle: () => null,
    I18nManager: { isRTL: false },
    Image: (props: { readonly accessibilityLabel?: string }) => (
      <img alt={props.accessibilityLabel ?? ""} />
    ),
    Keyboard: {
      addListener: () => ({ remove: () => undefined }),
      dismiss: vi.fn(),
      isVisible: () => false,
    },
    KeyboardAvoidingView: (props: Children & { readonly style?: unknown; testID?: string }) => (
      <div data-style={JSON.stringify(flatten(props.style))} data-testid={props.testID}>
        {props.children}
      </div>
    ),
    Modal: (props: Children & { readonly visible?: boolean }) =>
      props.visible === false ? null : <div>{props.children}</div>,
    PanResponder: { create: () => ({ panHandlers: {} }) },
    PixelRatio: { get: () => 3 },
    Platform: {
      get OS() {
        return harness.platform;
      },
      select: (choices: Record<string, unknown>) => choices[harness.platform] ?? choices["default"],
    },
    Pressable: (props: {
      readonly accessibilityHint?: string;
      readonly accessibilityLabel?: string;
      readonly accessibilityState?: { readonly disabled?: boolean; readonly selected?: boolean };
      readonly children?: ReactNode | ((state: { pressed: boolean }) => ReactNode);
      readonly disabled?: boolean;
      readonly onPress?: () => void;
      readonly onPressIn?: () => void;
      readonly style?: unknown;
      readonly testID?: string;
    }) => (
      <button
        aria-description={props.accessibilityHint}
        aria-label={props.accessibilityLabel}
        aria-selected={props.accessibilityState?.selected}
        data-style={
          typeof props.style === "function"
            ? JSON.stringify(flatten((props.style as (s: object) => unknown)({ pressed: false })))
            : JSON.stringify(flatten(props.style))
        }
        data-testid={props.testID}
        disabled={props.disabled}
        onClick={props.onPress}
        onPointerDown={props.onPressIn}
      >
        {typeof props.children === "function" ? props.children({ pressed: false }) : props.children}
      </button>
    ),
    ScrollView: (props: Children) => <div>{props.children}</div>,
    Share: { share: vi.fn(async () => undefined) },
    StyleSheet: {
      absoluteFill: {},
      create: <T,>(styles: T) => styles,
      flatten,
      hairlineWidth: 1,
    },
    Text: (props: Children & { readonly accessibilityLabel?: string }) => (
      <span aria-label={props.accessibilityLabel}>{props.children}</span>
    ),
    TextInput: (props: {
      readonly accessibilityLabel?: string;
      readonly onChangeText?: (text: string) => void;
      readonly placeholder?: string;
      readonly value?: string;
    }) => (
      <textarea
        aria-label={props.accessibilityLabel}
        onChange={(event) => props.onChangeText?.(event.currentTarget.value)}
        placeholder={props.placeholder}
        value={props.value}
      />
    ),
    useWindowDimensions: () => ({
      fontScale: harness.fontScale,
      height: harness.frame.height,
      scale: 3,
      width: harness.frame.width,
    }),
    View: (
      props: Children & {
        readonly accessibilityLabel?: string;
        readonly ref?: Ref<HTMLDivElement>;
        readonly style?: unknown;
        readonly testID?: string;
      },
    ) => (
      <div
        aria-label={props.accessibilityLabel}
        data-style={props.testID === undefined ? undefined : JSON.stringify(flatten(props.style))}
        data-testid={props.testID}
        ref={props.ref}
      >
        {props.children}
      </div>
    ),
  };
});
vi.mock("react-native-reanimated", () => {
  const View = (props: Children & { readonly accessibilityLabel?: string }) => (
    <div aria-label={props.accessibilityLabel}>{props.children}</div>
  );
  const transition = { duration: () => transition };
  return {
    default: { View },
    FadeIn: transition,
    FadeInDown: transition,
    FadeOut: transition,
    FadeOutDown: transition,
    FadeOutUp: transition,
    LayoutAnimationConfig: (props: Children) => <>{props.children}</>,
    LinearTransition: transition,
    useAnimatedStyle: () => ({}),
    useReducedMotion: () => true,
    useSharedValue: (value: number) => ({ value }),
    withTiming: (value: number) => value,
  };
});
vi.mock("react-native-gesture-handler/ReanimatedDrawerLayout", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    default: React.forwardRef(function Drawer(
      props: Children & {
        onDrawerStateChanged: (state: string, willShow: boolean) => void;
        renderNavigationView: () => ReactNode;
      },
      ref,
    ) {
      harness.drawer.onState = props.onDrawerStateChanged;
      React.useImperativeHandle(ref, () => ({
        closeDrawer: () => props.onDrawerStateChanged("idle", false),
        openDrawer: () => props.onDrawerStateChanged("idle", true),
      }));
      return (
        <div>
          <aside data-testid="sidebar">{props.renderNavigationView()}</aside>
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
vi.mock("react-native-reserved-regions", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    ReservedRegionsProvider: (
      props: Children & {
        onLayout?: (event: { nativeEvent: { layout: { height: number; width: number } } }) => void;
      },
    ) => {
      const InPair = (harness.contexts.inPair ??= React.createContext(false));
      // The shell is the window; a page pair, inside it, is the pane it is drawn in.
      const nested = React.useContext(InPair);
      const { height, width } = nested ? harness.pair : harness.frame;
      const { onLayout } = props;
      React.useEffect(() => {
        onLayout?.({ nativeEvent: { layout: { height, width } } });
      }, [height, onLayout, width]);
      return (
        <InPair.Provider value>
          <div>{props.children}</div>
        </InPair.Provider>
      );
    },
    useReservedRegions: () => harness.regions,
    useReservedRegionsReady: () => true,
  };
});
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaProvider: (props: Children & { readonly testID?: string }) => (
    <div data-testid={props.testID}>{props.children}</div>
  ),
  useSafeAreaFrame: () => ({ ...harness.frame, x: 0, y: 0 }),
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));
vi.mock("@react-navigation/elements", () => ({ useHeaderHeight: () => 0 }));
vi.mock("@react-navigation/native", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  const ScreenContext = (harness.contexts.screen ??= React.createContext<{
    focused: boolean;
    navigation: never;
  }>({ focused: false, navigation: null as never }));
  const action = (type: string) => (name?: string, params?: object) => ({
    payload: { name, params },
    type,
  });
  return {
    CommonActions: { reset: (payload: object) => ({ payload, type: "RESET" }) },
    createNavigationContainerRef: () => ({ isReady: () => false }),
    StackActions: {
      pop: (count = 1) => ({ payload: { count }, type: "POP" }),
      popTo: action("POP_TO"),
      popToTop: () => ({ type: "POP_TO_TOP" }),
      push: action("PUSH"),
      replace: action("REPLACE"),
    },
    useFocusEffect: (effect: () => (() => void) | undefined) => {
      const { focused } = React.useContext(ScreenContext);
      React.useEffect(() => (focused ? effect() : undefined), [effect, focused]);
    },
    useIsFocused: () => React.useContext(ScreenContext).focused,
    useNavigation: () => React.useContext(ScreenContext).navigation,
  };
});
vi.mock("expo", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    requireOptionalNativeModule: () => null,
    requireNativeView: () =>
      React.forwardRef(function NativeDisplay(_props: object, ref) {
        React.useImperativeHandle(ref, () => ({
          decode: async () => true,
          reset: async () => undefined,
        }));
        return <canvas data-native-display />;
      }),
  };
});
vi.mock("expo-haptics", () => ({
  ImpactFeedbackStyle: { Heavy: "heavy", Light: "light", Medium: "medium" },
  NotificationFeedbackType: { Error: "error", Success: "success", Warning: "warning" },
  impactAsync: vi.fn(async () => undefined),
  notificationAsync: vi.fn(async () => undefined),
  selectionAsync: vi.fn(async () => undefined),
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock("expo-web-browser", () => ({ openAuthSessionAsync: vi.fn(), openBrowserAsync: vi.fn() }));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: (props: Children) => <div>{props.children}</div>,
}));
vi.mock("../client/mobile-client.js", () => ({
  operationDetail: (error: unknown, fallback: string) =>
    error instanceof Error && error.message ? error.message : fallback,
}));
vi.mock("../client/deployment-rows.js", () => ({
  deploymentStatusDetail: () => "",
  deploymentStatusLabel: () => "Connected",
}));
vi.mock("../screens/deployment-row.js", () => ({ statusTone: () => "neutral" }));
vi.mock("../threads/deployment-identity.js", () => ({
  deploymentIdentity: () => null,
  sameDeploymentIdentity: () => true,
}));
vi.mock("../platform/attachment-draft-files.js", () => ({
  openChatDraftFile: vi.fn(),
  pickChatFile: vi.fn(async () => null),
  pickChatPhoto: vi.fn(async () => null),
  removeChatDraftFile: vi.fn(),
}));
vi.mock("../ui/notifications-context.js", () => ({
  useMobileNotifications: () => ({
    enterThread: () => () => undefined,
    readingLatest: () => undefined,
  }),
}));
vi.mock("../ui/keyboard.js", () => ({ useKeyboardVisible: () => harness.keyboard }));
vi.mock("../ui/glass.js", () => ({ useLiquidGlass: () => false }));
vi.mock("../ui/motion.js", () => ({
  appear: undefined,
  duration: { enter: 0, exit: 0 },
  enter: undefined,
  exit: undefined,
  move: undefined,
}));
vi.mock("../ui/screen.js", () => ({
  Screen: (props: Children) => <main>{props.children}</main>,
  useGutter: () => 16,
  useListContentInsets: () => ({}),
  useReadingColumn: () => ({}),
}));
vi.mock("../ui/primitives.js", () => ({
  AppText: (props: Children & { readonly accessibilityLabel?: string }) => {
    if (typeof props.children === "string")
      harness.draws.set(props.children, (harness.draws.get(props.children) ?? 0) + 1);
    return <span aria-label={props.accessibilityLabel}>{props.children}</span>;
  },
  Field: (props: {
    readonly label: string;
    readonly input: { readonly value?: string; readonly onChangeText?: (value: string) => void };
  }) => (
    <textarea
      aria-label={props.label}
      onChange={(event) => props.input.onChangeText?.(event.currentTarget.value)}
      value={props.input.value}
    />
  ),
  Notice: (props: {
    readonly action?: { readonly label: string; readonly onPress: () => void };
    readonly detail?: string;
    readonly title: string;
  }) => (
    <div role="alert">
      <strong>{props.title}</strong>
      <span>{props.detail}</span>
      {props.action ? <button onClick={props.action.onPress}>{props.action.label}</button> : null}
    </div>
  ),
  PrimaryButton: (props: { readonly label: string; readonly onPress: () => void }) => (
    <button onClick={props.onPress}>{props.label}</button>
  ),
  SecondaryButton: (props: { readonly label: string; readonly onPress: () => void }) => (
    <button onClick={props.onPress}>{props.label}</button>
  ),
  StatusDot: () => null,
  TypingDots: () => null,
  monoFontFamily: "monospace",
}));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("../ui/chat-orb.js", () => ({ ChatOrb: () => <i data-chat-orb /> }));
vi.mock("../ui/workspace-mark.js", () => ({
  WorkspaceDot: () => null,
  WorkspaceIconGlyph: () => null,
  WorkspaceMark: () => null,
}));
vi.mock("../markdown/markdown.js", () => ({
  Markdown: (props: { readonly text: string }) => <p>{props.text}</p>,
  PlainProse: (props: { readonly text: string }) => <p>{props.text}</p>,
}));
vi.mock("../thread/message-menu.js", () => ({ MessageMenu: () => null }));
vi.mock("../thread/attachment-views.js", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    AttachmentReader: React.createContext<HostClient | null>(null),
    AttachmentStrip: () => null,
    MessageAttachments: () => null,
  };
});
vi.mock("../thread/task-line.js", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  const actual =
    await vi.importActual<typeof import("../thread/task-line.js")>("../thread/task-line.js");
  return { ...actual, AssignmentLines: () => null, TaskScopeContext: React.createContext(null) };
});
vi.mock("../thread/waiting-questions.js", () => ({ WaitingQuestions: () => null }));
vi.mock("../thread/composer-bar.js", () => ({
  ComposerBar: (props: {
    readonly accessory?: ReactNode;
    readonly action?: ReactNode;
    readonly caption?: ReactNode;
    readonly field: ReactNode;
    readonly leading?: ReactNode;
  }) => (
    <div aria-label="Composer">
      {props.caption}
      {props.leading}
      {props.field}
      {props.action}
      {props.accessory}
    </div>
  ),
  ComposerGlyph: () => null,
  composerLaneHeight: 36,
}));
vi.mock("../thread/composer-menu.js", () => ({
  NativeMenu: (props: {
    readonly accessibilityLabel?: string;
    readonly options: readonly {
      readonly disabled?: boolean;
      readonly id: string;
      readonly label: string;
      readonly onPress: () => void;
    }[];
  }) => (
    <div aria-label={props.accessibilityLabel ?? "Menu"} data-menu>
      {props.options.map((option) => (
        <button disabled={option.disabled} key={option.id} onClick={option.onPress}>
          {option.label}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("../thread/composer-pills.js", () => ({ ComposerPills: () => null }));
vi.mock("../ui/composer-action.js", () => ({
  ComposerAction: (props: {
    readonly disabled: boolean;
    readonly kind: string;
    readonly label: string;
    readonly onPress: () => void;
  }) => (
    <button aria-label={props.label} disabled={props.disabled} onClick={props.onPress}>
      {props.kind}
    </button>
  ),
}));
vi.mock("../thread/request-card.js", () => ({ RequestCard: () => null }));
vi.mock("./home-intro.js", () => ({ HomeIntro: () => null, homeIntroDraftKey: "home-intro" }));
// Counts each conversation pane and page that mounts, around the real ones.
vi.mock("../thread/thread-pane.js", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  const actual = await vi.importActual<typeof import("../thread/thread-pane.js")>(
    "../thread/thread-pane.js",
  );
  return {
    ...actual,
    ThreadPane: (props: Parameters<typeof actual.ThreadPane>[0]) => {
      React.useEffect(() => {
        harness.paneMounts.push(
          `${props.threadId}:${props.withPage === undefined ? "full" : "companion"}`,
        );
      }, []);
      return <actual.ThreadPane {...props} />;
    },
  };
});
vi.mock("../browser/browser-page.js", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  const actual = await vi.importActual<typeof import("../browser/browser-page.js")>(
    "../browser/browser-page.js",
  );
  return {
    ...actual,
    BrowserPage: (props: Parameters<typeof actual.BrowserPage>[0]) => {
      React.useEffect(() => {
        harness.pageMounts.push(`${props.session.id}:${props.tabId}`);
      }, []);
      return (
        <div data-page={`${props.session.id}:${props.tabId}`}>
          <actual.BrowserPage {...props} />
        </div>
      );
    },
  };
});

const { MobileClientProvider } = await import("../ui/mobile-client-context.js");
const { SidebarShell } = await import("../sidebar/sidebar-shell.js");
const { useSidebarMenu } = await import("../navigation-header.js");
const { ThreadPane } = await import("../thread/thread-pane.js");
const { ThreadScreen } = await import("./thread.js");
const { TabsScreen } = await import("./tabs.js");
const { WorkspaceBrowserScreen } = await import("./workspace-browser.js");
const ScreenContext = harness.contexts.screen!;

// ---------------------------------------------------------------------------
// A small native stack: every route stays mounted, the top one is focused, and
// the actions the screens dispatch are applied exactly and recorded.

interface StackRoute {
  readonly key: string;
  readonly name: string;
  readonly params?: Record<string, unknown>;
}

interface Navigation {
  readonly dispatch: (action: { type: string; payload?: unknown }) => void;
  readonly getState: () => { index: number; routes: readonly StackRoute[] };
  readonly goBack: () => void;
  readonly isFocused: () => boolean;
  readonly navigate: (name: string, params?: object) => void;
  readonly setOptions: (options: Record<string, unknown>) => void;
  readonly setParams: (params: object) => void;
}

class TestStack {
  routes: StackRoute[];
  readonly trace: { readonly action: string; readonly from: string; readonly detail: unknown }[] =
    [];
  #version = 0;
  #count = 0;
  readonly #listeners = new Set<() => void>();
  readonly #options = new Map<string, Record<string, unknown>>();
  readonly #navigations = new Map<string, Navigation>();

  constructor(routes: readonly Omit<StackRoute, "key">[]) {
    this.routes = routes.map((route) => this.#route(route.name, route.params));
  }

  #route(name: string, params?: object): StackRoute {
    this.#count += 1;
    return { key: `${name}-${this.#count}`, name, params: params as Record<string, unknown> };
  }

  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  readonly version = () => this.#version;
  #publish() {
    this.#version += 1;
    for (const listener of this.#listeners) listener();
  }

  get top(): StackRoute {
    return this.routes.at(-1)!;
  }

  options(key: string): Record<string, unknown> {
    return this.#options.get(key) ?? {};
  }

  apply(from: string, action: { type: string; payload?: unknown }) {
    const payload = (action.payload ?? {}) as {
      readonly count?: number;
      readonly index?: number;
      readonly name?: string;
      readonly params?: object;
      readonly routes?: readonly { name: string; params?: object; key?: string }[];
    };
    this.trace.push({ action: action.type, from, detail: payload });
    switch (action.type) {
      case "PUSH":
        this.routes = [...this.routes, this.#route(payload.name!, payload.params)];
        break;
      case "REPLACE":
        this.routes = [...this.routes.slice(0, -1), this.#route(payload.name!, payload.params)];
        break;
      case "POP":
        this.routes = this.routes.slice(0, Math.max(1, this.routes.length - (payload.count ?? 1)));
        break;
      case "POP_TO_TOP":
        this.routes = this.routes.slice(0, 1);
        break;
      case "POP_TO": {
        const at = this.routes.findLastIndex((route) => route.name === payload.name);
        this.routes =
          at < 0
            ? [...this.routes, this.#route(payload.name!, payload.params)]
            : [
                ...this.routes.slice(0, at),
                {
                  ...this.routes[at]!,
                  params: (payload.params ?? this.routes[at]!.params) as Record<string, unknown>,
                },
              ];
        break;
      }
      case "RESET":
        this.routes = (payload.routes ?? []).map((route) =>
          route.key !== undefined
            ? (this.routes.find((held) => held.key === route.key) ??
              this.#route(route.name, route.params))
            : this.#route(route.name, route.params),
        );
        break;
      default:
        throw new Error(`The test stack cannot apply ${action.type}.`);
    }
    this.#publish();
  }

  navigation(key: string): Navigation {
    const held = this.#navigations.get(key);
    if (held) return held;
    const navigation: Navigation = {
      dispatch: (action) => this.apply(key, action),
      getState: () => ({ index: this.routes.length - 1, routes: this.routes }),
      goBack: () => {
        this.trace.push({ action: "GO_BACK", from: key, detail: null });
        this.routes = this.routes.filter((route) => route.key !== key);
        this.#publish();
      },
      isFocused: () => this.top.key === key,
      navigate: (name, params) => this.apply(key, { payload: { name, params }, type: "PUSH" }),
      setOptions: (options) => {
        this.#options.set(key, { ...this.options(key), ...options });
        this.#publish();
      },
      setParams: (params) => {
        this.trace.push({ action: "SET_PARAMS", from: key, detail: params });
        this.routes = this.routes.map((route) =>
          route.key === key ? { ...route, params: { ...route.params, ...params } } : route,
        );
        this.#publish();
      },
    };
    this.#navigations.set(key, navigation);
    return navigation;
  }
}

function HomeStandIn(props: { readonly route: StackRoute }): ReactNode {
  // Chat's own screen is not under test here: it is the root, with the Menu,
  // and the real conversation pane once Chat exists.
  const hostClient = useContext(HostContext);
  useSidebarMenu(hostClient);
  const homeThreadId = useSyncExternalStore(
    hostClient.subscribe,
    () => hostClient.getSnapshot().homeThreadId,
  );
  const { header, onHeader } = useScopedThreadHeader(hostClient, homeThreadId);
  useThreadHeader({
    deploymentId,
    fallbackTitle: "Chat",
    header,
    hostClient,
    threadId: homeThreadId,
  });
  return homeThreadId === null ? (
    <p>First message</p>
  ) : (
    <ThreadPane
      deploymentId={props.route.params!["deploymentId"] as string}
      hostClient={hostClient}
      onHeader={onHeader}
      onOpenThread={() => undefined}
      requestId={null}
      threadId={homeThreadId}
    />
  );
}
function SpecialistsStandIn(): ReactNode {
  useSidebarMenu(useContext(HostContext));
  return <p>Specialists</p>;
}
const HostContext = createContext<HostClient>(null as never);

const screens: Record<string, (props: { route: never }) => ReactNode> = {
  Home: HomeStandIn as never,
  Specialists: SpecialistsStandIn as never,
  Tabs: TabsScreen as never,
  Thread: ThreadScreen as never,
  WorkspaceBrowser: WorkspaceBrowserScreen as never,
};

function Header(props: { readonly stack: TestStack; readonly routeKey: string }): ReactNode {
  const options = props.stack.options(props.routeKey);
  const draw = (value: unknown) =>
    typeof value === "function" ? (value as () => ReactNode)() : (value as ReactNode);
  return (
    <header>
      <div data-header-left>{draw(options["headerLeft"])}</div>
      <div data-header-title>{draw(options["headerTitle"] ?? options["title"])}</div>
      <div data-header-right>{draw(options["headerRight"])}</div>
    </header>
  );
}

function StackView(props: { readonly stack: TestStack }): ReactNode {
  const { stack } = props;
  useSyncExternalStore(stack.subscribe, stack.version);
  return (
    <SidebarShell
      navigation={{ dispatch: (action) => stack.apply("sidebar", action as never) }}
      state={{ index: stack.routes.length - 1, routes: stack.routes }}
    >
      {stack.routes.map((route) => {
        const Screen = screens[route.name];
        if (Screen === undefined) throw new Error(`No screen for ${route.name}`);
        const focused = stack.top.key === route.key;
        return (
          <section data-focused={focused} data-route={route.key} key={route.key}>
            <ScreenContext.Provider
              value={{ focused, navigation: stack.navigation(route.key) as never }}
            >
              <Header routeKey={route.key} stack={stack} />
              <Screen route={{ key: route.key, name: route.name, params: route.params } as never} />
            </ScreenContext.Provider>
          </section>
        );
      })}
    </SidebarShell>
  );
}

// ---------------------------------------------------------------------------
// The journey's world: one MockHostClient, the phone's draft store and an
// attached Deployment row.

const deploymentId = "dep_0192f4a1-1111-4000-8000-000000000001";
const evidence: Record<string, unknown>[] = [];

interface World {
  readonly host: MockHostClient;
  readonly drafts: ThreadDraftStore;
  readonly stack: TestStack;
  readonly container: HTMLElement;
  readonly calls: {
    readonly activations: string[];
    readonly watches: string[];
    readonly viewers: string[];
    readonly displays: string[];
    readonly ownerRetains: string[];
    readonly creates: string[];
  };
  readonly render: () => Promise<void>;
  readonly record: (name: string, extra?: Record<string, unknown>) => void;
}

const roots: Root[] = [];
const hosts: MockHostClient[] = [];

async function world(
  options: {
    readonly routes?: readonly Omit<StackRoute, "key">[];
    readonly host?: ConstructorParameters<typeof MockHostClient>[0];
    readonly prepare?: (host: MockHostClient) => void | Promise<void>;
  } = {},
): Promise<World> {
  const host = new MockHostClient({ automations: "absent", latencyMs: 0, ...options.host });
  hosts.push(host);
  await options.prepare?.(host);
  const calls: World["calls"] = {
    activations: [],
    creates: [],
    displays: [],
    ownerRetains: [],
    viewers: [],
    watches: [],
  };
  const activate = host.activateWorkspaceTab;
  Object.defineProperty(host, "activateWorkspaceTab", {
    configurable: true,
    value: (tabId: string) => {
      calls.activations.push(tabId);
      return activate(tabId);
    },
  });
  const watch = host.retainBrowserWatch.bind(host) as (...args: unknown[]) => () => void;
  Object.defineProperty(host, "retainBrowserWatch", {
    configurable: true,
    value: (sessionId: string, surfaceId?: string, ...rest: unknown[]) => {
      calls.watches.push(`${sessionId}:${surfaceId}`);
      return watch(sessionId, surfaceId, ...rest);
    },
  });
  const viewer = host.retainBrowserViewer;
  Object.defineProperty(host, "retainBrowserViewer", {
    configurable: true,
    value: (sessionId: string, surfaceId?: string, retain?: object) => {
      calls.viewers.push(`${sessionId}:${surfaceId}`);
      return (viewer as (...args: unknown[]) => () => void)(sessionId, surfaceId, retain);
    },
  });
  const connect = host.connectComputerDisplay.bind(host);
  vi.spyOn(host, "connectComputerDisplay").mockImplementation((source) => {
    calls.displays.push(JSON.stringify(source));
    return connect(source);
  });
  const retainView = host.retainComputerView;
  Object.defineProperty(host, "retainComputerView", {
    configurable: true,
    value: (viewId: string, generation: number, retain?: object) => {
      calls.ownerRetains.push(`${viewId}:${generation}`);
      return retainView(viewId, generation, retain);
    },
  });
  for (const name of ["createHome", "createThread"] as const) {
    const original = (host as unknown as Record<string, (...args: unknown[]) => unknown>)[name]!;
    Object.defineProperty(host, name, {
      configurable: true,
      value: (...args: unknown[]) => {
        calls.creates.push(name);
        return original.apply(host, args);
      },
    });
  }
  const drafts = createThreadDraftStore({
    filePath: "/private/drafts-v3.json",
    now: () => new Date("2026-10-26T12:00:00.000Z"),
    privateFiles: new MemoryPrivateFilesystem(),
  });
  await drafts.load();
  const row = { deploymentId, signIn: null, status: "connected", name: "Mock" };
  const state = { rows: [row], selection: { deploymentId, hostClient: host } };
  const mobile = {
    doneShelf: { read: async () => false, write: async () => undefined },
    drafts,
    getSnapshot: () => state,
    openDeployment: async () => undefined,
    // No saved view on this phone: every surface is waiting for the live Host.
    savedViews: {
      getDeploymentId: () => null,
      getSnapshot: () => ({
        home: { source: "pending" },
        tasks: { source: "pending" },
        failure: null,
      }),
      subscribe: () => () => undefined,
    },
    subscribe: () => () => undefined,
  } as unknown as MobileClient;
  const stack = new TestStack(options.routes ?? [{ name: "Home", params: { deploymentId } }]);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const render = async () => {
    await act(async () =>
      root.render(
        <MobileClientProvider client={mobile}>
          <HostContext.Provider value={host}>
            <StackView stack={stack} />
          </HostContext.Provider>
        </MobileClientProvider>,
      ),
    );
    await settle();
  };
  await render();
  const record = (name: string, extra: Record<string, unknown> = {}) =>
    evidence.push({
      journey: name,
      platform: harness.platform,
      navigation: stack.trace,
      routes: stack.routes.map(({ name: route, params }) => ({ name: route, params })),
      activations: [...calls.activations],
      watchRetains: [...calls.watches],
      viewerRetains: [...calls.viewers],
      displayConnections: [...calls.displays],
      ownerViewRetains: [...calls.ownerRetains],
      conversationCreates: [...calls.creates],
      paneMounts: [...harness.paneMounts],
      pageMounts: [...harness.pageMounts],
      ...extra,
    });
  return { calls, container, drafts, host, record, render, stack };
}

async function settle(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index += 1)
    await act(async () => {
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
      else await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

/** The screen in front, as the stack draws it. */
function front(world: World): HTMLElement {
  const found = world.container.querySelector<HTMLElement>('section[data-focused="true"]');
  if (found === null) throw new Error("No screen is in front.");
  return found;
}
function sidebar(world: World): HTMLElement {
  return world.container.querySelector<HTMLElement>('[data-testid="sidebar"]')!;
}
/** The sidebar docked beside the stack, where the window has room for it. */
function dockedSidebar(world: World): HTMLElement {
  const found = world.container.querySelector<HTMLElement>('[data-testid="sidebar-column"]');
  if (found === null) throw new Error("The sidebar is not docked.");
  return found;
}
function buttons(scope: HTMLElement): HTMLButtonElement[] {
  return [...scope.querySelectorAll("button")];
}
function find(scope: HTMLElement, name: string): HTMLButtonElement | undefined {
  return (
    buttons(scope).find((button) => button.getAttribute("aria-label") === name) ??
    buttons(scope).find((button) => button.textContent?.trim() === name)
  );
}
function control(scope: HTMLElement, name: string): HTMLButtonElement {
  const found = find(scope, name);
  if (found === undefined)
    throw new Error(
      `No control named ${name} in: ${buttons(scope)
        .map((button) => button.getAttribute("aria-label") ?? button.textContent)
        .join(" | ")}`,
    );
  return found;
}
/** The person's own view of a window: its row names nobody in it. */
function ownerRow(scope: HTMLElement, title: string): HTMLButtonElement {
  const found = placeRows(scope).find(
    (button) => button.getAttribute("aria-label") === `${title}, Mac app`,
  );
  if (found === undefined) throw new Error(`No owner row for ${title}`);
  return found;
}
/** A row, in Tabs or the sidebar, found by the title its label starts with. */
function row(scope: HTMLElement, title: string): HTMLButtonElement {
  const found = buttons(scope).find((button) =>
    button.getAttribute("aria-label")?.startsWith(`${title}, `),
  );
  if (found === undefined)
    throw new Error(
      `No row for ${title} in: ${buttons(scope)
        .map((button) => button.getAttribute("aria-label"))
        .filter(Boolean)
        .join(" | ")}`,
    );
  return found;
}
/** Tabs' own rows, in the order drawn. */
function placeRows(scope: HTMLElement): HTMLButtonElement[] {
  return [...scope.querySelectorAll<HTMLButtonElement>('button[data-testid^="place:"]')];
}
/** Tabs' group headers, in the order drawn. */
function groupHeads(scope: HTMLElement): string[] {
  return [...scope.querySelectorAll<HTMLElement>("[data-section] > div[aria-label]")].map((head) =>
    head.getAttribute("aria-label")!,
  );
}

/**
 * Lets a journey change what the Host says — a streamed token, a Request, the
 * connection — and tells everyone listening, as the client would. Set up
 * before anything subscribes; each answer is kept until either side changes.
 */
function steerable(host: MockHostClient) {
  const read = host.getSnapshot;
  const subscribe = host.subscribe;
  const listeners = new Set<() => void>();
  let edit = (snapshot: HostSnapshot) => snapshot;
  let held: { readonly source: HostSnapshot; readonly shown: HostSnapshot } | null = null;
  Object.defineProperty(host, "getSnapshot", {
    configurable: true,
    value: () => {
      const source = read();
      if (held?.source !== source) held = { shown: edit(source), source };
      return held.shown;
    },
  });
  Object.defineProperty(host, "subscribe", {
    configurable: true,
    value: (listener: () => void) => {
      listeners.add(listener);
      const stop = subscribe(listener);
      return () => {
        listeners.delete(listener);
        stop();
      };
    },
  });
  return {
    async change(next: (snapshot: HostSnapshot) => HostSnapshot) {
      edit = next;
      held = null;
      await act(async () => listeners.forEach((listener) => listener()));
      await settle();
    },
  };
}
async function press(target: HTMLButtonElement): Promise<void> {
  await act(async () => target.click());
  await settle();
}
async function openSidebarTabs(world: World): Promise<void> {
  await press(control(sidebar(world), "All tabs"));
}
async function typeDraft(scope: HTMLElement, words: string): Promise<void> {
  const field = scope.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
  if (field === null) throw new Error("No composer here.");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      field,
      words,
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}
function draftShown(scope: HTMLElement): string | null {
  return scope.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.value ?? null;
}
function sheetRecipient(scope: HTMLElement): string | null {
  return scope.querySelector('[data-testid="conversation-name"]')?.textContent ?? null;
}

/** A tab from Tabs or the sidebar, as its route names it: the tab, and no conversation. */
function aloneRoute(place: { readonly destination: { readonly kind: string } }) {
  const { destination } = place;
  if (destination.kind !== "browser") throw new Error("Not a browser tab.");
  const { sessionId, tabId } = destination as unknown as { sessionId: string; tabId: string };
  return { deploymentId, scope: "workspace", sessionId, tabId };
}

function threadTitled(snapshot: HostSnapshot, title: string): string {
  const thread = snapshot.threads.find((candidate) => candidate.title === title);
  if (!thread) throw new Error(`The mock has no task titled ${title}.`);
  return thread.id;
}

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const host of hosts.splice(0)) host.dispose();
  document.body.replaceChildren();
  harness.platform = "ios";
  harness.frame = { height: 844, width: 390 };
  harness.fontScale = 1;
  harness.pair = { height: 760, width: 390 };
  harness.regions = [];
  harness.keyboard = false;
  harness.paneMounts = [];
  harness.pageMounts = [];
  harness.draws.clear();
});
afterAll(() => {
  const directory =
    process.env["OPENSTEER_MOBILE_TABS_EVIDENCE_DIR"] ?? join(tmpdir(), "opensteer-mobile-tabs");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "journey.json"),
    `${JSON.stringify({ suite: "mobile tabs journeys", recorded: evidence }, null, 2)}\n`,
  );
});

// ---------------------------------------------------------------------------

describe("J1: Tabs from the sidebar lists every tab this person may see", () => {
  it("keeps a local pending opening reachable from Tabs and closes only its late result", async () => {
    const w = await world({
      routes: [
        { name: "Home", params: { deploymentId } },
        { name: "Tabs", params: { deploymentId } },
      ],
    });
    const gate = Promise.withResolvers<void>();
    const dispatch = w.host.rpc["commands.dispatch"];
    const delayed: typeof dispatch = async (command, options) => {
      if (command.type === "browser.tab.open")
        await withTimeout(gate.promise, 2_000, {
          timeoutError: () => new Error("The delayed browser command was never released."),
        });
      return dispatch(command, options);
    };
    Object.defineProperty(w.host, "rpc", {
      value: new Proxy(w.host.rpc, {
        get: (target, name) => (name === "commands.dispatch" ? delayed : Reflect.get(target, name)),
      }),
    });
    const session = w.host
      .getSnapshot()
      .browserSessions.find((session) => session.state === "ready")!;
    let opening!: ReturnType<typeof w.host.beginBrowserTabOpen>;
    act(() => {
      opening = w.host.beginBrowserTabOpen(session.id, {
        url: "https://pending.example/",
        idempotencyKey: "mobile-list",
      });
      void opening.result.catch(() => undefined);
    });
    await press(control(front(w), "https://pending.example/"));
    expect(w.stack.top.params).toMatchObject({
      scope: "workspace",
      pendingBrowserTab: "mobile-list",
    });
    expect(front(w).textContent).toContain("Opening");
    const close = vi.spyOn(w.host, "closeBrowserTab");
    await press(control(front(w), "Close tab"));
    expect(w.stack.top.name).toBe("Tabs");
    await expect(opening.result).rejects.toMatchObject({ name: "AbortError" });
    await act(async () => {
      gate.resolve();
    });
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(w.stack.top.name).toBe("Tabs");
  });

  it("is a sidebar destination with the Menu, opened as the Deployment's own", async () => {
    const w = await world();
    const destinations = buttons(sidebar(w))
      .map((button) => button.textContent?.trim())
      .filter((label) => ["Chat", "New task", "Specialists", "All tabs"].includes(label ?? ""));
    expect(destinations).toEqual(["Chat", "New task", "Specialists", "All tabs"]);

    // From Chat: pushed over Chat, the Deployment's tabs rather than Chat's.
    await openSidebarTabs(w);
    expect(w.stack.trace.at(-1)).toEqual({
      action: "PUSH",
      detail: { name: "Tabs", params: { deploymentId } },
      from: "sidebar",
    });
    expect(w.stack.routes.map(({ name }) => name)).toEqual(["Home", "Tabs"]);
    // The Menu, carrying any questions waiting, where Back would be.
    const bar = front(w).querySelector<HTMLElement>("[data-header-left]")!;
    expect(
      buttons(bar).some((button) => button.getAttribute("aria-label")?.startsWith("Menu")),
    ).toBe(true);

    // From Tabs to Specialists and back: one destination replaces the other.
    await press(control(sidebar(w), "Specialists"));
    await openSidebarTabs(w);
    expect(w.stack.trace.at(-1)).toEqual({
      action: "REPLACE",
      detail: { name: "Tabs", params: { deploymentId } },
      from: "sidebar",
    });
    expect(w.stack.routes.map(({ name }) => name)).toEqual(["Home", "Tabs"]);
    w.record("J1 sidebar destination from Chat and Specialists");
  });

  it("from task A resets to Chat and Tabs, carrying no conversation", async () => {
    const snapshot = new MockHostClient({ automations: "absent", latencyMs: 0 }).getSnapshot();
    const taskA = threadTitled(snapshot, "Switch Slack to Opensteer");
    const w = await world({
      routes: [
        { name: "Home", params: { deploymentId } },
        { name: "Thread", params: { deploymentId, threadId: taskA } },
      ],
    });
    await openSidebarTabs(w);
    expect(w.stack.trace.at(-1)).toMatchObject({ action: "RESET" });
    expect(w.stack.routes.map(({ name, params }) => [name, params])).toEqual([
      ["Home", { deploymentId }],
      ["Tabs", { deploymentId }],
    ]);
    w.record("J1 from task A");
  });

  it("lists every tab, app and phone grouped by computer, with the page pill's marks and no pictures", async () => {
    harness.platform = "android";
    let worker = "";
    const w = await world({
      prepare: async (host) => {
        const snapshot = host.getSnapshot();
        // The person's own view of Notes on the Mac mini, opened on the Mac.
        const mini = snapshot.machines.find(({ name }) => name === "Mac mini")!;
        await host.openComputerView(mini.id, {
          app: { bundleId: "com.apple.Notes", displayName: "Notes", teamId: null },
          kind: "app",
        });
        // The delegated worker acts in the automation's page.
        worker = Object.values(snapshot.assignments)[0]!.workerThread.id;
        host.actInPlace(
          worker,
          placeList(host.getSnapshot()).find(({ title }) => title === "Flight award alerts")!.key,
        );
        host.scriptDormantBrowser({ profileName: "Work" });
      },
    });
    await openSidebarTabs(w);
    const screen = front(w);
    const snapshot = w.host.getSnapshot();
    const places = placeList(snapshot);
    // One row per place, none hidden, in the person's order within its computer:
    // the person's own Notes view, opened last, sits with the Mac mini's apps.
    expect(
      placeRows(screen).map((button) => button.getAttribute("aria-label")!.split(", ")[0]),
    ).toEqual([
      "Your reading list",
      "Confirm your reservation",
      "Le Petit Jardin",
      "Friday dinner",
      "PortableFS documentation",
      "Launch brief",
      "Coffee shortlist",
      "Weekend ideas",
      "Flight award alerts",
      "Q4 roadmap – Linear",
      "Slack — #launch",
      "Notes — Shopping list",
      "Notes — Shopping list",
      "Pixel 7",
      "Keynote",
    ]);
    expect(placeRows(screen)).toHaveLength(places.length);
    // Grouped by computer, a Mac's apps apart from its tabs.
    expect(groupHeads(screen)).toEqual([
      "Mac mini · Browser",
      "Mac mini · Apps",
      "Agent Phone · Pixel 7",
      "Studio Mac · Apps",
    ]);
    for (const title of [
      "Q4 roadmap – Linear", // opened by hand on the desktop
      "Friday dinner", // a task's
      "Flight award alerts", // a delegated worker acting there
      "Your reading list", // saved, waiting to be restored
      "Slack — #launch", // a task's Mac app, titled by the window it works in
    ])
      expect(row(screen, title)).toBeDefined();
    // The person's own Mac view is its own row, apart from the task working in Notes.
    expect(ownerRow(screen, "Notes — Shopping list")).toBeDefined();
    // Who is in a place, said as the page's pill says it; green only where acting.
    const workerTitle = snapshot.threads.find(({ id }) => id === worker)!.title;
    expect(row(screen, "Flight award alerts").getAttribute("aria-label")).toBe(
      `Flight award alerts, www.united.com, Guest, ${workerTitle}, working here`,
    );
    expect(row(screen, "Flight award alerts").dataset["testid"]).toBe("place:acting");
    expect(row(screen, "Friday dinner").getAttribute("aria-label")).toBe(
      "Friday dinner, resy.com, Work, Review PortableFS integration, idle",
    );
    expect(row(screen, "Friday dinner").dataset["testid"]).toBe("place:idle");
    expect(row(screen, "Q4 roadmap – Linear").getAttribute("aria-label")).toBe(
      "Q4 roadmap – Linear, linear.app, Work",
    );
    expect(row(screen, "Pixel 7").getAttribute("aria-label")).toBe(
      "Pixel 7, Agent Phone, Check the delivery ETA, working here",
    );
    // Chat in a tab wears Chat's orb.
    expect(row(screen, "Weekend ideas").querySelector("[data-chat-orb]")).not.toBeNull();
    // Marks, never names, on screen: the words are titles and sites.
    expect(screen.querySelector("[data-header-title]")?.textContent).toBe("Tabs");
    const words = screen.querySelector("[data-list]")!.textContent;
    expect(words).toContain("Q4 roadmap – Linear");
    for (const thread of snapshot.threads.filter(({ listed }) => listed))
      expect(words).not.toContain(thread.title);
    expect(words).not.toMatch(/Opened by|Agent working|This task/u);
    // Every row is a full target.
    for (const button of placeRows(screen))
      expect(JSON.parse(button.dataset["style"]!).minHeight).toBeGreaterThanOrEqual(44);
    // Opening the list asks for no picture of any tab, app or phone.
    expect(w.calls.watches).toEqual([]);
    expect(w.calls.viewers).toEqual([]);
    expect(w.calls.displays).toEqual([]);
    expect(w.calls.ownerRetains).toEqual([]);
    w.record("J1 global list", { groups: groupHeads(screen) });
  });

  it("narrows to the tabs agents are in from the bar's filter, titled so, and back to every tab", async () => {
    const w = await world();
    await openSidebarTabs(w);
    const places = placeList(w.host.getSnapshot());
    const busy = places.filter(placeHasAgents).map(({ title }) => title);
    expect(busy.length).toBeGreaterThan(0);
    expect(busy.length).toBeLessThan(places.length);
    const title = () => front(w).querySelector("[data-header-title]")?.textContent;
    const filter = () => front(w).querySelector<HTMLElement>("[data-header-right] [data-menu]")!;
    const shown = () =>
      placeRows(front(w)).map((b) => b.getAttribute("aria-label")!.split(", ")[0]);
    expect(filter().getAttribute("aria-label")).toBe("Filter");
    await press(control(filter(), "Tabs with agents"));
    expect(title()).toBe("Tabs with agents");
    expect(filter().getAttribute("aria-label")).toBe("Filter, showing tabs with agents");
    expect(shown()).toEqual(busy);
    await press(control(filter(), "All tabs"));
    expect(title()).toBe("Tabs");
    expect(shown()).toEqual(places.map(({ title }) => title));
  });

  it("is not redrawn by a streamed token, and a sign-in waiting on the reader marks only its tab", async () => {
    let host!: ReturnType<typeof steerable>;
    const w = await world({
      prepare: (mock) => void (host = steerable(mock)),
      routes: [{ name: "Tabs", params: { deploymentId } }],
    });
    const drawn = () => [
      harness.draws.get("Keynote") ?? 0,
      harness.draws.get("Studio Mac · Apps") ?? 0,
      harness.draws.get("Q4 roadmap – Linear") ?? 0,
    ];
    const before = drawn();
    expect(before.every((count) => count > 0)).toBe(true);
    const home = w.host.getSnapshot().homeThreadId!;
    for (const text of ["Hel", "Hello", "Hello there"])
      await host.change((snapshot) => {
        const entries = snapshot.transcripts[home] ?? [];
        return {
          ...snapshot,
          transcripts: {
            ...snapshot.transcripts,
            [home]: [...entries, { ...entries.at(-1), id: `streamed-${text}`, text } as never],
          },
        };
      });
    expect(drawn()).toEqual(before);

    const roadmap = placeList(w.host.getSnapshot()).find(
      ({ title }) => title === "Q4 roadmap – Linear",
    )!;
    if (roadmap.destination.kind !== "browser") throw new Error("Not a browser tab.");
    const { sessionId, tabId } = roadmap.destination;
    const asked = mockBrowserSignInRequest("https://linear.app", 1);
    await host.change((snapshot) => ({
      ...snapshot,
      waitingRequests: [
        ...snapshot.waitingRequests,
        {
          assignments: [],
          request: { ...asked, payload: { ...asked.payload, sessionId, tabId } },
          subagent: null,
        } as never,
      ],
    }));
    expect(row(front(w), "Q4 roadmap – Linear").getAttribute("aria-label")).toBe(
      "Q4 roadmap – Linear, linear.app, Work, needs you",
    );
    expect(row(front(w), "Q4 roadmap – Linear").textContent).toContain("Needs you");
    expect(
      placeRows(front(w)).filter((button) => button.textContent?.includes("Needs you")),
    ).toHaveLength(1);
    // Only that row is drawn again.
    const [keynote, , roadmapDraws] = drawn();
    expect(keynote).toBe(before[0]);
    expect(roadmapDraws).toBeGreaterThan(before[2]!);
    w.record("J1 streamed token and sign-in");
  });

  it("says when it cannot refresh, with Try again, when it is offline, and when there is nothing", async () => {
    let host!: ReturnType<typeof steerable>;
    let refresh!: ReturnType<typeof vi.spyOn>;
    const w = await world({
      prepare: (mock) => {
        host = steerable(mock);
        refresh = vi
          .spyOn(mock, "refresh")
          .mockRejectedValueOnce(new Error("The Host did not answer."));
      },
    });
    await openSidebarTabs(w);
    const notices = () =>
      [...front(w).querySelectorAll('[role="alert"]')].map((notice) => notice.textContent);
    expect(notices()).toEqual(["Tabs could not be refreshedThe Host did not answer.Try again"]);
    // What was known is still listed under the notice.
    expect(placeRows(front(w)).length).toBeGreaterThan(0);
    const asked = refresh.mock.calls.length;
    await press(control(front(w), "Try again"));
    expect(refresh.mock.calls.length).toBe(asked + 1);
    expect(notices()).toEqual([]);

    await host.change((snapshot) => ({ ...snapshot, connection: "offline" }));
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toContain("Tabs reconnect when the deployment is available.");
    expect(placeRows(front(w)).length).toBeGreaterThan(0);

    await host.change((snapshot) => ({
      ...snapshot,
      browserSessions: [],
      machines: [],
      workspaceTabs: [],
    }));
    expect(placeRows(front(w))).toEqual([]);
    expect(front(w).querySelector("[data-list]")!.textContent).toContain(
      "No tabs yetTabs you and your agents open appear here.",
    );
    w.record("J1 notices and empty");
  });

  it("shows nothing from the previous person once another signs in", async () => {
    const w = await world({
      prepare: (host) => void host.scriptDormantBrowser({ profileName: "Work" }),
    });
    await openSidebarTabs(w);
    const shown = placeRows(front(w))[0]!;
    expect(shown.isConnected).toBe(true);
    await act(async () => w.host.setDormantBrowserState({ accountChanged: true }));
    await settle();
    // The list is drawn afresh for the new reader: no tile the last one saw survives.
    expect(shown.isConnected).toBe(false);
    expect(placeRows(front(w)).length).toBeGreaterThan(0);
    expect(w.stack.trace.filter(({ from }) => from !== "sidebar")).toEqual([]);
    w.record("J1 account change");
  });
});

describe("J2: a tab from Tabs is that tab alone, whoever was in front", () => {
  /** The exact tab, alone: its page and no conversation over, under or beside it. */
  function expectAlone(scope: HTMLElement) {
    expect(scope.querySelector("[data-page]")).not.toBeNull();
    expect(scope.querySelector('textarea[aria-label="Message"]')).toBeNull();
    expect(scope.querySelector('[data-testid="conversation-slot"]')).toBeNull();
    expect(sheetRecipient(scope)).toBeNull();
    expect(harness.paneMounts.filter((mount) => mount.endsWith(":companion"))).toEqual([]);
  }

  it("on a narrow cover screen, from Chat, shows the page alone and leaves Chat's draft where it was", async () => {
    harness.frame = { height: 748, width: 344 };
    harness.pair = { height: 700, width: 344 };
    const w = await world();
    await typeDraft(front(w), "Ask about the reservation");
    await openSidebarTabs(w);
    // Friday dinner is held by a task; neither that task nor Chat comes with it.
    const place = placeList(w.host.getSnapshot()).find(({ title }) => title === "Friday dinner")!;
    await press(row(front(w), "Friday dinner"));
    const opened = w.stack.top;
    expect(opened.name).toBe("WorkspaceBrowser");
    expect(opened.params).toEqual(aloneRoute(place));
    expectAlone(front(w));
    // Back to Tabs, then another tab: alone too.
    await act(async () => w.stack.navigation(opened.key).goBack());
    await settle();
    expect(w.stack.top.name).toBe("Tabs");
    await press(row(front(w), "Q4 roadmap – Linear"));
    expectAlone(front(w));
    // Back to Chat: its own draft, untouched.
    await act(async () => w.stack.navigation(w.stack.top.key).goBack());
    await act(async () => w.stack.navigation(w.stack.top.key).goBack());
    await settle();
    expect(w.stack.routes.map(({ name }) => name)).toEqual(["Home"]);
    expect(draftShown(front(w))).toBe("Ask about the reservation");
    expect(w.calls.creates).toEqual([]);
    w.record("J2 from Chat on a cover screen");
  });

  it("from task A shows the tab alone, and A keeps its draft when chosen again from the sidebar", async () => {
    const snapshot = new MockHostClient({ automations: "absent", latencyMs: 0 }).getSnapshot();
    const taskA = threadTitled(snapshot, "Switch Slack to Opensteer");
    const w = await world({
      routes: [
        { name: "Home", params: { deploymentId } },
        { name: "Thread", params: { deploymentId, threadId: taskA } },
      ],
    });
    await typeDraft(front(w), "Compare this with the last one");
    await openSidebarTabs(w);
    await press(row(front(w), "Friday dinner"));
    expect(w.stack.top.params?.["threadId"]).toBeUndefined();
    expectAlone(front(w));
    await act(async () => harness.drawer.onState?.("idle", true));
    await settle();
    await press(row(sidebar(w), "Switch Slack to Opensteer"));
    expect(w.stack.routes.map(({ name }) => name)).toEqual(["Home", "Thread"]);
    expect(w.stack.top.params).toMatchObject({ threadId: taskA });
    expect(draftShown(front(w))).toBe("Compare this with the last one");
    w.record("J2 from task A");
  });

  it("before Chat exists, opens Tabs and a tab alone and creates nothing", async () => {
    // The mock's world before Chat has no computer to browse on, so the page
    // itself is opened in the seeded world.
    const first = await world({ host: { initialHome: "absent" } });
    expect(first.host.getSnapshot().homeThreadId).toBeNull();
    await openSidebarTabs(first);
    expect(first.stack.top).toMatchObject({ name: "Tabs", params: { deploymentId } });
    expect(placeRows(front(first))).toHaveLength(placeList(first.host.getSnapshot()).length);
    expect(first.calls.creates).toEqual([]);
    first.record("J2 before Chat: Tabs");

    const w = await world({
      routes: [
        { name: "Home", params: { deploymentId } },
        { name: "Tabs", params: { deploymentId } },
      ],
    });
    await press(row(front(w), "Q4 roadmap – Linear"));
    expect(w.stack.top.params).toMatchObject({ scope: "workspace" });
    expectAlone(front(w));
    expect(w.calls.creates).toEqual([]);
    w.record("J2 tab with no conversation");
  });
});

describe("J3: a saved tab restores once, through the shared activation", () => {
  async function openSaved(
    options: Parameters<MockHostClient["scriptDormantBrowser"]>[0] = { profileName: "Work" },
  ) {
    let saved: ReturnType<MockHostClient["scriptDormantBrowser"]> | null = null;
    const w = await world({
      prepare: (host) => {
        saved = host.scriptDormantBrowser(options);
      },
    });
    await openSidebarTabs(w);
    await press(row(front(w), saved!.title));
    return { saved: saved!, w };
  }

  it("opens, restores in place without remounting the conversation, and shows the page", async () => {
    const { saved, w } = await openSaved();
    const page = w.stack.top;
    expect(front(w).textContent).toContain("Opening…");
    expect(w.calls.activations).toEqual([saved.tabId]);
    expect(front(w).querySelector("[data-page]")).toBeNull();
    const panes = [...harness.paneMounts];
    await act(async () => w.host.finishBrowserActivation());
    await settle();
    expect(w.stack.top.key).toBe(page.key);
    expect(w.stack.top.params).toMatchObject({ sessionId: saved.sessionId, tabId: saved.tabId });
    expect(
      front(w).querySelector(`[data-page="${saved.sessionId}:${saved.tabId}"]`),
    ).not.toBeNull();
    expect(harness.paneMounts).toEqual(panes);
    expect(w.calls.activations).toEqual([saved.tabId]);
    expect(w.calls.viewers).toContain(`${saved.sessionId}:${saved.tabId}`);
    w.record("J3 restore");
  });

  it("closes an offline saved tab from its menu without starting its browser", async () => {
    const { saved, w } = await openSaved({ profileName: "Work", connected: false });
    const close = vi.spyOn(w.host, "closeWorkspaceTabs");
    await press(control(front(w), "Close tab"));
    expect(close).toHaveBeenCalledExactlyOnceWith([saved.tabId]);
    expect(w.stack.top.name).toBe("Tabs");
    expect(
      placeList(w.host.getSnapshot()).some(
        (place) => place.destination.kind === "browser" && place.destination.tabId === saved.tabId,
      ),
    ).toBe(false);
    expect(() => w.host.finishBrowserActivation()).toThrow("No browser activation is pending.");
    w.record("J3 close saved tab");
  });

  it("waits for an offline computer without asking, then asks once it connects", async () => {
    const { saved, w } = await openSaved({ profileName: "Work", connected: false });
    expect(front(w).textContent).toMatch(/Waiting for .+…/u);
    expect(() => w.host.finishBrowserActivation()).toThrow("No browser activation is pending.");
    await act(async () => w.host.setDormantBrowserState({ connected: true }));
    await settle();
    expect(front(w).textContent).toContain("Opening…");
    await act(async () => w.host.finishBrowserActivation());
    await settle();
    expect(
      front(w).querySelector(`[data-page="${saved.sessionId}:${saved.tabId}"]`),
    ).not.toBeNull();
    w.record("J3 offline then online");
  });

  it("retries a failed saved-tab close without restarting its browser", async () => {
    const { saved, w } = await openSaved({ profileName: "Work", connected: false });
    const close = vi.spyOn(w.host, "closeWorkspaceTabs").mockResolvedValueOnce({
      closed: [],
      failed: [{ tabId: saved.tabId, message: "The close was interrupted." }],
    });
    await press(control(front(w), "Close tab"));
    expect(front(w).textContent).toContain("The close was interrupted.");
    await press(control(front(w), "Try again"));
    expect(close).toHaveBeenCalledTimes(2);
    expect(w.calls.activations).toEqual([saved.tabId]);
    expect(w.stack.top.name).toBe("Tabs");
    w.record("J3 retry close");
  });

  it("states a lasting reason and never asks", async () => {
    const { w } = await openSaved({
      profileName: "Work",
      unavailableReason: "This computer no longer keeps browsers.",
    });
    expect(front(w).textContent).toContain("This computer no longer keeps browsers.");
    expect(find(front(w), "Try again")).toBeUndefined();
    expect(w.calls.activations).toEqual([]);
    w.record("J3 lasting reason");
  });

  it("shows a failure with Try again, which asks again", async () => {
    const { saved, w } = await openSaved();
    await act(async () => w.host.finishBrowserActivation("The browser could not start."));
    await settle();
    expect(front(w).textContent).toContain("The browser could not start.");
    await press(control(front(w), "Try again"));
    expect(w.calls.activations).toEqual([saved.tabId, saved.tabId]);
    await act(async () => w.host.finishBrowserActivation());
    await settle();
    expect(
      front(w).querySelector(`[data-page="${saved.sessionId}:${saved.tabId}"]`),
    ).not.toBeNull();
    w.record("J3 failure and retry");
  });

  it("does not navigate a person who left before it finished", async () => {
    const { w } = await openSaved();
    await act(async () => w.stack.navigation(w.stack.top.key).goBack());
    await settle();
    const trace = w.stack.trace.length;
    await act(async () => w.host.finishBrowserActivation());
    await settle();
    expect(w.stack.trace.length).toBe(trace);
    expect(w.stack.top.name).toBe("Tabs");
    w.record("J3 left early");
  });

  it("says a tab closed while opening is closed, and never shows a sibling", async () => {
    const { saved, w } = await openSaved();
    const routes = JSON.stringify(w.stack.routes);
    await act(async () => w.host.setDormantBrowserState({ closed: true }));
    await settle();
    expect(front(w).textContent).toContain("This tab was closed");
    expect(JSON.stringify(w.stack.routes)).toBe(routes);
    expect(front(w).querySelector("[data-page]")).toBeNull();
    expect(w.host.getSnapshot().activatingWorkspaceTabs ?? []).not.toContain(saved.tabId);
    w.record("J3 closed while opening");
  });

  it("drops a restore when the account changes, and navigates nobody", async () => {
    const { w } = await openSaved();
    const trace = w.stack.trace.length;
    await act(async () => w.host.setDormantBrowserState({ accountChanged: true }));
    await settle();
    expect(w.stack.trace.slice(trace).filter(({ action }) => action !== "SET_PARAMS")).toEqual([]);
    expect(w.stack.trace.slice(trace).filter(({ action }) => action === "SET_PARAMS")).toEqual([]);
    w.record("J3 account change");
  });
});

/** The task session that holds Notes on the Mac mini, beside the person's own view. */
function notesTaskSession(w: World): string {
  const session = w.host
    .getSnapshot()
    .machines.flatMap((machine) => machine.computerUse?.sessions ?? [])
    .find((candidate) => candidate.apps.some((app) => app.bundleId === "com.apple.Notes"));
  if (!session) throw new Error("No task holds Notes in the mock.");
  return session.sessionId;
}

describe("J6: native views keep their own authority", () => {
  async function ownerNotes() {
    let viewId = "";
    let generation = 0;
    const w = await world({
      prepare: async (host) => {
        const mini = host.getSnapshot().machines.find(({ name }) => name === "Mac mini")!;
        const view = await host.openComputerView(mini.id, {
          app: { bundleId: "com.apple.Notes", displayName: "Notes", teamId: null },
          kind: "app",
        });
        viewId = view.viewId;
        generation = view.generation;
      },
    });
    await openSidebarTabs(w);
    // The list holds no lease on the view; the page opened from it does.
    expect(w.calls.ownerRetains).toEqual([]);
    await press(ownerRow(front(w), "Notes — Shopping list"));
    return { generation, viewId, w };
  }

  it("opens the person's own Mac view from Tabs by its exact generation, never a task's session (iOS gate kept)", async () => {
    const { generation, viewId, w } = await ownerNotes();
    expect(w.stack.top.params).toMatchObject({
      appKey: "com.apple.notes",
      generation,
      scope: "workspace",
      viewId,
    });
    expect(w.stack.top.params?.["computerSessionId"]).toBeUndefined();
    expect(front(w).textContent).toContain(
      "Mac window video is unavailable on iOS in this release.",
    );
    // No picture of Notes is asked for on iOS, by the person's view or a task's.
    expect(
      w.calls.displays.filter(
        (source) => source.includes(viewId) || source.includes(notesTaskSession(w)),
      ),
    ).toEqual([]);
    expect(w.calls.ownerRetains).toContain(`${viewId}:${generation}`);
    w.record("J6 owner view iOS");
  });

  it("streams exactly the owner view on Android and ends with it rather than falling back", async () => {
    harness.platform = "android";
    const { generation, viewId, w } = await ownerNotes();
    const page = front(w);
    expect(w.calls.displays.map((source) => JSON.parse(source))).toContainEqual({
      generation,
      kind: "owner-view",
      viewId,
    });
    const notes = notesTaskSession(w);
    expect(w.calls.displays.some((source) => source.includes(notes))).toBe(false);
    await act(async () => {
      await w.host.closeComputerView(viewId, generation);
    });
    await settle();
    expect(page.textContent).toContain("This view has ended");
    // The task holding Notes is still there; its session is never borrowed.
    expect(w.calls.displays.some((source) => source.includes(notes))).toBe(false);
    w.record("J6 owner view Android");
  });

  it("opens a task's app from Tabs through that task's own session", async () => {
    harness.platform = "android";
    const w = await world();
    await openSidebarTabs(w);
    const slack = placeList(w.host.getSnapshot()).find(({ title }) => title === "Slack — #launch")!;
    if (slack.destination.kind !== "app") throw new Error("Slack is not an app here.");
    const session = slack.destination.computerSessionId;
    await press(row(front(w), "Slack — #launch"));
    expect(w.stack.top.params).toEqual({
      appKey: "com.tinyspeck.slackmacgap",
      computerSessionId: session,
      deploymentId,
      machineId: slack.destination.machineId,
      scope: "workspace",
    });
    expect(w.calls.displays.map((source) => JSON.parse(source))).toContainEqual({
      appKey: "com.tinyspeck.slackmacgap",
      kind: "task-session",
      sessionId: session,
    });
    w.record("J6 task app");
  });
});

describe("J7: a task's page from Tabs, beside its occupant's thread only where two fit", () => {
  it("keeps the page and the occupant's thread mounted through side by side, tabletop and the keyboard", async () => {
    const w = await world({
      routes: [
        { name: "Home", params: { deploymentId } },
        { name: "Tabs", params: { deploymentId } },
      ],
    });
    const snapshot = w.host.getSnapshot();
    const occupant = threadTitled(snapshot, "Switch Slack to Opensteer");
    const place = placeList(snapshot).find(({ title }) => title === "Le Petit Jardin")!;
    await press(row(front(w), "Le Petit Jardin"));
    expect(w.stack.top.params).toEqual(aloneRoute(place));
    const screen = front(w);
    const beside = () => harness.paneMounts.filter((mount) => mount.endsWith(":companion"));
    // A phone: the page alone.
    expect(screen.querySelector('[data-testid="pair-stacked"]')).not.toBeNull();
    expect(beside()).toEqual([]);
    // Room for two: the occupant's own thread beside the page.
    harness.pair = { height: 1000, width: 744 };
    await w.render();
    expect(screen.querySelector('[data-testid="pair-side"]')).not.toBeNull();
    expect(beside()).toEqual([`${occupant}:companion`]);
    harness.pair = { height: 900, width: 900 };
    harness.regions = [
      { frame: { height: 20, width: 900, x: 0, y: 420 }, kind: "division", occludesContent: false },
    ];
    await w.render();
    expect(screen.querySelector('[data-testid="pair-tabletop"]')).not.toBeNull();
    harness.keyboard = true;
    await w.render();
    harness.keyboard = false;
    harness.regions = [];
    harness.pair = { height: 1000, width: 744 };
    await w.render();
    // The same thread, never mounted again, and the same page throughout.
    expect(beside()).toEqual([`${occupant}:companion`]);
    expect(harness.pageMounts).toHaveLength(1);
    w.record("J7 layouts");
  });
});

describe("J8: one sidebar switches between tasks and tabs", () => {
  it("docks beside a tab chosen from it, switches straight to a task and back, and keeps the page through a fold", async () => {
    harness.frame = { height: 1133, width: 744 };
    harness.pair = { height: 1133, width: 424 };
    const w = await world();
    const home = w.stack.routes[0]!;
    const snapshot = w.host.getSnapshot();
    const places = placeList(snapshot);
    // Two live pages among the few the sidebar lists before All tabs.
    const [roadmap, dinner] = places
      .slice(0, 5)
      .filter(
        (place) =>
          place.kind === "browser" &&
          place.availability === "ready" &&
          place.workspaceTab?.state !== "suspended",
      );
    if (roadmap === undefined || dinner === undefined) throw new Error("Too few live tabs.");
    const later = places.slice(5).find((place) => place.kind === "browser")!;
    const taskA = threadTitled(snapshot, "Switch Slack to Opensteer");

    // The tab, exactly, beside the sidebar; nothing else comes with it.
    await press(row(dockedSidebar(w), roadmap.title));
    expect(w.stack.routes.map(({ name, params }) => [name, params])).toEqual([
      ["Home", { deploymentId }],
      ["WorkspaceBrowser", aloneRoute(roadmap)],
    ]);
    expect(front(w).querySelector("[data-page]")).not.toBeNull();
    expect(front(w).querySelector('[data-testid="conversation-slot"]')).toBeNull();
    expect(row(dockedSidebar(w), roadmap.title).getAttribute("aria-selected")).toBe("true");
    expect(row(dockedSidebar(w), dinner.title).getAttribute("aria-selected")).toBe("false");

    // Straight to a task, and straight to another tab: each in place of the last.
    await press(row(dockedSidebar(w), "Switch Slack to Opensteer"));
    expect(w.stack.routes.map(({ name }) => name)).toEqual(["Home", "Thread"]);
    expect(w.stack.top.params).toMatchObject({ threadId: taskA });
    await press(row(dockedSidebar(w), dinner.title));
    expect(w.stack.routes.map(({ name, params }) => [name, params])).toEqual([
      ["Home", { deploymentId }],
      ["WorkspaceBrowser", aloneRoute(dinner)],
    ]);
    expect(w.stack.routes[0]!.key).toBe(home.key);
    expect(row(dockedSidebar(w), dinner.title).getAttribute("aria-selected")).toBe("true");

    // Folded to the cover screen: the same page, in front, with the sidebar a drawer.
    const pages = [...harness.pageMounts];
    harness.frame = { height: 748, width: 344 };
    await w.render();
    expect(w.container.querySelector('[data-testid="sidebar-column"]')).toBeNull();
    expect(w.stack.top.params).toEqual(aloneRoute(dinner));
    expect(harness.pageMounts).toEqual(pages);
    expect(front(w).querySelector("[data-page]")).not.toBeNull();
    expect(front(w).querySelector('[data-testid="conversation-slot"]')).toBeNull();

    // The overview is still there, as the group's last row.
    harness.frame = { height: 1133, width: 744 };
    await w.render();
    await press(control(dockedSidebar(w), "All tabs"));
    expect(w.stack.routes.map(({ name, params }) => [name, params])).toEqual([
      ["Home", { deploymentId }],
      ["Tabs", { deploymentId }],
    ]);
    // A tab past the few listed, opened from there, is listed while it is open.
    const listed = (title: string) =>
      buttons(dockedSidebar(w)).some((button) =>
        button.getAttribute("aria-label")?.startsWith(`${title}, `),
      );
    expect(listed(later.title)).toBe(false);
    await press(row(front(w), later.title));
    expect(row(dockedSidebar(w), later.title).getAttribute("aria-selected")).toBe("true");
    expect(w.calls.creates).toEqual([]);
    w.record("J8 docked switching");
  });
});
