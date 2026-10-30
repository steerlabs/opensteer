// @vitest-environment happy-dom

import { act, useState, type ComponentProps, type ReactNode } from "react";
import { createId } from "@opensteer/core";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  groupTranscriptEntries,
  type DelegationEntry,
  type MessageEntry,
  type ReasoningEntry,
  type RunEntry,
  type ToolEntry,
  type TranscriptEntry,
  type WorkspaceSummary,
} from "@opensteer/client/host";
import { mockComputerUseToolRefs, mockComputerUseTurn } from "@opensteer/client/mock";
import { TranscriptGroupRow, replyActivityKeys } from "./transcript.js";

// Exercise the actual native renderer's state and hierarchy with DOM hosts.
// The platform controls and animation drivers are outside this regression.
vi.mock("react-native", () => ({
  View: ({
    children,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
  }) => <div aria-label={accessibilityLabel}>{children}</div>,
  Pressable: ({
    children,
    onPress,
    accessibilityState,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityState?: { expanded?: boolean };
    accessibilityLabel?: string;
  }) => (
    <button
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
vi.mock("react-native-reanimated", () => ({
  default: {
    View: ({
      children,
      accessibilityLabel,
    }: {
      children?: ReactNode;
      accessibilityLabel?: string;
    }) => <div aria-label={accessibilityLabel}>{children}</div>,
  },
}));
vi.mock("../ui/motion.js", () => ({ appear: undefined, exit: undefined }));
vi.mock("../ui/sheet.js", () => ({ Sheet: () => null }));
vi.mock("../ui/primitives.js", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
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
vi.mock("./message-menu.js", () => ({
  MessageMenu: (props: { onActivity?: () => void }) =>
    props.onActivity ? <button onClick={props.onActivity}>Run details</button> : null,
}));
vi.mock("./attachment-views.js", () => ({ MessageAttachments: () => null }));
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
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  return (
    <TranscriptGroupRow
      {...props}
      onToggleOpen={(key) => {
        const next = new Set(open);
        if (!next.delete(key)) next.add(key);
        setOpen(next);
      }}
      open={open.has(props.group.key)}
    />
  );
}

function setup(conversation = false) {
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
          />,
        ),
      );
    },
  };
}

function press(container: HTMLElement, text: string): void {
  const button = [...container.querySelectorAll("button")].find((item) =>
    item.textContent?.includes(text),
  );
  if (!button) throw new Error(`Missing button: ${text}`);
  act(() => button.click());
}

describe("native transcript prose", () => {
  it("keeps an incoming update to one line on Home and opens the exact report in place", () => {
    const { container, render, onOpenThread } = setup(true);
    const threadId = createId("thread");
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
        threadId,
        workspaceId,
        workspaceName: "Travel",
      },
      body: `Three flights fit. ${"Details and evidence. ".repeat(100)}FINAL SOURCE`,
    };
    // The reader belongs to the Workspace the update came from, so its source
    // is somewhere they can go.
    render([update], [{ id: workspaceId, name: "Travel" } as unknown as WorkspaceSummary]);
    expect(container.textContent).toContain("Travel research");
    expect(container.textContent).not.toContain("Three flights fit.");
    press(container, "left a note");
    expect(container.textContent).toContain("FINAL SOURCE");
    press(container, "left a note");
    expect(container.textContent).not.toContain("FINAL SOURCE");
    press(container, "Travel research");
    expect(onOpenThread).toHaveBeenCalledWith(threadId);

    // In a task the same update is a message, drawn from its bounded excerpt
    // until the reader opens it from inside the message.
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
  });

  it("shows snapshot reasoning and progress beside compact tools, independently of status", () => {
    const { container, render, onOpenStep } = setup();
    render([run, command, thought, note, { ...command, id: "tool:a:2", callId: "call-2" }]);
    expect(container.textContent).toContain(thought.text);
    expect(container.textContent).toContain(note.body);
    const status = container.querySelector('[aria-label="Agent status"]');
    expect(status?.textContent).toContain("Working");
    expect(status?.textContent).not.toContain(thought.text);
    expect(status?.querySelector("button")).toBeNull();
    press(container, "Ran a command");
    expect(onOpenStep).toHaveBeenCalledWith(command.id);
    expect(container.textContent).toContain(thought.text);

    render([{ ...run, status: "completed" }, command, thought, note]);
    expect(container.textContent).toContain(thought.text);
    press(container, "Thought");
    // The headline can repeat the opening words, so inspect the prose span itself.
    expect(
      [...container.querySelectorAll("span")].filter((item) => item.textContent === thought.text),
    ).toHaveLength(1);
  });

  it("preserves a manual collapse while revealing a later thought and keeping message order", () => {
    const { container, render } = setup();
    render([run, thought, note]);
    const message = container.querySelector("p");
    const status = container.querySelector('[aria-label="Agent status"]');
    expect(container.textContent!.indexOf(note.body)).toBeLessThan(
      container.textContent!.indexOf("Working"),
    );
    press(container, "Thought");
    const next = { ...thought, id: "reasoning:a:2", text: "A new independent thought." };
    render([run, thought, note, command, next]);
    expect(container.querySelector("p")).toBe(message);
    expect(container.querySelector('[aria-label="Agent status"]')).toBe(status);
    expect(container.textContent!.indexOf(note.body)).toBeLessThan(
      container.textContent!.indexOf("Working"),
    );
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons[0]?.getAttribute("aria-expanded")).toBe("false");
    expect(buttons.at(-1)?.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent!.indexOf(note.body)).toBeLessThan(
      container.textContent!.indexOf("first-command"),
    );
    const answer = { ...note, id: "final-answer", body: "Final answer after the work." };
    render([{ ...run, status: "completed" }, thought, note, command, next, answer]);
    expect(container.querySelector("p")).toBe(message);
    const text = container.textContent!;
    expect(text.indexOf("first-command")).toBeLessThan(text.indexOf("Worked"));
    expect(text.indexOf(answer.body)).toBeLessThan(text.indexOf("Worked"));
    expect(container.querySelector('[aria-label="Agent status"]')).toBe(status);
  });

  it("keeps the same footer after all replies through writing, waiting and stopping, then folds the answered turn behind it", () => {
    const { container, render } = setup();
    const answer = {
      ...note,
      id: "final-answer",
      body: "The answer is arriving.",
      streaming: true,
    };
    render([run, command, note, answer]);
    const status = container.querySelector('[aria-label="Agent status"]');
    const message = container.querySelectorAll("p")[1];
    const phases: readonly [RunEntry, string][] = [
      [run, "Writing"],
      [{ ...run, status: "waiting" }, "Waiting for you"],
      [{ ...run, stopping: true }, "Stopping"],
    ];
    for (const [phase, label] of phases) {
      render([phase, command, note, answer]);
      expect(container.querySelectorAll("p")[1]).toBe(message);
      expect(container.querySelector('[aria-label="Agent status"]')).toBe(status);
      expect(status?.parentElement?.nextElementSibling).toBeNull();
      expect(status?.textContent).toContain(label);
      expect(container.textContent!.indexOf(answer.body)).toBeLessThan(
        container.textContent!.indexOf(label),
      );
    }

    // Answered, the turn is its reply over a closed "Worked" line, and the
    // steps are not drawn at all, not merely hidden.
    const answered = [
      { ...run, replyMessageId: answer.id, status: "completed" } satisfies RunEntry,
      command,
      note,
      { ...answer, streaming: false },
    ];
    render(answered);
    const worked = () =>
      [...container.querySelectorAll("button")].find((item) =>
        item.textContent?.startsWith("Worked"),
      );
    expect(worked()?.getAttribute("aria-expanded")).toBe("false");
    expect(worked()?.nextElementSibling).toBeNull();
    expect(container.querySelector('[aria-label="Agent status"]')).toBeNull();
    expect(container.querySelectorAll("p")).toHaveLength(1);
    expect(container.querySelector("p")).toBe(message);
    expect(container.textContent).not.toContain(note.body);
    expect(container.textContent).not.toContain("Ran a command");
    expect(container.textContent!.indexOf(answer.body)).toBeLessThan(
      container.textContent!.indexOf("Worked"),
    );

    // Opened, every step is back where it happened, with the reply among them.
    press(container, "Worked");
    expect(worked()?.getAttribute("aria-expanded")).toBe("true");
    const text = container.textContent!;
    expect(text.indexOf("Ran a command")).toBeLessThan(text.indexOf(note.body));
    expect(text.indexOf(note.body)).toBeLessThan(text.indexOf(answer.body));
    expect(text.indexOf(answer.body)).toBeLessThan(text.indexOf("Worked"));
    expect(container.querySelectorAll("p")[1]).toBe(message);
    // The reader's choice holds while the Thread moves on around it.
    render(answered.map((entry) => ({ ...entry })));
    expect(worked()?.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain(note.body);
    press(container, "Worked");
    expect(worked()?.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain(note.body);

    // A turn that failed or stopped keeps in view the steps that explain it.
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
      expect(container.textContent).toContain("Ran a command");
      expect(worked()).toBeUndefined();
      expect(container.querySelector('[aria-label="Agent status"]')?.textContent).toContain(
        "Worked",
      );
    }
  });
});

// Ways an old delegation's line can fail: it opens the conversation that
// handed the work out instead of the one that did it, where the task, its
// result and the pages it used are; or a failure reads like a finish.
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
    expect(line().getAttribute("aria-label")).toBe("Research, Done");
    expect(container.textContent).toBe("ResearchDone");
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
    const text = container.textContent ?? "";
    expect(text).toContain("Listed apps on a Mac");
    expect(text).toContain("Used Slack");
    expect(text).toContain("9 steps on Alex's MacBook Pro");
    expect(text).toContain("4 integration lookups, 9 steps in Slack");
    expect(text).toContain("2 errors");
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

it("quiet Chat keeps automatic replies and lets silent human work open Activity", () => {
  const { container, render, onOpenActivity, onOpenThread } = setup(true);
  const author = {
    kind: "agent" as const,
    displayName: "Research",
    threadId: createId("thread"),
    runId: createId("run"),
    workspaceId: createId("workspace"),
    workspaceName: "Main",
  };
  render([{ ...run, startedBy: author, status: "running" }]);
  expect(container.textContent).toBe("");
  render([{ ...run, startedBy: author, status: "completed" }]);
  expect(container.textContent).toBe("");
  render(
    [{ ...run, startedBy: author, replyMessageId: note.id, status: "completed" }, note],
    [
      {
        id: author.workspaceId,
        homeThreadId: null,
        description: "",
        fileCount: 0,
        harnessLabel: "Codex",
        kind: "specialized",
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
