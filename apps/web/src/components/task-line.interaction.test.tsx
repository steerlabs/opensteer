// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AssignmentIdSchema,
  WaitingRequestSchema,
  createId,
  type AssignmentSummary,
  type WaitingRequest,
} from "@opensteer/core";
import type { AssignmentEntry, HostSnapshot, TranscriptEntry } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { AppShell } from "./app-shell.js";
import { HomeRoute } from "./home/home-route.js";
import { ThreadRoute } from "./thread-view.js";
import { ToastProvider } from "./toast.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
const clients: MockHostClient[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const client of clients.splice(0)) client.dispose();
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/**
 * A task with the tasks one of its turns handed out replaced by `tasks`, each
 * reading the given summary, and `waiting` as the questions on the reader.
 */
async function chatWith(
  tasks: (seeded: AssignmentSummary) => readonly AssignmentSummary[],
  waiting: (tasks: readonly AssignmentSummary[]) => readonly WaitingRequest[] = () => [],
): Promise<{
  client: MockHostClient;
  node: HTMLElement;
  tasks: readonly AssignmentSummary[];
  update: (changed: AssignmentSummary) => void;
}> {
  stubLayoutApis();
  const client = new MockHostClient({ latencyMs: 0 });
  clients.push(client);
  const read = client.getSnapshot.bind(client);
  const base = read();
  // The task that handed work out: its transcript holds the task lines.
  const home = Object.values(base.assignments)[0]!.parentThreadId;
  const seeded = base.transcripts[home]!.find(
    (entry): entry is AssignmentEntry => entry.kind === "assignment",
  )!;
  let made = tasks(seeded.assignment);
  const questions = waiting(made);
  let cache = new WeakMap<HostSnapshot, HostSnapshot>();
  // The Host moving a task on: the next summary, told to whoever reads it.
  const listeners = new Set<() => void>();
  const subscribe = client.subscribe.bind(client);
  vi.spyOn(client, "subscribe").mockImplementation((listener) => {
    listeners.add(listener);
    const unsubscribe = subscribe(listener);
    return () => {
      listeners.delete(listener);
      unsubscribe();
    };
  });
  const update = (changed: AssignmentSummary) => {
    made = made.map((assignment) => (assignment.id === changed.id ? changed : assignment));
    cache = new WeakMap();
    for (const listener of listeners) listener();
  };
  vi.spyOn(client, "getSnapshot").mockImplementation(() => {
    const snapshot = read();
    let held = cache.get(snapshot);
    if (!held) {
      const entries = snapshot.transcripts[home] ?? [];
      held = {
        ...snapshot,
        assignments: {
          ...Object.fromEntries(
            Object.entries(snapshot.assignments).filter(([id]) => id !== seeded.assignment.id),
          ),
          ...Object.fromEntries(made.map((assignment) => [assignment.id, assignment])),
        },
        connection: "connected",
        transcripts: {
          ...snapshot.transcripts,
          [home]: entries.flatMap((entry): TranscriptEntry[] =>
            entry.id === seeded.id
              ? made.map((assignment) => ({
                  ...seeded,
                  assignment,
                  id: `assignment:${assignment.id}`,
                }))
              : [entry],
          ),
        },
        waitingRequests: [...questions],
      };
      cache.set(snapshot, held);
    }
    return held;
  });
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  roots.push(root);
  await act(async () =>
    root.render(
      <ToastProvider>
        <MemoryRouter initialEntries={[`/tasks/${home}`]}>
          <Routes>
            <Route element={<AppShell hostClient={client} loadError={null} />}>
              <Route index element={<HomeRoute />} />
              <Route path="tasks/:threadId" element={<ThreadRoute />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    ),
  );
  return { client, node, tasks: made, update };
}

function variant(
  seeded: AssignmentSummary,
  index: number,
  change: Partial<AssignmentSummary>,
): AssignmentSummary {
  return {
    ...seeded,
    id: index === 0 ? seeded.id : AssignmentIdSchema.parse(createId("delegation")),
    // Open unless the change settles it: the seeded task may have finished.
    finishedAt: null,
    status: "open",
    ...change,
  };
}

const settled = (status: AssignmentSummary["status"]): Partial<AssignmentSummary> => ({
  currentRunStatus: status === "failed" ? "failed" : "completed",
  finishedAt: "2026-10-25T10:05:00Z",
  status,
});

function askingAbout(
  client: MockHostClient,
  assignment: AssignmentSummary,
  title: string,
): WaitingRequest {
  const pending = Object.values(client.getSnapshot().requests)
    .flat()
    .find((request) => request.status === "pending")!;
  return WaitingRequestSchema.parse({
    assignments: [
      {
        id: assignment.id,
        parentThreadId: assignment.parentThreadId,
        workerThread: { id: assignment.workerThread.id, title: assignment.workerThread.title },
      },
    ],
    request: {
      ...pending,
      originatingThreadId: assignment.workerThread.id,
      presentation: { ...pending.presentation, title },
    },
  });
}

const lines = (node: HTMLElement) => [
  ...node.querySelectorAll<HTMLElement>('.agent-step[data-agent-key^="task:"]'),
];
const secondLine = (line: HTMLElement) => line.querySelector(".agent-step__l2")?.textContent;

// Ways a task's row can fail the reader: two states read alike, a working
// task stops showing it is moving (or one that is not pulses), a question
// waiting on the reader is not said where the task is, a failure reads as an
// ending like any other, or the row stops opening the task.
describe("a task's row in the conversation that handed it out", () => {
  it.each([
    ["working", { currentRunStatus: "running" as const }, "working", "working"],
    ["done", settled("completed"), "finished", undefined],
    ["failed", settled("failed"), "failed", "failed"],
    ["stopped", settled("cancelled"), "stopped", "stopped"],
  ] as const)("reads a %s task in words and by its dot", async (_, change, tone, dot) => {
    const { node } = await chatWith((seeded) => [variant(seeded, 0, change)]);
    const [line] = lines(node);
    expect(lines(node)).toHaveLength(1);
    expect(line!.dataset.tone).toBe(tone);
    expect(line!.querySelector<HTMLElement>(".agent-mark")?.dataset.dot).toBe(dot);
    // A lone row says what it is, and the row is the task's own mark and title.
    expect(line!.querySelector(".agent-step__noun")?.textContent).toBe("Task");
    expect(line!.querySelector(".agent-mark .task-mark")).not.toBeNull();
    if (tone === "failed")
      expect(line!.querySelector('[data-tone="failed"]')?.textContent).toContain("Couldn't finish");
    const open = line!.querySelector<HTMLAnchorElement>("a.agent-step__head")!;
    expect(open.getAttribute("aria-label")).toMatch(/^Task .+\. Open the task$/u);
    const title = line!.querySelector(".agent-step__title")!.textContent;
    await act(async () => open.click());
    expect(node.querySelector(".conv-header__name")?.textContent).toBe(title);
  });

  it("says a task asked a question, which is answered above the composer", async () => {
    const { node } = await chatWith(
      (seeded) => [variant(seeded, 0, { currentRunStatus: "waiting" })],
      ([task]) => [askingAbout(clients[0]!, task!, "Book the 7:00 PM table at Adda?")],
    );
    const [line] = lines(node);
    expect(line!.dataset.tone).toBe("needs-you");
    expect(secondLine(line!)).toBe("Task·Asked you a question");
    expect(line!.querySelector('[data-tone="attention"]')).not.toBeNull();
    // Answered where Chat docks its tasks' questions, never on the row.
    expect(line!.textContent).not.toContain("Book the 7:00 PM table at Adda?");
  });
});

// Ways it can fail: tasks one turn handed out hide behind a count the reader
// has to open, one that needs the reader is not said on its own row, or a
// task that ends is announced twice or not at all.
describe("tasks one turn handed out together", () => {
  it("read as a row each under one group row, every one opening its task", async () => {
    const { node } = await chatWith(
      (seeded) => [
        variant(seeded, 0, settled("completed")),
        variant(seeded, 1, { currentRunStatus: "waiting" }),
        variant(seeded, 2, { currentRunStatus: "running" }),
      ],
      ([, asking]) => [askingAbout(clients[0]!, asking!, "Which quarter should I use?")],
    );
    expect(lines(node).map((line) => line.dataset.tone)).toEqual([
      "finished",
      "needs-you",
      "working",
    ]);
    expect(secondLine(lines(node)[1]!)).toBe("Asked you a question");
    expect(node.querySelectorAll("a.agent-step__head")).toHaveLength(3);
    // The conversation's subagents fold beside it; this is the tasks' own group row.
    const group = [
      ...node.querySelectorAll<HTMLButtonElement>("button.agent-step__head[aria-expanded]"),
    ].find((button) => button.getAttribute("aria-label")?.includes(" tasks: "))!;
    expect(group.getAttribute("aria-label")).toBe(
      "3 tasks: 1 needs you, 1 working, 1 finished. Hide tasks",
    );
  });

  it("says when one of them ends, once", async () => {
    const { node, tasks, update } = await chatWith((seeded) => [
      variant(seeded, 0, { currentRunStatus: "running" }),
      variant(seeded, 1, { currentRunStatus: "running" }),
    ]);
    const said = () =>
      [...node.querySelectorAll<HTMLElement>('.agent-tasks [role="status"]')]
        .map(({ textContent }) => textContent)
        .filter(Boolean);
    expect(said()).toEqual([]);
    await act(async () => update({ ...tasks[0]!, ...settled("failed") }));
    expect(said()).toEqual([expect.stringMatching(/: Couldn’t finish$/)]);
  });
});

// Ways the row's menu can fail: the quieter row loses the way to stop a
// task, Stop acts without asking, or a finished task still offers it.
describe("a task row's menu", () => {
  it("stops an open task from a right click, after asking once", async () => {
    const { client, node, tasks } = await chatWith((seeded) => [
      variant(seeded, 0, { currentRunStatus: "running" }),
    ]);
    const cancel = vi.spyOn(client, "cancelAssignment");
    const line = lines(node)[0]!;
    await act(async () =>
      line.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
    );
    expect(line.querySelector(".agent-step__more")?.getAttribute("aria-expanded")).toBe("true");
    const stop = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.includes("Stop task…"),
    )!;
    await act(async () => stop.click());
    expect(cancel).not.toHaveBeenCalled();
    const confirm = [...document.querySelectorAll<HTMLButtonElement>(".task-stop button")].find(
      (button) => button.textContent === "Stop task",
    )!;
    await act(async () => confirm.click());
    expect(cancel).toHaveBeenCalledExactlyOnceWith(tasks[0]!.id);
  });

  it("offers only Open for a finished task", async () => {
    const { node } = await chatWith((seeded) => [variant(seeded, 0, settled("completed"))]);
    await act(async () => node.querySelector<HTMLButtonElement>(".agent-step__more")!.click());
    expect(
      [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent),
    ).toEqual(["Open task"]);
  });
});

/** happy-dom has neither, and the routed shell measures its layout with both. */
function stubLayoutApis(): void {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(window, "matchMedia").mockImplementation((query) =>
    Object.assign(new EventTarget(), {
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
    }),
  );
}
