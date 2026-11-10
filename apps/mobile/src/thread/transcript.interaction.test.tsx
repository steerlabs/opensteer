// @vitest-environment happy-dom

import type { WebViewProps } from "react-native-webview";
import { AccessibilityInfo, Linking } from "react-native";
import { act, useState, type ComponentProps, type ReactNode } from "react";
import { createId } from "@opensteer/core";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  groupTranscriptEntries,
  type DelegationEntry,
  type HostClient,
  type HostSnapshot,
  type MessageEntry,
  type NodeEntry,
  type PlaceEntry,
  type BrowserSessionSummary,
  type ReasoningEntry,
  type RunEntry,
  type ToolEntry,
  type TranscriptEntry,
  type WorkspaceSummary,
} from "@opensteer/client/host";
import { mockComputerUseToolRefs, mockComputerUseTurn } from "@opensteer/client/mock";
import { MockHostClient } from "@opensteer/client/mock";
import { BrowserSessionIdSchema, ThreadIdSchema } from "@opensteer/core";
import {
  TranscriptAppTabsContext,
  TranscriptSurfacesContext,
  TracePlace,
  type TranscriptAppTabs,
  type TranscriptSurfaces,
} from "./surface-chips.js";
import { TranscriptGroupRow, replyActivityKeys } from "./transcript.js";
import { AgentMemoryContext } from "./agent-cards.js";
import { TaskScopeContext } from "./task-line.js";
import { AppCard } from "./app-card.js";
import { TranscriptHostClientContext } from "./attachment-views.js";

// Exercise the actual native renderer's state and hierarchy with DOM hosts.
// The platform controls and animation drivers are outside this regression.
const appWebView = vi.hoisted(() => ({ props: null as WebViewProps | null }));
vi.mock("react-native-webview", () => ({
  WebView: (props: WebViewProps) => {
    appWebView.props = props;
    const {
      source,
      style,
      containerStyle,
      incognito,
      sharedCookiesEnabled,
      thirdPartyCookiesEnabled,
      allowFileAccess,
      onMessage,
    } = props;
    return (
      <div
        data-app-webview
        data-uri={source && "uri" in source ? source.uri : ""}
        data-style={JSON.stringify(style)}
        data-container-style={JSON.stringify(containerStyle)}
        data-isolation={JSON.stringify({
          incognito,
          sharedCookiesEnabled,
          thirdPartyCookiesEnabled,
          allowFileAccess,
        })}
      >
        <button
          onClick={() =>
            onMessage?.({
              nativeEvent: { data: JSON.stringify({ type: "opensteer-app:size", height: 50_000 }) },
            } as Parameters<NonNullable<WebViewProps["onMessage"]>>[0])
          }
        >
          Report app height
        </button>
      </div>
    );
  },
}));
vi.mock("react-native", () => ({
  AccessibilityInfo: { announceForAccessibility: vi.fn() },
  Platform: { OS: "ios", Version: "26" },
  Linking: { openURL: vi.fn(async () => undefined) },
  ActivityIndicator: () => <span>Loading app</span>,
  View: ({
    children,
    accessibilityLabel,
    style,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
    style?: object;
  }) => (
    <div aria-label={accessibilityLabel} data-style={JSON.stringify(style)}>
      {children}
    </div>
  ),
  Image: () => <img alt="" />,
  Pressable: ({
    disabled,
    children,
    onPress,
    accessibilityState,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    accessibilityState?: { expanded?: boolean; disabled?: boolean };
    accessibilityLabel?: string;
  }) => (
    <button
      disabled={disabled}
      aria-expanded={accessibilityState?.expanded}
      aria-label={accessibilityLabel}
      onClick={onPress}
    >
      {children}
    </button>
  ),
  StyleSheet: { create: (styles: object) => styles, hairlineWidth: 1 },
  useWindowDimensions: () => ({ fontScale: 1, height: 844, scale: 3, width: 390 }),
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaProvider: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  useSafeAreaFrame: () => ({ height: 844, width: 390, x: 0, y: 0 }),
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));
vi.mock("react-native-reanimated", () => ({
  default: {
    View: ({
      children,
      accessibilityLabel,
    }: {
      children?: ReactNode;
      accessibilityLabel?: string;
    }) => (
      <div aria-label={accessibilityLabel} data-animated-view>
        {children}
      </div>
    ),
  },
  LayoutAnimationConfig: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("../ui/motion.js", () => ({
  appear: undefined,
  bubblePop: undefined,
  bubbleRise: undefined,
  enter: undefined,
  exit: undefined,
  move: undefined,
}));
vi.mock("../ui/sheet.js", () => ({ Sheet: () => null }));
vi.mock("../ui/primitives.js", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Notice: (props: {
    action: { label: string; onPress: () => void };
    detail: string;
    title: string;
  }) => (
    <div role="alert">
      {props.title}: {props.detail}
      <button onClick={props.action.onPress}>{props.action.label}</button>
    </div>
  ),
  StatusDot: () => null,
  TypingDots: () => null,
  monoFontFamily: "monospace",
}));
vi.mock("../ui/symbol.js", () => ({
  Symbol: ({ name }: { name: string }) => <i data-symbol={name} />,
}));
vi.mock("../ui/chat-orb.js", () => ({ ChatOrb: () => <i data-chat-orb /> }));
vi.mock("../ui/workspace-mark.js", () => ({
  WorkspaceMark: () => null,
  WorkspaceIconGlyph: () => null,
}));
// The native menu's Activity item, as `messageActions` titles it.
vi.mock("./message-hold.js", () => ({
  MessageHold: (props: { children: ReactNode; onActivity?: () => void }) => (
    <>
      {props.children}
      {props.onActivity ? <button onClick={props.onActivity}>Run details</button> : null}
    </>
  ),
  MessageMore: () => null,
}));
vi.mock("../ui/copy-mark.js", () => ({ CopyMark: () => null }));
vi.mock("./attachment-views.js", async () => ({
  MessageAttachments: () => null,
  TranscriptHostClientContext: (await import("react")).createContext<
    import("@opensteer/client/host").HostClient | null
  >(null),
}));
vi.mock("../markdown/markdown.js", () => ({
  Markdown: ({ text }: { text: string }) => <p>{text}</p>,
  PlainProse: ({ text }: { text: string }) => <p>{text}</p>,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) void act(() => root.unmount());
  document.body.replaceChildren();
});

const run: RunEntry = {
  id: "run:a",
  kind: "run",
  replyMessageId: null,
  runId: "a",
  status: "running",
  createdAt: "2026-08-16T10:00:00.000Z",
  error: null,
};
const thought: ReasoningEntry = {
  id: "reasoning:a:1",
  kind: "reasoning",
  runId: "a",
  state: "done",
  createdAt: run.createdAt,
  completedAt: "2026-08-16T10:00:02.000Z",
  text: "This completed thought arrived in a live snapshot.",
};
const note: MessageEntry = {
  id: "message:a:1",
  kind: "message",
  messageKind: "assistant",
  runId: "a",
  createdAt: run.createdAt,
  author: { kind: "platform", cause: "test" },
  body: "Checking the result.",
};
const command: ToolEntry = {
  id: "tool:a:1",
  kind: "tool",
  runId: "a",
  callId: "call-1",
  state: "done",
  createdAt: run.createdAt,
  completedAt: thought.completedAt,
  arguments: { command: "first-command" },
  output: { text: "done" },
  tool: { namespace: "codex", name: "shell" },
  integration: null,
  isError: false,
  streamText: "",
};

// The recorded Run that showed only these counters under its reply.
const runUsage = {
  cachedInputTokens: 115_456,
  inputTokens: 1_565,
  outputTokens: 1_424,
  reasoningTokens: 1_022,
};

/** The row as the pane draws it, holding which turns the reader opened while it is mounted. */
function PaneRow(
  props: Omit<ComponentProps<typeof TranscriptGroupRow>, "onToggleOpen" | "open">,
): ReactNode {
  const [open, setOpen] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  return (
    <TranscriptGroupRow
      {...props}
      onToggleOpen={(key, current) => setOpen((choices) => new Map(choices).set(key, !current))}
      open={open.get(props.group.key) ?? null}
    />
  );
}

function setup(conversation = false, surfaces: TranscriptSurfaces | null = null) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const onOpenStep = vi.fn();
  const onOpenActivity = vi.fn();
  const onOpenThread = vi.fn();
  return {
    container,
    onOpenActivity,
    onOpenThread,
    onOpenStep,
    render(
      entries: TranscriptEntry[],
      workspaces: readonly WorkspaceSummary[] = [],
      grouping: Parameters<typeof groupTranscriptEntries>[1] = {},
    ) {
      const groups = groupTranscriptEntries(entries, grouping);
      const group = groups[0];
      if (!group) throw new Error("Missing turn");
      void act(() =>
        root.render(
          <TranscriptSurfacesContext value={surfaces}>
            <PaneRow
              activityKey={replyActivityKeys(groups).get(group.key) ?? null}
              conversation={conversation}
              group={group}
              highlightRequestId={null}
              onOpenActivity={onOpenActivity}
              onOpenStep={onOpenStep}
              onOpenThread={onOpenThread}
              spacingTop={0}
              homeThreadId={null}
              viewerUserId={null}
              workspaces={workspaces}
            />
          </TranscriptSurfacesContext>,
        ),
      );
    },
  };
}

function press(container: HTMLElement, text: string): void {
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent?.includes(text) || item.getAttribute("aria-label") === text,
  );
  if (!button) throw new Error(`Missing button: ${text}`);
  act(() => button.click());
}

describe("native transcript prose", () => {
  it("keeps finalized streamed prose outside row animations", () => {
    const { container, render } = setup();
    render([run, command, { ...note, id: "stream:a", streaming: true }]);
    const prose = () =>
      [...container.querySelectorAll("p")].find((p) => p.textContent === note.body)!;
    expect(prose().closest("[data-animated-view]")).toBeNull();
    render([run, command, note]);
    expect(prose().closest("[data-animated-view]")).toBeNull();
    expect(container.querySelector("[data-animated-view]")?.textContent).toContain("Ran a command");
  });

  it("windows a long open trace and reveals its earlier rows", () => {
    const { container, render } = setup();
    const notes = Array.from({ length: 32 }, (_, i) => ({
      ...note,
      id: `note-${i}`,
      body: `Trace note ${i}.`,
    }));
    render([run, ...notes]);
    expect(container.querySelectorAll("p")).toHaveLength(30);
    expect(container.textContent).not.toContain("Trace note 0.");
    expect(container.textContent).toContain("Trace note 31.");
    press(container, "Show 2 earlier steps");
    expect(container.querySelectorAll("p")).toHaveLength(32);
    expect(container.textContent).toContain("Trace note 0.");
    expect(container.textContent).not.toContain("earlier steps");
  });

  it("draws an incoming report in a task from its bounded excerpt until opened in place", () => {
    const workspaceId = createId("workspace");
    const update: MessageEntry = {
      ...note,
      id: "worker-report",
      messageKind: "input",
      policy: "report",
      author: {
        displayName: "Travel research",
        kind: "agent",
        runId: createId("run"),
        threadId: createId("thread"),
        workspaceId,
        workspaceName: "Travel",
      },
      body: `Three flights fit. ${"Details and evidence. ".repeat(100)}FINAL SOURCE`,
    };
    const task = setup();
    task.render([update], [{ id: workspaceId, name: "Travel" } as unknown as WorkspaceSummary]);
    expect(task.container.textContent).toContain("Three flights fit.");
    expect(task.container.textContent).not.toContain("FINAL SOURCE");
    press(task.container, "Show more");
    expect(task.container.textContent).toContain("FINAL SOURCE");
    press(task.container, "Show less");
    expect(task.container.textContent).not.toContain("FINAL SOURCE");
  });

  it("shows the Run's reply as Opensteer's message and keeps what it did behind it", () => {
    const { container, render, onOpenActivity } = setup(true);
    const answer = { ...note, id: "final", body: "Here is the useful answer." };
    render([{ ...run, replyMessageId: answer.id, status: "completed" }, note, command, answer]);
    expect(container.textContent).toContain(answer.body);
    const prose = [...container.querySelectorAll("p")].find(
      (node) => node.textContent === answer.body,
    );
    const readingSurface = JSON.parse(prose!.parentElement!.dataset.style!);
    expect(readingSurface.backgroundColor).toBeUndefined();
    expect(readingSurface.borderWidth).toBeUndefined();
    expect(container.textContent).not.toContain(note.body);
    // The reply's menu is the only way in; nothing in the conversation opens in place.
    expect([...container.querySelectorAll("button")].map((item) => item.textContent)).toEqual([
      "Run details",
    ]);
    press(container, "Run details");
    expect(onOpenActivity).toHaveBeenCalledWith("turn:run:a");
    expect(container.textContent).not.toContain(note.body);
  });

  it("never shows what a failed Run wrote on the way as its answer", () => {
    const { container, render, onOpenActivity } = setup(true);
    render([
      {
        ...run,
        error: { code: "failed", message: "The page would not load", retryable: false },
        status: "failed",
        usage: runUsage,
      },
      note,
      command,
    ]);
    expect(container.textContent).toContain("The page would not load");
    expect(container.textContent).not.toContain(note.body);
    expect(container.textContent).not.toContain("Show steps");
    // What it did on the way is still there to open, from the outcome's own menu.
    press(container, "Run details");
    expect(onOpenActivity).toHaveBeenCalledWith("turn:run:a");
    expect(container.textContent).not.toContain(note.body);
    expect(container.textContent).not.toContain("1.6k in");
    expect(container.textContent).not.toContain("Execution details");
  });

  it("shows Opensteer typing while it answers, with nothing under it to press", () => {
    const { container, render } = setup(true);
    render([run, note, { ...command, completedAt: null, state: "running" }]);
    // Typing is what Opensteer is doing, never a control, and nothing stands under it.
    const typing = container.querySelector('[aria-label="Opensteer is replying"]');
    expect(typing).not.toBeNull();
    expect(typing?.closest("button")).toBeNull();
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.textContent).not.toContain(note.body);
    expect(container.textContent).not.toContain("Show steps");
  });

  it("says the AI account is getting ready where typing would stand, and types for an ordinary start", () => {
    const queued: RunEntry = { ...run, status: "queued" };
    const startHold = "Codex 2 is getting ready";
    const typing = (container: HTMLElement) =>
      container.querySelector('[aria-label="Opensteer is replying"]');
    const conversation = setup(true);
    conversation.render([queued], [], { startHold });
    expect(conversation.container.textContent).toBe(startHold);
    expect(typing(conversation.container)).toBeNull();
    conversation.render([queued]);
    expect(typing(conversation.container)).not.toBeNull();
    expect(conversation.container.textContent).not.toContain(startHold);

    const work = setup();
    work.render([queued], [], { startHold });
    expect(work.container.textContent).toContain(startHold);
    work.render([queued]);
    expect(work.container.textContent).toContain("Starting");
  });

  it("keeps a plain answer a message: nothing to open and no usage, while written or after", () => {
    const { container, render } = setup(true);
    const answer = { ...note, id: "final", body: "Here is the useful answer." };
    const writing = { ...answer, body: "Here is the", id: "stream:a", streaming: true };
    for (const written of [writing, answer]) {
      render([{ ...run, usage: runUsage }, written]);
      expect(container.querySelector('[aria-label="Opensteer is replying"]')).not.toBeNull();
      expect(container.querySelectorAll("button")).toHaveLength(0);
      expect(container.textContent).not.toContain("Here is the");
    }
    render([{ ...run, replyMessageId: answer.id, status: "completed", usage: runUsage }, answer]);
    expect(container.textContent).toContain(answer.body);
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.textContent).not.toContain("1.6k in");
    expect(container.textContent).not.toContain("Execution details");
  });

  it("keeps a reply's steps out of the conversation while it is written and after", () => {
    const { container, render, onOpenActivity } = setup(true);
    const answer = { ...note, id: "final", body: "Here is the useful answer." };
    const live = { ...run, usage: runUsage };
    render([live, note, command, { ...answer, id: "stream:a", streaming: true }]);
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.textContent).not.toContain(note.body);
    expect(container.textContent).not.toContain(answer.body);

    render([{ ...live, replyMessageId: answer.id, status: "completed" }, note, command, answer]);
    expect(container.textContent).not.toContain(note.body);
    expect(container.textContent?.split(answer.body)).toHaveLength(2);
    press(container, "Run details");
    expect(onOpenActivity).toHaveBeenCalledWith("turn:run:a");
    expect(container.textContent).not.toContain(note.body);
    expect(container.textContent).not.toContain("1.6k in");
    expect(container.textContent).not.toContain("Execution details");
  });

  it("ends a work transcript's finished turn at its work, with no token counts", () => {
    const { container, render } = setup();
    render([{ ...run, status: "completed", usage: runUsage }, command]);
    expect(container.textContent).not.toContain("1.6k in");
    expect(container.textContent).not.toContain("Execution details");

    const answer = { ...note, id: "final", body: "Here is the useful answer." };
    render([{ ...run, replyMessageId: answer.id, status: "completed" }, answer]);
    expect(container.textContent).toContain(answer.body);
    expect(container.querySelector('[aria-label="Agent status"]')).toBeNull();
  });

  it("shows a live task's notes and steps in order, then folds to its last word", () => {
    const { container, render, onOpenStep } = setup();
    const answer = { ...note, id: "answer", body: "The final answer." };
    render([run, note, command, answer]);
    expect(statusLine(container).getAttribute("aria-expanded")).toBe("true");
    const text = container.textContent!;
    expect(text.indexOf(note.body)).toBeLessThan(text.indexOf("Ran a command"));
    expect(text.indexOf("Ran a command")).toBeLessThan(text.indexOf(answer.body));
    const message = container.querySelectorAll("p")[1];
    render([{ ...run, status: "completed" }, note, command, answer]);
    expect(statusLine(container).getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain(note.body);
    expect(container.textContent).not.toContain("Ran a command");
    expect(container.querySelector("p")).toBe(message);
    act(() => statusLine(container).click());
    expect(container.textContent).toContain(note.body);
    press(container, "Ran a command");
    expect(onOpenStep).toHaveBeenCalledWith(command.id);
  });

  it.each([true, false])(
    "keeps the reader's explicit open=%s choice when a task settles",
    (open) => {
      const { container, render } = setup();
      const entries = [note, command, { ...note, id: "answer", body: "Answer." }];
      render([run, ...entries]);
      act(() => statusLine(container).click());
      if (open) act(() => statusLine(container).click());
      expect(statusLine(container).getAttribute("aria-expanded")).toBe(String(open));
      render([{ ...run, status: "completed" }, ...entries]);
      expect(statusLine(container).getAttribute("aria-expanded")).toBe(String(open));
      expect(container.textContent?.includes(note.body)).toBe(open);
      expect(container.textContent?.includes("Ran a command")).toBe(open);
    },
  );

  // Failure mode: the status line jumps from below the reply to above it when
  // the run ends, or the agent's words remount as tools arrive.
  it("leads with one status line and keeps the agent's words mounted as tools arrive and the run ends", () => {
    const { container, render } = setup();
    render([run, thought, note]);
    const message = container.querySelector("p");
    const status = statusLine(container);
    const next = { ...thought, id: "reasoning:a:2", text: "A new independent thought." };
    render([run, thought, note, command, next]);
    expect(container.querySelector("p")).toBe(message);
    expect(statusLine(container)).toBe(status);
    const answer = { ...note, id: "final-answer", body: "Final answer after the work." };
    render([{ ...run, status: "completed" }, thought, note, command, next, answer]);
    expect(container.textContent).not.toContain(note.body);
    expect(container.textContent).toContain(answer.body);
    expect(statusLine(container)).toBe(status);
    expect(status.textContent).toBe("Worked for 2s");
    const text = container.textContent!;
    expect(text.indexOf("Worked")).toBeLessThan(text.indexOf(answer.body));
  });

  it("keeps the same status line through writing, waiting, stopping and the end, opening every step in place", () => {
    const { container, render } = setup();
    const answer = {
      ...note,
      id: "final-answer",
      body: "The answer is arriving.",
      streaming: true,
    };
    render([run, command, note, answer]);
    const status = statusLine(container);
    const message = container.querySelectorAll("p")[1];
    const phases: readonly [RunEntry, string][] = [
      [run, "Writing"],
      [{ ...run, status: "waiting" }, "Waiting for you"],
      [{ ...run, stopping: true }, "Stopping"],
    ];
    for (const [phase, label] of phases) {
      render([phase, command, note, answer]);
      expect(container.querySelectorAll("p")[1]).toBe(message);
      expect(statusLine(container)).toBe(status);
      expect(status.textContent).toContain(label);
    }

    // Answered, the turn is its last word under a closed "Worked" line, and the
    // steps are not drawn at all, not merely hidden.
    const answered = [
      { ...run, replyMessageId: answer.id, status: "completed" } satisfies RunEntry,
      command,
      note,
      { ...answer, streaming: false },
    ];
    render(answered);
    expect(statusLine(container)).toBe(status);
    expect(status.textContent).toMatch(/^Worked/u);
    expect(status.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelectorAll("p")).toHaveLength(1);
    expect(container.querySelector("p")).toBe(message);
    expect(container.textContent).not.toContain("Ran a command");

    // Opened, every step is back where it happened, between the words.
    act(() => status.click());
    expect(status.getAttribute("aria-expanded")).toBe("true");
    const text = container.textContent!;
    expect(text.indexOf("Worked")).toBeLessThan(text.indexOf("Ran a command"));
    expect(text.indexOf("Ran a command")).toBeLessThan(text.indexOf(note.body));
    expect(text.indexOf(note.body)).toBeLessThan(text.indexOf(answer.body));
    expect(container.querySelectorAll("p")[1]).toBe(message);
    // The reader's choice holds while the Thread moves on around it.
    render(answered.map((entry) => ({ ...entry })));
    expect(statusLine(container).getAttribute("aria-expanded")).toBe("true");
    act(() => statusLine(container).click());
    expect(container.textContent).not.toContain("Ran a command");
    expect(container.textContent).not.toContain(note.body);
    expect(container.textContent).toContain(answer.body);

    // A turn that failed or stopped says so below its words; its steps stay one tap away.
    const ended: readonly [RunEntry, string][] = [
      [
        {
          ...run,
          error: { code: "failed", message: "The page would not load", retryable: false },
          status: "failed",
        },
        "The page would not load",
      ],
      [{ ...run, status: "interrupted" }, "This run stopped."],
    ];
    for (const [outcome, said] of ended) {
      render([outcome, command, note]);
      expect(container.textContent).toContain(said);
      expect(container.textContent).toContain(note.body);
      expect(statusLine(container).textContent).toMatch(/^Worked/u);
      expect(container.textContent!.indexOf(note.body)).toBeLessThan(
        container.textContent!.indexOf(said),
      );
    }
  });
});

/** A task's turn leads with its status line, which opens and closes its steps. */
function statusLine(container: HTMLElement): HTMLElement {
  const line = container.querySelector("button");
  if (!line) throw new Error("No status line");
  return line;
}

// Ways an old delegation's line can fail: it opens the conversation that
// handed the work out instead of the one that did it, where the task, its
// result and the pages it used are; or a failure reads like a finish.
describe("a turn's subagents", () => {
  const threadId = "thread_subagents";
  const node = (title: string, minute: number, patch: Partial<NodeEntry> = {}): NodeEntry => {
    const nodeId = createId("executionNode");
    return {
      id: `node:${nodeId}`,
      kind: "node",
      nodeKind: "subagent",
      nodeId,
      title,
      runId: "a",
      status: "running",
      createdAt: `2026-08-16T10:0${minute}:00.000Z`,
      completedAt: null,
      model: null,
      effort: null,
      originCallId: null,
      parentNodeId: null,
      phaseIndex: null,
      phases: [],
      prompt: `Please ${title.toLowerCase()}.`,
      result: null,
      progress: null,
      ...patch,
    };
  };

  /** A pane's row over a Host whose transcript is the entries drawn. */
  async function pane() {
    const loaded = new MockHostClient({ latencyMs: 0, subagents: "absent" });
    await loaded.load();
    let current: HostSnapshot = { ...loaded.getSnapshot(), connection: "connected" };
    loaded.dispose();
    const listeners = new Set<() => void>();
    const hostClient = {
      getSnapshot: () => current,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as unknown as HostClient;
    const onOpenSubagent = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const memory = new Map<string, boolean>();
    return {
      container,
      onOpenSubagent,
      draw(entries: TranscriptEntry[]) {
        current = { ...current, transcripts: { ...current.transcripts, [threadId]: entries } };
        const [group] = groupTranscriptEntries(entries);
        act(() => {
          for (const listener of listeners) listener();
          root.render(
            <TaskScopeContext
              value={{
                focused: true,
                hostClient,
                onOpenSubagent,
                onViewWork: () => undefined,
                threadId,
              }}
            >
              <AgentMemoryContext value={memory}>
                <PaneRow
                  group={group!}
                  highlightRequestId={null}
                  homeThreadId={null}
                  onOpenStep={() => undefined}
                  onOpenThread={() => undefined}
                  spacingTop={0}
                  viewerUserId={null}
                  workspaces={[]}
                />
              </AgentMemoryContext>
            </TaskScopeContext>,
          );
        });
      },
    };
  }

  const cards = (container: HTMLElement) =>
    [...container.querySelectorAll("button[aria-label]")]
      .map((button) => button.getAttribute("aria-label")!)
      .filter((label) => label.includes(", subagent, "))
      .map((label) => label.split(",")[0]);

  // Failure: adjacent subagents read as loose cards, one started later joins a
  // group a step stands between, a live one disappears into the folded turn or
  // vanishes the moment it finishes, or opening the fold draws a card twice.
  it("stand where they started, grouped while adjacent, and keep a live one outside the fold", async () => {
    const { container, draw, onOpenSubagent } = await pane();
    const mapper = node("Map the parser", 1);
    const reader = node("Read the protocol", 2, {
      completedAt: "2026-08-16T10:03:00.000Z",
      result: "Read it.",
      status: "completed",
    });
    const tests = node("Check the tests", 4);
    const answer = { ...note, id: "answer", body: "The final answer." };
    draw([run, note, mapper, reader, command, tests]);
    const head = container.querySelector('button[aria-label^="2 subagents"]')!;
    expect(head.getAttribute("aria-label")).toBe("2 subagents · 1 working · 1 finished");
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(cards(container)).toEqual(["Map the parser", "Read the protocol", "Check the tests"]);
    const text = container.textContent!;
    // The rows, after the status line that names what is under way.
    const step = text.lastIndexOf("Ran a command");
    expect(text.lastIndexOf("Read the protocol")).toBeLessThan(step);
    expect(step).toBeLessThan(text.lastIndexOf("Check the tests"));
    press(
      container,
      container
        .querySelector('button[aria-label^="Check the tests,"]')!
        .getAttribute("aria-label")!,
    );
    expect(onOpenSubagent).toHaveBeenCalledWith(threadId, tests.nodeId);

    const done = (entry: NodeEntry): NodeEntry => ({
      ...entry,
      completedAt: "2026-08-16T10:09:00.000Z",
      status: "completed",
    });
    const ended = { ...run, endedAt: "2026-08-16T10:08:00.000Z", status: "completed" as const };
    const announce = vi.mocked(AccessibilityInfo.announceForAccessibility);
    announce.mockClear();
    draw([ended, note, done(mapper), reader, command, tests, answer]);
    expect(announce.mock.calls).toEqual([["Map the parser finished"]]);
    expect(statusLine(container).getAttribute("aria-expanded")).toBe("false");
    expect(statusLine(container).textContent).toContain("· 3 subagents");
    expect(cards(container)).toEqual(["Check the tests"]);

    draw([ended, note, done(mapper), reader, command, done(tests), answer]);
    expect(cards(container)).toEqual(["Check the tests"]);

    act(() => statusLine(container).click());
    expect(cards(container)).toEqual(["Check the tests"]);
    act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label^="2 subagents"]')!.click(),
    );
    expect(cards(container)).toEqual(["Map the parser", "Read the protocol", "Check the tests"]);
  });
});

describe("a delegation's line", () => {
  it("opens exactly the delegated conversation, in the words a task's line uses", () => {
    const { container, render, onOpenThread } = setup();
    const delegation: DelegationEntry = {
      id: "delegation:one",
      kind: "delegation",
      childRunId: "run-child",
      childThread: { id: "thread-child", title: "Research", workspaceId: "workspace-child" },
      createdAt: run.createdAt,
      delegationId: "one",
      delivery: { resultMessageId: createId("message"), status: "delivered" },
      failure: null,
      outcome: "completed",
      resultPreview: null,
      runId: run.runId,
      taskPreview: "Investigate",
    };
    render([delegation], [{ id: "workspace-child", name: "Research Lab" } as WorkspaceSummary]);
    const line = () => container.querySelector('[aria-label^="Research, "]')!;
    expect(line().getAttribute("aria-label")).toBe("Research, Finished");
    expect(container.textContent).toBe("ResearchFinished");
    act(() => (line() as HTMLElement).click());
    expect(onOpenThread).toHaveBeenCalledExactlyOnceWith("thread-child");

    render([{ ...delegation, outcome: "failed", resultPreview: "Could not finish." }]);
    expect(line().getAttribute("aria-label")).toBe("Research, Couldn’t finish");
    act(() => (line() as HTMLElement).click());
    expect(onOpenThread).toHaveBeenCalledTimes(2);
    expect(onOpenThread).toHaveBeenLastCalledWith("thread-child");
  });
});

describe("a Computer use row", () => {
  const slack = (state: "running" | "settled"): TranscriptEntry[] => [
    { ...run, status: state === "running" ? "running" : "completed" },
    ...mockComputerUseTurn({ agent: note.author, runId: run.runId ?? "a", state }),
  ];

  it("folds one app's steps into one row and lists them as a timeline", () => {
    const { container, render, onOpenStep } = setup();
    render(slack("settled"));
    expect(statusLine(container).textContent).toBe("Worked for 1m 27s");
    act(() => statusLine(container).click());
    const text = container.textContent ?? "";
    expect(text).toContain("Listed apps on a Mac");
    expect(text).toContain("Used Slack");
    expect(text).toContain("9 steps on Alex's MacBook Pro");
    expect(text).not.toContain("Integration call");
    for (const reference of mockComputerUseToolRefs) expect(text).not.toContain(reference);
    expect(container.querySelector('[data-symbol="laptopcomputer"]')).not.toBeNull();

    press(container, "Used Slack");
    const row = [...container.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("Used Slack"),
    );
    expect(row?.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain(
      "Stopped. Another window of this app came to the front.",
    );
    expect(container.textContent).toContain('Clicked "Opensteer 2", then waited 2000 ms');
    // A step that stopped and looked again is marked as a stop, not an error.
    const stop = [...container.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("Stopped. Another window of this app came to the front."),
    );
    expect(stop?.querySelector("[data-symbol]")?.getAttribute("data-symbol")).toBe("stop.circle");
    press(container, "Stopped. Another window of this app came to the front.");
    expect(onOpenStep).toHaveBeenCalledWith(`tool:${run.runId}:call_cu_7`);
  });
});

it("quiet Chat keeps only automatic replies and lets silent human work open Activity", () => {
  const { container, render, onOpenActivity, onOpenThread } = setup(true);
  const author = {
    kind: "agent" as const,
    displayName: "Research",
    threadId: createId("thread"),
    runId: createId("run"),
    workspaceId: createId("workspace"),
    workspaceName: "Main",
  };
  // Whether a silent automatic turn has a row is the shared model's
  // (`conversationRows`); a failed one says so.
  render([
    {
      ...run,
      startedBy: author,
      status: "failed",
      error: { code: "failed", message: "Could not relay", retryable: false },
    },
  ]);
  expect(container.textContent).toContain("Could not relay");
  render([{ ...run, startedBy: author, status: "completed" }]);
  expect(container.textContent).not.toContain("Worked");
  render(
    [{ ...run, startedBy: author, replyMessageId: note.id, status: "completed" }, note],
    [
      {
        id: author.workspaceId,
        homeThreadId: null,
        voiceThreadId: null,
        description: "",
        fileCount: 0,
        harnessLabel: "Codex",
        kind: "project",
        machineName: null,
        name: "Research",
        icon: null,
        runnerLabel: "",
        storageIssue: null,
        color: null,
        updatedAt: "2026-09-26T15:00:00.000Z",
        status: "ready",
      } satisfies WorkspaceSummary,
    ],
  );
  expect(container.textContent).toContain(note.body);
  press(container, "Research");
  expect(onOpenThread).toHaveBeenCalledWith(author.threadId);
  render([
    {
      ...run,
      status: "completed",
      startedAt: run.createdAt,
      endedAt: new Date(Date.parse(run.createdAt) + 120_000).toISOString(),
    },
  ]);
  press(container, "Worked for 2m");
  expect(onOpenActivity).toHaveBeenCalled();
  const human = { kind: "human" as const, displayName: "You", principalId: "person" };
  render([
    {
      ...run,
      personWaiting: true,
      startedBy: human,
      status: "failed",
      error: { code: "failed", message: "Could not finish", retryable: false },
    },
  ]);
  expect(container.textContent).toContain("Could not finish");
  render([{ ...run, personWaiting: true, startedBy: human, status: "interrupted" }]);
  expect(container.textContent).toContain("Stopped.");
  const task = setup();
  task.render([
    {
      ...run,
      status: "completed",
      startedAt: run.createdAt,
      endedAt: new Date(Date.parse(run.createdAt) + 120_000).toISOString(),
    },
  ]);
  expect(task.container.textContent).toContain("Worked for 2m");
});

it("renders an addressed message as an assistant message in its own row", () => {
  const view = setup();
  view.render([{ ...note, id: "notice", addressedToUserId: "person", body: "Milestone passed." }]);
  expect(view.container.textContent).toContain("Milestone passed.");
});

describe("native page rail", () => {
  function fixture() {
    const client = new MockHostClient({ latencyMs: 0 });
    const original = client
      .getSnapshot()
      .browserSessions.find((session) => session.tabCatalog?.tabs.length)!;
    const tab = original.tabCatalog!.tabs[0]!;
    const threadId = ThreadIdSchema.parse("thr_00000000-0000-4000-8000-000000000001");
    const session: BrowserSessionSummary = {
      ...original,
      attachedRunIds: [run.runId!],
      uses: [
        {
          runId: run.runId!,
          threadId,
          tabId: tab.id,
          firstUsedAt: run.createdAt,
          lastUsedAt: run.createdAt,
        },
      ],
      tabCatalog: {
        ...original.tabCatalog!,
        tabs: [
          {
            ...tab,
            occupants: [
              { threadId, home: false, holding: true, acting: true, lastActiveAt: run.createdAt },
            ],
          },
        ],
      },
    };
    const stop: PlaceEntry = {
      kind: "place",
      id: "stop",
      createdAt: run.createdAt,
      runId: run.runId!,
      title: "Recorded page",
      site: "https://recorded.example",
      place: {
        kind: "browser",
        sessionId: BrowserSessionIdSchema.parse(session.id),
        surfaceId: tab.id,
      },
    };
    vi.spyOn(client, "getSnapshot").mockReturnValue({
      ...client.getSnapshot(),
      browserSessions: [session],
    });
    const open = vi.fn();
    return { client, session, stop, open, surfaces: { hostClient: client, threadId, open } };
  }
  it("presses the exact destination, marks only the newest stop live, and disables an ended stop", () => {
    const f = fixture();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const draw = () =>
      act(() =>
        root.render(
          <TranscriptSurfacesContext value={f.surfaces}>
            <TracePlace entry={f.stop} latest={false} />
            <TracePlace entry={{ ...f.stop, id: "newest" }} latest />
          </TranscriptSurfacesContext>,
        ),
      );
    try {
      draw();
      const stops = container.querySelectorAll("button");
      expect(stops[0]!.getAttribute("aria-label")).not.toContain("agent working");
      expect(stops[1]!.getAttribute("aria-label")).toContain("agent working");
      act(() => stops[1]!.click());
      expect(f.open).toHaveBeenCalledExactlyOnceWith({
        kind: "browser",
        sessionId: f.session.id,
        tabId: f.session.tabCatalog!.tabs[0]!.id,
      });
      vi.mocked(f.client.getSnapshot).mockReturnValue({
        ...f.client.getSnapshot(),
        browserSessions: [{ ...f.session, state: "closed" }],
      });
      draw();
      expect(container.querySelectorAll("button:disabled")).toHaveLength(2);
      act(() => container.querySelector<HTMLButtonElement>("button")!.click());
      expect(f.open).toHaveBeenCalledTimes(1);
    } finally {
      f.client.dispose();
    }
  });
  it("removes the live stop mark when a completed task is reopened", () => {
    const f = fixture();
    try {
      const view = setup(false, f.surfaces);
      view.render([run, f.stop]);
      expect(
        view.container.querySelector('[aria-label^="Recorded page"]')?.getAttribute("aria-label"),
      ).toContain("agent working");
      view.render([{ ...run, status: "completed" }, f.stop]);
      press(view.container, "Worked");
      expect(
        view.container.querySelector('[aria-label^="Recorded page"]')?.getAttribute("aria-label"),
      ).not.toContain("agent working");
    } finally {
      f.client.dispose();
    }
  });
  it.each([false, true])(
    "keeps chips out of working replies until settled (Chat: %s)",
    (conversation) => {
      const f = fixture();
      try {
        const view = setup(conversation, f.surfaces);
        view.render([run, command, note]);
        expect(
          view.container.querySelector(
            `button[aria-label^="${f.session.tabCatalog!.tabs[0]!.title}"]`,
          ),
        ).toBeNull();
        view.render([{ ...run, status: "completed", replyMessageId: note.id }, command, note]);
        expect(
          view.container.querySelector(
            `button[aria-label^="${f.session.tabCatalog!.tabs[0]!.title}"]`,
          ),
        ).not.toBeNull();
      } finally {
        f.client.dispose();
      }
    },
  );
});

it("renders published apps in isolated native WebViews, caps inline height and reloads already-mounted views on republish", async () => {
  const client = new MockHostClient();
  const appId = "app_11111111-1111-4111-8111-111111111111";
  let snapshot = client.getSnapshot();
  const prefix = `https://host.test/v1/apps/${appId}/dark/${"a".repeat(43)}/`;
  let version = 1;
  const listeners = new Set<() => void>();
  vi.spyOn(client, "subscribe").mockImplementation((listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  });
  vi.spyOn(client, "getSnapshot").mockImplementation(() => snapshot);
  const read = vi.spyOn(client, "viewApp").mockImplementation(async () => ({
    app: {
      id: appId,
      workspaceId: createId("workspace"),
      threadId: createId("thread"),
      runId: createId("run"),
      title: `Budget ${version}`,
      latestVersion: version,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    url: `${prefix}?version=${version}`,
  }));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  try {
    await act(async () =>
      root.render(
        <TranscriptHostClientContext value={client}>
          <AppCard
            entry={{
              appId,
              id: "app:event",
              createdAt: new Date().toISOString(),
              kind: "app",
              title: "Budget",
              version: 1,
              runId: createId("run"),
            }}
          />
        </TranscriptHostClientContext>,
      ),
    );
    const frame = () => container.querySelector("[data-app-webview]")!;
    expect(JSON.parse(frame().getAttribute("data-isolation")!)).toEqual({
      incognito: undefined,
      sharedCookiesEnabled: false,
      thirdPartyCookiesEnabled: false,
      allowFileAccess: false,
    });
    press(container, "Report app height");
    expect(JSON.parse(frame().getAttribute("data-style")!).height).toBe(640);
    expect(JSON.parse(frame().getAttribute("data-container-style")!)).toMatchObject({
      height: 640,
      flex: 0,
    });
    const initial = appWebView.props!;
    expect(initial.originWhitelist).toEqual(["*"]);
    const navigate = (url: string, navigationType = "click", isTopFrame = true) =>
      initial.onShouldStartLoadWithRequest!({ url, navigationType, isTopFrame } as Parameters<
        NonNullable<WebViewProps["onShouldStartLoadWithRequest"]>
      >[0]);
    expect(navigate(prefix + "?version=1#chart")).toBe(true);
    expect(navigate(prefix + "?version=1#/router")).toBe(true);
    expect(navigate(prefix + "settings")).toBe(true);
    expect(navigate("https://host.test/v1/rpc/bootstrap.get")).toBe(false);
    expect(Linking.openURL).toHaveBeenLastCalledWith("https://host.test/v1/rpc/bootstrap.get");
    expect(
      initial.onShouldStartLoadWithRequest!({ url: "http://example.com/android" } as Parameters<
        NonNullable<WebViewProps["onShouldStartLoadWithRequest"]>
      >[0]),
    ).toBe(false);
    expect(Linking.openURL).toHaveBeenLastCalledWith("http://example.com/android");
    vi.mocked(Linking.openURL).mockClear();
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "opensteer://thread"])
      expect(navigate(url)).toBe(false);
    expect(navigate("https://example.com", "other")).toBe(false);
    expect(navigate("https://example.com", "click", false)).toBe(false);
    expect(Linking.openURL).not.toHaveBeenCalled();
    initial.onOpenWindow!({ nativeEvent: { targetUrl: "https://example.com" } } as Parameters<
      NonNullable<WebViewProps["onOpenWindow"]>
    >[0]);
    expect(Linking.openURL).toHaveBeenLastCalledWith("https://example.com");
    vi.mocked(Linking.openURL).mockClear();
    initial.onOpenWindow!({ nativeEvent: { targetUrl: "file:///etc/passwd" } } as Parameters<
      NonNullable<WebViewProps["onOpenWindow"]>
    >[0]);
    expect(Linking.openURL).not.toHaveBeenCalled();
    await act(() => initial.onLoad!({} as Parameters<NonNullable<WebViewProps["onLoad"]>>[0]));
    expect(container.textContent).toContain("Could not load this app");
    expect(container.querySelector("[data-app-webview]")).toBeNull();
    version = 2;
    snapshot = { ...snapshot, appVersions: { [appId]: 2 } };
    await act(async () => {
      for (const listener of listeners) listener();
    });
    expect(frame().getAttribute("data-uri")).toBe(prefix + "?version=2");
    expect(container.textContent).toContain("Budget 2");
    const fresh = appWebView.props!;
    await act(() =>
      fresh.onHttpError!({} as Parameters<NonNullable<WebViewProps["onHttpError"]>>[0]),
    );
    expect(frame()).not.toBeNull();
    await act(() =>
      fresh.onMessage!({
        nativeEvent: { data: JSON.stringify({ type: "opensteer-app:ready" }) },
      } as Parameters<NonNullable<WebViewProps["onMessage"]>>[0]),
    );
    await act(() => fresh.onLoad!({} as Parameters<NonNullable<WebViewProps["onLoad"]>>[0]));
    await act(() =>
      fresh.onHttpError!({} as Parameters<NonNullable<WebViewProps["onHttpError"]>>[0]),
    );
    expect(container.textContent).not.toContain("Could not load this app");
    expect(frame()).not.toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
  } finally {
    client.dispose();
  }
});

/*
 * An app is one live copy on a client. What can go wrong: Open waits on the
 * Host before the page appears; the card keeps its WebView while the tab has
 * one too; closing the tab leaves the card without its app; a Host that refuses
 * the tab leaves the card dead, or the person on a page for a tab that never was.
 */
describe("an app's card and its tab", () => {
  const appId = "app_11111111-1111-4111-8111-111111111111";
  async function mount(openAppTab: (appId: string) => Promise<void>) {
    const client = new MockHostClient();
    const tabRow = {
      appId,
      latestVersion: 1,
      openedAt: new Date().toISOString(),
      threadId: createId("thread"),
      title: "Budget",
      workspaceId: createId("workspace"),
    };
    let snapshot = client.getSnapshot();
    const listeners = new Set<() => void>();
    const publish = (appTabs: readonly (typeof tabRow)[]) => {
      snapshot = { ...snapshot, appTabs };
      for (const listener of listeners) listener();
    };
    vi.spyOn(client, "subscribe").mockImplementation((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    });
    vi.spyOn(client, "getSnapshot").mockImplementation(() => snapshot);
    const view = vi.spyOn(client, "viewApp").mockImplementation(async () => ({
      app: {
        id: appId,
        workspaceId: tabRow.workspaceId,
        threadId: tabRow.threadId,
        runId: createId("run"),
        title: "Budget",
        latestVersion: 1,
        createdAt: tabRow.openedAt,
        updatedAt: tabRow.openedAt,
      },
      url: `https://host.test/v1/apps/${appId}/dark/${"a".repeat(43)}/`,
    }));
    const open = vi.spyOn(client, "openAppTab").mockImplementation(openAppTab);
    const tabs: TranscriptAppTabs = { leave: vi.fn(), open: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () =>
      root.render(
        <TranscriptHostClientContext value={client}>
          <TranscriptAppTabsContext value={tabs}>
            <AppCard
              entry={{
                appId,
                id: "app:event",
                createdAt: tabRow.openedAt,
                kind: "app",
                title: "Budget",
                version: 1,
                runId: createId("run"),
              }}
            />
          </TranscriptAppTabsContext>
        </TranscriptHostClientContext>,
      ),
    );
    return { client, container, open, publish, tabRow, tabs, view };
  }
  const frame = (container: HTMLElement) => container.querySelector("[data-app-webview]");

  it("goes to the tab without waiting for the Host, runs no copy of its own, and comes back when it closes", async () => {
    const answer = Promise.withResolvers<void>();
    const f = await mount(() => answer.promise);
    try {
      expect(frame(f.container)).not.toBeNull();
      await act(async () => press(f.container, "Open"));
      expect(f.open).toHaveBeenCalledWith(appId);
      expect(f.tabs.open).toHaveBeenCalledWith(appId);

      await act(async () => f.publish([f.tabRow]));
      expect(frame(f.container)).toBeNull();
      expect(f.view).toHaveBeenCalledTimes(1);
      expect(f.container.textContent).toContain("Open in Tabs");
      await act(async () => press(f.container, "Open in Tabs"));
      expect(f.tabs.open).toHaveBeenCalledTimes(2);
      expect(f.open).toHaveBeenCalledTimes(1);

      await act(async () => f.publish([]));
      expect(frame(f.container)).not.toBeNull();
      expect(f.container.textContent).not.toContain("Open in Tabs");
      await act(async () => answer.resolve());
      expect(f.tabs.leave).not.toHaveBeenCalled();
    } finally {
      f.client.dispose();
    }
  });

  it("says so when the Host refuses the tab, takes the page back and can try again", async () => {
    const f = await mount(async () => {
      throw new Error("This Host cannot open app tabs.");
    });
    try {
      await act(async () => press(f.container, "Open"));
      expect(f.tabs.leave).toHaveBeenCalledWith(appId);
      expect(f.container.querySelector('[role="alert"]')?.textContent).toContain(
        "This Host cannot open app tabs.",
      );
      expect(frame(f.container)).not.toBeNull();

      f.open.mockImplementation(async () => undefined);
      await act(async () => press(f.container, "Try again"));
      expect(f.open).toHaveBeenCalledTimes(2);
      expect(f.tabs.open).toHaveBeenCalledTimes(2);
      expect(f.container.querySelector('[role="alert"]')).toBeNull();
    } finally {
      f.client.dispose();
    }
  });
});

vi.mock("../report-mail.js", () => ({ contactSupport: vi.fn() }));
