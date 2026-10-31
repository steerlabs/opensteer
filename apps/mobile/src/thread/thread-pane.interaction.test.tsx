// @vitest-environment happy-dom

import type { VoiceSnapshot } from "@opensteer/client/voice";
import { DictationController } from "@opensteer/client/dictation";
import type { DictationEvent, DictationPort } from "@opensteer/protocol/dictation";
import {
  HostClientRequestError,
  type HostClient,
  type HostSnapshot,
  type MessageEntry,
  type ReasoningEntry,
  type RequestReceiptEntry,
  type RunEntry,
  type ToolEntry,
  type TranscriptEntry,
} from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { MemoryPrivateFilesystem } from "@opensteer/client/test-support";
import {
  AssignmentSummarySchema,
  createId,
  RunIdSchema,
  ThreadIdSchema,
  WorkspaceIdSchema,
  WaitingRequestSchema,
  type Request,
  type ThreadInputQueue,
} from "@opensteer/core";
import type { ComputerUseSessionSummary, MachineSummary } from "@opensteer/protocol";
import { act, useState, type ReactNode, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createThreadDraftStore, type ThreadDraftStore } from "../client/thread-drafts.js";
import type { ThreadHeaderState } from "./thread-pane.js";
import { VoiceContext, VoiceOverlay, type VoiceControls } from "../voice/controls.js";

/*
 * One conversation on the phone, drawn by the real pane, transcript, composer
 * and queue tray against a Host whose snapshot the test moves. Native controls
 * are DOM stand-ins that keep their labels and their presses.
 *
 * What can go wrong in Chat:
 *   - a message sent while Opensteer is replying hides in a queue tray, or is
 *     offered Steer, Edit, Remove or Resume;
 *   - the reply's steps, counters or durations show in the conversation, or a
 *     "Show steps" row stands under a reply;
 *   - the typing bubble shows the reply's work, or opens anything but its
 *     Activity; the conversation's name poses as a control;
 *   - typing beside an approval answers the approval;
 *   - a steering decision the previous release saved is sent again, or wedges
 *     the composer on "This request can no longer accept that answer";
 *   - a link to something said on the way to a reply lands nowhere;
 *   - a link to an approval already answered lands on the wrong row, never
 *     opens the Activity holding it, or pages history for a row that will
 *     never be drawn; a link to one still waiting jumps once it is answered;
 *   - a reply at work on a Mac this reader is not shown, or no longer shown,
 *     leaves an empty row between the person's messages;
 *   - Stop pauses Chat and asks for Resume before the next message.
 *   - replies in one Run borrow each other's app and phone chips, or lose
 *     chips from a stretch before a message that joined the reply.
 * What can go wrong in a task: any of that leaks into it, and its tray loses
 * a control.
 */

const harness = vi.hoisted(() => ({
  paneRenders: 0,
  headerWrites: 0,
  focused: true,
  drafts: null as ThreadDraftStore | null,
  focusCleanups: new Set<() => void>(),
  select: null as
    null | ((event: { nativeEvent: { selection: { start: number; end: number } } }) => void),
  navigate: vi.fn(),
  dispatch: vi.fn(),
  setParams: vi.fn(),
  scrollToIndex: vi.fn(),
  scrollToOffset: vi.fn(),
  dismissModal: null as (() => void) | null,
  handles: new Map<number, HTMLElement>(),
  /** The pane's own insets: its safe area and anything reserved over it. */
  insets: { bottom: 0, left: 0, right: 0, top: 0 },
  /** Where the screen's bar options go, as the native stack would take them. */
  setOptions: null as ((options: Record<string, unknown>) => void) | null,
  /** The transcript list's props as last rendered, to drive its native events. */
  list: null as null | {
    readonly contentContainerStyle?: unknown;
    readonly onContentSizeChange?: (width: number, height: number) => void;
    readonly onLayout?: (event: {
      nativeEvent: { layout: { height: number; width: number } };
    }) => void;
    readonly onScroll?: (event: object) => void;
    readonly onScrollBeginDrag?: () => void;
    readonly onScrollEndDrag?: () => void;
  },
}));

const selectionCalls: { text: string | undefined; start: number; end: number }[] = [];
let dictation = new DictationController({ port: null, createId: () => crypto.randomUUID() });
vi.mock("../dictation/context.js", () => ({ useDictation: () => dictation }));

vi.mock("react-native", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  type Children = { readonly children?: ReactNode };
  return {
    AccessibilityInfo: {
      announceForAccessibility: vi.fn(),
      setAccessibilityFocus: vi.fn(),
      announceForAccessibilityWithOptions: vi.fn(),
    },
    ActivityIndicator: () => null,
    Alert: { alert: vi.fn() },
    AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: "active" },
    FlatList: (props: {
      readonly data: readonly unknown[];
      readonly keyExtractor: (item: unknown) => string;
      readonly ListEmptyComponent?: ReactNode;
      readonly ListHeaderComponent?: ReactNode;
      readonly ref?: Ref<unknown>;
      readonly renderItem: (info: { readonly index: number; readonly item: unknown }) => ReactNode;
    }) => {
      React.useImperativeHandle(props.ref, () => ({
        scrollToIndex: harness.scrollToIndex,
        scrollToOffset: harness.scrollToOffset,
      }));
      harness.list = props as NonNullable<typeof harness.list>;
      return (
        <div>
          {props.ListHeaderComponent}
          {props.data.length === 0
            ? props.ListEmptyComponent
            : props.data.map((item, index) => (
                <div data-row={props.keyExtractor(item)} key={props.keyExtractor(item)}>
                  {props.renderItem({ index, item })}
                </div>
              ))}
        </div>
      );
    },
    // A tab preview's picture, once a frame reaches it.
    Image: (props: { readonly accessibilityLabel?: string }) => (
      <img alt={props.accessibilityLabel ?? ""} />
    ),
    Keyboard: { addListener: () => ({ remove: () => undefined }), isVisible: () => false },
    findNodeHandle: (node: HTMLElement | null) => {
      if (!node?.isConnected) return null;
      const handle = harness.handles.size + 1;
      harness.handles.set(handle, node);
      return handle;
    },
    Modal: (props: Children & { readonly visible?: boolean; readonly onDismiss?: () => void }) => {
      React.useEffect(() => {
        harness.dismissModal = props.visible === false ? () => props.onDismiss?.() : null;
        return () => {
          harness.dismissModal = null;
        };
      }, [props.visible, props.onDismiss]);
      return <div data-modal-visible={props.visible !== false}>{props.children}</div>;
    },
    ScrollView: ({ children }: Children) => <div>{children}</div>,
    KeyboardAvoidingView: ({ children }: Children) => <div>{children}</div>,
    PanResponder: { create: () => ({ panHandlers: {} }) },
    PixelRatio: { get: () => 3 },
    Platform: { OS: "ios", select: (choices: { default?: unknown; ios?: unknown }) => choices.ios },
    Pressable: (props: {
      readonly accessibilityHint?: string;
      readonly accessibilityLabel?: string;
      readonly accessibilityState?: { readonly disabled?: boolean; readonly expanded?: boolean };
      readonly children?: ReactNode | ((state: { pressed: boolean }) => ReactNode);
      readonly disabled?: boolean;
      readonly onPress?: () => void;
    }) => (
      <button
        aria-description={props.accessibilityHint}
        aria-expanded={props.accessibilityState?.expanded}
        aria-label={props.accessibilityLabel}
        disabled={props.disabled}
        onClick={props.onPress}
      >
        {typeof props.children === "function" ? props.children({ pressed: false }) : props.children}
      </button>
    ),
    Share: { share: vi.fn(async () => undefined) },
    StyleSheet: { create: (styles: object) => styles, hairlineWidth: 1 },
    Text: ({ children }: Children) => <span>{children}</span>,
    TextInput: (props: {
      readonly ref?: Ref<unknown>;
      readonly onSelectionChange?: (event: {
        nativeEvent: { selection: { start: number; end: number } };
      }) => void;
      readonly accessibilityLabel?: string;
      readonly onChangeText?: (text: string) => void;
      readonly placeholder?: string;
      readonly value?: string;
    }) => {
      harness.select = props.onSelectionChange ?? null;
      React.useImperativeHandle(props.ref, () => ({
        focus: () => undefined,
        setSelection: (start: number, end: number) =>
          selectionCalls.push({ text: props.value, start, end }),
      }));
      return (
        <textarea
          aria-label={props.accessibilityLabel}
          onChange={(event) => props.onChangeText?.(event.currentTarget.value)}
          onSelect={(event) =>
            props.onSelectionChange?.({
              nativeEvent: {
                selection: {
                  start: event.currentTarget.selectionStart,
                  end: event.currentTarget.selectionEnd,
                },
              },
            })
          }
          placeholder={props.placeholder}
          value={props.value}
        />
      );
    },
    useWindowDimensions: () => ({ fontScale: 1, height: 844, scale: 3, width: 390 }),
    // A row's air above it is all a test reads of its style.
    View: (
      props: Children & {
        readonly accessibilityLabel?: string;
        readonly style?: unknown;
        readonly ref?: Ref<HTMLDivElement>;
        readonly testID?: string;
      },
    ) => (
      <div
        ref={props.ref}
        aria-label={props.accessibilityLabel}
        data-margin-top={marginTopOf(props.style)}
        data-style={props.testID === undefined ? undefined : JSON.stringify(flatten(props.style))}
        data-testid={props.testID}
      >
        {props.children}
      </div>
    ),
  };
});
/** Style arrays as React Native merges them, so a test can read the result. */
function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  return typeof style === "object" && style !== null ? (style as Record<string, unknown>) : {};
}
function marginTopOf(style: unknown): number | undefined {
  const layers = (Array.isArray(style) ? style.flat(3) : [style]) as unknown[];
  for (const layer of layers.reverse()) {
    if (typeof layer === "object" && layer !== null && "marginTop" in layer) {
      const value = (layer as { readonly marginTop?: unknown }).marginTop;
      if (typeof value === "number") return value;
    }
  }
  return undefined;
}
vi.mock("react-native-reanimated", () => {
  const View = (props: { readonly accessibilityLabel?: string; readonly children?: ReactNode }) => (
    <div aria-label={props.accessibilityLabel}>{props.children}</div>
  );
  const transition = { duration: () => undefined };
  return {
    default: { View },
    Easing: { inOut: () => undefined, sin: () => undefined, linear: () => undefined },
    cancelAnimation: () => undefined,
    withRepeat: (value: number) => value,
    LayoutAnimationConfig: ({ children }: { children?: ReactNode }) => <>{children}</>,
    FadeOutDown: transition,
    FadeOutUp: transition,
    LinearTransition: transition,
    useAnimatedStyle: () => ({}),
    useReducedMotion: () => true,
    useSharedValue: (value: number) => ({ value }),
    withTiming: (value: number) => value,
  };
});
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaProvider: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SafeAreaView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));
vi.mock("@react-navigation/elements", () => ({
  useHeaderHeight: () => {
    harness.paneRenders += 1;
    return 0;
  },
}));
vi.mock("@react-navigation/native", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  const navigation = {
    dispatch: harness.dispatch,
    // The conversation is the screen in front: a chip opens over it.
    getState: () => ({ index: 0, routes: [{ name: "Thread" }] }),
    navigate: harness.navigate,
    setOptions: (options: Record<string, unknown>) => {
      harness.headerWrites += 1;
      harness.setOptions?.(options);
    },
    setParams: harness.setParams,
  };
  return {
    StackActions: {
      popTo: (name: string, params: object) => ({ name, params, type: "POP_TO" }),
      push: (name: string, params: object) => ({ name, params, type: "PUSH" }),
    },
    useFocusEffect: (effect: () => (() => void) | undefined) =>
      React.useEffect(() => {
        const cleanup = effect();
        if (cleanup) harness.focusCleanups.add(cleanup);
        return () => {
          if (cleanup) {
            harness.focusCleanups.delete(cleanup);
            cleanup();
          }
        };
      }, [effect]),
    useIsFocused: () => harness.focused,
    // One object for the screen's life, as the real hook returns.
    useNavigation: () => navigation,
  };
});
vi.mock("../ui/glass.js", () => ({ useLiquidGlass: () => false }));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: (props: {
    readonly actions: readonly {
      readonly id?: string;
      readonly title: string;
      readonly subactions?: readonly { readonly id?: string; readonly title: string }[];
    }[];
    readonly children?: ReactNode;
    readonly onPressAction?: (event: { readonly nativeEvent: { readonly event: string } }) => void;
  }) => (
    <div>
      {props.children}
      {props.actions
        .flatMap((action) => [action, ...(action.subactions ?? [])])
        .map((action) => (
          <button
            key={action.id ?? action.title}
            onClick={() =>
              props.onPressAction?.({ nativeEvent: { event: action.id ?? action.title } })
            }
          >
            {action.title}
          </button>
        ))}
    </div>
  ),
}));
vi.mock("../computers/phone-display-native.js", () => ({ nativePictureView: () => null }));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock("expo-haptics", () => ({
  ImpactFeedbackStyle: { Heavy: "heavy", Light: "light", Medium: "medium" },
  NotificationFeedbackType: { Error: "error", Success: "success", Warning: "warning" },
  impactAsync: vi.fn(async () => undefined),
  notificationAsync: vi.fn(async () => undefined),
  selectionAsync: vi.fn(async () => undefined),
}));
vi.mock("../client/mobile-client.js", () => ({
  operationDetail: (error: unknown, fallback: string) =>
    error instanceof Error && error.message ? error.message : fallback,
}));
vi.mock("../platform/attachment-draft-files.js", () => ({
  openChatDraftFile: vi.fn(),
  pickChatFile: vi.fn(async () => null),
  pickChatPhoto: vi.fn(async () => null),
  removeChatDraftFile: vi.fn(),
}));
vi.mock("../ui/mobile-client-context.js", () => ({
  useHostUserId: (client: HostClient | null) => client?.getSnapshot().user?.id ?? null,
  useHostValue: <T,>(client: HostClient | null, select: (snapshot: never) => T, fallback: T) =>
    client === null ? fallback : select(client.getSnapshot() as never),
  useMobileClient: () => ({ drafts: harness.drafts }),
}));
vi.mock("../ui/notifications-context.js", () => ({
  useMobileNotifications: () => ({
    enterThread: () => () => undefined,
    readingLatest: () => undefined,
  }),
}));
vi.mock("../ui/keyboard.js", () => ({ useKeyboardVisible: () => false }));
vi.mock("../ui/pane.js", () => ({
  useContentInsets: () => harness.insets,
  usePaneGeometry: () => "",
}));
vi.mock("../ui/screen.js", () => ({ useGutter: () => 16, useReadingColumn: () => ({}) }));
vi.mock("../sidebar/sidebar-context.js", () => ({ useSidebarVisible: () => false }));
vi.mock("../ui/motion.js", () => ({
  appear: undefined,
  duration: { enter: 0, exit: 0 },
  enter: undefined,
  exit: undefined,
}));
vi.mock("../ui/primitives.js", () => ({
  AppText: (props: { readonly accessibilityLabel?: string; readonly children?: ReactNode }) => (
    <span aria-label={props.accessibilityLabel}>{props.children}</span>
  ),
  Field: (props: {
    readonly label: string;
    readonly input: { readonly value?: string; readonly onChangeText?: (value: string) => void };
  }) => (
    <textarea
      aria-label={props.label}
      value={props.input.value}
      onChange={(event) => props.input.onChangeText?.(event.currentTarget.value)}
    />
  ),
  PrimaryButton: (props: {
    readonly label: string;
    readonly onPress: () => void;
    readonly disabled?: boolean;
  }) => (
    <button disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
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
  WorkspaceMark: () => null,
  WorkspaceIconGlyph: (props: { icon: string; color: string }) => (
    <svg data-icon={props.icon} color={props.color} />
  ),
}));
vi.mock("../markdown/markdown.js", () => ({
  Markdown: ({ text }: { readonly text: string }) => <p>{text}</p>,
  PlainProse: ({ text }: { readonly text: string }) => <p>{text}</p>,
}));
// The menus a reply carries, item for item as `messageActions` titles them.
vi.mock("./message-menu.js", async () => {
  const actions = await vi.importActual<typeof import("./message-menu-actions.js")>(
    "./message-menu-actions.js",
  );
  return {
    MessageMenu: (props: import("./message-menu-actions.js").MessageMenuOptions) => (
      <div aria-label="Message actions">
        {actions.messageActions(props).map((action) => (
          <button key={action.id} onClick={() => actions.performMessageAction(action.id, props)}>
            {action.title}
          </button>
        ))}
      </div>
    ),
  };
});
vi.mock("./attachment-views.js", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    AttachmentReader: React.createContext<HostClient | null>(null),
    AttachmentStrip: () => null,
    MessageAttachments: () => null,
  };
});
vi.mock("./task-line.js", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  const actual = await vi.importActual<typeof import("./task-line.js")>("./task-line.js");
  return {
    ...actual,
    AssignmentLines: () => null,
    TaskScopeContext: React.createContext(null),
  };
});
vi.mock("./waiting-questions.js", () => ({ WaitingQuestions: () => null }));
vi.mock("./composer-bar.js", () => ({
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
  ComposerCircleFace: () => null,
  composerControlStyle: {},
  composerLaneHeight: 36,
}));
vi.mock("./composer-menu.js", () => ({
  NativeMenu: (props: {
    readonly options: readonly {
      readonly disabled?: boolean;
      readonly id: string;
      readonly label: string;
      readonly onPress: () => void;
    }[];
  }) => (
    <div aria-label="Thread actions">
      {props.options.map((option) => (
        <button disabled={option.disabled} key={option.id} onClick={option.onPress}>
          {option.label}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("./composer-pills.js", () => ({ ComposerPills: () => null }));
vi.mock("../ui/composer-action.js", () => ({
  ComposerAction: (props: {
    readonly disabled: boolean;
    readonly kind: "send" | "stop";
    readonly label: string;
    readonly onPress: () => void;
  }) => (
    <button
      aria-label={props.label}
      data-kind={props.kind}
      disabled={props.disabled}
      onClick={props.onPress}
    >
      {props.kind}
    </button>
  ),
}));
// The docked approval keeps its own explicit buttons; it is drawn by its title here.
vi.mock("./request-card.js", () => ({
  RequestCard: (props: {
    readonly surface: { readonly request: { readonly presentation: { readonly title: string } } };
  }) => <section aria-label="Docked request">{props.surface.request.presentation.title}</section>,
}));

const { ThreadPane } = await import("./thread-pane.js");
const { useScopedThreadHeader, useThreadHeader } = await import("../screens/thread-header.js");

/**
 * The conversation as a Thread screen draws it: the pane, and the native bar
 * the screen configures from what the pane reports — the task's title and its
 * menu, Retry, and Pages — drawn here from the options the bar would take.
 */
function WithNativeHeader(props: {
  readonly hostClient: HostClient;
  readonly onHeader: (header: ThreadHeaderState) => void;
  readonly pane: (onHeader: (header: ThreadHeaderState) => void) => ReactNode;
  readonly threadId: string;
}): ReactNode {
  const [options, setOptions] = useState<Record<string, unknown>>({});
  harness.setOptions = (next) => setOptions((current) => ({ ...current, ...next }));
  const { header, onHeader } = useScopedThreadHeader(props.hostClient, props.threadId);
  useThreadHeader({
    deploymentId,
    fallbackTitle: "Thread",
    header,
    hostClient: props.hostClient,
    threadId: props.threadId,
  });
  const title = options["headerTitle"];
  const right = options["headerRight"];
  return (
    <>
      <header>
        {typeof title === "function" ? (title as () => ReactNode)() : (title as ReactNode)}
        {typeof right === "function" ? (right as () => ReactNode)() : null}
      </header>
      {props.pane((next) => {
        props.onHeader(next);
        onHeader(next);
      })}
    </>
  );
}

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  dictation.dispose();
  dictation = new DictationController({ port: null, createId: () => crypto.randomUUID() });
  document.body.replaceChildren();
  harness.drafts = null;
  harness.focused = true;
  harness.dismissModal = null;
  harness.handles.clear();
  harness.navigate.mockReset();
  harness.dispatch.mockReset();
  harness.setParams.mockReset();
  harness.scrollToIndex.mockReset();
  harness.scrollToOffset.mockReset();
  harness.insets = { bottom: 0, left: 0, right: 0, top: 0 };
  harness.list = null;
  harness.setOptions = null;
});

const deploymentId = "dep_0192f4a1-1111-4000-8000-000000000001";
const base = new MockHostClient({ automations: "absent", latencyMs: 0 }).getSnapshot();
const viewer = base.user;
if (viewer === null) throw new Error("The mock Host has no signed-in reader.");
const userId = viewer.id;
const chatId = ThreadIdSchema.parse(base.homeThreadId);
const workId = ThreadIdSchema.parse("thr_00000000-0000-4000-8000-000000000004");
const workspaceId = WorkspaceIdSchema.parse(
  base.threads.find(({ id }) => id === chatId)?.workspaceId,
);
const at = "2026-10-09T10:00:00.000Z";
const human = {
  displayName: viewer.displayName,
  kind: "human" as const,
  principalId: `user:${userId}`,
  userId,
};

let sequence = 0;
function said(body: string, runId: string | null): MessageEntry {
  sequence += 1;
  return {
    author: human,
    body,
    createdAt: at,
    id: createId("message"),
    kind: "message",
    messageKind: "input",
    runId,
    sequence: String(sequence),
  };
}
function wrote(body: string, runId: string, threadId = chatId): MessageEntry {
  sequence += 1;
  return {
    author: {
      displayName: "Opensteer",
      kind: "agent",
      runId: RunIdSchema.parse(runId),
      threadId: ThreadIdSchema.parse(threadId),
      workspaceId,
      workspaceName: "Main",
    },
    body,
    createdAt: at,
    id: createId("message"),
    kind: "message",
    messageKind: "assistant",
    runId,
    sequence: String(sequence),
  };
}
function ran(runId: string, change: Partial<RunEntry> = {}): RunEntry {
  return {
    createdAt: at,
    error: null,
    id: `run:${runId}`,
    kind: "run",
    replyMessageId: null,
    runId,
    status: "running",
    ...change,
  };
}
function thought(runId: string, text: string): ReasoningEntry {
  return {
    completedAt: at,
    createdAt: at,
    id: `reasoning:${runId}:${text.length}`,
    kind: "reasoning",
    runId,
    state: "done",
    text,
  };
}
function command(runId: string, line: string, running = false): ToolEntry {
  return {
    arguments: { command: line },
    callId: `call-${line}`,
    completedAt: running ? null : at,
    createdAt: at,
    id: `tool:${runId}:${line}`,
    integration: null,
    isError: false,
    kind: "tool",
    output: running ? undefined : { text: "ok" },
    runId,
    state: running ? "running" : "done",
    streamText: "",
    tool: { name: "shell", namespace: "codex" },
  };
}

/** An approval the person already answered, where the transcript records it. */
function answered(runId: string | null, title = "Send the note to Maya?"): RequestReceiptEntry {
  const requestId = createId("request");
  return {
    createdAt: at,
    id: `request:${requestId}`,
    kind: "request",
    outcome: "Allowed once",
    requestId,
    requestKind: "harness.approval",
    runId,
    title,
  };
}
function approval(runId: string, title: string, id = createId("request")): Request {
  return {
    callId: `call-${title}`,
    cancellationReason: null,
    createdAt: at,
    id,
    kind: "harness.approval",
    mode: "live",
    originatingOccurrenceId: null,
    originatingRunId: runId,
    originatingThreadId: chatId,
    originatingWorkspaceId: workspaceId,
    payload: { kind: "harness.approval" },
    presentation: {
      kind: "choice",
      options: [
        { hint: "allow-once", id: "allow", label: "Allow once" },
        { hint: "reject-once", id: "reject", label: "Reject" },
      ],
      risk: "medium",
      title,
    },
    requestedBy: userId,
    requiredActor: "requester",
    resolvedAt: null,
    resolvedBy: null,
    response: null,
    status: "pending",
    targetWorkspaceId: workspaceId,
  } as Request;
}

/** The mock Host's Mac mini: online, able to show a picture, owned by this reader. */
const macMini = base.machines.find(({ name }) => name === "Mac mini");
if (macMini?.computerUse === null || macMini?.computerUse === undefined) {
  throw new Error("The mock Host has no Mac mini with computer use.");
}
function clickingInNotes(runId: string, running: boolean): ToolEntry {
  return {
    arguments: { arguments: {}, toolRef: "igr_x.itl_y.z" },
    callId: `call-notes-${runId}`,
    completedAt: running ? null : at,
    createdAt: at,
    id: `tool:${runId}:notes`,
    integration: {
      account: "This computer",
      computerApp: {
        app: "Notes",
        bundleId: "com.apple.Notes",
        computer: "Mac mini",
        runnerId: macMini?.id ?? "",
      },
      effect: "write",
      integration: "Computer use",
      operation: { name: "act", title: "Act" },
    },
    isError: false,
    kind: "tool",
    output: running ? undefined : { text: "Clicked" },
    runId,
    state: running ? "running" : "done",
    streamText: "",
    tool: { name: "integration_call", namespace: "opensteer.integrations" },
  } as ToolEntry;
}
function notesSession(runId: string): ComputerUseSessionSummary {
  return {
    actionCount: 1,
    apps: [{ bundleId: "com.apple.Notes", displayName: "Notes", teamId: null }],
    openedAt: at,
    runId,
    sessionId: "cus_00000000-0000-4000-8000-0000000000aa",
    threadId: chatId,
    threadTitle: "Chat",
  } as unknown as ComputerUseSessionSummary;
}
/** This reader's Macs, with the Mac mini as given; null leaves it out, as for a reader who does not own it. */
function macs(mini: Partial<MachineSummary> | null): readonly MachineSummary[] {
  return base.machines.flatMap((machine) =>
    machine.id !== macMini?.id ? [machine] : mini === null ? [] : [{ ...machine, ...mini }],
  );
}
function sessions(list: readonly ComputerUseSessionSummary[]): Partial<MachineSummary> {
  const report = macMini?.computerUse;
  if (!report) throw new Error("The Mac mini reports no computer use.");
  return { computerUse: { ...report, sessions: [...list] } };
}

/** One exchange answered, a second under way with work behind it. */
function chatAtWork() {
  const runA = createId("run");
  const runB = createId("run");
  const askA = said("What's on Thursday?", runA);
  const noteA = wrote("Looking at your calendar first.", runA);
  const replyA = wrote("Design review with Maya at 2:00.", runA);
  const askB = said("Can you draft a note to Maya?", runB);
  const preambleB = wrote("Drafting it now.", runB);
  const entries: TranscriptEntry[] = [
    askA,
    ran(runA, { replyMessageId: replyA.id, status: "completed" }),
    thought(runA, "Thursday has two meetings."),
    noteA,
    command(runA, "calendar thursday"),
    replyA,
    askB,
    ran(runB),
    preambleB,
    command(runB, "draft note", true),
  ];
  return { askA, askB, entries, noteA, preambleB, replyA, runA, runB };
}

function waitingInput(message: MessageEntry, threadId: string): ThreadInputQueue["items"][number] {
  return {
    canCancel: true,
    canMove: true,
    canSteer: true,
    input: {
      assignmentId: null,
      cancelReason: null,
      causalChainId: createId("causalChain"),
      createdAt: at,
      deliveredAt: null,
      messageId: message.id as ThreadInputQueue["items"][number]["input"]["messageId"],
      policy: "queue",
      replyTarget: null,
      runId: null,
      state: "pending",
      threadId: threadId as ThreadInputQueue["threadId"],
      updatedAt: at,
    },
    message: {
      author: human,
      content: [{ text: message.body, type: "text" }],
      createdAt: at,
      id: message.id,
      kind: "input",
      runId: null,
      sequence: message.sequence ?? "1",
      threadId,
    },
  } as ThreadInputQueue["items"][number];
}

function snapshotFor(input: {
  readonly entries: readonly TranscriptEntry[];
  /** The Host holds an earlier page of this transcript than the one loaded. */
  readonly earlier?: boolean;
  readonly machines?: readonly MachineSummary[];
  /** The Thread's environment has gone offline: nothing live can be confirmed. */
  readonly offline?: boolean;
  readonly paused?: boolean;
  readonly queue?: readonly ThreadInputQueue["items"][number][];
  readonly requests?: readonly Request[];
  readonly run: { readonly id: string; readonly status: "running" | "waiting" } | null;
  readonly threadId: string;
}): HostSnapshot {
  const status = input.run === null ? "idle" : input.run.status;
  const environmentId = base.threads.find(({ id }) => id === input.threadId)?.environmentId;
  return {
    ...base,
    assignments: {},
    connection: "connected",
    environments: base.environments.map((environment) =>
      input.offline === true && environment.id === environmentId
        ? { ...environment, status: "disconnected" }
        : environment,
    ),
    machines: [...(input.machines ?? base.machines)],
    transcriptWindows: {
      ...base.transcriptWindows,
      [input.threadId]: {
        byteCount: 0,
        hasMore: input.earlier === true,
        itemCount: input.entries.length,
        nextBefore: input.earlier === true ? "earlier-page" : null,
        threadId: input.threadId,
        totalItems: input.entries.length,
      },
    },
    inputQueues:
      input.queue === undefined
        ? {}
        : {
            [input.threadId]: {
              items: [...input.queue],
              paused: input.paused ?? false,
              steerRunId: input.run?.id ?? null,
              threadId: input.threadId,
            } as ThreadInputQueue,
          },
    network: "online",
    requests: input.requests === undefined ? {} : { [input.threadId]: [...input.requests] },
    runQueue:
      input.run === null
        ? []
        : [
            {
              createdAt: at,
              id: input.run.id,
              runOrdinal: 1,
              status: input.run.status,
              threadId: input.threadId,
            },
          ],
    session: "authenticated",
    threadReadStates: {},
    threads: base.threads.map((thread) =>
      thread.id === input.threadId
        ? { ...thread, inputQueuePaused: input.paused ?? false, status }
        : thread,
    ),
    transcripts: { ...base.transcripts, [input.threadId]: [...input.entries] },
    waitingRequests: [],
  };
}

/** One state object, as a store's snapshot must be. */
const connectingWatch = { error: null, frame: null, status: "connecting" } as const;

/** A Host whose snapshot the test moves, recording what the phone asks of it. */
function fakeHost(initial: HostSnapshot) {
  let snapshot = initial;
  // What the Host answers the next "Load earlier" with: the transcript with that page merged in.
  let earlierPage: HostSnapshot | null = null;
  const listeners = new Set<() => void>();
  const dispatch = vi.fn(async (command: { readonly type: string }) => ({ type: command.type }));
  const stopRun = vi.fn(async (_threadId: string) => undefined);
  const resumeThreadInputQueue = vi.fn(async (_threadId: string) => undefined);
  const loadTranscriptAround = vi.fn(async (_threadId: string, _messageId: string) => undefined);
  const loadEarlierTranscript = vi.fn(async (_threadId: string) => {
    if (earlierPage === null) return;
    snapshot = earlierPage;
    earlierPage = null;
    for (const listener of listeners) listener();
  });
  const stopComputerSession = vi.fn(async (_input: { readonly sessionId: string }) => ({
    data: {},
    ok: true,
  }));
  const client = {
    acceptBrowserWatchFrame: vi.fn(),
    activateThread: vi.fn(),
    // What a mounted tab preview reads: the Host's latest place and a passive picture.
    browserWatchFrames: { get: () => null, subscribe: () => () => undefined },
    browserWatchState: () => connectingWatch,
    cancelThreadInput: vi.fn(async () => undefined),
    latestPlaceOfThread: () => null,
    retainBrowserWatch: vi.fn(() => () => undefined),
    subscribeBrowserWatch: () => () => undefined,
    subscribeLatestPlace: () => () => undefined,
    dispatch,
    getSnapshot: () => snapshot,
    load: vi.fn(async () => undefined),
    loadEarlierTranscript,
    loadLatestTranscript: vi.fn(async () => undefined),
    loadTranscriptAround,
    markThreadRead: vi.fn(async () => undefined),
    moveThreadInput: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    resumeThreadInputQueue,
    rpc: { "integration.computer.session.stop": stopComputerSession },
    steerThreadInput: vi.fn(async () => undefined),
    stopRun,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    client: client as unknown as HostClient,
    dispatch,
    /** The transcript the Host has once the phone loads its earlier page. */
    holdEarlier(next: HostSnapshot) {
      earlierPage = next;
    },
    loadEarlierTranscript,
    loadTranscriptAround,
    move(next: HostSnapshot) {
      snapshot = next;
      act(() => {
        for (const listener of listeners) listener();
      });
    },
    resumeThreadInputQueue,
    stopComputerSession,
    stopRun,
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(
  host: { readonly client: HostClient },
  threadId: string,
  options: {
    readonly files?: MemoryPrivateFilesystem;
    readonly messageId?: string;
    readonly requestId?: string;
    /** Draws the screen's native bar over the pane, as the Thread screen does. */
    readonly header?: boolean;
  } = {},
) {
  const drafts = createThreadDraftStore({
    filePath: "/private/drafts-v3.json",
    now: () => new Date(at),
    privateFiles: options.files ?? new MemoryPrivateFilesystem(),
  });
  await drafts.load();
  harness.drafts = drafts;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const headers: ThreadHeaderState[] = [];
  const pane = (onHeader: (header: ThreadHeaderState) => void) => (
    <ThreadPane
      deploymentId={deploymentId}
      hostClient={host.client}
      messageId={options.messageId ?? null}
      onAnchorReleased={() => undefined}
      onHeader={onHeader}
      onOpenThread={() => undefined}
      requestId={options.requestId ?? null}
      threadId={threadId}
    />
  );
  await act(async () =>
    root.render(
      options.header === true ? (
        <WithNativeHeader
          hostClient={host.client}
          onHeader={(header) => headers.push(header)}
          pane={pane}
          threadId={threadId}
        />
      ) : (
        pane((header) => headers.push(header))
      ),
    ),
  );
  await settle();
  return { container, drafts, headers, root, pane };
}

function text(container: HTMLElement): string {
  return container.textContent ?? "";
}

function occurrences(container: HTMLElement, words: string): number {
  return text(container).split(words).length - 1;
}

/** The FlatList's rows, by their keys, and each row's air above it. */
function rows(container: HTMLElement): { readonly key: string; readonly top: string }[] {
  return [...container.querySelectorAll<HTMLElement>("[data-row]")].map((row) => ({
    key: row.dataset["row"] ?? "",
    top: (row.firstElementChild as HTMLElement | null)?.dataset["marginTop"] ?? "",
  }));
}

/** A control by its accessibility label, or else by its words. */
function button(container: HTMLElement, name: string): HTMLButtonElement {
  const buttons = [...container.querySelectorAll("button")];
  const found =
    buttons.find((candidate) => candidate.getAttribute("aria-label") === name) ??
    buttons.find((candidate) => candidate.textContent?.trim() === name);
  if (!found) throw new Error(`No control named ${name}`);
  return found;
}

function hasButton(container: HTMLElement, name: string): boolean {
  return [...container.querySelectorAll("button")].some(
    (candidate) =>
      candidate.getAttribute("aria-label") === name || candidate.textContent?.trim() === name,
  );
}

async function press(container: HTMLElement, name: string): Promise<void> {
  const target = button(container, name);
  await act(async () => target.click());
  await settle();
}

async function type(container: HTMLElement, label: string, words: string): Promise<void> {
  const field = container.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`);
  if (field === null) throw new Error(`No field named ${label}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      field,
      words,
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

function sent(dispatch: ReturnType<typeof fakeHost>["dispatch"]): readonly string[] {
  return dispatch.mock.calls.map(([command]) => command.type);
}

const queueControls = [
  "Queued",
  "Paused",
  "Resume",
  "Steer into this turn",
  "Edit",
  "Remove",
] as const;

it("counts each tab in the Tabs control, which always opens the collection, and the preview opens the tab", async () => {
  const source = snapshotFor({ entries: [], run: null, threadId: workId, machines: [] });
  const template = base.browserSessions.find(
    (session) => session.state === "ready" && session.tabs.length > 0,
  )!;
  const first = template.tabs[0]!;
  const second = { ...first, id: (first.id + "-second") as typeof first.id, active: false };
  const session = {
    ...template,
    attachedRunIds: [],
    threadIds: [workId],
    uses: [],
    tabCatalog: undefined,
    tabs: [first, second],
  };
  const { tabCatalog: _catalog, ...withoutCatalog } = session;
  const host = fakeHost({ ...source, browserSessions: [withoutCatalog] });
  const { container, headers } = await mount(host, workId, { header: true });
  expect(headers.at(-1)).toMatchObject({ surfaceCount: 2, surfacesActing: false });
  await press(container, "Tabs");
  expect(harness.dispatch).toHaveBeenLastCalledWith(
    expect.objectContaining({
      name: "WorkspaceBrowser",
      params: { deploymentId, threadId: workId },
    }),
  );
  host.move({ ...source, browserSessions: [{ ...withoutCatalog, tabs: [second] }] });
  await settle();
  expect(headers.at(-1)?.surfaceCount).toBe(1);
  // Even one tab opens the collection from the bar: the bar never jumps past it.
  await press(container, "Tabs");
  expect(harness.dispatch).toHaveBeenLastCalledWith(
    expect.objectContaining({
      name: "WorkspaceBrowser",
      params: { deploymentId, threadId: workId },
    }),
  );
  // The preview above the composer is the way straight to the tab.
  const preview = container.querySelector<HTMLButtonElement>(
    'button[aria-description="Opens this tab"]',
  );
  expect(preview).not.toBeNull();
  await act(async () => preview!.click());
  await settle();
  expect(harness.dispatch).toHaveBeenLastCalledWith(
    expect.objectContaining({
      name: "WorkspaceBrowser",
      params: { deploymentId, threadId: workId, sessionId: session.id, tabId: second.id },
    }),
  );
});

it("does not render the pane for another thread's durable event or streaming append", async () => {
  let snapshot = snapshotFor({
    entries: [said("Keep this conversation", null)],
    run: null,
    threadId: workId,
  });
  const host = fakeHost(snapshot);
  const { container } = await mount(host, workId);
  const renders = harness.paneRenders;
  const backgroundRunId = createId("run");
  const background = wrote("Background reply", backgroundRunId, chatId);
  snapshot = {
    ...snapshot,
    revision: snapshot.revision + 1,
    threads: snapshot.threads.map((thread) =>
      thread.id === chatId ? { ...thread, title: "Background task renamed" } : thread,
    ),
    workspaces: snapshot.workspaces.map((workspace) => ({
      ...workspace,
      updatedAt: "2026-10-29T12:00:00.000Z",
    })),
    transcripts: {
      ...snapshot.transcripts,
      [chatId]: [background],
    },
  };
  host.move(snapshot);
  await settle();
  expect.soft(harness.paneRenders - renders).toBe(0);
  snapshot = {
    ...snapshot,
    transcripts: {
      ...snapshot.transcripts,
      [chatId]: [{ ...background, body: "Background reply keeps streaming" }],
    },
  };
  host.move(snapshot);
  await settle();
  expect.soft(harness.paneRenders - renders).toBe(0);
  expect(text(container)).toContain("Keep this conversation");
});

it("renders this thread's transcript, stream, requests, input queue, run queue and state changes", async () => {
  const runId = createId("run");
  const message = wrote("Reply begins", runId, workId);
  let snapshot = snapshotFor({
    entries: [said("Start work", runId), ran(runId), message],
    run: { id: runId, status: "running" },
    threadId: workId,
  });
  const host = fakeHost(snapshot);
  const { container } = await mount(host, workId);
  const move = async (patch: Partial<HostSnapshot>) => {
    const before = harness.paneRenders;
    snapshot = { ...snapshot, ...patch };
    host.move(snapshot);
    await settle();
    expect(harness.paneRenders).toBeGreaterThan(before);
  };
  await move({
    transcripts: {
      ...snapshot.transcripts,
      [workId]: [...snapshot.transcripts[workId]!, said("New durable message", null)],
    },
  });
  expect(text(container)).toContain("New durable message");
  await move({
    transcripts: {
      ...snapshot.transcripts,
      [workId]: snapshot.transcripts[workId]!.map((entry) =>
        entry.id === message.id ? { ...message, body: "Reply begins and keeps streaming" } : entry,
      ),
    },
  });
  expect(text(container)).toContain("Reply begins and keeps streaming");
  const request = { ...approval(runId, "Review this new approval"), originatingThreadId: workId };
  await move({ requests: { [workId]: [request] } });
  expect(text(container)).toContain("Review this new approval");
  const waiting = said("New queued instruction", null);
  await move({
    inputQueues: {
      [workId]: {
        threadId: workId,
        paused: false,
        steerRunId: runId,
        items: [waitingInput(waiting, workId)],
      } as ThreadInputQueue,
    },
  });
  expect(container.querySelector('[aria-label="Queued messages"]')?.textContent).toContain(
    waiting.body,
  );
  await move({ runQueue: [] });
  expect(hasButton(container, "Stop this run")).toBe(false);
  await move({
    threads: snapshot.threads.map((thread) =>
      thread.id === workId ? { ...thread, status: "archived" } : thread,
    ),
  });
  expect(text(container)).toContain("This thread is archived and cannot take new messages.");
});

describe("Chat while Opensteer is replying", () => {
  it("shows a message sent meanwhile as a sent bubble, with no queue and no way to steer it", async () => {
    const chat = chatAtWork();
    const waiting = said("And move the vendor call", null);
    const host = fakeHost(
      snapshotFor({
        entries: [...chat.entries, waiting],
        queue: [waitingInput(waiting, chatId)],
        run: { id: chat.runB, status: "running" },
        threadId: chatId,
      }),
    );
    const { container, headers } = await mount(host, chatId);

    expect(occurrences(container, waiting.body)).toBe(1);
    for (const control of queueControls) {
      expect(text(container)).not.toContain(control);
      expect(hasButton(container, control)).toBe(false);
    }
    expect(headers.at(-1)).toMatchObject({ title: "Chat", workspaceName: null });
  });

  it("keeps the reply's work out of the conversation: one typing bubble that opens its Activity, no steps, no counters", async () => {
    const chat = chatAtWork();
    const host = fakeHost(
      snapshotFor({
        entries: chat.entries,
        run: { id: chat.runB, status: "running" },
        threadId: chatId,
      }),
    );
    const { container } = await mount(host, chatId);

    const typing = container.querySelectorAll('[aria-label="Opensteer is replying"]');
    expect(typing).toHaveLength(1);
    const opener = typing[0]?.querySelector("button");
    expect(opener?.getAttribute("aria-label")).toBe("Show what Opensteer is doing");
    expect(opener?.textContent?.trim()).toBe("");
    expect(opener?.getAttribute("aria-description")).toMatch(/Run details/);
    expect(text(container)).toContain(chat.replyA.body);
    for (const hidden of [
      chat.noteA.body,
      chat.preambleB.body,
      "Thursday has two meetings.",
      "calendar thursday",
      "Show steps",
      "Hide steps",
      "Worked",
      "Working",
      "error",
    ]) {
      expect(text(container)).not.toContain(hidden);
    }
    expect(container.querySelector('[aria-label="Agent status"]')).toBeNull();
    expect(button(container, "Stop the reply").dataset["kind"]).toBe("stop");

    // The typing, and once the reply lands still that reply: the latest.
    await act(async () => opener?.click());
    expect(harness.navigate).toHaveBeenCalledWith("ConversationActivity", {
      deploymentId,
      threadId: chatId,
    });
  });

  it("opens a reply's Run details from its menu, for that reply", async () => {
    const chat = chatAtWork();
    const host = fakeHost(
      snapshotFor({
        entries: chat.entries,
        run: { id: chat.runB, status: "running" },
        threadId: chatId,
      }),
    );
    const { container } = await mount(host, chatId);

    const menu = [...container.querySelectorAll('[aria-label="Message actions"]')].find((item) =>
      item.parentElement?.textContent?.includes(chat.replyA.body),
    );
    const titles = [...(menu?.querySelectorAll("button") ?? [])].map((item) => item.textContent);
    expect(titles).toContain("Run details");
    expect(titles).not.toContain("Show steps");
    const activity = [...(menu?.querySelectorAll("button") ?? [])].find(
      (item) => item.textContent === "Run details",
    );
    await act(async () => activity?.click());
    expect(harness.navigate).toHaveBeenCalledWith("ConversationActivity", {
      deploymentId,
      threadId: chatId,
      turnKey: `turn:run:${chat.runA}`,
    });
  });

  it("sends what is typed beside an approval as a message, and leaves the approval to its buttons", async () => {
    const chat = chatAtWork();
    const approval: Request = {
      callId: "call-approval",
      cancellationReason: null,
      createdAt: at,
      id: createId("request"),
      kind: "harness.approval",
      mode: "live",
      originatingOccurrenceId: null,
      originatingRunId: chat.runB,
      originatingThreadId: chatId,
      originatingWorkspaceId: workspaceId,
      payload: { kind: "harness.approval" },
      presentation: {
        kind: "choice",
        options: [
          { hint: "allow-once", id: "allow", label: "Allow once" },
          { hint: "reject-once", id: "reject", label: "Reject" },
        ],
        risk: "medium",
        title: "Send the note to Maya?",
      },
      requestedBy: userId,
      requiredActor: "requester",
      resolvedAt: null,
      resolvedBy: null,
      response: null,
      status: "pending",
      targetWorkspaceId: workspaceId,
    } as Request;
    const host = fakeHost(
      snapshotFor({
        entries: chat.entries.map((entry) =>
          entry.kind === "run" && entry.runId === chat.runB
            ? { ...entry, status: "waiting" }
            : entry,
        ),
        requests: [approval],
        run: { id: chat.runB, status: "waiting" },
        threadId: chatId,
      }),
    );
    const { container } = await mount(host, chatId);

    expect(container.querySelector('[aria-label="Docked request"]')?.textContent).toBe(
      "Send the note to Maya?",
    );
    await type(container, "Message", "Use the staging list instead");
    expect(text(container)).not.toContain("chooses");
    expect(hasButton(container, "Choose Reject and send")).toBe(false);
    expect(container.querySelector('textarea[aria-label="Suggest a change"]')).toBeNull();

    await press(container, "Send message");
    expect(sent(host.dispatch)).toEqual(["thread.sendMessage"]);
    expect(host.dispatch.mock.calls[0]?.[0]).toMatchObject({
      content: [{ text: "Use the staging list instead", type: "text" }],
      delivery: "queue",
      threadId: chatId,
      type: "thread.sendMessage",
    });
    expect(container.querySelector('[aria-label="Docked request"]')).not.toBeNull();
  });

  it("stops the reply, then sends the next message straight away with nothing to resume", async () => {
    const chat = chatAtWork();
    const waiting = said("And move the vendor call", null);
    const host = fakeHost(
      snapshotFor({
        entries: [...chat.entries, waiting],
        queue: [waitingInput(waiting, chatId)],
        run: { id: chat.runB, status: "running" },
        threadId: chatId,
      }),
    );
    const { container } = await mount(host, chatId);

    await press(container, "Stop the reply");
    expect(host.stopRun).toHaveBeenCalledWith(chatId);

    // The Host ends the reply and cancels what that exchange had not yet taken.
    host.move(
      snapshotFor({
        entries: [
          ...chat.entries.map((entry) =>
            entry.kind === "run" && entry.runId === chat.runB
              ? { ...entry, status: "interrupted" as const }
              : entry.kind === "tool" && entry.runId === chat.runB
                ? { ...entry, state: "done" as const }
                : entry,
          ),
          {
            ...waiting,
            delivery: { reason: "Not sent: you stopped the reply.", status: "failed" as const },
          },
        ],
        queue: [],
        run: null,
        threadId: chatId,
      }),
    );
    await settle();
    expect(text(container)).toContain("Not sent: you stopped the reply.");
    for (const control of queueControls) expect(hasButton(container, control)).toBe(false);

    await type(container, "Message", "Try Friday instead");
    await press(container, "Send message");
    expect(sent(host.dispatch)).toEqual(["thread.sendMessage"]);
    expect(host.dispatch.mock.calls[0]?.[0]).toMatchObject({
      content: [{ text: "Try Friday instead", type: "text" }],
      delivery: "queue",
    });
  });
});

describe("a link into Chat", () => {
  it("opens the Activity of the reply whose steps hold the linked message, at that reply", async () => {
    const chat = chatAtWork();
    const host = fakeHost(
      snapshotFor({ entries: chat.entries.slice(0, 6), run: null, threadId: chatId }),
    );
    await mount(host, chatId, { messageId: chat.noteA.id });

    expect(host.loadTranscriptAround).toHaveBeenCalledWith(chatId, chat.noteA.id);
    expect(harness.navigate).toHaveBeenCalledTimes(1);
    expect(harness.navigate).toHaveBeenCalledWith("ConversationActivity", {
      deploymentId,
      threadId: chatId,
      turnKey: `turn:run:${chat.runA}`,
    });
    // The question is row 0; the reply that answered it is row 1.
    expect(harness.scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index: 1 }));
  });

  it("goes to a linked reply in place, opening nothing over it", async () => {
    const chat = chatAtWork();
    const host = fakeHost(
      snapshotFor({ entries: chat.entries.slice(0, 6), run: null, threadId: chatId }),
    );
    await mount(host, chatId, { messageId: chat.replyA.id });

    expect(harness.navigate).not.toHaveBeenCalled();
    expect(harness.scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index: 1 }));
  });
});

describe("a message that joins the reply under way", () => {
  /**
   * The person asked, Opensteer did something, then the person said more and
   * the Host handed that to the same reply: the Run now goes on after it.
   */
  function joinedReply() {
    const runId = createId("run");
    const ask = said("Plan the trip to Lisbon", runId);
    const note = wrote("Checking flights first.", runId);
    const looked = thought(runId, "Looking at flights for Thursday.");
    const more = said("Also book the hotel", runId);
    const entries: TranscriptEntry[] = [ask, ran(runId), note, looked, more];
    return { ask, entries, looked, more, note, runId };
  }

  it("stands right under the person's last message, and the reply keeps typing in the same place as its work goes on", async () => {
    const reply = joinedReply();
    const host = fakeHost(
      snapshotFor({
        entries: reply.entries,
        run: { id: reply.runId, status: "running" },
        threadId: chatId,
      }),
    );
    const { container } = await mount(host, chatId);

    const replyRow = `turn:after:${reply.more.id}`;
    // What the reply did before the message said nothing of its own: no row
    // stands between the person's two messages, which sit as one person's do.
    expect(rows(container)).toEqual([
      { key: reply.ask.id, top: "0" },
      { key: reply.more.id, top: "6" },
      { key: replyRow, top: "16" },
    ]);
    const typing = container.querySelector('[aria-label="Opensteer is replying"]');
    expect(typing).not.toBeNull();

    // The reply's first step after the message lands: same row, same dots.
    const compared = thought(reply.runId, "Comparing hotels near the Alfama.");
    host.move(
      snapshotFor({
        entries: [...reply.entries, compared],
        run: { id: reply.runId, status: "running" },
        threadId: chatId,
      }),
    );
    await settle();
    expect(rows(container).map(({ key }) => key)).toEqual([reply.ask.id, reply.more.id, replyRow]);
    expect(container.querySelector('[aria-label="Opensteer is replying"]')).toBe(typing);
    expect(typing?.isConnected).toBe(true);

    // Its menu, once it answers, opens the Activity of every step it took.
    const answer = wrote("Flights on Thursday and a hotel in the Alfama.", reply.runId);
    host.move(
      snapshotFor({
        entries: [
          ...reply.entries.map((entry) =>
            entry.kind === "run"
              ? { ...entry, replyMessageId: answer.id, status: "completed" as const }
              : entry,
          ),
          compared,
          answer,
        ],
        run: null,
        threadId: chatId,
      }),
    );
    await settle();
    expect(rows(container).map(({ key }) => key)).toEqual([reply.ask.id, reply.more.id, replyRow]);
    const activity = [...container.querySelectorAll("button")].find(
      (item) =>
        item.textContent === "Run details" && item.closest(`[data-row="${replyRow}"]`) !== null,
    );
    await act(async () => activity?.click());
    // The reply's own turn names its Activity: it began with that step.
    expect(harness.navigate).toHaveBeenCalledWith("ConversationActivity", {
      deploymentId,
      threadId: chatId,
      turnKey: `turn:${compared.id}`,
    });
  });

  it("leaves no gap above a message waiting while the reply asks for approval", async () => {
    const runId = createId("run");
    const ask = said("Send Maya the agenda", runId);
    const waiting = said("And copy Sam", null);
    const host = fakeHost(
      snapshotFor({
        entries: [
          ask,
          ran(runId, { status: "waiting" }),
          thought(runId, "Drafting the email."),
          waiting,
        ],
        queue: [waitingInput(waiting, chatId)],
        run: { id: runId, status: "waiting" },
        threadId: chatId,
      }),
    );
    const { container } = await mount(host, chatId);

    expect(rows(container)).toEqual([
      { key: ask.id, top: "0" },
      { key: waiting.id, top: "6" },
    ]);
  });

  it("opens a link to something said before the message at the reply that holds it", async () => {
    const reply = joinedReply();
    const host = fakeHost(
      snapshotFor({
        entries: reply.entries,
        run: { id: reply.runId, status: "running" },
        threadId: chatId,
      }),
    );
    await mount(host, chatId, { messageId: reply.note.id });

    // Named by the turn it was said in, which the reply going on never renames.
    expect(harness.navigate).toHaveBeenCalledWith("ConversationActivity", {
      deploymentId,
      threadId: chatId,
      turnKey: `turn:run:${reply.runId}`,
    });
    // The rows are the question, the message, and the reply under way.
    expect(harness.scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index: 2 }));
  });
});

describe("a link to an approval", () => {
  /** An exchange whose approval was answered on the way to its reply. */
  function exchange(question: string, answer: string) {
    const runId = createId("run");
    const ask = said(question, runId);
    const receipt = answered(runId);
    const reply = wrote(answer, runId);
    const entries: TranscriptEntry[] = [
      ask,
      ran(runId, { replyMessageId: reply.id, status: "completed" }),
      receipt,
      reply,
    ];
    return { ask, entries, receipt, reply, runId };
  }
  /** The same, with a message the person added after the approval, which joined the reply. */
  function joinedExchange(question: string, more: string, answer: string) {
    const runId = createId("run");
    const ask = said(question, runId);
    const receipt = answered(runId);
    const added = said(more, runId);
    const reply = wrote(answer, runId);
    const entries: TranscriptEntry[] = [
      ask,
      ran(runId, { replyMessageId: reply.id, status: "completed" }),
      receipt,
      added,
      reply,
    ];
    return { added, ask, entries, receipt, reply, runId };
  }

  it("opens the Activity holding the answer at its reply, counting only the rows drawn", async () => {
    const first = joinedExchange("Plan the trip", "Also book the hotel", "Booked both.");
    const second = exchange("Send Maya the agenda", "Sent it.");
    const host = fakeHost(
      snapshotFor({ entries: [...first.entries, ...second.entries], run: null, threadId: chatId }),
    );
    const { container } = await mount(host, chatId, { requestId: second.receipt.requestId });

    // The first exchange's quiet stretch before the added message draws no row.
    expect(rows(container).map(({ key }) => key)).toEqual([
      first.ask.id,
      first.added.id,
      `turn:after:${first.added.id}`,
      second.ask.id,
      `turn:after:${second.ask.id}`,
    ]);
    expect(harness.navigate).toHaveBeenCalledTimes(1);
    expect(harness.navigate).toHaveBeenCalledWith("ConversationActivity", {
      deploymentId,
      threadId: chatId,
      turnKey: `turn:run:${second.runId}`,
    });
    expect(harness.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(harness.scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index: 4 }));
  });

  it("goes to the reply after a message that joined once the approval was answered", async () => {
    const joined = joinedExchange("Plan the trip", "Also book the hotel", "Booked both.");
    const host = fakeHost(snapshotFor({ entries: joined.entries, run: null, threadId: chatId }));
    await mount(host, chatId, { requestId: joined.receipt.requestId });

    // Named by the stretch that holds the answer, which the reply going on never renames.
    expect(harness.navigate).toHaveBeenCalledWith("ConversationActivity", {
      deploymentId,
      threadId: chatId,
      turnKey: `turn:run:${joined.runId}`,
    });
    // The question, the added message, then the reply.
    expect(harness.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(harness.scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index: 2 }));
  });

  it("opens only the Activity while its reply has no row yet, and never pages history for it", async () => {
    const runId = createId("run");
    const ask = said("Send Maya the agenda", runId);
    const receipt = answered(runId);
    const host = fakeHost(
      snapshotFor({
        earlier: true,
        entries: [ask, ran(runId, { status: "waiting" }), thought(runId, "Drafting."), receipt],
        requests: [approval(runId, "Copy Sam too?")],
        run: { id: runId, status: "waiting" },
        threadId: chatId,
      }),
    );
    const { container } = await mount(host, chatId, { requestId: receipt.requestId });

    expect(rows(container).map(({ key }) => key)).toEqual([ask.id]);
    expect(container.querySelector('[aria-label="Docked request"]')?.textContent).toBe(
      "Copy Sam too?",
    );
    expect(harness.navigate).toHaveBeenCalledTimes(1);
    expect(harness.navigate).toHaveBeenCalledWith("ConversationActivity", {
      deploymentId,
      threadId: chatId,
      turnKey: `turn:run:${runId}`,
    });
    expect(harness.scrollToIndex).not.toHaveBeenCalled();
    expect(host.loadEarlierTranscript).not.toHaveBeenCalled();
  });

  it("pages back to an answer on an earlier page, then stops paging", async () => {
    const first = joinedExchange("Plan the trip", "Also book the hotel", "Booked both.");
    const second = exchange("Send Maya the agenda", "Sent it.");
    const host = fakeHost(
      snapshotFor({ earlier: true, entries: second.entries, run: null, threadId: chatId }),
    );
    host.holdEarlier(
      snapshotFor({
        earlier: true,
        entries: [...first.entries, ...second.entries],
        run: null,
        threadId: chatId,
      }),
    );
    await mount(host, chatId, { requestId: first.receipt.requestId });

    expect(host.loadEarlierTranscript).toHaveBeenCalledTimes(1);
    expect(harness.navigate).toHaveBeenCalledWith("ConversationActivity", {
      deploymentId,
      threadId: chatId,
      turnKey: `turn:run:${first.runId}`,
    });
    expect(harness.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(harness.scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index: 2 }));
  });

  it("leaves an approval still waiting in the composer, and moves nothing once it is answered", async () => {
    const runId = createId("run");
    const ask = said("Send Maya the agenda", runId);
    const drafting = thought(runId, "Drafting the email.");
    const request = approval(runId, "Send the note to Maya?");
    const host = fakeHost(
      snapshotFor({
        earlier: true,
        entries: [ask, ran(runId, { status: "waiting" }), drafting],
        requests: [request],
        run: { id: runId, status: "waiting" },
        threadId: chatId,
      }),
    );
    const { container } = await mount(host, chatId, { requestId: request.id });

    expect(container.querySelector('[aria-label="Docked request"]')?.textContent).toBe(
      "Send the note to Maya?",
    );
    // Answered, here or anywhere: its record lands in the reply's steps.
    host.move(
      snapshotFor({
        earlier: true,
        entries: [
          ask,
          ran(runId),
          drafting,
          { ...answered(runId), id: `request:${request.id}`, requestId: request.id },
        ],
        run: { id: runId, status: "running" },
        threadId: chatId,
      }),
    );
    await settle();

    expect(container.querySelector('[aria-label="Docked request"]')).toBeNull();
    expect(harness.navigate).not.toHaveBeenCalled();
    expect(harness.scrollToIndex).not.toHaveBeenCalled();
    expect(host.loadEarlierTranscript).not.toHaveBeenCalled();
  });

  it("brings a task to the turn holding the answer, with nothing opened over it", async () => {
    const runA = createId("run");
    const runB = createId("run");
    const receipt = answered(runB, "Push to main?");
    const host = fakeHost(
      snapshotFor({
        entries: [
          said("Audit the repo", runA),
          ran(runA, { status: "completed" }),
          command(runA, "git status"),
          said("Now fix what you found", runB),
          ran(runB, { status: "completed" }),
          receipt,
          command(runB, "git push"),
        ],
        run: null,
        threadId: workId,
      }),
    );
    const { container } = await mount(host, workId, { requestId: receipt.requestId });

    expect(harness.navigate).not.toHaveBeenCalled();
    expect(harness.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(harness.scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index: 3 }));
    expect(text(container)).toContain("Push to main?");
  });
});

describe("surfaces belonging to one reply", () => {
  it("keeps each reply's apps and phones across joined stretches", async () => {
    const threadId = chatId;
    const runId = createId("run");
    const ask = said("Use my notes and phone", runId);
    const joinedFirst = said("Keep the recipes", runId);
    const first = wrote("Your notes are filed.", runId, threadId);
    const joinedSecond = said("Include tomorrow", runId);
    const second = wrote("Your calendar is updated.", runId, threadId);
    const notes = clickingInNotes(runId, false);
    const calendar: ToolEntry = {
      ...notes,
      id: `tool:${runId}:calendar`,
      callId: `call-calendar-${runId}`,
      integration: {
        account: "This computer",
        computerApp: {
          app: "Calendar",
          bundleId: "com.apple.iCal",
          computer: "Mac mini",
          runnerId: createId("runner"),
        },
        effect: "write",
        integration: "Computer use",
        operation: { name: "act", title: "Act" },
      },
    };
    const phone = (computer: string): ToolEntry => ({
      ...notes,
      id: `tool:${runId}:${computer}`,
      callId: `call-${computer}-${runId}`,
      integration: {
        account: "This computer",
        computerApp: null,
        phone: { computer, runnerId: createId("runner") },
        effect: "write",
        integration: "Computer use",
        operation: { name: "act", title: "Act" },
      },
    });
    const firstWork = [notes, phone("First phone"), joinedFirst, first];
    const initial: HostSnapshot = {
      ...snapshotFor({
        entries: [ask, ran(runId, { replyMessageId: first.id, status: "completed" }), ...firstWork],
        machines: [],
        run: null,
        threadId,
      }),
      browserSessions: [
        {
          access: "full-control",
          attachedRunIds: [],
          dialog: null,
          error: null,
          id: "reply-browser",
          origin: "agent",
          placement: { kind: "runner", runnerId: createId("runner") },
          profileId: null,
          runtimeId: "reply-runtime",
          state: "closed",
          tabs: [],
          uses: [
            {
              threadId,
              runId,
              tabId: "reply-page",
              firstUsedAt: at,
              lastUsedAt: at,
              pageTitle: "Shared page",
              pageSite: "https://example.com",
            },
          ],
          viewerError: null,
          viewerState: "disconnected",
          workspaceId,
        },
      ],
    };
    const host = fakeHost(initial);
    const { container } = await mount(host, threadId);
    const chipsFor = (reply: MessageEntry): string[] => {
      const row = [...container.querySelectorAll<HTMLElement>("[data-row]")].find((item) =>
        item.textContent?.includes(reply.body),
      );
      if (!row) throw new Error(`Missing reply: ${reply.body}`);
      return [...row.querySelectorAll("button[aria-description]")].map(
        (chip) => chip.getAttribute("aria-label") ?? "",
      );
    };
    expect(chipsFor(first)).toEqual([
      "Shared page, example.com, closed",
      "First phone, finished",
      "Notes, finished",
    ]);

    host.move({
      ...initial,
      transcripts: {
        ...initial.transcripts,
        [threadId]: [
          ask,
          ran(runId, {
            replyMessageId: second.id,
            status: "completed",
            turnReplyMessageIds: [first.id],
          }),
          ...firstWork,
          calendar,
          phone("Second phone"),
          joinedSecond,
          second,
        ],
      },
    });
    await settle();

    expect(chipsFor(first)).toEqual([
      "Shared page, example.com, closed",
      "First phone, finished",
      "Notes, finished",
    ]);
    expect(chipsFor(second)).toEqual([
      "Shared page, example.com, closed",
      "Second phone, finished",
      "Calendar, finished",
    ]);
  });
});

describe("a reply at work on a Mac", () => {
  /** The person asked, Opensteer began clicking in Notes, and the person said more while it did. */
  function joinedWhileClicking() {
    const runId = createId("run");
    const ask = said("Tidy my notes", runId);
    const more = said("Keep the recipes", runId);
    const entries: TranscriptEntry[] = [ask, ran(runId), clickingInNotes(runId, true), more];
    return { ask, entries, more, runId };
  }
  const closed = (reply: ReturnType<typeof joinedWhileClicking>) => [
    { key: reply.ask.id, top: "0" },
    { key: reply.more.id, top: "6" },
    { key: `turn:after:${reply.more.id}`, top: "16" },
  ];

  it("leaves no row for work on a Mac this reader is not shown", async () => {
    const reply = joinedWhileClicking();
    for (const machines of [
      // The session has ended, been swept or stopped elsewhere.
      macs(sessions([])),
      // The Mac went offline: its last report is nobody's to stop.
      macs({ ...sessions([notesSession(reply.runId)]), status: "offline" }),
      // Someone else's Mac: only its owner is shown its sessions.
      macs(null),
    ]) {
      const host = fakeHost(
        snapshotFor({
          entries: reply.entries,
          machines,
          run: { id: reply.runId, status: "running" },
          threadId: chatId,
        }),
      );
      const { container } = await mount(host, chatId);
      expect(rows(container)).toEqual(closed(reply));
    }
  });

  it("keeps a silent automatic turn's pending and confirmed computer Stop", async () => {
    const runId = createId("run");
    const entry = ran(runId, { startedBy: { kind: "platform", cause: "assignment-result" } });
    const working = (stopping: boolean, active: boolean) =>
      snapshotFor({
        entries: [{ ...entry, stopping }, clickingInNotes(runId, false)],
        machines: macs(sessions(active ? [notesSession(runId)] : [])),
        run: { id: runId, status: "running" },
        threadId: chatId,
      });
    const host = fakeHost(working(false, true));
    const { container } = await mount(host, chatId);
    let finish: (() => void) | undefined;
    host.stopComputerSession.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { ok: true, data: {} };
    });
    await press(container, "Stop using Mac");
    host.move(working(true, false));
    await settle();
    expect(container.textContent).toContain("Stopping");
    await act(async () => {
      finish?.();
    });
    await settle();
    expect(container.textContent).toContain("Stopped using Mac mini");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 3100));
    });
    await settle();
    expect(container.textContent).not.toContain("Stopped using Mac mini");
  }, 10000);

  it("keeps the reader's own Mac's line with Stop and its app's chip, then the Stop it leaves for three seconds, then closes the gap", async () => {
    const reply = joinedWhileClicking();
    const working = (machines: readonly MachineSummary[]) =>
      snapshotFor({
        entries: reply.entries,
        machines,
        run: { id: reply.runId, status: "running" },
        threadId: chatId,
      });
    const session = notesSession(reply.runId);
    const host = fakeHost(working(macs(sessions([session]))));
    const { container } = await mount(host, chatId);

    // A turn straight after the message that started its Run is drawn under that message's place.
    const lineRow = `turn:after:${reply.ask.id}`;
    expect(rows(container)).toEqual([
      { key: reply.ask.id, top: "0" },
      { key: lineRow, top: "16" },
      { key: reply.more.id, top: "16" },
      { key: `turn:after:${reply.more.id}`, top: "16" },
    ]);
    const line = () => container.querySelector(`[data-row="${lineRow}"]`)?.textContent ?? "";
    expect(line()).toContain("On Mac mini");
    // The line has no Watch of its own: the app's chip under it is the one way
    // to the app, and opens exactly the app the agent is using.
    expect(hasButton(container, "Watch")).toBe(false);
    await press(container, "Notes");
    expect(harness.dispatch).toHaveBeenCalledWith({
      name: "WorkspaceBrowser",
      params: {
        appKey: "com.apple.notes",
        computerSessionId: session.sessionId,
        deploymentId,
        machineId: macMini?.id,
        threadId: chatId,
      },
      type: "PUSH",
    });

    await press(container, "Stop using Mac");
    expect(host.stopComputerSession).toHaveBeenCalledWith(
      { sessionId: session.sessionId },
      { signal: expect.any(AbortSignal) },
    );
    // The Host took the Mac back: the session leaves the list, and the line says so.
    host.move(working(macs(sessions([]))));
    await settle();
    expect(rows(container).map(({ key }) => key)).toContain(lineRow);
    expect(line()).toContain("Stopped using Mac mini");

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 3_100));
    });
    await settle();
    expect(rows(container)).toEqual(closed(reply));
  }, 10_000);

  it("draws background work on the reader's Mac under its reply, and nothing for it when not shown or not live", async () => {
    const runId = createId("run");
    const ask = said("File my receipts as they come in", runId);
    const answer = wrote("I'll keep filing them.", runId);
    const filing = clickingInNotes(runId, false);
    const entries: TranscriptEntry[] = [
      ask,
      ran(runId, { background: true, turnReplyMessageIds: [answer.id] }),
      answer,
      filing,
    ];
    const background = (machines: readonly MachineSummary[], offline = false) =>
      snapshotFor({
        entries,
        machines,
        offline,
        run: { id: runId, status: "running" },
        threadId: chatId,
      });

    const shown = await mount(fakeHost(background(macs(sessions([notesSession(runId)])))), chatId);
    expect(rows(shown.container).map(({ key }) => key)).toEqual([
      ask.id,
      `turn:after:${ask.id}`,
      `turn:${filing.id}`,
      "working",
    ]);
    expect(shown.container.querySelector(`[data-row="turn:${filing.id}"]`)?.textContent).toContain(
      "On Mac mini",
    );

    for (const snapshot of [
      background(macs(sessions([]))),
      background(macs(sessions([notesSession(runId)])), true),
    ]) {
      const { container } = await mount(fakeHost(snapshot), chatId);
      expect(rows(container).map(({ key }) => key)).toEqual([
        ask.id,
        `turn:after:${ask.id}`,
        "working",
      ]);
    }
  });
});

describe("a conversation's own title in its bar", () => {
  it("keeps the conversation's name plain, and Retry a control of its own", async () => {
    const chat = chatAtWork();
    // The Host cannot be reached, so the line under the name offers Retry.
    const host = fakeHost({
      ...snapshotFor({
        entries: chat.entries,
        run: { id: chat.runB, status: "running" },
        threadId: chatId,
      }),
      connection: "offline",
    });
    const { container } = await mount(host, chatId, { header: true });

    expect(text(container)).toContain("Chat");
    expect(hasButton(container, "Chat")).toBe(false);
    const retry = button(container, "Retry");
    expect(retry.parentElement?.closest("button")).toBeNull();
    await act(async () => retry.click());
    expect(host.client.refresh).toHaveBeenCalledExactlyOnceWith({ retryConnection: true });
  });

  it("keeps a task's name plain", async () => {
    const host = fakeHost(snapshotFor({ entries: [], run: null, threadId: workId }));
    const { container } = await mount(host, workId, { header: true });

    const title = base.threads.find(({ id }) => id === workId)?.title ?? "";
    expect(text(container)).toContain(title);
    expect(hasButton(container, title)).toBe(false);
  });
});

describe("a phone carrying a steering decision from the previous release", () => {
  const chatKey = `${deploymentId}:${userId}:${chatId}`;
  const held = {
    createdAt: at,
    draftText: "Use the staging list instead",
    idempotencyKey: "request:held",
    messageIdempotencyKey: "message:held",
    optionId: "reject",
    requestId: "req_0192f4a1-4444-4000-8000-000000000004",
    text: "Use the staging list instead",
    threadId: chatId,
    userId,
  };

  function previousRelease(): MemoryPrivateFilesystem {
    const files = new MemoryPrivateFilesystem();
    files.put(
      "/private/drafts-v3.json",
      JSON.stringify({
        drafts: { [chatKey]: { text: held.draftText, updatedAt: at, userId } },
        pending: {},
        pendingSteers: { [chatKey]: held },
        schemaVersion: 3,
      }),
    );
    return files;
  }

  it("sends the held words once as a message, never answers the approval again, and is free to send", async () => {
    const chat = chatAtWork();
    // The decision was acknowledged before the upgrade: the Host refuses to take it again.
    const host = fakeHost(
      snapshotFor({ entries: chat.entries.slice(0, 6), run: null, threadId: chatId }),
    );
    host.dispatch.mockImplementation(async (command: { readonly type: string }) => {
      if (command.type === "request.respond") {
        throw new HostClientRequestError({
          code: "conflict",
          message: "This request is no longer pending.",
          status: 409,
        });
      }
      return { type: command.type };
    });
    const { container, drafts } = await mount(host, chatId, { files: previousRelease() });

    expect(host.dispatch.mock.calls).toEqual([
      [
        {
          content: [{ text: held.text, type: "text" }],
          delivery: "queue",
          idempotencyKey: held.messageIdempotencyKey,
          threadId: chatId,
          type: "thread.sendMessage",
        },
      ],
    ]);
    expect(drafts.readPending(deploymentId, userId, chatId)).toBeNull();
    expect(text(container)).not.toContain("can no longer accept");
    expect(text(container)).not.toContain("Not sent yet.");
    expect(hasButton(container, "Restore message")).toBe(false);
    expect(
      container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.value,
    ).toBe("");

    await type(container, "Message", "One more thing");
    expect(button(container, "Send message").disabled).toBe(false);
  });

  it("keeps words saved beside files and a quote with them, sends nothing on its own, then sends all of it once", async () => {
    const chat = chatAtWork();
    const quote = {
      attribution: "Opensteer",
      excerpt: "Design review at 2:00.",
      messageId: chat.replyA.id,
    };
    const file = {
      attachmentId: "att_0192f4a1-5555-4000-8000-000000000005",
      localUri: null,
      mediaType: "application/pdf",
      name: "agenda.pdf",
      sizeBytes: 2048,
      status: "ready",
    };
    const files = new MemoryPrivateFilesystem();
    files.put(
      "/private/drafts-v3.json",
      JSON.stringify({
        drafts: {
          [chatKey]: { attachments: [file], quote, text: held.draftText, updatedAt: at, userId },
        },
        pending: {},
        pendingSteers: { [chatKey]: held },
        schemaVersion: 3,
      }),
    );
    const host = fakeHost(
      snapshotFor({ entries: chat.entries.slice(0, 6), run: null, threadId: chatId }),
    );
    const { container, drafts } = await mount(host, chatId, { files });

    // Nothing leaves the phone by itself, and the draft is whole.
    expect(host.dispatch).not.toHaveBeenCalled();
    expect(drafts.readPending(deploymentId, userId, chatId)).toBeNull();
    expect(
      container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.value,
    ).toBe(held.draftText);
    expect(container.querySelector('[aria-label="Quoted update"]')?.textContent).toContain(
      quote.attribution,
    );
    expect(drafts.readDraft(deploymentId, userId, chatId)?.attachments).toEqual([file]);

    await press(container, "Send message");
    expect(host.dispatch.mock.calls).toEqual([
      [
        expect.objectContaining({
          content: [
            { text: held.text, type: "text" },
            {
              artifactId: file.attachmentId,
              mediaType: file.mediaType,
              name: file.name,
              sizeBytes: file.sizeBytes,
              type: "artifact",
            },
          ],
          delivery: "queue",
          quotedMessageId: quote.messageId,
          threadId: chatId,
          type: "thread.sendMessage",
        }),
      ],
    ]);
  });

  it("leaves an approval still waiting where it is, to be answered with its buttons", async () => {
    const chat = chatAtWork();
    const approval = {
      callId: "call-approval",
      cancellationReason: null,
      createdAt: at,
      id: held.requestId,
      kind: "harness.approval",
      mode: "live",
      originatingOccurrenceId: null,
      originatingRunId: chat.runB,
      originatingThreadId: chatId,
      originatingWorkspaceId: workspaceId,
      payload: { kind: "harness.approval" },
      presentation: {
        kind: "choice",
        options: [
          { hint: "allow-once", id: "allow", label: "Allow once" },
          { hint: "reject-once", id: "reject", label: "Reject" },
        ],
        title: "Send the note to Maya?",
      },
      requestedBy: userId,
      requiredActor: "requester",
      resolvedAt: null,
      resolvedBy: null,
      response: null,
      status: "pending",
      targetWorkspaceId: workspaceId,
    } as Request;
    const host = fakeHost(
      snapshotFor({
        entries: chat.entries,
        requests: [approval],
        run: { id: chat.runB, status: "waiting" },
        threadId: chatId,
      }),
    );
    const { container } = await mount(host, chatId, { files: previousRelease() });

    expect(sent(host.dispatch)).toEqual(["thread.sendMessage"]);
    expect(container.querySelector('[aria-label="Docked request"]')).not.toBeNull();
  });
});

describe("a task", () => {
  function taskAtWork() {
    const runId = createId("run");
    const ask = said("Reconcile August", runId);
    const note = wrote("Opening the statements.", runId, workId);
    const entries: TranscriptEntry[] = [
      ask,
      ran(runId),
      note,
      command(runId, "open statements", true),
    ];
    return { entries, note, runId };
  }

  it("keeps its queue tray, every control on it, its steps behind its status line and its own Stop", async () => {
    const task = taskAtWork();
    const waiting = said("Include the card fees", null);
    const host = fakeHost(
      snapshotFor({
        entries: [...task.entries, waiting],
        queue: [waitingInput(waiting, workId)],
        run: { id: task.runId, status: "running" },
        threadId: workId,
      }),
    );
    const { container, headers } = await mount(host, workId);

    const tray = container.querySelector('[aria-label="Queued messages"]');
    expect(tray?.textContent).toContain("Queued");
    expect(tray?.textContent).toContain(waiting.body);
    for (const control of ["Steer into this turn", "Edit", "Remove"]) {
      expect(hasButton(container, control)).toBe(true);
    }
    expect(text(container)).toContain(task.note.body);
    expect(
      container.querySelector('button[aria-description="Shows this reply\'s steps"]'),
    ).not.toBeNull();
    expect(button(container, "Stop this run").dataset["kind"]).toBe("stop");
    expect(hasButton(container, "Stop the reply")).toBe(false);
    expect(headers.at(-1)?.title).toBe(base.threads.find(({ id }) => id === workId)?.title);
  });

  it("is paused by Stop and offers Resume", async () => {
    const task = taskAtWork();
    const waiting = said("Include the card fees", null);
    const host = fakeHost(
      snapshotFor({
        entries: [
          ...task.entries.map((entry) =>
            entry.kind === "run" ? { ...entry, status: "interrupted" as const } : entry,
          ),
          waiting,
        ],
        paused: true,
        queue: [waitingInput(waiting, workId)],
        run: null,
        threadId: workId,
      }),
    );
    const { container } = await mount(host, workId);

    expect(container.querySelector('[aria-label="Queued messages"]')?.textContent).toContain(
      "Paused",
    );
    await press(container, "Resume");
    expect(host.resumeThreadInputQueue).toHaveBeenCalledWith(workId);
  });
});

// Ways a finished task's title can fail: the bar drops "Finished" while the
// drawn transcript is a window from before the ending, and the title has no
// menu either — nothing on screen, nor its accessible name, says the task
// ended; or the bar keeps a second status line beside a menu that already
// says it.
describe("a finished task's title", () => {
  it.each([
    ["a menu to mark Done", false, false],
    ["a menu to rename it", true, false],
    ["a menu to open who asked", false, true],
  ] as const)(
    "says Finished when opened before its ending with %s",
    async (_, capable, readableRequester) => {
      const earlierRun = createId("run");
      const endingRun = createId("run");
      const ask = said("Plan the Tokyo trip", earlierRun);
      const entries: TranscriptEntry[] = [
        ask,
        ran(earlierRun, { status: "completed" }),
        wrote("A first draft of the plan.", earlierRun, workId),
      ];
      const work = base.threads.find(({ id }) => id === workId)!;
      const assignment = AssignmentSummarySchema.parse({
        createdAt: "2026-10-25T10:00:00Z",
        updatedAt: "2026-10-25T10:05:00Z",
        currentRunId: endingRun,
        currentRunStatus: "completed",
        finishedAt: "2026-10-25T10:05:00Z",
        id: createId("delegation"),
        initialRunId: earlierRun,
        modelLabel: null,
        objectivePreview: "Plan trip",
        origin: "run",
        // Not in this reader's snapshot unless it is their Chat.
        parentThreadId: readableRequester ? chatId : createId("thread"),
        resultPreview: null,
        returnStatus: "delivered",
        revision: 2,
        status: "completed",
        workerThread: {
          id: work.id,
          environmentId: work.environmentId,
          workspaceId: work.workspaceId,
          status: "idle",
          pendingRequests: 0,
          title: work.title,
          icon: work.icon,
          color: work.color ?? undefined,
        },
      });
      const host = fakeHost({
        ...snapshotFor({ entries, run: null, threadId: workId }),
        assignments: { [assignment.id]: assignment },
        taskMarksAvailable: capable,
        threadRenameAvailable: capable,
      });
      const { container } = await mount(host, workId, { header: true, messageId: ask.id });
      expect(host.loadTranscriptAround).toHaveBeenCalledWith(workId, ask.id);
      // The window is from before the ending, so the transcript does not say it.
      expect(text(container)).not.toContain("Returned to");
      const bar = container.querySelector("header")!;
      const trigger = bar.querySelector('[aria-label$="Task actions"]');
      expect(trigger?.getAttribute("aria-label")).toMatch(/, Finished\. Task actions$/);
      expect(bar.textContent).not.toContain("Finished");
      expect(hasButton(container, "Mark Done")).toBe(true);
      expect(hasButton(container, "Rename…")).toBe(capable);
    },
  );
});

describe("a conversation's task family", () => {
  it("has no item when the conversation has no family", async () => {
    const host = fakeHost({
      ...snapshotFor({ entries: [], run: null, threadId: workId }),
      assignments: {},
      threadAutomations: {},
    });
    const { container } = await mount(host, workId, { header: true });
    expect(container.querySelector('button[aria-label*="tasks running"]')).toBeNull();
    expect(container.querySelector('button[aria-label*="task running"]')).toBeNull();
  });

  it("opens its family separately from its own actions and navigates to a child", async () => {
    const work = base.threads.find(({ id }) => id === workId)!;
    const task = (title: string, status: "completed" | "open") =>
      AssignmentSummarySchema.parse({
        createdAt: "2026-10-30T15:00:00Z",
        updatedAt: "2026-10-30T15:05:00Z",
        currentRunId: createId("run"),
        currentRunStatus: status === "open" ? "running" : "completed",
        finishedAt: status === "open" ? null : "2026-10-30T15:05:00Z",
        id: createId("delegation"),
        initialRunId: createId("run"),
        modelLabel: null,
        objectivePreview: title,
        origin: "run",
        parentThreadId: workId,
        resultPreview: null,
        returnStatus: status === "open" ? "pending" : "delivered",
        revision: 1,
        status,
        workerThread: {
          id: createId("thread"),
          environmentId: work.environmentId,
          workspaceId: work.workspaceId,
          status: status === "open" ? "running" : "idle",
          pendingRequests: 0,
          title,
          icon: null,
        },
      });
    const going = task("Check OpenTable", "open");
    const finished = task("Check Resy", "completed");
    const host = fakeHost({
      ...snapshotFor({ entries: [], run: null, threadId: workId }),
      assignments: { [going.id]: going, [finished.id]: finished },
      threadAutomations: {
        [workId]: [
          {
            id: "schedule",
            name: "Morning brief",
            kind: "schedule",
            paused: false,
            nextFireAt: "2026-11-01T09:00:00Z",
          },
          { id: "watch", name: "Repository", kind: "watch", paused: false, nextFireAt: null },
          { id: "hook", name: "Deploy", kind: "webhook", paused: false, nextFireAt: null },
          { id: "paused", name: "Later", kind: "schedule", paused: true, nextFireAt: null },
        ],
      },
    });
    const { container } = await mount(host, workId, { header: true });
    expect(hasButton(container, "Started here")).toBe(false);
    expect(container.querySelector("[data-modal-visible]")).toBeNull();
    const writes = harness.headerWrites;
    await act(async () =>
      host.move({
        ...host.client.getSnapshot(),
        assignments: {
          [going.id]: { ...going, objectivePreview: "A streaming child's changing subject" },
          [finished.id]: finished,
        },
      }),
    );
    expect(harness.headerWrites).toBe(writes);
    await act(async () =>
      host.move({
        ...host.client.getSnapshot(),
        waitingRequests: [
          WaitingRequestSchema.parse({
            request: approval(going.currentRunId!, "Allow check"),
            subagent: null,
            assignments: [
              {
                id: going.id,
                parentThreadId: workId,
                workerThread: { id: going.workerThread.id, title: going.workerThread.title },
              },
            ],
          }),
        ],
      }),
    );
    await press(container, "1 task running, one needs you, 4 automations");
    expect(text(container)).toContain("Running · 1");
    expect(text(container)).toContain("Automations · 4");
    expect(text(container)).toContain("Watching");
    expect(text(container)).toContain("On webhook");
    expect(text(container)).toContain("Paused");
    const automation = container.querySelector('[aria-label="Repository, Watching"]');
    expect(automation).not.toBeNull();
    expect(automation?.closest("button")).toBeNull();
    expect(text(container)).not.toContain("Check Resy");
    await press(container, "Earlier · 1");
    expect(text(container)).toContain("Check Resy");
    const child = container.querySelector<HTMLButtonElement>(
      'button[aria-label^="Check OpenTable, Needs you"]',
    )!;
    expect(child).not.toBeNull();
    await act(async () => child.click());
    expect(container.querySelector("[data-modal-visible]")).toBeNull();
    expect(harness.dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        name: "Thread",
        params: { deploymentId, threadId: going.workerThread.id },
        type: "PUSH",
      }),
    );
    const settled = Array.from({ length: 5 }, (_, index) =>
      task(`Earlier task ${index}`, "completed"),
    );
    await act(async () =>
      host.move({
        ...host.client.getSnapshot(),
        waitingRequests: [],
        assignments: Object.fromEntries(settled.map((task) => [task.id, task])),
        threadAutomations: {},
      }),
    );
    await press(container, "5 earlier");
    expect(text(container)).toContain("Earlier · 5");
    expect(container.querySelectorAll('button[aria-label^="Earlier task"]')).toHaveLength(4);
    await press(container, "Show all");
    expect(container.querySelectorAll('button[aria-label^="Earlier task"]')).toHaveLength(5);
  });
});

describe("renaming a task on a phone", () => {
  it("renames an unassigned task through the cross-platform dialog and cancels empty, unchanged or dismissed edits", async () => {
    const client = new MockHostClient({ latencyMs: 0, automations: "absent" });
    try {
      await client.load();
      const { container } = await mount({ client }, workId, { header: true });
      const rename = vi.spyOn(client, "renameThread");
      expect(
        Object.values(client.getSnapshot().assignments).some(
          (assignment) => assignment.workerThread.id === workId,
        ),
      ).toBe(false);
      const original = client.getSnapshot().threads.find(({ id }) => id === workId)!.title;
      for (const value of ["", original, "cancelled", "A better name"]) {
        await act(async () => button(container, "Rename…").click());
        const field = container.querySelector<HTMLTextAreaElement>('[aria-label="Task title"]')!;
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
            field,
            value,
          );
          field.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await act(async () => button(container, value === "cancelled" ? "Cancel" : "Save").click());
        await settle();
      }
      expect(rename).toHaveBeenCalledTimes(1);
      expect(rename).toHaveBeenCalledWith(workId, "A better name");
      expect(client.getSnapshot().threads.find(({ id }) => id === workId)?.title).toBe(
        "A better name",
      );
      expect(text(container)).toContain("A better name");
      rename.mockRejectedValueOnce(new Error("Rename refused"));
      await press(container, "Rename…");
      const field = container.querySelector<HTMLTextAreaElement>('[aria-label="Task title"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
          field,
          "Refused name",
        );
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await press(container, "Save");
      expect(text(container)).toContain("Rename refused");
      expect(client.getSnapshot().threads.find(({ id }) => id === workId)?.title).toBe(
        "A better name",
      );
      await press(container, "Cancel");
    } finally {
      client.dispose();
    }
  });

  it.each(["generated", "same title chosen", "chosen at creation"])(
    "shows the mock Host's title lifecycle live (%s)",
    async (mode) => {
      const client = new MockHostClient({ latencyMs: 0, automations: "absent" });
      try {
        await client.load();
        const template = client.getSnapshot().threads.find((thread) => thread.role === "work")!;
        const seed = "Prepare the mobile launch with a detailed milestone schedule";
        const thread = await client.createThread({
          accessMode: template.accessMode,
          environmentId: template.environmentId,
          harnessInstanceId: template.harnessInstanceId,
          modelSelection: template.modelSelection,
          workspaceId: template.workspaceId,
          title: seed,
          ...(mode !== "chosen at creation" ? { generateTitle: true } : {}),
        });
        const { headers, container } = await mount({ client }, thread.id, { header: true });
        await act(async () => {
          await client.dispatch({
            type: "thread.sendMessage",
            threadId: thread.id,
            content: [{ type: "text", text: seed }],
            idempotencyKey: `title-lifecycle:${mode}`,
          });
        });
        if (mode === "same title chosen")
          await act(async () => {
            await client.renameThread(thread.id, seed);
          });
        const transcript = client.getSnapshot().transcripts[thread.id];
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 150));
        });
        const title = mode === "generated" ? "Prepare the mobile launch with" : seed;
        expect(headers.at(-1)?.title).toBe(title);
        expect(text(container)).toContain(title);
        expect(client.getSnapshot().transcripts[thread.id]).toEqual(transcript);
      } finally {
        client.dispose();
      }
    },
  );

  it.each([true, false])(
    "hides rename for Chat or a Host without the capability (%s)",
    async (home) => {
      const host = fakeHost({
        ...snapshotFor({ entries: [], run: null, threadId: home ? chatId : workId }),
        threadRenameAvailable: home,
      });
      const { container } = await mount(host, home ? chatId : workId, { header: true });
      expect(hasButton(container, "Rename…")).toBe(false);
    },
  );
});

describe("task marks on a phone", () => {
  it("projects icon-only changes into the header and lets a person choose an icon or Use default without changing the title", async () => {
    const client = new MockHostClient({ latencyMs: 0, automations: "absent" });
    try {
      await client.load();
      const original = client.getSnapshot().threads.find(({ id }) => id === workId)!;
      const dispatch = vi.spyOn(client, "dispatch");
      const { container, headers } = await mount({ client }, workId, { header: true });
      await press(container, "Change icon…");
      expect(container.querySelector('[aria-label="Search icons"]')).not.toBeNull();
      const focus = (await import("react-native")).AccessibilityInfo.setAccessibilityFocus;
      const opener = container.querySelector('[aria-label$="Task actions"]');
      vi.mocked(focus).mockClear();
      await press(container, "Plane");
      await settle();
      expect(container.querySelector('[data-modal-visible="false"]')).not.toBeNull();
      expect(focus).not.toHaveBeenCalled();
      expect(harness.dismissModal).not.toBeNull();
      await act(async () => harness.dismissModal?.());
      expect(focus).toHaveBeenCalledOnce();
      expect(harness.handles.get(vi.mocked(focus).mock.calls[0]![0])).toBe(opener);
      expect(container.querySelector("[data-modal-visible]")).toBeNull();
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "thread.icon.set",
          threadId: workId,
          icon: "plane",
        }),
      );
      expect(headers.at(-1)).toMatchObject({
        icon: "plane",
        color: original.color,
        title: original.title,
      });
      await press(container, "Change icon…");
      await press(container, "Use default");
      await settle();
      await act(async () => harness.dismissModal?.());
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "thread.icon.set", icon: null }),
      );
      expect(headers.at(-1)).toMatchObject({ icon: "document", title: original.title });
      dispatch.mockRejectedValueOnce(new Error("Icon refused"));
      await press(container, "Change icon…");
      await press(container, "Plane");
      expect(text(container)).toContain("Icon refused");
      expect(client.getSnapshot().threads.find(({ id }) => id === workId)?.icon).toBe("document");
      vi.mocked(focus).mockClear();
      await press(container, "Close");
      expect(container.querySelector('[data-modal-visible="false"]')).not.toBeNull();
      expect(focus).not.toHaveBeenCalled();
      await act(async () => harness.dismissModal?.());
      expect(focus).toHaveBeenCalledOnce();
      expect(harness.handles.get(vi.mocked(focus).mock.calls[0]![0])).toBe(opener);
      expect(container.querySelector("[data-modal-visible]")).toBeNull();
    } finally {
      client.dispose();
    }
  });

  it("reports specialist tile-only edits in the header without changing the task mark or unread state", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    try {
      await client.load();
      const workspace = client.getSnapshot().workspaces.find(({ kind }) => kind === "specialized")!;
      const template = client.getSnapshot().threads.find(({ role }) => role === "work")!;
      const thread = await client.createThread({
        workspaceId: workspace.id,
        title: "Tokyo flights",
        environmentId: template.environmentId,
        accessMode: template.accessMode,
        harnessInstanceId: template.harnessInstanceId,
        modelSelection: template.modelSelection,
      });
      const { headers, container } = await mount({ client }, thread.id, { header: true });
      expect(headers.at(-1)).toMatchObject({
        workspaceName: workspace.name,
        workspaceColor: workspace.color,
        workspaceIcon: workspace.icon,
      });
      const before = client.getSnapshot();
      await act(async () => {
        await client.dispatch({
          type: "workspace.color.set",
          workspaceId: workspace.id,
          color: "magenta",
          idempotencyKey: "mobile-header-colour",
        });
        await client.dispatch({
          type: "workspace.icon.set",
          workspaceId: workspace.id,
          icon: "luggage",
          idempotencyKey: "mobile-header-icon",
        });
      });
      expect(headers.at(-1)).toMatchObject({
        workspaceColor: "magenta",
        workspaceIcon: "luggage",
        icon: thread.icon,
        color: thread.color,
      });
      expect(container.textContent).toContain(workspace.name);
      expect(client.getSnapshot().threadReadStates).toEqual(before.threadReadStates);
    } finally {
      client.dispose();
    }
  });

  it.each([true, false])("hides Change icon for Chat or an old Host (%s)", async (home) => {
    const host = fakeHost({
      ...snapshotFor({ entries: [], run: null, threadId: home ? chatId : workId }),
      taskMarksAvailable: home,
    });
    const { container } = await mount(host, home ? chatId : workId, { header: true });
    expect(hasButton(container, "Change icon…")).toBe(false);
  });
});

/*
 * A conversation in a pane that changes shape. What can go wrong: its text or
 * composer runs under a notch, a rail or a reserved region at the pane's side,
 * because only the bottom inset was ever applied; a reflow as the window folds
 * pulls a reader back to the newest entry from where they were reading, or
 * strands a reader who was following the newest entry above it.
 */
describe("a conversation in a pane that changes shape", () => {
  it("keeps its transcript and composer clear of the pane's own side and bottom insets", async () => {
    harness.insets = { bottom: 20, left: 44, right: 30, top: 0 };
    const host = fakeHost(snapshotFor({ entries: [], machines: [], run: null, threadId: chatId }));
    const { container } = await mount(host, chatId);
    expect(flatten(harness.list?.contentContainerStyle)).toMatchObject({
      paddingLeft: 16 + 44,
      paddingRight: 16 + 30,
    });
    const dock = container.querySelector<HTMLElement>('[data-testid="composer-dock"]');
    expect(JSON.parse(dock?.dataset["style"] ?? "{}")).toMatchObject({
      paddingBottom: 20 + 8,
      paddingLeft: 8 + 44,
      paddingRight: 8 + 30,
    });
  });

  it("follows the newest entry through a reflow, and leaves a reader who scrolled back where they are", async () => {
    const host = fakeHost(snapshotFor({ entries: [], machines: [], run: null, threadId: chatId }));
    await mount(host, chatId);
    const list = () => {
      if (harness.list === null) throw new Error("No transcript list.");
      return harness.list;
    };
    const layout = (height: number, width: number) => ({
      nativeEvent: { layout: { height, width } },
    });
    act(() => {
      list().onLayout?.(layout(600, 390));
      list().onContentSizeChange?.(390, 2000);
    });
    expect(harness.scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 1400 });

    // Unfolded: the same text, wider, is shorter.
    harness.scrollToOffset.mockReset();
    act(() => {
      list().onLayout?.(layout(700, 744));
      list().onContentSizeChange?.(744, 1500);
    });
    expect(harness.scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 800 });

    // The reader drags back into the history.
    act(() => {
      list().onScrollBeginDrag?.();
      list().onScroll?.({
        nativeEvent: {
          contentOffset: { x: 0, y: 200 },
          contentSize: { height: 1500, width: 744 },
          layoutMeasurement: { height: 700, width: 744 },
        },
      });
      list().onScrollEndDrag?.();
    });
    harness.scrollToOffset.mockReset();
    act(() => {
      list().onLayout?.(layout(600, 390));
      list().onContentSizeChange?.(390, 2000);
    });
    expect(harness.scrollToOffset).not.toHaveBeenCalled();
  });
});

it("a shared Done update freezes the phone composer and Reopen restores it", async () => {
  const initial = snapshotFor({ entries: [], run: null, threadId: workId });
  const host = fakeHost(initial);
  const reopen = vi.fn(async () => undefined);
  Object.assign(host.client, { setTaskDone: reopen });
  const { container } = await mount(host, workId);
  const completed = {
    ...initial,
    threads: initial.threads.map((thread) =>
      thread.id === workId ? { ...thread, doneAt: at } : thread,
    ),
  };
  host.move(completed);
  await settle();
  expect(text(container)).toContain("This task is Done");
  expect(container.querySelector("textarea, input")).toBeNull();
  await press(container, "Reopen");
  expect(reopen).toHaveBeenCalledExactlyOnceWith(workId, false);
  host.move(initial);
  await settle();
  expect(text(container)).not.toContain("This task is Done");
  expect(container.querySelector("textarea, input")).not.toBeNull();
});

// Ways a task's page can fail on a phone: it gives no way back to the
// conversation it works for, names the reader's Chat by its Thread title, or
// offers a way into a conversation the reader cannot open.
describe("a task's way back", () => {
  const withParent = (parentThreadId: string) => {
    const snapshot = snapshotFor({ entries: [], run: null, threadId: workId });
    return {
      ...snapshot,
      threads: snapshot.threads.map((thread) =>
        thread.id === workId ? { ...thread, parentThreadId } : thread,
      ),
    };
  };

  it("leads back to Chat by name, at the top of the task", async () => {
    const { container } = await mount(fakeHost(withParent(chatId)), workId);
    const back = button(container, "Back to Chat");
    expect(back.textContent).toBe("Chat");
    expect(container.querySelector("button")).toBe(back);
    await act(async () => back.click());
    expect(harness.dispatch).toHaveBeenLastCalledWith({
      name: "Home",
      params: { deploymentId },
      type: "POP_TO",
    });
  });

  it("offers none into a conversation the reader cannot open", async () => {
    const { container } = await mount(fakeHost(withParent(createId("thread"))), workId);
    expect(container.querySelector('[aria-label^="Back to"]')).toBeNull();
  });
});

async function enableDictation(
  model: "installed" | "download" = "installed",
  microphone: "granted" | "denied" = "granted",
) {
  let listener: ((event: DictationEvent) => void) | undefined;
  let session = "";
  let seq = 0;
  const port: DictationPort = {
    availability: async () => ({
      available: true,
      locale: "en-US",
      languageName: "English",
      model,
      microphone,
    }),
    start: vi.fn(async (id) => {
      session = id;
      seq = 0;
    }),
    download: vi.fn(async (id) => {
      session = id;
      seq = 0;
    }),
    stop: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    subscribe: (next) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    openMicrophoneSettings: vi.fn(async () => undefined),
  };
  dictation.dispose();
  dictation = new DictationController({ port, createId: () => crypto.randomUUID() });
  await dictation.refresh();
  return {
    port,
    emit: async (payload: object) => {
      await act(async () => listener?.({ session, seq: ++seq, ...payload } as DictationEvent));
      await settle();
    },
  };
}

it("dictates at the caret, cancels preview, adopts edits and sends finalized words once", async () => {
  const speech = await enableDictation();
  const host = fakeHost(snapshotFor({ entries: [], run: null, threadId: workId }));
  const { container } = await mount(host, workId);
  await type(container, "Message", "Hi there");
  const field = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;
  await act(async () => {
    harness.select?.({ nativeEvent: { selection: { start: 2, end: 2 } } });
  });
  await press(container, "Start dictation (English)");
  await speech.emit({ type: "listening" });
  await speech.emit({ type: "text", finalized: [], volatile: ["my"] });
  expect(field.value).toBe("Hi my there");
  await press(container, "Cancel dictation");
  expect(field.value).toBe("Hi there");
  await act(async () => harness.select?.({ nativeEvent: { selection: { start: 3, end: 8 } } }));
  await press(container, "Start dictation (English)");
  await speech.emit({ type: "listening" });
  await speech.emit({ type: "text", finalized: [], volatile: ["my"] });
  expect(field.value).toBe("Hi my");
  expect(selectionCalls.at(-1)).toEqual({ text: "Hi my", start: 5, end: 5 });
  const calls = selectionCalls.length;
  await act(async () => harness.select?.({ nativeEvent: { selection: { start: 0, end: 0 } } }));
  await speech.emit({ type: "text", finalized: [], volatile: ["my"] });
  expect(selectionCalls).toHaveLength(calls);
  await speech.emit({ type: "text", finalized: [], volatile: ["my friend"] });
  expect(selectionCalls.at(-1)).toEqual({ text: "Hi my friend", start: 12, end: 12 });
  await type(container, "Message", "Hi my there!");
  expect(speech.port.cancel).toHaveBeenCalled();
  expect(field.value).toBe("Hi my there!");
  await press(container, "Start dictation (English)");
  await speech.emit({ type: "listening" });
  await speech.emit({ type: "text", finalized: ["friend"], volatile: [] });
  await press(container, "Send message");
  await press(container, "Send message");
  expect(speech.port.stop).toHaveBeenCalledTimes(1);
  await speech.emit({ type: "ended", reason: "completed", error: null });
  expect(host.dispatch.mock.calls[0]?.[0]).toMatchObject({
    type: "thread.sendMessage",
    content: [{ type: "text", text: "Hi my there! friend" }],
  });
  expect(sent(host.dispatch)).toHaveLength(1);
  expect(selectionCalls.at(-1)).toEqual({ text: "Hi my there! friend", start: 19, end: 19 });
});

it("keeps denied permission actionable and downloads without starting the microphone", async () => {
  let speech = await enableDictation("installed", "denied");
  const host = fakeHost(snapshotFor({ entries: [], run: null, threadId: workId }));
  const { container } = await mount(host, workId);
  await press(container, "Start dictation (English)");
  await press(container, "Open Settings");
  expect(speech.port.openMicrophoneSettings).toHaveBeenCalledOnce();
  speech = await enableDictation("download");
  // Re-render the existing composer against its new runtime.
  await type(container, "Message", "download");
  await press(container, "Start dictation (English)");
  await speech.emit({ type: "downloading", progress: 0.42 });
  expect(text(container)).toContain("42%");
  await speech.emit({ type: "ended", reason: "completed", error: null });
  expect(text(container)).toContain("English is ready");
  expect(speech.port.start).not.toHaveBeenCalled();
});

it.each(["failed", "aborted", "unmount", "blur", "read-only"])(
  "does not send after dictation %s",
  async (outcome) => {
    const speech = await enableDictation();
    const host = fakeHost(snapshotFor({ entries: [], run: null, threadId: workId }));
    const { container } = await mount(host, workId);
    await press(container, "Start dictation (English)");
    await speech.emit({ type: "listening" });
    await speech.emit({ type: "text", finalized: ["hello"], volatile: [] });
    await press(container, "Send message");
    if (outcome === "aborted") await type(container, "Message", "edited while finishing");
    if (outcome === "read-only") {
      const next = snapshotFor({ entries: [], run: null, threadId: workId });
      host.move({
        ...next,
        threads: next.threads.map((t) => (t.id === workId ? { ...t, status: "archived" } : t)),
      });
      await settle();
    }
    if (outcome === "unmount") await act(async () => roots.pop()?.unmount());
    if (outcome === "blur")
      await act(async () => {
        for (const cleanup of harness.focusCleanups) cleanup();
      });
    await speech.emit({
      type: "ended",
      reason: outcome === "failed" ? "failed" : "completed",
      error: outcome === "failed" ? "recognition-failed" : null,
    });
    expect(sent(host.dispatch)).toHaveLength(0);
  },
);

it("hides an unsupported mic and disables it while another composer owns dictation", async () => {
  const host = fakeHost(snapshotFor({ entries: [], run: null, threadId: workId }));
  const { container } = await mount(host, workId);
  expect(hasButton(container, "Start dictation (English)")).toBe(false);
  await act(async () => {
    await enableDictation();
  });
  await type(container, "Message", "refresh");
  await act(async () =>
    dictation.start({
      owner: "another",
      read: () => ({ text: "", selection: { start: 0, end: 0 } }),
      commit: () => undefined,
    }),
  );
  expect(button(container, "Start dictation (English)").disabled).toBe(true);
  await act(async () => dictation.cancel("another"));
});

it("does not send an empty message when Send finishes a microphone with no speech", async () => {
  const speech = await enableDictation();
  const host = fakeHost(snapshotFor({ entries: [], run: null, threadId: workId }));
  const { container } = await mount(host, workId);
  await press(container, "Start dictation (English)");
  await press(container, "Send message");
  await speech.emit({ type: "ended", reason: "completed", error: null });
  expect(sent(host.dispatch)).toHaveLength(0);
  expect(text(container)).toContain("No speech detected");
});

function voiceController(phase: VoiceSnapshot["phase"]) {
  let snapshot: VoiceSnapshot = {
    available: true,
    phase,
    muted: false,
    heard: null,
    spoken: null,
    since: null,
    notice: null,
  };
  const listeners = new Set<() => void>();
  const controller: VoiceControls = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    subscribeLevel: () => () => undefined,
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
    setMuted: vi.fn(),
    dismissNotice: vi.fn(),
  };
  return {
    controller,
    move: (phase: VoiceSnapshot["phase"]) => {
      snapshot = { ...snapshot, phase };
      for (const listener of listeners) listener();
    },
  };
}

it("steps dictation aside while voice is active and restores it when idle", async () => {
  const speech = await enableDictation();
  const voice = voiceController("idle");
  const host = fakeHost(snapshotFor({ entries: [], run: null, threadId: workId }));
  const { container, root, pane } = await mount(host, workId);
  await act(async () =>
    root.render(<VoiceContext value={voice.controller}>{pane(() => undefined)}</VoiceContext>),
  );
  expect(hasButton(container, "Start dictation (English)")).toBe(true);
  for (const phase of ["connecting", "listening", "hearing", "thinking", "speaking"] as const) {
    await act(async () => voice.move(phase));
    expect(hasButton(container, "Start dictation (English)"), phase).toBe(false);
    expect(speech.port.start).not.toHaveBeenCalled();
  }
  await act(async () => voice.move("idle"));
  await press(container, "Start dictation (English)");
  expect(speech.port.start).toHaveBeenCalledOnce();
});

it("docks voice above a task composer, floats without one and ignores unfocused docks", async () => {
  const voice = voiceController("listening");
  const host = fakeHost(snapshotFor({ entries: [], run: null, threadId: workId }));
  const { container, root, pane } = await mount(host, workId);
  const draw = async (composer: boolean) =>
    act(async () =>
      root.render(
        <VoiceContext value={voice.controller}>
          <section aria-label="Overlay">
            <VoiceOverlay />
          </section>
          <section aria-label="Task">{composer ? pane(() => undefined) : null}</section>
        </VoiceContext>,
      ),
    );
  const bar = '[aria-label="Voice: Listening"]';
  await draw(true);
  expect(container.querySelector('[aria-label="Task"]')?.querySelector(bar)).not.toBeNull();
  expect(container.querySelector('[aria-label="Overlay"]')?.querySelector(bar)).toBeNull();
  const composer = container.querySelector('[aria-label="Composer"]')!;
  expect(
    container.querySelector(bar)!.compareDocumentPosition(composer) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  await draw(false);
  expect(container.querySelector('[aria-label="Overlay"]')?.querySelector(bar)).not.toBeNull();
  await draw(true);
  expect(container.querySelector('[aria-label="Overlay"]')?.querySelector(bar)).toBeNull();
  harness.focused = false;
  await draw(true);
  expect(container.querySelector('[aria-label="Task"]')?.querySelector(bar)).toBeNull();
  expect(container.querySelector('[aria-label="Overlay"]')?.querySelector(bar)).not.toBeNull();
  harness.focused = true;
  await draw(true);
  expect(container.querySelector('[aria-label="Task"]')?.querySelector(bar)).not.toBeNull();
  expect(container.querySelector('[aria-label="Overlay"]')?.querySelector(bar)).toBeNull();
});

it("offers voice on Chat's first message but not on a new task composer", async () => {
  const { HomeIntro } = await import("../screens/home-intro.js");
  const { FirstMessageComposer, firstMessageExecution } = await import("./first-message.js");
  const host = fakeHost({
    ...snapshotFor({ entries: [], run: null, threadId: workId }),
    homeThreadId: null,
  });
  const { container, root } = await mount(host, workId);
  const voice = voiceController("idle");
  await act(async () =>
    root.render(
      <VoiceContext value={voice.controller}>
        <HomeIntro
          deploymentId={deploymentId}
          hostClient={host.client}
          onHomeReady={vi.fn()}
          onQuoteTaken={vi.fn()}
          quote={null}
          userId={host.client.getSnapshot().user!.id}
          workspaceId={host.client.getSnapshot().workspaces[0]!.id}
        />
      </VoiceContext>,
    ),
  );
  expect(hasButton(container, "Talk to Opensteer")).toBe(true);
  await press(container, "Talk to Opensteer");
  expect(voice.controller.start).toHaveBeenCalledOnce();
  const staged = {
    items: [],
    notice: null,
    pick: vi.fn(),
    remove: vi.fn(),
    retry: vi.fn(),
  } as unknown as Parameters<typeof FirstMessageComposer>[0]["staged"];
  await act(async () =>
    root.render(
      <VoiceContext value={voice.controller}>
        <FirstMessageComposer
          blocker={null}
          held={false}
          execution={firstMessageExecution("task", host.client.getSnapshot())}
          inputRef={{ current: null }}
          onChangeText={vi.fn()}
          onChooseAI={vi.fn()}
          onSend={vi.fn()}
          placeholder="Task"
          quote={null}
          onRemoveQuote={vi.fn()}
          savedAttachmentKeys={[]}
          selectionLabel="Choose AI"
          sending={false}
          staged={staged}
          text=""
          underHeader={false}
          usageScope={{ deploymentId: "test-deployment", userId: "test-user" }}
        >
          {null}
        </FirstMessageComposer>
      </VoiceContext>,
    ),
  );
  expect(hasButton(container, "Talk to Opensteer")).toBe(false);
  await act(async () => voice.move("listening"));
  expect(container.querySelector('[aria-label="Voice: Listening"]')).not.toBeNull();
});
