// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import type {
  MessageEntry,
  ReasoningEntry,
  RunEntry,
  ToolEntry,
  TranscriptEntry,
} from "@opensteer/client/host";
import {
  MockHostClient,
  mockComputerUseToolRefs,
  mockComputerUseTurn,
} from "@opensteer/client/mock";
import { createId, ThreadIdSchema, WorkspaceIdSchema, RunnerIdSchema } from "@opensteer/core";
import { computerUseStops } from "@opensteer/client/integrations";
import { AgentTranscript } from "./agent-activity.js";
import { useWorkspaceNavigation } from "./workspace/navigation.js";
import { WorkspaceProvider } from "./workspace/workspace-context.js";

/** Chips open places through the workspace's navigation, as they do in the app. */
function TestWorkspace({ children }: { readonly children: React.ReactNode }) {
  const nav = useWorkspaceNavigation({ deploymentId: null, userId: null }, null);
  return (
    <WorkspaceProvider attention={0} nav={nav} openDrawer={() => undefined}>
      {children}
    </WorkspaceProvider>
  );
}

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
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
      <MemoryRouter initialEntries={["/threads/thread-1"]}>
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

describe("AgentTranscript work", () => {
  it("keeps prose visible beside compact tool groups and opens tool details independently", () => {
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

    const head = container.querySelector(".work__head");
    expect(head?.textContent).toContain("Worked for 3s");
    expect(container.textContent).toContain("open-source coding agent");
    expect(head?.textContent).toContain("1 error");
    expect(head?.tagName).toBe("DIV");

    // Two commands fold into a row; the agent's note sits between rows.
    const commands = button(container, "Ran 2 commands");
    expect(commands).toBeDefined();
    expect(container.textContent).toContain("public page");
    expect(button(container, "Opened a browser")).toBeDefined();
    expect(container.querySelector('a[href="/threads/thread-1?panel=browser"]')).toBeNull();

    click(commands);
    const lines = container.querySelectorAll(".trace-step__lines .trace-step__head");
    expect(lines).toHaveLength(2);
    expect(container.querySelector(".trace-step__icon--error")).not.toBeNull();

    click(lines[1]);
    expect(container.querySelector(".trace-code--command")?.textContent).toBe("pnpm test");
    expect(container.textContent).toContain("lint failed");

    click(commands);
    expect(container.textContent).not.toContain("lint failed");
    expect(container.textContent).toContain("public page");
    expect(container.textContent).toContain("open-source coding agent");
  });

  it("shows live reasoning outside status and tool disclosures and preserves it on completion", () => {
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

    const work = container.querySelector(".work__head");
    expect(work?.hasAttribute("aria-expanded")).toBe(false);
    expect(button(container, "Running commands")).toBeUndefined();
    expect(button(container, "Thinking")?.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".trace-step__thought")?.textContent).toContain(
      "live rendering path",
    );
    expect(container.querySelector(".trace-thought")?.parentElement?.className).toBe(
      "turn__content",
    );
    expect(container.querySelector(".work .trace-step__thought")).toBeNull();
    const thoughtNode = container.querySelector(".trace-thought");

    render(root, [
      run,
      first,
      reasoning({ completedAt: "2026-08-16T10:00:04.000Z", state: "done" }),
      { ...second, completedAt: "2026-08-16T10:00:05.000Z", state: "done" },
    ]);

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
    expect(container.querySelector(".trace-step__thought")).toBeNull();
    expect(container.textContent).toContain(note.body);
    click(button(container, "Thought"));
    expect(container.querySelector(".trace-step__thought")?.textContent).toContain(
      "live rendering path",
    );
  });

  it("keeps a progress message mounted and ordered when later tools arrive and the run finishes", () => {
    const first = tool();
    const next = tool({ arguments: { command: "second-command" } });
    const container = mount([{ ...run, status: "running" }, first, note]);
    const root = roots.at(-1)!;
    const messageNode = container.querySelector(".msg--assistant__body");
    const statusNode = container.querySelector('[aria-label="Agent status"]');
    expect(container.textContent!.indexOf(note.body)).toBeLessThan(
      container.textContent!.indexOf("Working"),
    );
    render(root, [{ ...run, status: "running" }, first, note, next]);
    expect(container.querySelector(".msg--assistant__body")).toBe(messageNode);
    expect(container.querySelector('[aria-label="Agent status"]')).toBe(statusNode);
    expect(container.textContent!.indexOf(note.body)).toBeLessThan(
      container.textContent!.indexOf("Working"),
    );
    render(root, [run, first, note, next]);
    expect(container.querySelector(".msg--assistant__body")).toBe(messageNode);
    const children = [...container.querySelector(".turn__content")!.children];
    expect(children[1]).toBe(messageNode);
    expect(children[2]?.textContent).toContain("second-command");
    const answer = { ...note, id: "final-answer", body: "Final answer after the work." };
    render(root, [run, first, note, next, answer]);
    expect(container.querySelector(".msg--assistant__body")).toBe(messageNode);
    const text = container.textContent!;
    expect(text.indexOf("second-command")).toBeLessThan(text.indexOf("Worked"));
    expect(text.indexOf(answer.body)).toBeLessThan(text.indexOf("Worked"));
    expect(container.querySelector(".turn__content")?.lastElementChild).toBe(statusNode);
  });

  it("keeps the same footer after all replies through writing, waiting, stopping and completion", () => {
    const first = tool();
    const answer = {
      ...note,
      id: "final-answer",
      body: "The answer is arriving.",
      streaming: true,
    };
    const container = mount([{ ...run, status: "running" }, first, note, answer]);
    const root = roots.at(-1)!;
    const status = container.querySelector('[aria-label="Agent status"]');
    const message = container.querySelectorAll(".msg--assistant__body")[1];
    const phases: readonly [RunEntry, string][] = [
      [{ ...run, status: "running" }, "Writing"],
      [{ ...run, status: "waiting" }, "Waiting for you"],
      [{ ...run, status: "running", stopping: true }, "Stopping"],
      [run, "Worked"],
    ];
    for (const [phase, label] of phases) {
      render(root, [phase, first, note, { ...answer, streaming: phase.status !== "completed" }]);
      expect(container.querySelectorAll(".msg--assistant__body")[1]).toBe(message);
      expect(container.querySelector(".turn__content")?.lastElementChild).toBe(status);
      expect(status?.textContent).toContain(label);
      expect(container.textContent!.indexOf(answer.body)).toBeLessThan(
        container.textContent!.indexOf(label),
      );
    }
  });
});

describe("a Computer use row", () => {
  const slack = (state: "running" | "settled"): TranscriptEntry[] => [
    { ...run, status: state === "running" ? "running" : "completed" },
    ...mockComputerUseTurn({ agent: note.author, runId: "run-a", state }),
  ];

  it("reads as one Slack row that opens into a timeline of steps", () => {
    const container = mount(slack("settled"));
    const heads = [...container.querySelectorAll(".turn__content > .trace-step")].map(
      (row) => row.querySelector(".trace-step__head")?.textContent,
    );
    expect(heads).toEqual([
      'Listed apps on a Macfor "Computer use" and "Slack"1 error',
      "Used Slack9 steps on Alex's MacBook Pro1 error",
    ]);
    expect(container.querySelector(".work__meta")?.textContent).toBe(
      "4 integration lookups, 9 steps in Slack",
    );
    expect(container.querySelector(".work__head .trace-errors")?.textContent).toBe("2 errors");
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
    const broken = button(container, "Couldn't use Slack");
    expect(broken?.querySelector("title")?.textContent).toBe("Returned an error");
    expect(broken?.querySelector(".trace-errors")).toBeNull();
    expect(timeline?.querySelectorAll(".trace-errors")).toHaveLength(0);
    expect(button(container, 'Clicked "Opensteer 2", then waited 2000 ms')).toBeDefined();

    click(stop);
    const detail = stop?.closest(".trace-step")?.querySelector(".trace-step__body");
    const observation = button(detail as HTMLElement, "Observation");
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
    const reason = broken?.closest(".trace-step")?.querySelector(".trace-step__summary");
    expect(reason?.textContent).toBe(
      "Invalid Act arguments at $.actions[0]: must match exactly one allowed schema",
    );
  });

  it("updates the row's live step in place while it runs", () => {
    const container = mount(slack("running"));
    const head = button(container, "Using Slack");
    expect(head?.querySelector(".trace-step__detail--live")?.textContent).toBe("Clicking in Slack");
    expect(container.querySelector(".work__label")?.textContent).toBe(
      "Clicking in Slack on Alex's MacBook Pro",
    );
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

  it("keeps a lookup's output, full of references, closed until asked for", () => {
    const container = mount(slack("settled"));
    click(button(container, "Listed apps on a Mac"));
    const [, , found] = container.querySelectorAll(".trace-step__lines .trace-step__head");
    click(found);
    const detail = found?.closest(".trace-step")?.querySelector(".trace-step__body");
    const output = button(detail as HTMLElement, "Output");
    expect(output?.getAttribute("aria-expanded")).toBe("false");
    expect(detail?.querySelector("pre")).toBeNull();
    expect(container.innerHTML).not.toMatch(/igr_|itl_/u);
    click(output);
    expect(detail?.querySelector("pre")?.textContent).toContain("toolRefs");
  });
});

it("opens the exact phone from its conversation chip and keeps only Stop on the activity line", () => {
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
        phone: { computer: machine.name, runnerId: RunnerIdSchema.parse(machine.id) },
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
  const chip = container.querySelector<HTMLAnchorElement>(
    `a[aria-label="Open ${machine.name}, agent working"]`,
  );
  expect(chip).not.toBeNull();
  const params = new URL(chip!.href).searchParams;
  expect(params.get("computerSession")).toBe(session.sessionId);
  expect(params.get("phone")).toBe(machine.id);
  expect(params.has("app")).toBe(false);
  click(chip);
});

describe("task mark bylines", () => {
  it("resolves a live ordinary task, falls back for an unknown author, and keeps specialist attribution", async () => {
    const mock = new MockHostClient();
    try {
      await mock.load();
      const snapshot = mock.getSnapshot();
      const thread = snapshot.threads.find((thread) => thread.icon === "plane")!;
      const main = snapshot.workspaces.find((workspace) => workspace.kind === "main")!;
      const specialist = snapshot.workspaces.find((workspace) => workspace.name === "Travel")!;
      const author = {
        kind: "agent" as const,
        displayName: thread.title,
        runId: createId("run"),
        threadId: ThreadIdSchema.parse(thread.id),
        workspaceId: WorkspaceIdSchema.parse(main.id),
        workspaceName: main.name,
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
              <AgentTranscript
                entries={[message]}
                attachmentReader={mock}
                homeThreadId={snapshot.homeThreadId}
                workspaces={snapshot.workspaces}
              />
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
        container.querySelector(".msg--assistant__author .task-mark")?.getAttribute("data-pending"),
      ).toBe("true");
      await draw({
        ...entry,
        author: {
          ...author,
          workspaceId: WorkspaceIdSchema.parse(specialist.id),
          workspaceName: specialist.name,
          displayName: specialist.name,
        },
      });
      expect(
        container
          .querySelector(".msg--assistant__author .workspace-orb")
          ?.getAttribute("data-color"),
      ).toBe("blue");
      expect(container.querySelector(".msg--assistant__author")?.textContent).toBe("Travel");
    } finally {
      mock.dispose();
    }
  });
});

it("keeps a silent automatic turn through pending Stop and its kept window", async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(container.textContent).toContain("Stopped using");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 3100));
  });
  expect(container.textContent).not.toContain("Stopped using");
}, 10000);
