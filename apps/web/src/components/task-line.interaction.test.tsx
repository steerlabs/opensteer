// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AssignmentIdSchema,
  ThreadReadStateSchema,
  WaitingRequestSchema,
  createId,
  type AssignmentSummary,
  type WaitingRequest,
} from "@opensteer/core";
import type { AssignmentEntry, HostSnapshot, TranscriptEntry } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { AppShell } from "./app-shell.js";
import { HomeRoute } from "./home-view.js";
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
 * Chat with the tasks one of its turns handed out replaced by `tasks`, each
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
  const home = base.homeThreadId!;
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
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route element={<AppShell hostClient={client} loadError={null} />}>
              <Route index element={<HomeRoute />} />
              <Route path="threads/:threadId" element={<ThreadRoute />} />
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

const lines = (node: HTMLElement) => [...node.querySelectorAll<HTMLElement>(".task-line")];

// Ways a task's line can fail the reader: two states read alike, a working
// task stops showing it is moving (or one that is not pulses), a question
// waiting on the reader is not said where the task is, a failure reads as an
// ending like any other, or the line stops opening the task.
describe("a task's line in the conversation that handed it out", () => {
  it.each([
    ["working", { currentRunStatus: "running" as const }, "Working", "working", true],
    ["done", settled("completed"), "Finished", "completed", false],
    ["failed", settled("failed"), "Couldn’t finish", "failed", false],
    ["stopped", settled("cancelled"), "Stopped", "stopped", false],
  ] as const)(
    "reads a %s task as its word and dot alone",
    async (_, change, word, tone, moving) => {
      const { node } = await chatWith((seeded) => [variant(seeded, 0, change)]);
      const [line] = lines(node);
      expect(lines(node)).toHaveLength(1);
      expect(line!.dataset.tone).toBe(tone);
      expect(line!.querySelector(".task-line__state")?.textContent).toBe(word);
      const dot = line!.querySelector<HTMLElement>(".task-dot")!;
      expect(dot.dataset.tone).toBe(tone);
      expect(dot.dataset.moving === "true").toBe(moving);
      expect(line!.querySelector(".task-line__note")).toBeNull();
      // No card: the line is the task's mark, title and state, and it opens the task.
      const open = line!.querySelector<HTMLAnchorElement>("a.task-line__open")!;
      expect(open.querySelector(".task-mark")).not.toBeNull();
      expect(open.getAttribute("aria-label")).toMatch(/\. Open task$/u);
      const title = open.querySelector(".task-line__title")!.textContent!;
      await act(async () => open.click());
      expect(node.querySelector(".conv-header__name")?.textContent).toBe(title);
    },
  );

  it("keeps the line for a decision and asks its question under the title", async () => {
    const { node } = await chatWith(
      (seeded) => [variant(seeded, 0, { currentRunStatus: "waiting" })],
      ([task]) => [askingAbout(clients[0]!, task!, "Book the 7:00 PM table at Adda?")],
    );
    const [line] = lines(node);
    expect(line!.dataset.tone).toBe("waiting");
    expect(line!.querySelector(".task-line__state")?.textContent).toBe("Needs you");
    const note = line!.querySelector<HTMLElement>(".task-line__note")!;
    expect(note.dataset.kind).toBe("decision");
    expect(note.textContent).toBe("Book the 7:00 PM table at Adda?");
    // Answered where Chat docks its tasks' questions, not on the line.
    expect(line!.querySelectorAll("button:not(.task-line__more)")).toHaveLength(0);
    expect(line!.querySelector("a.task-line__open")?.getAttribute("aria-label")).toContain(
      "Book the 7:00 PM table at Adda?",
    );
  });
});

// Ways it can fail: tasks one turn handed out hide behind a count the reader
// has to open, one that needs the reader is not said on its own line, or a
// task that ends is announced twice or not at all.
describe("tasks one turn handed out together", () => {
  it("read as a line each, every one saying where it stands and opening its task", async () => {
    const { node } = await chatWith(
      (seeded) => [
        variant(seeded, 0, settled("completed")),
        variant(seeded, 1, { currentRunStatus: "waiting" }),
        variant(seeded, 2, { currentRunStatus: "running" }),
      ],
      ([, asking]) => [askingAbout(clients[0]!, asking!, "Which quarter should I use?")],
    );
    expect(lines(node).map((line) => line.querySelector(".task-line__state")?.textContent)).toEqual(
      ["Finished", "Needs you", "Working"],
    );
    expect(lines(node)[1]!.querySelector(".task-line__note")?.textContent).toBe(
      "Which quarter should I use?",
    );
    expect(node.querySelectorAll("a.task-line__open")).toHaveLength(3);
    expect(node.querySelector("button.task-line__open")).toBeNull();
  });

  it("says when one of them ends, once", async () => {
    const { node, tasks, update } = await chatWith((seeded) => [
      variant(seeded, 0, { currentRunStatus: "running" }),
      variant(seeded, 1, { currentRunStatus: "running" }),
    ]);
    const said = () =>
      [...node.querySelectorAll<HTMLElement>('.task-lines [role="status"]')]
        .map(({ textContent }) => textContent)
        .filter(Boolean);
    expect(said()).toEqual([]);
    await act(async () => update({ ...tasks[0]!, ...settled("failed") }));
    expect(said()).toEqual([expect.stringMatching(/: Couldn’t finish$/)]);
  });
});

// Ways the line's menu can fail: the quieter line loses the way to stop a
// task, Stop acts without asking, or a finished task still offers it.
describe("a task line's menu", () => {
  it("stops an open task from a right click, after asking once", async () => {
    const { client, node, tasks } = await chatWith((seeded) => [
      variant(seeded, 0, { currentRunStatus: "running" }),
    ]);
    const cancel = vi.spyOn(client, "cancelAssignment");
    const line = lines(node)[0]!;
    await act(async () =>
      line.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
    );
    expect(line.classList.contains("task-line--menu")).toBe(true);
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
    await act(async () => node.querySelector<HTMLButtonElement>(".task-line__more")!.click());
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

it("keeps an opened Done task in the sidebar and renders authoritative ask reorders", async () => {
  stubLayoutApis();
  const client = new MockHostClient({ latencyMs: 0 });
  clients.push(client);
  await client.load();
  const base = client.getSnapshot();
  const template = base.tasks!.entries.find(({ thread }) => thread.role === "work")!;
  const first = {
    ...template,
    thread: {
      ...template.thread,
      status: "idle" as const,
      title: "Read my result",
      doneAt: "2026-10-01T00:00:00Z",
      askedAt: "2026-10-01T00:00:00Z",
    },
  };
  const second = {
    ...first,
    thread: {
      ...first.thread,
      id: createId("thread"),
      title: "Another task",
      doneAt: null,
      askedAt: "2026-10-02T00:00:00Z",
    },
  };
  let current: HostSnapshot = {
    ...base,
    activeTasks: [],
    threads: [],
    tasks: { ...base.tasks!, entries: [first, second] },
    threadReadStates: {
      [first.thread.id]: ThreadReadStateSchema.parse({
        threadId: first.thread.id,
        readSequence: "0",
        unreadSequence: "1",
        asOfSequence: "1",
      }),
    },
  };
  vi.spyOn(client, "getSnapshot").mockImplementation(() => current);
  const listeners = new Set<() => void>();
  vi.spyOn(client, "subscribe").mockImplementation((listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  });
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  roots.push(root);
  await act(async () =>
    root.render(
      <ToastProvider>
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route element={<AppShell hostClient={client} loadError={null} />}>
              <Route index element={<div />} />
              <Route path="threads/:threadId" element={<div />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    ),
  );
  const taskRows = () => [
    ...node.querySelectorAll<HTMLElement>(".side-section--tasks [data-thread-id]"),
  ];
  expect(taskRows().map((row) => row.dataset.threadId)).toEqual([
    second.thread.id,
    first.thread.id,
  ]);
  await act(async () => taskRows()[1]!.querySelector<HTMLAnchorElement>("a")!.click());
  await act(async () => {
    current = { ...current, threadReadStates: {} };
    for (const listener of listeners) listener();
  });
  expect(taskRows().map((row) => row.dataset.threadId)).toEqual([
    second.thread.id,
    first.thread.id,
  ]);
  await act(async () => {
    current = {
      ...current,
      tasks: {
        ...current.tasks!,
        entries: [
          { ...first, thread: { ...first.thread, askedAt: "2026-10-03T00:00:00Z" } },
          second,
        ],
      },
    };
    for (const listener of listeners) listener();
  });
  expect(taskRows().map((row) => row.dataset.threadId)).toEqual([
    first.thread.id,
    second.thread.id,
  ]);
});
