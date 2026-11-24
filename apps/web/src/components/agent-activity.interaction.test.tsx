import { DeviceIdSchema } from "@opensteer/core";
// @vitest-environment happy-dom
import { tabFixture, tabStoreFixture } from "@opensteer/client/test-support";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpHostClient } from "@opensteer/client/host";
import { PersonalDetailSnapshotSchema } from "@opensteer/protocol/personal-sync";
import { TranscriptItemSchema } from "@opensteer/protocol/transcript";
import type {
  MessageEntry,
  PlaceEntry,
  ReasoningEntry,
  RunEntry,
  ToolEntry,
  TranscriptEntry,
} from "@opensteer/client/host";
import {
  MockHostClient,
  MockPersonalHost,
  mockComputerUseToolRefs,
  mockComputerUseTurn,
} from "@opensteer/client/mock";
import {
  BrowserSessionIdSchema,
  BrowserSurfaceIdSchema,
  TabIdSchema,
  createId,
  defaultTaskSymbol,
  ThreadIdSchema,
  type BrowserPageContentPart,
  type Tab,
} from "@opensteer/core";
import { computerUseStops } from "@opensteer/client/integrations";
import {
  createMessageOutboxStorage,
  disposeMessageOutbox,
  initializeMessageOutbox,
} from "@opensteer/client/host";
import { mcpPresentationScenarios, mcpPresentationTool } from "@opensteer/client/test-support";
import {
  AgentTranscript,
  ConversationActivity,
  type TranscriptTabSource,
} from "./agent-activity.js";
import type { WorkspaceNavigation } from "./workspace/navigation.js";
import { useWorkspaceNavigation } from "./workspace/navigation.js";
import { WorkspaceProvider } from "./workspace/workspace-context.js";

/** Chips open places through the workspace's navigation, as they do in the app. */
function TestWorkspace({
  children,
  onShow,
}: {
  readonly children: React.ReactNode;
  readonly onShow?: WorkspaceNavigation["showPlace"];
}) {
  const nav = useWorkspaceNavigation({ deploymentId: null, userId: null });
  return (
    <WorkspaceProvider
      attention={0}
      nav={onShow ? { ...nav, showPlace: onShow } : nav}
      openDrawer={() => undefined}
    >
      {children}
    </WorkspaceProvider>
  );
}

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
});

let sequence = 0;

function tool(overrides: Partial<ToolEntry> = {}): ToolEntry {
  sequence += 1;
  return {
    arguments: { command: "/bin/zsh -lc 'pnpm test'" },
    callId: `call-${sequence}`,
    completedAt: "2026-08-16T10:00:04.000Z",
    createdAt: "2026-08-16T10:00:01.000Z",
    id: `tool:run-a:call-${sequence}`,
    integration: null,
    isError: false,
    kind: "tool",
    output: { text: "12 tests passed" },
    runId: "run-a",
    state: "done",
    streamText: "",
    tool: { name: "shell", namespace: "codex" },
    ...overrides,
  };
}

function reasoning(overrides: Partial<ReasoningEntry> = {}): ReasoningEntry {
  return {
    completedAt: null,
    createdAt: "2026-08-16T10:00:02.000Z",
    id: "reasoning:run-a:block-1",
    kind: "reasoning",
    runId: "run-a",
    state: "streaming",
    text: "I am tracing the live rendering path.",
    ...overrides,
  };
}

const run: RunEntry = {
  createdAt: "2026-08-16T10:00:00.000Z",
  error: null,
  id: "run:run-a",
  kind: "run",
  replyMessageId: null,
  runId: "run-a",
  status: "completed",
};

const note: MessageEntry = {
  author: { cause: "test", kind: "platform" },
  body: "Page control is off, so I'll read the public page.",
  createdAt: "2026-08-16T10:00:02.000Z",
  id: "message-note",
  kind: "message",
  messageKind: "assistant",
  runId: "run-a",
};

function mount(entries: TranscriptEntry[]): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  render(root, entries);
  return container;
}

function render(root: Root, entries: TranscriptEntry[]): void {
  act(() =>
    root.render(
      <MemoryRouter initialEntries={["/tasks/thread-1"]}>
        <AgentTranscript entries={entries} />
      </MemoryRouter>,
    ),
  );
}

function click(element: Element | null | undefined): void {
  if (!(element instanceof HTMLElement)) throw new Error("Nothing to click");
  act(() => element.click());
}

function button(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
}

/** A turn's status line, which opens and closes its folded steps. */
function status(container: HTMLElement): HTMLElement {
  const head = container.querySelector<HTMLElement>(".work__head");
  if (!head) throw new Error("No status line");
  return head;
}

describe("AgentTranscript work", () => {
  it.each(mcpPresentationScenarios)(
    "presents %s while running and after completion",
    (name, args, active, done) => {
      for (const running of [true, false]) {
        const container = mount([mcpPresentationTool(name, args, running)]);
        if (!running) click(status(container));
        expect(container.querySelector(".trace-step__label")?.textContent).toBe(
          running ? active : done,
        );
      }
    },
  );

  // Failure modes: steps crowd out what the agent wrote; a failed step the
  // agent read and carried on from shows as an alarm on the turn; opening a
  // step's detail opens or closes anything else.
  it("folds to the last word and opens steps and details independently", () => {
    const container = mount([
      run,
      tool(),
      tool({ isError: true, output: { text: "lint failed" }, state: "failed" }),
      note,
      tool({
        arguments: { fresh: true },
        output: { text: "{}" },
        tool: { name: "browser_session_open", namespace: "opensteer" },
      }),
      { ...note, body: "OpenCode is an open-source coding agent.", id: "message-reply" },
    ]);

    const head = status(container);
    expect(head.textContent).toBe("Worked for 3s");
    expect(head.tagName).toBe("BUTTON");
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".trace-errors")).toBeNull();
    expect(container.textContent).not.toContain("public page");
    expect(container.textContent).toContain("open-source coding agent");
    expect(container.querySelector(".trace-step")).toBeNull();

    // Two commands fold into a row; the agent's note sits between rows.
    click(head);
    const commands = button(container, "Ran 2 commands");
    expect(commands).toBeDefined();
    expect(button(container, "Opened a browser")).toBeDefined();
    expect(container.querySelector('a[href="/tasks/thread-1?panel=browser"]')).toBeNull();
    const text = container.textContent!;
    expect(text.indexOf("Ran 2 commands")).toBeLessThan(text.indexOf("public page"));
    expect(text.indexOf("public page")).toBeLessThan(text.indexOf("Opened a browser"));

    click(commands);
    const lines = container.querySelectorAll(".trace-step__lines .trace-step__head");
    expect(lines).toHaveLength(2);
    expect(container.querySelector(".trace-step__icon--error")).not.toBeNull();

    click(lines[1]);
    expect(container.querySelector(".trace-code--command")?.textContent).toBe("pnpm test");
    expect(container.textContent).toContain("lint failed");

    click(commands);
    expect(container.textContent).not.toContain("lint failed");
    click(head);
    expect(container.querySelector(".trace-step")).toBeNull();
    expect(container.textContent).not.toContain("public page");
    expect(container.textContent).toContain("open-source coding agent");
  });

  // The reader's opened steps and the thought's node survive completion.
  it("says what a live turn is doing on its status line and keeps opened steps through completion", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const first = tool();
    const thought = reasoning();
    const second = tool({
      callId: "call-live",
      completedAt: null,
      id: "tool:run-a:call-live",
      state: "running",
    });

    render(root, [{ ...run, status: "running" }, first, thought, second]);

    expect(status(container).textContent).toBe("Running a command");
    expect(container.querySelector(".trace-thought")).not.toBeNull();
    click(status(container));
    click(status(container));
    expect(button(container, "Thinking")?.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".trace-step__thought")?.textContent).toContain(
      "live rendering path",
    );
    expect(container.querySelector(".trace-thought")?.parentElement?.className).toBe(
      "turn__content",
    );
    const thoughtNode = container.querySelector(".trace-thought");

    render(root, [
      run,
      first,
      reasoning({ completedAt: "2026-08-16T10:00:04.000Z", state: "done" }),
      { ...second, completedAt: "2026-08-16T10:00:05.000Z", state: "done" },
    ]);

    expect(status(container).textContent).toBe("Worked for 4s");
    expect(container.querySelector(".trace-thought")).toBe(thoughtNode);
    expect(container.querySelector(".trace-step__thought")?.textContent).toContain(
      "live rendering path",
    );

    click(button(container, "Thought"));
    expect(container.querySelector(".trace-step__thought")).toBeNull();
  });

  it("reveals completed reasoning in an active snapshot and keeps manual choices local", () => {
    const container = mount([
      { ...run, status: "running" },
      reasoning({ state: "done", text: "Snapshot thought" }),
    ]);
    const root = roots.at(-1)!;
    expect(container.querySelector(".trace-step__thought")?.textContent).toBe("Snapshot thought");
    click(button(container, "Thought"));
    render(root, [
      { ...run, status: "running" },
      reasoning({ state: "done", text: "Snapshot thought" }),
      tool(),
      reasoning({ id: "new-thought", text: "New visible thought" }),
    ]);
    expect(container.querySelectorAll(".trace-step__thought")).toHaveLength(1);
    expect(container.querySelector(".trace-step__thought")?.textContent).toBe(
      "New visible thought",
    );
    expect(button(container, "Thought")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("starts historical thoughts compact with their own disclosure", () => {
    const container = mount([run, reasoning({ state: "done" }), note]);
    expect(container.textContent).toContain(note.body);
    click(status(container));
    expect(container.querySelector(".trace-step__thought")).toBeNull();
    click(button(container, "Thought"));
    expect(container.querySelector(".trace-step__thought")?.textContent).toContain(
      "live rendering path",
    );
  });

  it("tells a live turn in order, then keeps only its last word mounted", () => {
    const first = tool();
    const answer = { ...note, id: "final-answer", body: "Final answer after the work." };
    const container = mount([{ ...run, status: "running" }, note, first, answer]);
    const root = roots.at(-1)!;
    const content = () => [...container.querySelector(".turn__content")!.children];
    const [head, noteNode, stepNode, answerNode] = content();
    expect(noteNode?.textContent).toContain(note.body);
    expect(stepNode?.textContent).toContain("Ran a command");
    expect(answerNode?.textContent).toBe(answer.body);
    render(root, [run, note, first, answer]);
    expect(content()).toEqual([head, answerNode]);
    expect(head?.textContent).toContain("Worked for");
    click(status(container));
    expect(content()[1]?.textContent).toContain(note.body);
    expect(content()[2]?.textContent).toContain("Ran a command");
    expect(content().at(-1)).toBe(answerNode);
  });

  it("keeps a reader's closed live turn closed when it settles", () => {
    const first = tool();
    const answer = { ...note, id: "final-answer", body: "Final answer." };
    const container = mount([{ ...run, status: "running" }, note, first, answer]);
    const root = roots.at(-1)!;
    click(status(container));
    expect(status(container).getAttribute("aria-expanded")).toBe("false");
    render(root, [run, note, first, answer]);
    expect(status(container).getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain(note.body);
    expect(container.textContent).toContain(answer.body);
  });

  it("opens a folded turn for a linked intermediate message", () => {
    const entries = [
      run,
      note,
      tool(),
      ...Array.from({ length: 35 }, (_, i) => ({ ...note, id: `later-${i}`, body: `Later ${i}` })),
      { ...note, id: "answer", body: "Done." },
    ];
    const container = mount(entries);
    expect(container.textContent).not.toContain(note.body);
    act(() =>
      roots.at(-1)!.render(
        <MemoryRouter>
          <AgentTranscript entries={entries} revealMessage={{ id: note.id }} />
        </MemoryRouter>,
      ),
    );
    expect(status(container).getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(`[data-message-id="${note.id}"]`)?.textContent).toBe(note.body);
  });

  it("mounts and scrolls to an early linked message in Run details", () => {
    const entries = [
      run,
      note,
      ...Array.from({ length: 35 }, (_, i) => ({ ...note, id: `later-${i}`, body: `Later ${i}` })),
      { ...note, id: "answer", body: "Done." },
    ];
    const container = mount(entries);
    const scroll = vi.fn();
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scroll,
    });
    try {
      act(() =>
        roots.at(-1)!.render(
          <MemoryRouter>
            <ConversationActivity
              anchor={container}
              entries={entries}
              live={false}
              onClose={() => undefined}
              reveal={note.id}
              selection={{ kind: "turn", key: "turn:run:run-a" }}
            />
          </MemoryRouter>,
        ),
      );
      const target = document.querySelector(`[data-message-id="${note.id}"]`);
      expect(target?.textContent).toBe(note.body);
      expect(target?.classList.contains("transcript__found")).toBe(true);
      expect(scroll).toHaveBeenCalledWith({ block: "center" });
      expect(scroll.mock.instances).toContain(target);
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", original);
      else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
  });

  it("does not reapply a visible reveal when the named reply loads later", () => {
    const fallback = { ...note, id: "fallback", body: "Fallback last word." };
    const reply = { ...note, id: "named-reply", body: "Named reply." };
    const settled = { ...run, replyMessageId: reply.id };
    const reveal = { id: fallback.id };
    const container = mount([settled, tool(), fallback]);
    const root = roots.at(-1)!;
    const draw = (entries: TranscriptEntry[]) =>
      act(() =>
        root.render(
          <MemoryRouter>
            <AgentTranscript entries={entries} revealMessage={reveal} />
          </MemoryRouter>,
        ),
      );
    const step = tool();
    draw([settled, step, fallback]);
    expect(status(container).getAttribute("aria-expanded")).toBe("false");
    click(status(container));
    click(status(container));
    draw([settled, reply, step, fallback]);
    expect(status(container).getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain(fallback.body);
    expect(container.textContent).toContain(reply.body);
  });

  it("windows a long open trace and reveals its earlier rows", () => {
    const notes = Array.from({ length: 32 }, (_, i) => ({
      ...note,
      id: `note-${i}`,
      body: `Trace note ${i}.`,
    }));
    const container = mount([{ ...run, status: "running" }, ...notes]);
    expect(container.querySelectorAll(".msg--assistant__body")).toHaveLength(30);
    expect(container.textContent).not.toContain("Trace note 0.");
    expect(container.textContent).toContain("Trace note 31.");
    click(button(container, "Show 2 earlier steps"));
    expect(container.querySelectorAll(".msg--assistant__body")).toHaveLength(32);
    expect(container.textContent).toContain("Trace note 0.");
    expect(button(container, "earlier steps")).toBeUndefined();
  });

  it("keeps the same status line above the reply through writing, waiting, stopping and completion", () => {
    const first = tool();
    const answer = {
      ...note,
      id: "final-answer",
      body: "The answer is arriving.",
      streaming: true,
    };
    const container = mount([{ ...run, status: "running" }, first, note, answer]);
    const root = roots.at(-1)!;
    const statusNode = container.querySelector('[aria-label="Agent status"]');
    const message = container.querySelectorAll(".msg--assistant__body")[1];
    const phases: readonly [RunEntry, string][] = [
      [{ ...run, status: "running" }, "Writing"],
      [{ ...run, status: "waiting" }, "Waiting for you"],
      [{ ...run, status: "running", stopping: true }, "Stopping"],
      [run, "Worked"],
    ];
    for (const [phase, label] of phases) {
      render(root, [phase, first, note, { ...answer, streaming: phase.status !== "completed" }]);
      expect(container.querySelector(`[data-message-id="${answer.id}"]`)).toBe(message);
      expect(container.querySelector(".turn__content")?.firstElementChild).toBe(statusNode);
      expect(statusNode?.textContent).toContain(label);
    }
  });

  it("ends a turn that only answered at its answer", () => {
    const answer = { ...note, id: "final-answer", body: "Here is the answer." };
    const container = mount([{ ...run, replyMessageId: answer.id }, answer]);
    expect(container.textContent).toContain(answer.body);
    expect(container.querySelector('[aria-label="Agent status"]')).toBeNull();
  });
});

describe("a Computer use row", () => {
  const slack = (state: "running" | "settled"): TranscriptEntry[] => [
    { ...run, status: state === "running" ? "running" : "completed" },
    ...mockComputerUseTurn({ agent: note.author, runId: "run-a", state }),
  ];

  it("reads as one Slack row that opens into a timeline of steps", () => {
    const container = mount(slack("settled"));
    expect(status(container).textContent).toBe("Worked for 1m 27s");
    click(status(container));
    const heads = [...container.querySelectorAll(".turn__content > .trace-step")].map(
      (row) => row.querySelector(".trace-step__head")?.textContent,
    );
    expect(heads).toEqual([
      'Listed apps on a Macfor "Computer use" and "Slack"· 1 failed',
      "Used Slack10 steps on Alex's MacBook Pro· 1 failed",
    ]);
    for (const reference of mockComputerUseToolRefs) {
      expect(container.innerHTML).not.toContain(reference);
    }

    const row = button(container, "Used Slack");
    click(row);
    expect(row?.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".trace-step__place")?.textContent).toBe(
      "on Alex's MacBook Pro",
    );
    const timeline = container.querySelector(".trace-step__lines--timeline");
    expect(timeline?.children).toHaveLength(10);
    const stop = button(container, "Stopped. Another window of this app came to the front.");
    expect(stop?.querySelector("title")?.textContent).toBe("Stopped");
    expect(stop?.querySelector(".trace-errors")).toBeNull();
    // The row counts the error once; the step's own mark says which one it was.
    const broken = button(
      container,
      "Invalid Act arguments at $.actions[0]: must match exactly one allowed schema",
    );
    expect(broken?.querySelector("title")?.textContent).toBe("Returned an error");
    expect(broken?.querySelector(".trace-errors")).toBeNull();
    expect(timeline?.querySelectorAll(".trace-errors")).toHaveLength(0);
    expect(button(container, 'Clicked "Opensteer 2", then waited 2000 ms')).toBeDefined();

    click(stop);
    const detail = stop?.closest(".trace-step")?.querySelector(".trace-step__body");
    const observation = button(detail as HTMLElement, "Output");
    const input = button(detail as HTMLElement, "Input");
    expect(observation?.getAttribute("aria-expanded")).toBe("false");
    expect(input?.getAttribute("aria-expanded")).toBe("false");
    expect(detail?.querySelector("pre")).toBeNull();
    click(observation);
    expect(detail?.querySelector("pre")?.textContent).toMatch(
      /^Observation 612db06195afcd8b[\s\S]*Nothing was done\. Act on this fresh observation\.$/u,
    );
    // A failure that never reached the app says why in prose, with nothing verbatim open.
    click(broken);
    const reason = broken?.querySelector(".trace-step__label");
    expect(reason?.textContent).toBe(
      "Invalid Act arguments at $.actions[0]: must match exactly one allowed schema",
    );
  });

  it("updates the row's live step in place while it runs", () => {
    const container = mount(slack("running"));
    expect(container.querySelector(".work__label")?.textContent).toBe(
      "Clicking in Slack on Alex's MacBook Pro",
    );
    const head = button(container, "Using Slack");
    expect(head?.querySelector(".trace-step__detail--live")?.textContent).toBe("Clicking in Slack");
    click(head);
    expect(container.querySelector(".trace-step__place")?.textContent).toBe(
      "on Alex's MacBook Pro",
    );
    const steps = [
      ...container.querySelectorAll(".trace-step__lines--timeline .trace-step__label"),
    ];
    expect(steps.at(-1)?.textContent).toBe("Clicking in Slack");
    expect(steps.at(-2)?.textContent).toBe('Clicked "Opensteer", then waited 500 ms');
  });

  it("keeps installed-app output closed until asked for", () => {
    const container = mount(slack("settled"));
    click(status(container));
    click(button(container, "Listed apps on a Mac"));
    const [, , found] = container.querySelectorAll(".trace-step__lines .trace-step__head");
    click(found);
    const detail = found?.closest(".trace-step")?.querySelector(".trace-step__body");
    const output = button(detail as HTMLElement, "Output");
    expect(output?.getAttribute("aria-expanded")).toBe("false");
    expect(detail?.querySelector("pre")).toBeNull();
    expect(container.innerHTML).not.toMatch(/igr_|itl_/u);
    click(output);
    expect(detail?.querySelector("pre")?.textContent).toContain(
      '"bundleId":"com.tinyspeck.slackmacgap"',
    );
  });
});

it("opens the exact phone from its conversation chip and keeps Stop and the steps on the activity line", () => {
  const client = new MockHostClient({ latencyMs: 0 });
  const machine = client.getSnapshot().machines.find((machine) => machine.device?.form === "phone");
  const session = machine?.computerUse?.sessions[0];
  if (!machine || !session) throw new Error("Expected phone session");
  const entries: TranscriptEntry[] = [
    {
      createdAt: session.openedAt,
      error: null,
      id: `run:${session.runId}`,
      kind: "run",
      replyMessageId: null,
      runId: session.runId,
      status: "running",
    },
    tool({
      runId: session.runId,
      state: "running",
      completedAt: null,
      arguments: { arguments: { actions: [{ type: "tap" }] } },
      integration: {
        account: "This phone",
        computerApp: null,
        phone: { computer: machine.name, runnerId: DeviceIdSchema.parse(machine.id) },
        effect: "write",
        integration: "Android phone",
        operation: { name: "act", title: "Act" },
      },
    }),
  ];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() =>
    root.render(
      <MemoryRouter>
        <TestWorkspace>
          <AgentTranscript
            entries={entries}
            computers={{
              hostClient: client,
              machines: [machine],
            }}
          />
        </TestWorkspace>
      </MemoryRouter>,
    ),
  );
  expect(
    container.querySelector(`button[aria-label="Stop using phone, ${machine.name}"]`)?.textContent,
  ).toBe("Stop using phone");
  expect(container.querySelector('[aria-label^="Watch "]')).toBeNull();
  // The live trace starts open; its disclosure stays beside Stop on the phone.
  const steps = container.querySelector<HTMLButtonElement>("button.computer-now__where");
  expect(steps?.getAttribute("aria-expanded")).toBe("true");
  expect(container.querySelector(".trace-step")).not.toBeNull();
  click(steps);
  expect(steps?.getAttribute("aria-expanded")).toBe("false");
  expect(container.querySelector(".trace-step")).toBeNull();
  expect(container.querySelector(".surface-chip")).toBeNull();
  act(() =>
    root.render(
      <MemoryRouter>
        <TestWorkspace>
          <AgentTranscript
            entries={entries.map((entry) =>
              entry.kind === "run" ? { ...entry, status: "completed" } : entry,
            )}
            computers={{ hostClient: client, machines: [machine] }}
            browserSessions={{
              tabs: tabStoreFixture([
                tabFixture({
                  tabId: TabIdSchema.parse("phone-tab"),
                  kind: "phone",
                  computer: { computerId: DeviceIdSchema.parse(machine.id), name: machine.name },
                }),
              ]),
              browserProfiles: [],
            }}
          />
        </TestWorkspace>
      </MemoryRouter>,
    ),
  );
  const chip = container.querySelector<HTMLAnchorElement>(`a[aria-label="Open ${machine.name}"]`);
  expect(chip).not.toBeNull();
  // The chip opens the phone's one tab.
  expect(new URL(chip!.href).searchParams.get("tab")).toBe("phone-tab");
  click(chip);
});

describe("task mark bylines", () => {
  it("resolves a live ordinary task and falls back for an unknown author", async () => {
    const mock = new MockHostClient();
    try {
      await mock.load();
      const snapshot = mock.getSnapshot();
      const thread = snapshot.threads.find((thread) => thread.icon === "plane")!;
      const author = {
        kind: "agent" as const,
        displayName: thread.title,
        runId: createId("run"),
        threadId: ThreadIdSchema.parse(thread.id),
      };
      const entry: MessageEntry = { ...note, author, body: "Here is the result." };
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      roots.push(root);
      const draw = async (message: MessageEntry) =>
        act(async () =>
          root.render(
            <MemoryRouter>
              <AgentTranscript entries={[message]} attachmentReader={mock} />
            </MemoryRouter>,
          ),
        );
      await draw(entry);
      expect(
        container.querySelector(".msg--assistant__author .task-mark")?.getAttribute("data-icon"),
      ).toBe("plane");
      await act(async () => {
        await mock.dispatch({
          type: "thread.icon.set",
          threadId: thread.id,
          icon: "hotel",
          idempotencyKey: "byline-icon",
        });
      });
      expect(
        container.querySelector(".msg--assistant__author .task-mark")?.getAttribute("data-icon"),
      ).toBe("hotel");
      await draw({ ...entry, author: { ...author, threadId: createId("thread") } });
      expect(
        container.querySelector(".msg--assistant__author .task-mark")?.getAttribute("data-icon"),
      ).toBe(defaultTaskSymbol);
      expect(container.querySelector(".msg--assistant__author .task-mark svg")).not.toBeNull();
    } finally {
      mock.dispose();
    }
  });
});

it("keeps a silent automatic turn through pending Stop and its kept window", async () => {
  vi.useFakeTimers();
  const client = new MockHostClient({ latencyMs: 0 });
  const machine = client.getSnapshot().machines.find((m) => m.device?.form === "phone")!;
  const session = machine.computerUse!.sessions[0]!;
  const entry: RunEntry = {
    ...run,
    id: `run:${session.runId}`,
    runId: session.runId,
    status: "running",
    startedBy: { kind: "platform", cause: "assignment-result" },
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const draw = (stopping: boolean) =>
    act(() =>
      root.render(
        <MemoryRouter>
          <TestWorkspace>
            <AgentTranscript
              conversation
              entries={[{ ...entry, stopping }]}
              computers={{ hostClient: client, machines: [] }}
            />
          </TestWorkspace>
        </MemoryRouter>,
      ),
    );
  draw(false);
  act(() =>
    computerUseStops(client).stop({
      machineName: machine.name,
      sessionId: session.sessionId,
      runId: session.runId,
    }),
  );
  draw(true);
  expect(container.textContent).toContain("Stopping");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50);
  });
  expect(container.textContent).toContain("Stopped using");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3100);
  });
  expect(container.textContent).not.toContain("Stopped using");
}, 10000);

describe("page rail", () => {
  function fixture() {
    const client = new MockHostClient({ latencyMs: 0 });
    const page = tabFixture({
      tabId: TabIdSchema.parse("page-1"),
      title: "Recorded page",
      url: "https://recorded.example/",
      usedBy: [{ taskId: ThreadIdSchema.parse("thr_00000000-0000-4000-8000-000000000001") }],
    });
    const source = { tabs: tabStoreFixture([page]), browserProfiles: [] };
    const closed = { tabs: tabStoreFixture([]), browserProfiles: [] };
    const browserUses = [
      {
        sessionId: "bsn_00000000-0000-4000-8000-000000000001",
        runId: run.runId!,
        tabId: page.tabId,
        threadId: "thread-1",
        firstUsedAt: run.createdAt,
        lastUsedAt: run.createdAt,
      },
    ];
    const stop: PlaceEntry = {
      kind: "place",
      id: "first-stop",
      createdAt: run.createdAt,
      runId: run.runId!,
      tabId: page.tabId,
      title: "Recorded page",
      site: "https://recorded.example",
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const show = vi.fn();
    const draw = (
      entries: TranscriptEntry[],
      sessions: TranscriptTabSource = source,
      conversation = false,
      uses = browserUses,
    ) =>
      act(() =>
        root.render(
          <MemoryRouter>
            <TestWorkspace onShow={show}>
              <AgentTranscript
                entries={entries}
                browserSessions={sessions}
                browserUses={uses}
                conversation={conversation}
                threadId="thr_00000000-0000-4000-8000-000000000001"
              />
            </TestWorkspace>
          </MemoryRouter>,
        ),
      );
    return { client, container, show, draw, stop, source, closed };
  }
  it("opens the exact recorded stop, preserves modifier clicks and makes ended stops non-links", async () => {
    const f = fixture();
    try {
      f.draw([{ ...run, status: "running" }, f.stop]);
      const link = f.container.querySelector<HTMLAnchorElement>("a.trace-place")!;
      expect(link.textContent).toContain("Recorded page");
      expect(link.textContent).toContain("recorded.example");
      for (const modifier of ["metaKey", "ctrlKey", "shiftKey"]) {
        const event = new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          [modifier]: true,
        });
        await act(() => link.dispatchEvent(event));
        expect(event.defaultPrevented).toBe(false);
      }
      expect(f.show).not.toHaveBeenCalled();
      click(link);
      expect(f.show).toHaveBeenCalledExactlyOnceWith({ kind: "tab", tabId: f.stop.tabId });
      f.draw([{ ...run, status: "running" }, f.stop], f.closed);
      expect(f.container.querySelector("a.trace-place")).toBeNull();
      expect(f.container.querySelector('.trace-place--ended[role="img"]')).not.toBeNull();
    } finally {
      f.client.dispose();
    }
  });
  it("renders app and phone place entries in the trace and keeps their chips at Run end without usage reads", () => {
    const f = fixture();
    try {
      const windowTab = tabFixture({
        tabId: TabIdSchema.parse("window-1"),
        kind: "window",
        title: "Notes",
      });
      const phoneTab = tabFixture({
        tabId: TabIdSchema.parse("phone-1"),
        kind: "phone",
        title: "Pixel 7",
      });
      const native = { tabs: tabStoreFixture([windowTab, phoneTab]), browserProfiles: [] };
      const app: PlaceEntry = {
        ...f.stop,
        id: "native-app",
        title: "Notes",
        site: null,
        tabId: windowTab.tabId,
      };
      const phone: PlaceEntry = {
        ...f.stop,
        id: "native-phone",
        title: "Pixel 7",
        site: null,
        tabId: phoneTab.tabId,
      };
      f.draw([{ ...run, status: "running" }, app, phone], native, false, []);
      const stops = f.container.querySelectorAll(".trace-place");
      expect(stops).toHaveLength(2);
      expect(stops[0]!.textContent).toContain("Notes");
      expect(stops[1]!.textContent).toContain("Pixel 7");
      f.draw([run, app, phone], native, false, []);
      expect(
        [...f.container.querySelectorAll(".surface-chip__title")].map((node) => node.textContent),
      ).toEqual(["Notes", "Pixel 7"]);
    } finally {
      f.client.dispose();
    }
  });
  it("lights only the latest stop while its turn is live, and folds historical stops", () => {
    const f = fixture();
    try {
      const newer = { ...f.stop, id: "newest" };
      f.draw([{ ...run, status: "running" }, f.stop, newer]);
      const stops = f.container.querySelectorAll(".trace-place");
      expect(stops).toHaveLength(2);
      expect(stops[0]!.querySelector(".live-dot")).toBeNull();
      expect(stops[1]!.querySelector(".live-dot")).not.toBeNull();
      f.draw([run, f.stop, newer]);
      expect(f.container.querySelector(".trace-place")).toBeNull();
      click(status(f.container));
      expect(f.container.querySelectorAll(".trace-place")).toHaveLength(2);
      expect(f.container.querySelector(".trace-place .live-dot")).toBeNull();
    } finally {
      f.client.dispose();
    }
  });
  it.each(["interrupted", "failed"] as const)(
    "keeps a %s reply's pages below its outcome",
    (status) => {
      const f = fixture();
      try {
        f.draw([
          {
            ...run,
            status,
            error:
              status === "failed"
                ? { code: "test", message: "Browser task failed", retryable: false }
                : null,
          },
          note,
        ]);
        const outcome = f.container.querySelector(
          status === "failed" ? ".run-failure" : ".run-note",
        )!;
        expect(outcome).not.toBeNull();
        expect(outcome.nextElementSibling?.classList.contains("surface-chips")).toBe(true);
        expect(f.container.querySelector(".viewfinder")).toBeNull();
      } finally {
        f.client.dispose();
      }
    },
  );
  it.each([false, true])("shows page chips only once settled (Chat: %s)", (conversation) => {
    const f = fixture();
    try {
      f.draw([{ ...run, status: "running" }, note], f.source, conversation);
      expect(f.container.querySelector(".surface-chip")).toBeNull();
      f.draw([{ ...run, replyMessageId: note.id }, note], f.source, conversation);
      expect(f.container.querySelector(".surface-chip")).not.toBeNull();
    } finally {
      f.client.dispose();
    }
  });
});

it("draws nothing for a silent automatic turn, and its source and failure when it fails", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() =>
    root.render(
      <MemoryRouter>
        <AgentTranscript
          conversation
          entries={[
            {
              ...run,
              status: "completed",
              replyMessageId: null,
              startedBy: { kind: "platform", cause: "automatic" },
              startedAt: run.createdAt,
              endedAt: "2026-08-16T10:02:00.000Z",
            },
          ]}
        />
      </MemoryRouter>,
    ),
  );
  expect(container.textContent).toBe("");
  act(() =>
    root.render(
      <MemoryRouter>
        <AgentTranscript
          conversation
          entries={[
            {
              ...run,
              status: "failed",
              error: { code: "failed", message: "Could not relay", retryable: false },
              replyMessageId: null,
              startedBy: { kind: "platform", cause: "automatic" },
            },
          ]}
        />
      </MemoryRouter>,
    ),
  );
  expect(container.textContent).toContain("Could not relay");
  expect(container.querySelector(".turn-source")).not.toBeNull();
});

it("loads output only on expansion, retries a failure, and reuses it when reopened", async () => {
  const seed = new MockHostClient({ latencyMs: 0, places: "absent" });
  const host = new MockPersonalHost(seed);
  const threadId = seed
    .getSnapshot()
    .threads.find(({ title }) => title === "Subagents everywhere")!.id;
  const thread = seed.scopedDetail(threadId)!.thread;
  const revision = String(seed.getSnapshot().revision);
  const item = TranscriptItemSchema.parse({
    id: "tool:check",
    kind: "tool",
    toolCallId: "check",
    tool: { name: "shell", namespace: "codex" },
    view: { status: "done", truncated: true },
    runId: createId("run"),
    attemptId: createId("runAttempt"),
    nodeId: null,
    position: "1",
    revision,
    createdAt: "2026-08-16T10:00:01.000Z",
    isTurnStart: false,
  });
  vi.spyOn(seed, "scopedDetail").mockReturnValue(
    PersonalDetailSnapshotSchema.parse({
      thread,
      items: [item],
      activeItems: [],
      pendingRequests: [],
      nextBefore: null,
    }),
  );
  const read = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      Response.json(
        {
          ok: false,
          error: { code: "internal", message: "The item could not be read", retryable: false },
        },
        { status: 500 },
      ),
    )
    .mockImplementation(async () =>
      Response.json({
        ok: true,
        data: {
          item,
          threadId,
          nodeId: null,
          truncated: false,
          body: {
            kind: "tool",
            arguments: { command: "pnpm test" },
            output: { text: "whole lazy output" },
          },
        },
      }),
    );
  const client = new HttpHostClient({
    baseUrl: "http://fixture",
    webSocketFactory: host.connect,
    fetch: (input, options) =>
      new URL(String(input)).pathname.endsWith("/transcript.item.get")
        ? read(input, options)
        : host.fetch(input, options),
  });
  try {
    client.activateThread(threadId);
    await client.load();
    const entry = await vi.waitFor(() => {
      const held = client
        .getThreadTranscript(threadId)
        ?.getSnapshot()
        .entries.find(({ id }) => id === item.id);
      if (held?.kind !== "tool") throw new Error("Missing scoped tool card");
      return held;
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () =>
      root.render(
        <MemoryRouter>
          <AgentTranscript entries={[entry]} attachmentReader={client} threadId={threadId} />
        </MemoryRouter>,
      ),
    );
    expect(read).not.toHaveBeenCalled();
    click(status(container));
    expect(read).not.toHaveBeenCalled();
    await act(async () => click(container.querySelector(".trace-step__head")));
    expect(read).toHaveBeenCalledTimes(1);
    const route = new URL(String(read.mock.calls[0]?.[0]));
    expect(JSON.parse(route.searchParams.get("input")!)).toMatchObject({
      threadId,
      itemId: item.id,
    });
    expect(container.textContent).toContain("Couldn't load this output.");
    await act(async () => click(button(container, "Try again")));
    expect(container.textContent).toContain("whole lazy output");
    click(container.querySelector(".trace-step__head"));
    await act(async () => click(container.querySelector(".trace-step__head")));
    expect(container.textContent).toContain("whole lazy output");
    expect(read).toHaveBeenCalledTimes(2);
  } finally {
    client.dispose();
    host.dispose();
  }
});

it("keeps an edited message's history a click away after a Run took it", async () => {
  const listMessageRevisions = vi.fn(async () => ({
    hasMore: false,
    revisions: [
      {
        author: { displayName: "Me", kind: "human" as const, userId: "me" },
        content: [{ text: "Check the integration shard", type: "text" as const }],
        createdAt: "2026-08-16T10:00:01.000Z",
        deviceLabel: "Chrome on Mac",
        revision: 1,
      },
      {
        author: { displayName: "Me", kind: "human" as const, userId: "me" },
        content: [{ text: "Check the shard", type: "text" as const }],
        createdAt: "2026-08-16T10:00:00.000Z",
        deviceLabel: null,
        revision: 0,
      },
    ],
  }));
  const client = { listMessageRevisions } as unknown as MockHostClient;
  const edit = { editedAt: "2026-08-16T10:00:01.000Z", revision: 1 };
  const own = {
    author: { displayName: "Me", kind: "human", userId: "me" },
    body: "Check the integration shard",
    createdAt: "2026-08-16T10:00:00.000Z",
    edit,
    id: "message-own",
    kind: "message",
    messageKind: "input",
    runId: "run-a",
  } as MessageEntry;
  const asked: MessageEntry = {
    author: {
      actor: "human",
      displayName: "Maya Chen",
      kind: "team-member",
      teamId: "dep_00000000-0000-4000-8000-000000000001",
      teamUserId: "usr_maya",
    },
    body: "Is CI green on main?",
    createdAt: "2026-08-16T10:00:00.000Z",
    edit: { ...edit, ownerEdited: true },
    id: "message-asked",
    kind: "message",
    messageKind: "input",
    runId: "run-a",
  } as MessageEntry;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <MemoryRouter>
        <AgentTranscript
          attachmentReader={client}
          entries={[own, asked]}
          threadId="thread-1"
          viewerUserId="me"
        />
      </MemoryRouter>,
    ),
  );
  const marks = [...container.querySelectorAll<HTMLButtonElement>(".waiting__edited")];
  expect(marks.map((mark) => mark.textContent)).toEqual(["Edited", "edited by you"]);
  await act(async () => click(marks[0]));
  expect(listMessageRevisions).toHaveBeenCalledWith("thread-1", "message-own", undefined);
  expect(document.body.textContent).toContain("Check the shard");
  await act(async () => click(marks[1]));
  expect(listMessageRevisions).toHaveBeenLastCalledWith("thread-1", "message-asked", undefined);
});

describe("a message's pages", () => {
  // Failure mode: the screen works out which tabs a transcript names from the rows it was given,
  // so a page only the opened message names, past those its preview carries, keeps the title and
  // the link it had when the message was opened.
  it("follow their tabs, the pages an opened message adds to its preview too", async () => {
    const mock = new MockHostClient({ latencyMs: 0 });
    try {
      await mock.load();
      const threadId = "thr_00000000-0000-4000-8000-000000000005";
      mock.activateThread(threadId);
      const viewer = createId("user");
      const pages = [
        "mock-tab-0-0",
        "mock-tab-4-0",
        "mock-tab-8-0",
        "mock-tab-11-0",
        "mock-tab-3-0",
      ].map((tabId, index): BrowserPageContentPart => ({
        type: "browser-page",
        sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000802"),
        tabId: BrowserSurfaceIdSchema.parse(tabId),
        title: `Page ${index}`,
        url: `https://pages.example/${index}`,
      }));
      const author = {
        displayName: "Me",
        kind: "human",
        principalId: viewer,
        userId: viewer,
      } as const;
      // The row carries the preview: its words and the first page alone.
      const preview: MessageEntry = {
        ...note,
        author,
        body: "Everything I read about it",
        id: "message-pages",
        itemId: "message-pages",
        messageKind: "input",
        pages: pages.slice(0, 1),
        previewTruncated: true,
        runId: null,
      };
      const read = vi.spyOn(mock, "readTranscriptItem").mockResolvedValue({
        body: {
          kind: "message",
          message: {
            author,
            content: [{ type: "text", text: preview.body }, ...pages],
            createdAt: preview.createdAt,
            id: preview.id,
            kind: "input",
            runId: null,
            sequence: "1",
            threadId,
          },
        },
      } as unknown as Awaited<ReturnType<MockHostClient["readTranscriptItem"]>>);
      const { tabs, browserProfiles } = mock.getSnapshot();
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      roots.push(root);
      await act(async () =>
        root.render(
          <MemoryRouter>
            <TestWorkspace>
              <AgentTranscript
                attachmentReader={mock}
                browserSessions={{ tabs, browserProfiles }}
                entries={[preview]}
                threadId={threadId}
                viewerUserId={viewer}
              />
            </TestWorkspace>
          </MemoryRouter>,
        ),
      );
      const chips = () => [...container.querySelectorAll(".msg--user__pages .surface-chip")];
      const titles = () =>
        chips().map((chip) => chip.querySelector(".surface-chip__title")?.textContent);
      expect(titles()).toEqual(["Your reading list"]);
      await act(async () =>
        container.querySelector<HTMLButtonElement>(".message-fold__toggle")!.click(),
      );
      await vi.waitFor(() => expect(titles()).toHaveLength(5));
      expect(read).toHaveBeenCalledWith(threadId, preview.id, undefined);
      expect(titles()[4]).toBe("Launch brief");
      const retitle = (change: (rows: Tab[]) => Tab[]) =>
        act(() => tabs.replaceRows(change([...tabs.rows.values()]), tabs.complete));
      retitle((rows) =>
        rows.map((tab) =>
          tab.tabId === "mock-tab-3-0" ? { ...tab, title: "Launch brief v2" } : tab,
        ),
      );
      expect(titles()[4]).toBe("Launch brief v2");
      // Closed, it is named as it was sent and opens nothing.
      retitle((rows) => rows.filter((tab) => tab.tabId !== "mock-tab-3-0"));
      expect(titles()[4]).toBe("Page 4");
      expect(chips()[4]?.classList.contains("surface-chip--ended")).toBe(true);
    } finally {
      mock.dispose();
    }
  });
});

describe("a message still on this device", () => {
  it("offers Edit and Don't send for files alone, and Edit takes it back", async () => {
    const mock = new MockHostClient({ latencyMs: 0 });
    const records = new Map<string, string>();
    const outbox = initializeMessageOutbox(mock, {
      storage: createMessageOutboxStorage({
        read: async (key) => records.get(key) ?? null,
        write: async (key, value) => void records.set(key, value),
        remove: async (key) => void records.delete(key),
      }),
      drafts: { restore: async () => "restored" },
    });
    const restoreDraft = vi.spyOn(outbox, "restoreDraft").mockResolvedValue("restored");
    try {
      const viewer = createId("user");
      const entry: MessageEntry = {
        kind: "message",
        id: "files-only",
        clientSendKey: "files-only",
        createdAt: new Date().toISOString(),
        messageKind: "input",
        runId: null,
        policy: "queue",
        body: "",
        attachments: [
          {
            type: "artifact",
            artifactId: createId("attachment"),
            name: "photo.jpg",
            mediaType: "image/jpeg",
            sizeBytes: 10,
          },
        ],
        author: { kind: "human", userId: viewer, principalId: viewer, displayName: "You" },
        localDelivery: { phase: "waiting", attempted: false },
      };
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      roots.push(root);
      await act(async () =>
        root.render(
          <MemoryRouter>
            <AgentTranscript entries={[entry]} attachmentReader={mock} viewerUserId={viewer} />
          </MemoryRouter>,
        ),
      );
      const control = (name: string) =>
        [...container.querySelectorAll("button")].find((item) => item.textContent === name);
      expect(control("Don't send")).toBeDefined();
      await act(async () => control("Edit")!.click());
      expect(restoreDraft).toHaveBeenCalledWith("files-only");
    } finally {
      disposeMessageOutbox(mock);
      mock.dispose();
    }
  });
});

describe("arrival motion", () => {
  // Failure mode: every turn rises in whenever it mounts, so opening or returning to a task with a
  // long report composites the whole turn (hundreds of ms), as does each row scrolled into view.
  it("moves only a row live work appends, never rows there when shown, history, a repair or a new cut", async () => {
    const message = (index: number): MessageEntry => ({
      ...note,
      runId: null,
      body: `Update ${index}`,
      createdAt: new Date(Date.UTC(2026, 7, 16, 10, index)).toISOString(),
      id: `arrival-${index}`,
    });
    const range = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, index) => message(from + index));
    const scroller = document.createElement("div");
    document.body.append(scroller);
    const root = createRoot(scroller);
    roots.push(root);
    // The live conversation's newest rows, of the cut given; null for a window of history.
    const show = async (entries: MessageEntry[], liveCut: number | null = 1) =>
      act(async () => {
        root.render(
          <MemoryRouter initialEntries={["/tasks/arrival"]}>
            <AgentTranscript entries={entries} liveCut={liveCut} scroller={() => scroller} />
          </MemoryRouter>,
        );
      });
    const settle = () => {
      for (const slot of scroller.querySelectorAll(".transcript__virtual-slot--arrived"))
        act(() => {
          slot.dispatchEvent(new Event("animationend"));
        });
    };
    const moving = () =>
      [...scroller.querySelectorAll(".transcript__virtual-slot--arrived")].map((slot) =>
        slot.querySelector("[data-message-id]")?.getAttribute("data-message-id"),
      );
    await show(range(10, 20));
    expect(moving()).toEqual([]);
    // A page of history lands above: nothing arrives.
    await show(range(0, 20));
    expect(moving()).toEqual([]);
    // Live work appends one row: it rises in, once.
    await show(range(0, 21));
    expect(moving()).toEqual(["arrival-20"]);
    act(() => {
      scroller
        .querySelector(".transcript__virtual-slot--arrived")!
        .dispatchEvent(new Event("animationend"));
    });
    await show(range(0, 21));
    expect(moving()).toEqual([]);
    // Two at once rise in too; more than that is a catch-up, not live work.
    await show(range(0, 23));
    expect(moving()).toEqual(["arrival-21", "arrival-22"]);
    for (const slot of scroller.querySelectorAll(".transcript__virtual-slot--arrived"))
      act(() => {
        slot.dispatchEvent(new Event("animationend"));
      });
    await show(range(0, 26));
    expect(moving()).toEqual([]);
    // A jump or a new cut replaces the window: none of its rows arrive.
    await show(range(40, 50));
    expect(moving()).toEqual([]);
    // Nor when the new window overlaps the old and ends in a row never shown: rows left the front.
    await show(range(42, 51));
    expect(moving()).toEqual([]);
    // Nor when it moves back over rows shown before and ends past them.
    await show(range(30, 52));
    expect(moving()).toEqual([]);
    await show(range(30, 53));
    expect(moving()).toEqual(["arrival-52"]);
    settle();
    // A repair installs a new cut that keeps every row and adds one: it was read, not appended.
    await show(range(30, 54), 2);
    expect(moving()).toEqual([]);
    await show(range(30, 55), 2);
    expect(moving()).toEqual(["arrival-54"]);
    settle();
    // In a window of history, Load newer appends a page; landing on the newest rows, it still
    // moves nothing, and only live work after it does.
    await show(range(30, 55), null);
    await show(range(30, 56), null);
    expect(moving()).toEqual([]);
    await show(range(30, 57), 2);
    expect(moving()).toEqual([]);
    await show(range(30, 58), 2);
    expect(moving()).toEqual(["arrival-57"]);
  });
});

describe("a message the reader opened", () => {
  // Failure mode: every transcript is virtualized, so a message opened with Show more folds again
  // once focus has moved on and its row scrolls out of view and back.
  it("stays open when its row scrolls out of view and is drawn again", async () => {
    const at = (minute: number) => new Date(Date.UTC(2026, 7, 16, 10, minute)).toISOString();
    const words = "Check every shard, then the flaky ones again. ".repeat(40);
    const viewer = createId("user");
    const sam = createId("user");
    const opened: MessageEntry[] = [
      {
        ...note,
        author: { displayName: "Me", kind: "human", principalId: viewer, userId: viewer },
        body: words,
        createdAt: at(0),
        id: "opened-own",
        messageKind: "input",
        previewTruncated: true,
        runId: null,
      },
      {
        ...note,
        author: { displayName: "Sam", kind: "human", principalId: sam, userId: sam },
        body: words,
        createdAt: at(1),
        id: "opened-input",
        messageKind: "input",
        previewTruncated: true,
        runId: null,
      },
      {
        ...note,
        author: { cause: "run-recovery", kind: "platform" },
        body: words,
        createdAt: at(2),
        id: "opened-recovery",
        messageKind: "input",
        runId: null,
      },
    ];
    const after = Array.from({ length: 120 }, (_, index): MessageEntry => ({
      ...note,
      body: `Update ${index}`,
      createdAt: at(3 + index),
      id: `opened-after-${index}`,
      runId: null,
    }));
    const scroller = document.createElement("div");
    let scrollTop = 0;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 800 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
        },
      },
    });
    const elsewhere = document.createElement("button");
    document.body.append(scroller, elsewhere);
    const root = createRoot(scroller);
    roots.push(root);
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/tasks/opened"]}>
          <AgentTranscript
            entries={[...opened, ...after]}
            scroller={() => scroller}
            viewerUserId={viewer}
          />
        </MemoryRouter>,
      );
      await import("./markdown.js");
    });
    const row = (id: string) => scroller.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
    const toggle = (id: string) =>
      row(id)?.querySelector<HTMLButtonElement>(".message-fold__toggle, .update-line__toggle");
    const scrollTo = (top: number) =>
      act(async () => {
        scrollTop = top;
        scroller.dispatchEvent(new Event("scroll"));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
    for (const { id } of opened) {
      expect(toggle(id)?.getAttribute("aria-expanded"), id).toBe("false");
      act(() => {
        toggle(id)!.focus();
        toggle(id)!.click();
      });
      expect(toggle(id)?.getAttribute("aria-expanded"), id).toBe("true");
    }
    act(() => elsewhere.focus());
    await scrollTo(6000);
    for (const { id } of opened) expect(row(id), id).toBeNull();
    await scrollTo(0);
    for (const { id } of opened) expect(toggle(id)?.getAttribute("aria-expanded"), id).toBe("true");
  });
});

describe("a long transcript's bodies", () => {
  it("draws only the rows in and near view of any transcript it scrolls, each parsed at once", async () => {
    const makeEntries = (count: number, thread: string): MessageEntry[] =>
      Array.from({ length: count }, (_, index) => ({
        ...note,
        runId: null,
        body: `Update **${index}**`,
        createdAt: new Date(Date.UTC(2026, 7, 16, 10, index)).toISOString(),
        id: `${thread}-message-${index}`,
      }));
    for (const [thread, count] of [
      ["short", 45],
      ["long", 100],
    ] as const) {
      const scroller = document.createElement("div");
      document.body.append(scroller);
      const root = createRoot(scroller);
      roots.push(root);
      await act(async () => {
        root.render(
          <MemoryRouter initialEntries={[`/tasks/${thread}`]}>
            <AgentTranscript entries={makeEntries(count, thread)} scroller={() => scroller} />
          </MemoryRouter>,
        );
        await import("./markdown.js");
      });
      const body = (index: number) =>
        scroller.querySelector(`[data-message-id="${thread}-message-${index}"]`);
      // Without layout the window stands at the top, and the newest rows stay held at the tail.
      await vi.waitFor(() =>
        expect(body(count - 1)?.querySelector("strong")?.textContent).toBe(`${count - 1}`),
      );
      expect(body(2)?.querySelector("strong")?.textContent).toBe("2");
      expect(scroller.dataset.virtualized).toBe("true");
      expect(scroller.querySelectorAll("[data-transcript-row]").length).toBeLessThan(
        Math.min(count, 60),
      );
      expect(scroller.querySelectorAll(".transcript__spacer").length).toBeGreaterThan(0);
      expect(body(count - 12)).toBeNull();
    }
  });

  it("draws a task switched back to from its finished replies, without parsing them again", async () => {
    const { drawnBlocks } = await import("./markdown.js");
    const report = (turn: number) =>
      Array.from(
        { length: 6 },
        (_, section) =>
          `## Finding ${turn}.${section}\n\nThe **source** says [more](https://example.com/${turn}/${section}).\n\n` +
          "```ts\nconst value = " +
          `${turn * 10 + section}` +
          ";\n```",
      ).join("\n\n");
    const entries: MessageEntry[] = Array.from({ length: 10 }, (_, turn) => ({
      ...note,
      runId: null,
      body: report(turn),
      createdAt: new Date(Date.UTC(2026, 7, 16, 10, turn)).toISOString(),
      id: `switch-report-${turn}`,
    }));
    const open = async () => {
      const scroller = document.createElement("div");
      document.body.append(scroller);
      const root = createRoot(scroller);
      await act(async () => {
        root.render(
          <MemoryRouter initialEntries={["/tasks/switch"]}>
            <AgentTranscript entries={entries} scroller={() => scroller} />
          </MemoryRouter>,
        );
        await import("./markdown.js");
      });
      await vi.waitFor(() =>
        expect(scroller.querySelector('[data-message-id="switch-report-9"] h2')).not.toBeNull(),
      );
      const drawn = scroller.querySelector(".transcript")?.innerHTML ?? scroller.innerHTML;
      act(() => root.unmount());
      scroller.remove();
      return drawn;
    };
    const parsed = vi.spyOn(drawnBlocks, "set");
    const first = await open();
    const firstParses = parsed.mock.calls.length;
    expect(firstParses).toBeGreaterThan(0);
    const again = await open();
    expect(parsed.mock.calls.length).toBe(firstParses);
    expect(again).toBe(first);
  });

  it("renders full assistant replies without an expand button in Task and Chat modes", async () => {
    const longBody = `${"Full assistant answer line. ".repeat(80)}FINAL_WORD`;
    const fullReply: MessageEntry = {
      ...note,
      runId: null,
      id: "assistant-long",
      body: longBody,
      previewTruncated: false,
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    for (const conversation of [false, true]) {
      await act(async () => {
        root.render(
          <MemoryRouter initialEntries={["/tasks/thread-1"]}>
            <AgentTranscript conversation={conversation} entries={[fullReply]} />
          </MemoryRouter>,
        );
        await import("./markdown.js");
      });
      await vi.waitFor(() => expect(container.textContent).toContain("FINAL_WORD"));
      expect(container.textContent).not.toContain("Read full reply");
      expect(container.textContent).not.toContain("Show full message");
    }
  });

  it("pins tail scrollTop across height resizes while following, and yields immediately when the user scrolls up", async () => {
    const callbacks: ResizeObserverCallback[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: ResizeObserverCallback) {
          callbacks.push(cb);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const entries: MessageEntry[] = Array.from({ length: 100 }, (_, index) => ({
      ...note,
      runId: null,
      body: `Message ${index}`,
      createdAt: new Date(Date.UTC(2026, 7, 16, 10, index)).toISOString(),
      id: `message-${index}`,
    }));
    const scroller = document.createElement("div");
    let scrollHeight = 10_000;
    const clientHeight = 800;
    let scrollTop = 0;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, get: () => clientHeight },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = Math.max(0, Math.min(scrollHeight - clientHeight, value));
        },
      },
    });
    document.body.append(scroller);
    const root = createRoot(scroller);
    roots.push(root);
    try {
      await act(async () => {
        root.render(
          <MemoryRouter initialEntries={["/tasks/thread-tail"]}>
            <AgentTranscript entries={entries} followTail scroller={() => scroller} />
          </MemoryRouter>,
        );
        await import("./markdown.js");
      });
      expect(scroller.dataset.virtualized).toBe("true");
      expect(scrollTop).toBe(scrollHeight - clientHeight);

      // Simulate height shrink followed by height growth while following tail.
      scrollHeight = 9_400;
      scrollTop = Math.min(scrollTop, scrollHeight - clientHeight);
      await act(async () => {
        for (const cb of callbacks) cb([], {} as ResizeObserver);
      });
      expect(scrollTop).toBe(scrollHeight - clientHeight);

      scrollHeight = 10_600;
      await act(async () => {
        for (const cb of callbacks) cb([], {} as ResizeObserver);
      });
      expect(scrollTop).toBe(scrollHeight - clientHeight);

      // User scrolls up while scrollHeight and clientHeight are unchanged: must not snap back.
      scrollTop = 8_500;
      scroller.dispatchEvent(new Event("scroll"));
      await act(async () => {
        for (const cb of callbacks) cb([], {} as ResizeObserver);
      });
      expect(scrollTop).toBe(8_500);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
