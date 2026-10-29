// @vitest-environment happy-dom

import type {
  BrowserSessionSummary,
  HostClient,
  HostSnapshot,
  MessageEntry,
  ReasoningEntry,
  RunEntry,
  ToolEntry,
  TranscriptEntry,
} from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { createId, RunIdSchema, ThreadIdSchema, WorkspaceIdSchema } from "@opensteer/core";
import { BrowserSurfaceIdSchema } from "@opensteer/protocol";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadHeaderState } from "../thread/thread-pane.js";

/*
 * Run details: what one of Opensteer's replies did, in a native sheet opened on
 * purpose. What can go wrong: the Chat title still poses as a control; a
 * reply's menu opens another reply's
 * steps; the sheet freezes on what the reply had done when it opened; a step
 * cannot be opened from it; a reply no longer loaded leaves an empty sheet.
 */

const harness = vi.hoisted(() => ({
  dispatch: vi.fn(),
  goBack: vi.fn(),
  hostClient: null as HostClient | null,
  navigate: vi.fn(),
  setOptions: vi.fn(),
}));

vi.mock("react-native", () => {
  type Children = { readonly children?: ReactNode };
  return {
    Platform: { OS: "ios", select: (choices: { ios?: unknown }) => choices.ios },
    Pressable: (props: {
      readonly accessibilityHint?: string;
      readonly accessibilityLabel?: string;
      readonly children?: ReactNode | ((state: { pressed: boolean }) => ReactNode);
      readonly onPress?: () => void;
    }) => (
      <button
        aria-description={props.accessibilityHint}
        aria-label={props.accessibilityLabel}
        onClick={props.onPress}
      >
        {typeof props.children === "function" ? props.children({ pressed: false }) : props.children}
      </button>
    ),
    ScrollView: ({ children }: Children) => <div>{children}</div>,
    StyleSheet: { create: (styles: object) => styles, hairlineWidth: 1 },
    Text: ({ children }: Children) => <span>{children}</span>,
    View: (props: Children & { readonly accessibilityLabel?: string }) => (
      <div aria-label={props.accessibilityLabel}>{props.children}</div>
    ),
  };
});
vi.mock("react-native-reanimated", () => ({
  default: {
    View: (props: { readonly accessibilityLabel?: string; readonly children?: ReactNode }) => (
      <div aria-label={props.accessibilityLabel}>{props.children}</div>
    ),
  },
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));
vi.mock("@react-navigation/native", () => ({
  StackActions: {
    push: (name: string, params: object) => ({ name, params, type: "PUSH" }),
  },
  useNavigation: () => ({
    dispatch: harness.dispatch,
    goBack: harness.goBack,
    navigate: harness.navigate,
    setOptions: harness.setOptions,
  }),
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock("expo-haptics", () => ({ selectionAsync: vi.fn(async () => undefined) }));
vi.mock("../client/mobile-client.js", () => ({
  operationDetail: (_error: unknown, fallback: string) => fallback,
}));
vi.mock("../ui/mobile-client-context.js", () => ({
  useHostUserId: () => null,
  useMobileState: () => ({
    selection: { deploymentId, hostClient: harness.hostClient },
  }),
}));
vi.mock("../ui/screen.js", () => ({ useGutter: () => 16 }));
vi.mock("../ui/motion.js", () => ({ appear: undefined, exit: undefined }));
vi.mock("../ui/glass.js", () => ({ useLiquidGlass: () => false }));
vi.mock("../ui/primitives.js", () => ({
  AppText: ({ children }: { readonly children?: ReactNode }) => <span>{children}</span>,
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
  SecondaryButton: () => null,
  StatusDot: () => null,
  TypingDots: () => null,
  monoFontFamily: "monospace",
}));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("../ui/chat-orb.js", () => ({ ChatOrb: () => <i data-chat-orb /> }));
vi.mock("../ui/workspace-mark.js", () => ({
  WorkspaceDot: () => null,
  WorkspaceMark: () => null,
  WorkspaceIconGlyph: () => null,
}));
vi.mock("../markdown/markdown.js", () => ({
  Markdown: ({ text }: { readonly text: string }) => <p>{text}</p>,
  PlainProse: ({ text }: { readonly text: string }) => <p>{text}</p>,
}));
vi.mock("../thread/message-menu.js", () => ({ MessageMenu: () => null }));
vi.mock("../thread/attachment-views.js", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    AttachmentReader: React.createContext<HostClient | null>(null),
    MessageAttachments: () => null,
  };
});
vi.mock("../thread/assignment-card.js", async () => ({
  ...(await vi.importActual<typeof import("../thread/assignment-card.js")>(
    "../thread/assignment-card.js",
  )),
  AssignmentCard: () => null,
}));
vi.mock("../thread/computer-use-line.js", () => ({
  ComputerUseLine: () => null,
  KeptComputerStopLine: () => null,
  useComputerLine: () => null,
}));
vi.mock("../thread/thread-pane.js", () => ({ sameThreadHeader: () => false }));
vi.mock("../navigation-header.js", () => ({ browserHeaderActions: () => ({}) }));

const { ConversationActivityScreen } = await import("./conversation-activity.js");
const { useThreadHeader } = await import("./thread-header.js");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  harness.dispatch.mockReset();
  harness.goBack.mockReset();
  harness.hostClient = null;
  harness.navigate.mockReset();
  harness.setOptions.mockReset();
});

const deploymentId = "dep_0192f4a1-1111-4000-8000-000000000001";
const base = new MockHostClient({ automations: "absent", latencyMs: 0 }).getSnapshot();
const chatId = ThreadIdSchema.parse(base.homeThreadId);
const workspaceId = WorkspaceIdSchema.parse(
  base.threads.find(({ id }) => id === chatId)?.workspaceId,
);
const at = "2026-10-09T10:00:00.000Z";
const later = "2026-10-09T10:05:00.000Z";

let sequence = 0;
function said(body: string, runId: string): MessageEntry {
  sequence += 1;
  return {
    author: { displayName: "Alex", kind: "human", principalId: "user:alex" },
    body,
    createdAt: at,
    id: createId("message"),
    kind: "message",
    messageKind: "input",
    runId,
    sequence: String(sequence),
  };
}
function wrote(body: string, runId: string, createdAt = at): MessageEntry {
  sequence += 1;
  return {
    author: {
      displayName: "Opensteer",
      kind: "agent",
      runId: RunIdSchema.parse(runId),
      threadId: chatId,
      workspaceId,
      workspaceName: "Main",
    },
    body,
    createdAt,
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

const runA = createId("run");
const runB = createId("run");
const askA = said("What's on Thursday?", runA);
const thoughtA: ReasoningEntry = {
  completedAt: at,
  createdAt: at,
  id: `reasoning:${runA}:1`,
  kind: "reasoning",
  runId: runA,
  state: "done",
  text: "Thursday has two meetings.",
};
const noteA = wrote("Looking at your calendar first.", runA);
const lookupA = command(runA, "calendar thursday");
const replyA = wrote("Design review with Maya at 2:00.", runA);
const answered: TranscriptEntry[] = [
  askA,
  ran(runA, { replyMessageId: replyA.id, status: "completed" }),
  thoughtA,
  noteA,
  lookupA,
  replyA,
];
const askB = said("Can you draft a note to Maya?", runB);
const preambleB = wrote("Drafting it now.", runB);
const draftingB = command(runB, "draft note", true);
const replying: TranscriptEntry[] = [...answered, askB, ran(runB), preambleB, draftingB];

function snapshotWith(entries: readonly TranscriptEntry[]): HostSnapshot {
  return {
    ...base,
    connection: "connected",
    inputQueues: {},
    network: "online",
    session: "authenticated",
    transcripts: { ...base.transcripts, [chatId]: [...entries] },
  };
}

function fakeHost(initial: HostSnapshot) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  const client = {
    getSnapshot: () => snapshot,
    load: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as HostClient;
  harness.hostClient = client;
  return {
    client,
    move(next: HostSnapshot) {
      snapshot = next;
      act(() => {
        for (const listener of listeners) listener();
      });
    },
  };
}

function render(node: ReactNode): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(node));
  return container;
}

function activity(turnKey?: string): HTMLElement {
  const params = { deploymentId, threadId: chatId, ...(turnKey === undefined ? {} : { turnKey }) };
  return render(<ConversationActivityScreen route={{ params }} />);
}

function press(container: HTMLElement, words: string): void {
  const target = [...container.querySelectorAll("button")].find(
    (candidate) =>
      candidate.getAttribute("aria-label") === words || candidate.textContent?.includes(words),
  );
  if (!target) throw new Error(`No control for ${words}`);
  act(() => target.click());
}

describe("Run details", () => {
  it("opens the exact browser tab used by this reply even when another tab is viewed", () => {
    const browser = {
      access: "full-control",
      attachedRunIds: [],
      dialog: null,
      error: null,
      id: "exact-browser",
      origin: "agent",
      placement: { kind: "runner", runnerId: "runner" },
      profileId: null,
      runtimeId: "runtime",
      state: "ready",
      tabs: [
        {
          active: true,
          id: BrowserSurfaceIdSchema.parse("viewed-tab"),
          title: "Other page",
          url: "https://other.test",
        },
        {
          active: false,
          id: BrowserSurfaceIdSchema.parse("used-tab"),
          title: "Research",
          url: "https://research.test",
        },
      ],
      viewerError: null,
      viewerState: "synchronized",
      workspaceId,
      uses: [
        {
          threadId: chatId,
          runId: runA,
          tabId: "used-tab",
          firstUsedAt: at,
          lastUsedAt: at,
          pageTitle: "Research",
          pageSite: "https://research.test",
        },
      ],
    } as BrowserSessionSummary;
    fakeHost({ ...snapshotWith(answered), browserSessions: [browser] });
    const sheet = activity(`turn:run:${runA}`);
    press(sheet, "Research, research.test");
    // The sheet closes first, so the page opens over the conversation rather than inside it.
    expect(harness.goBack).toHaveBeenCalledOnce();
    expect(harness.dispatch).toHaveBeenCalledWith({
      name: "WorkspaceBrowser",
      params: {
        deploymentId,
        sessionId: "exact-browser",
        tabId: "used-tab",
        threadId: chatId,
      },
      type: "PUSH",
    });
  });

  it("opens on the reply being written and stays with it as it finishes", () => {
    const host = fakeHost(snapshotWith(replying));
    const sheet = activity();

    expect(sheet.textContent).toContain("Run details");
    expect(sheet.textContent).toContain("Now");
    expect(sheet.textContent).toContain(preambleB.body);
    expect(sheet.textContent).toContain("draft note");
    expect(sheet.textContent).not.toContain(noteA.body);
    expect(sheet.textContent).not.toContain(thoughtA.text);

    const replyB = wrote("Here is the note for Maya.", runB, later);
    host.move(
      snapshotWith([
        ...answered,
        askB,
        ran(runB, { replyMessageId: replyB.id, status: "completed" }),
        preambleB,
        { ...draftingB, completedAt: later, output: { text: "ok" }, state: "done" },
        replyB,
      ]),
    );
    expect(sheet.textContent).not.toContain("Now");
    expect(sheet.textContent).toContain(preambleB.body);
    expect(sheet.textContent).toContain("draft note");
    // The reply is the conversation's; Run details are what led to it.
    expect(sheet.textContent).not.toContain(replyB.body);
  });

  it("shows the reply it was opened from, and only that reply's steps", () => {
    fakeHost(snapshotWith(replying));
    const sheet = activity(`turn:run:${runA}`);

    expect(sheet.textContent).toContain(noteA.body);
    expect(sheet.textContent).toContain("calendar thursday");
    expect(sheet.textContent).not.toContain(replyA.body);
    expect(sheet.textContent).not.toContain(preambleB.body);
    expect(sheet.textContent).not.toContain("Now");
  });

  it("opens one step in full over it", () => {
    fakeHost(snapshotWith(answered));
    const sheet = activity(`turn:run:${runA}`);

    press(sheet, "calendar thursday");
    expect(harness.navigate).toHaveBeenCalledWith("ThreadStep", {
      deploymentId,
      entryId: lookupA.id,
      threadId: chatId,
    });
  });

  it("says so, with a way out, when that reply is no longer loaded", () => {
    fakeHost(snapshotWith(answered));
    const sheet = activity("turn:gone");

    expect(sheet.querySelector('[role="alert"]')?.textContent).toContain(
      "These run details can't be shown",
    );
    press(sheet, "Close");
    expect(harness.goBack).toHaveBeenCalled();
  });

  it("stays on a reply a message joined while the reply's next step arrives", () => {
    const runC = createId("run");
    const askC = said("Plan the trip to Lisbon", runC);
    const looked: ReasoningEntry = { ...thoughtA, id: `reasoning:${runC}:1`, runId: runC };
    const moreC = said("Also book the hotel", runC);
    const joined: TranscriptEntry[] = [...answered, askC, ran(runC), looked, moreC];
    const host = fakeHost(snapshotWith(joined));
    // What a link to a step said before the message hands over: the turn it was said in.
    const sheet = activity(`turn:run:${runC}`);
    expect(sheet.textContent).toContain("Now");
    expect(sheet.querySelector('[role="alert"]')).toBeNull();

    const compared = command(runC, "compare hotels");
    host.move(snapshotWith([...joined, compared]));
    expect(sheet.querySelector('[role="alert"]')).toBeNull();
    expect(sheet.textContent).toContain("Now");
    expect(sheet.textContent).toContain("compare hotels");
  });

  it("says there is nothing yet before Opensteer has done anything", () => {
    fakeHost(snapshotWith([]));
    const sheet = activity();

    expect(sheet.textContent).toContain("Nothing yet");
    expect(sheet.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("the conversation's title", () => {
  function Header(props: {
    readonly header: ThreadHeaderState;
    readonly hostClient: HostClient;
  }): ReactNode {
    useThreadHeader({
      deploymentId,
      fallbackTitle: "Chat",
      header: props.header,
      hostClient: props.hostClient,
      threadId: chatId,
    });
    return null;
  }

  function title(
    header: ThreadHeaderState,
    hostClient = fakeHost(snapshotWith([])).client,
  ): HTMLElement {
    render(<Header header={header} hostClient={hostClient} />);
    const options = harness.setOptions.mock.calls.at(-1)?.[0] as
      { readonly headerTitle?: unknown } | undefined;
    if (typeof options?.headerTitle !== "function") throw new Error("No title was set.");
    const draw = options.headerTitle as () => ReactNode;
    return render(<>{draw()}</>);
  }

  const chatHeader: ThreadHeaderState = {
    canRetry: false,
    connectionLabel: null,
    surfaceCount: 0,
    surfacesActing: false,
    task: null,
    title: "Chat",
    workspaceId,
    workspaceName: null,
    workspaceColor: null,
    workspaceIcon: null,
    icon: null,
    color: null,
    isHome: true,
  };

  it("is only the conversation's name: Run details open from the transcript", () => {
    const bar = title(chatHeader);
    expect(bar.textContent).toContain("Chat");
    expect(bar.querySelector("[data-chat-orb]")).not.toBeNull();
    expect(bar.querySelector("button")).toBeNull();
  });

  it("leaves the connection line and its Retry their own", () => {
    const refresh = vi.fn(async () => undefined);
    const client = fakeHost(snapshotWith([])).client;
    vi.spyOn(client, "refresh").mockImplementation(refresh);
    const bar = title(
      {
        ...chatHeader,
        canRetry: true,
        connectionLabel: "Unavailable",
        title: "Ana Lopez",
        workspaceName: "Main",
      },
      client,
    );

    expect(bar.textContent).toContain("Ana Lopez");
    const buttons = [...bar.querySelectorAll("button")];
    expect(buttons.map((candidate) => candidate.textContent)).toEqual(["Retry"]);
    const retry = buttons[0];
    expect(bar.textContent).toContain("Unavailable");
    act(() => retry?.click());
    expect(refresh).toHaveBeenCalled();
  });
});
