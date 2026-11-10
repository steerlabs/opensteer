// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { AccessibilityInfo } from "react-native";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AssignmentIdSchema,
  WaitingRequestSchema,
  createId,
  type AssignmentSummary,
  type WaitingRequest,
} from "@opensteer/core";
import type { ActionReview, AssignmentEntry, HostSnapshot } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";

vi.mock("react-native", () => {
  type Children = { readonly children?: ReactNode };
  return {
    Platform: { OS: "ios", Version: "26" },
    AccessibilityInfo: { announceForAccessibility: vi.fn() },
    Alert: { alert: vi.fn() },
    FlatList: () => null,
    useWindowDimensions: () => ({ fontScale: 1, height: 844, scale: 3, width: 390 }),
    Pressable: (
      props: Children & {
        readonly accessibilityLabel?: string;
        readonly accessibilityState?: { readonly expanded?: boolean };
        readonly onPress?: () => void;
      },
    ) => (
      <button
        aria-expanded={props.accessibilityState?.expanded}
        aria-label={props.accessibilityLabel}
        onClick={props.onPress}
      >
        {props.children}
      </button>
    ),
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
    View: ({ children }: Children) => <div>{children}</div>,
  };
});
vi.mock("react-native-reanimated", () => ({
  default: { View: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div> },
  LayoutAnimationConfig: ({ children }: { readonly children?: ReactNode }) => <>{children}</>,
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaFrame: () => ({ height: 844, width: 390, x: 0, y: 0 }),
}));
vi.mock("../ui/motion.js", () => ({
  appear: undefined,
  enter: undefined,
  exit: undefined,
  move: undefined,
}));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: (props: {
    readonly children?: ReactNode;
    readonly actions: readonly { id: string; title: string }[];
    readonly onPressAction?: (event: { nativeEvent: { event: string } }) => void;
  }) => (
    <div>
      {props.children}
      {props.actions.map((action) => (
        <button
          data-menu-action={action.id}
          key={action.id}
          onClick={() => props.onPressAction?.({ nativeEvent: { event: action.id } })}
        >
          {action.title}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("../ui/primitives.js", () => ({
  AppText: ({ children }: { readonly children?: ReactNode }) => <span>{children}</span>,
  StatusDot: (props: {
    readonly live?: boolean;
    readonly ring?: boolean;
    readonly size?: number;
    readonly tone: string;
  }) => (
    <i
      data-dot={props.tone}
      data-live={props.live === true}
      data-ring={props.ring === true}
      data-size={props.size}
    />
  ),
}));
vi.mock("../ui/action-review.js", () => ({
  ActionReviewSheet: (props: {
    readonly review: ActionReview | null;
    readonly confirmLabel: string;
  }) =>
    props.review === null ? null : (
      <button data-confirm onClick={() => void props.review?.confirm()}>
        {props.confirmLabel}
      </button>
    ),
}));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("../ui/task-mark.js", () => ({
  TaskMark: ({ mark }: { readonly mark: { icon: string } }) => <i data-task-icon={mark.icon} />,
}));
vi.mock("../client/mobile-client.js", () => ({
  operationDetail: (_error: unknown, fallback: string) => fallback,
}));

const { TaskCards, TaskScopeContext } = await import("./task-line.js");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
const clients: MockHostClient[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const client of clients.splice(0)) client.dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

/** The Host's tasks with `tasks` in place of its first, and `waiting` on the reader. */
async function linesFor(
  tasks: (seeded: AssignmentSummary) => readonly AssignmentSummary[],
  waiting: (
    client: MockHostClient,
    tasks: readonly AssignmentSummary[],
  ) => WaitingRequest[] = () => [],
) {
  const client = new MockHostClient({ latencyMs: 0 });
  clients.push(client);
  await client.load();
  const base = client.getSnapshot();
  const seeded = Object.values(base.assignments).find(({ status }) => status === "open")!;
  const made = tasks(seeded);
  const snapshot: HostSnapshot = {
    ...base,
    assignments: Object.fromEntries(made.map((assignment) => [assignment.id, assignment])),
    connection: "connected",
    waitingRequests: waiting(client, made),
  };
  const read = vi.spyOn(client, "getSnapshot").mockReturnValue(snapshot);
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
  let current = snapshot;
  const update = (changed: AssignmentSummary) => {
    current = { ...current, assignments: { ...current.assignments, [changed.id]: changed } };
    read.mockReturnValue(current);
    for (const listener of listeners) listener();
  };
  const onViewWork = vi.fn();
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  roots.push(root);
  const entries: AssignmentEntry[] = made.map((assignment) => ({
    assignment,
    createdAt: assignment.createdAt,
    id: `assignment:${assignment.id}`,
    kind: "assignment",
    runId: "run_turn",
  }));
  await act(async () =>
    root.render(
      <TaskScopeContext
        value={{
          focused: true,
          hostClient: client,
          onOpenSubagent: () => undefined,
          onViewWork,
          threadId: made[0]!.parentThreadId,
        }}
      >
        <TaskCards entries={entries} live />
      </TaskScopeContext>,
    ),
  );
  return { client, node, onViewWork, tasks: made, update };
}

function variant(
  seeded: AssignmentSummary,
  index: number,
  change: Partial<AssignmentSummary>,
): AssignmentSummary {
  return {
    ...seeded,
    id: index === 0 ? seeded.id : AssignmentIdSchema.parse(createId("delegation")),
    // Nothing asked of anybody unless a test says so.
    workerThread: { ...seeded.workerThread, pendingRequests: 0 },
    ...change,
  };
}

const settled = (status: AssignmentSummary["status"]): Partial<AssignmentSummary> => ({
  currentRunStatus: status === "failed" ? "failed" : "completed",
  finishedAt: "2026-10-25T10:05:00Z",
  status,
});

function asking(client: MockHostClient, task: AssignmentSummary, title: string): WaitingRequest {
  const pending = Object.values(client.getSnapshot().requests)
    .flat()
    .find((request) => request.status === "pending")!;
  return WaitingRequestSchema.parse({
    assignments: [
      {
        id: task.id,
        parentThreadId: task.parentThreadId,
        workerThread: { id: task.workerThread.id, title: task.workerThread.title },
      },
    ],
    request: {
      ...pending,
      originatingThreadId: task.workerThread.id,
      presentation: { ...pending.presentation, title },
    },
  });
}

const card = (node: HTMLElement) =>
  node.querySelector<HTMLButtonElement>('button[aria-label$="Open task"]')!;

// Ways a task's card can fail on a phone: two states read alike or by colour
// alone, a working task stops breathing (or a settled one keeps on), the
// question it waits on is not said on it, or a tap no longer opens the task.
describe("a task's card on a phone", () => {
  it.each([
    ["working", { currentRunStatus: "running" as const }, "Working", "ember", true, false],
    ["done", settled("completed"), "Finished", "muted", false, false],
    ["failed", settled("failed"), "Couldn’t finish", "red", false, false],
    ["stopped", settled("cancelled"), "Stopped", "muted", false, true],
  ] as const)(
    "reads a %s task by its word and dot, and opens it",
    async (_, change, word, dot, live, ring) => {
      const { node, onViewWork, tasks } = await linesFor((seeded) => [variant(seeded, 0, change)]);
      const open = card(node);
      expect(open.getAttribute("aria-label")).toBe(
        `${tasks[0]!.workerThread.title}, Opensteer, task, ${word}. Open task`,
      );
      expect(open.textContent).toContain(`Task${word}`);
      const shown = open.querySelector<HTMLElement>("[data-dot]")!;
      expect([shown.dataset.dot, shown.dataset.live, shown.dataset.ring]).toEqual([
        dot,
        String(live),
        String(ring),
      ]);
      await act(async () => open.click());
      expect(onViewWork).toHaveBeenCalledExactlyOnceWith(tasks[0]!.workerThread.id);
    },
  );

  it("says the question it waits on as its one line", async () => {
    const { node } = await linesFor(
      (seeded) => [variant(seeded, 0, { currentRunStatus: "waiting" })],
      (client, [task]) => [asking(client, task!, "Book the 7:00 PM table at Adda?")],
    );
    const open = card(node);
    expect(open.querySelector<HTMLElement>("[data-dot]")?.dataset.dot).toBe("amber");
    expect(open.textContent).toContain("Needs you");
    expect(open.textContent?.endsWith("Book the 7:00 PM table at Adda?")).toBe(true);
  });

  it("stops an open task from its long-press menu, after asking", async () => {
    const { client, node, tasks } = await linesFor((seeded) => [
      variant(seeded, 0, { currentRunStatus: "running" }),
    ]);
    const cancel = vi
      .spyOn(client, "cancelAssignment")
      .mockResolvedValue({ ...tasks[0]!, status: "cancelled" });
    await act(async () =>
      node.querySelector<HTMLButtonElement>('[data-menu-action="stop"]')!.click(),
    );
    expect(cancel).not.toHaveBeenCalled();
    await act(async () => node.querySelector<HTMLButtonElement>("[data-confirm]")!.click());
    expect(cancel).toHaveBeenCalledExactlyOnceWith(tasks[0]!.id);
  });
});

// Ways a group can fail on a phone: its count disagrees with its cards, a
// live group hides its members behind a tap, one that needs the reader is not
// said, or a task that ends is announced twice or not at all.
describe("tasks one turn handed out together, on a phone", () => {
  it("share a group that counts them and stands open while any is live", async () => {
    const { node } = await linesFor(
      (seeded) => [
        variant(seeded, 0, settled("completed")),
        variant(seeded, 1, { currentRunStatus: "waiting" }),
        variant(seeded, 2, { currentRunStatus: "running" }),
      ],
      (client, [, task]) => [asking(client, task!, "Which quarter should I use?")],
    );
    const head = node.querySelector("button[aria-expanded]")!;
    expect(head.getAttribute("aria-label")).toBe("3 tasks · 1 needs you · 1 working · 1 finished");
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(node.querySelectorAll('[data-menu-action="open"]')).toHaveLength(3);
    expect(
      [...node.querySelectorAll('button[aria-label$="Open task"]')].map((line) =>
        line.getAttribute("aria-label"),
      ),
    ).toEqual([
      expect.stringMatching(/, task, Finished\. Open task$/u),
      expect.stringMatching(/, task, Needs you\. Open task$/u),
      expect.stringMatching(/, task, Working\. Open task$/u),
    ]);
  });

  it("start closed once all are settled, and open on a tap", async () => {
    const { node } = await linesFor((seeded) => [
      variant(seeded, 0, settled("completed")),
      variant(seeded, 1, settled("failed")),
    ]);
    const head = node.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    expect(head.getAttribute("aria-label")).toBe("2 tasks · 1 finished · 1 failed");
    expect(node.querySelectorAll('button[aria-label$="Open task"]')).toHaveLength(0);
    await act(async () => head.click());
    expect(node.querySelectorAll('button[aria-label$="Open task"]')).toHaveLength(2);
  });

  it("says when one of them ends, once", async () => {
    const { tasks, update } = await linesFor((seeded) => [
      variant(seeded, 0, { currentRunStatus: "running" }),
      variant(seeded, 1, { currentRunStatus: "running" }),
    ]);
    const announce = vi.mocked(AccessibilityInfo.announceForAccessibility);
    announce.mockClear();
    await act(async () => update({ ...tasks[0]!, ...settled("failed") }));
    expect(announce.mock.calls).toEqual([[expect.stringMatching(/: Couldn’t finish$/)]]);
  });
});
