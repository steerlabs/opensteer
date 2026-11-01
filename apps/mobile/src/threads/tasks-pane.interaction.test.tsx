// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";

vi.mock("react-native-reanimated", async () => {
  const native = await import("react-native");
  const transition = { duration: () => transition, easing: () => transition };
  return {
    default: { FlatList: native.FlatList },
    LinearTransition: transition,
    Easing: { out: (value: unknown) => value, cubic: (value: number) => value },
    useReducedMotion: () => true,
  };
});
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
vi.mock("@opensteer/client/react", () => ({
  useHostSnapshot: (client: { getSnapshot: () => unknown }) => ({
    snapshot: client.getSnapshot(),
    loadError: null,
    reload: vi.fn(),
  }),
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios", Version: "26" },
  ActivityIndicator: () => <span>Loading</span>,
  FlatList: (props: {
    data: readonly unknown[];
    renderItem: (input: { item: unknown }) => ReactNode;
    ListFooterComponent?: ReactNode;
    ListHeaderComponent?: ReactNode;
  }) => (
    <div>
      {props.ListHeaderComponent}
      {props.data.map((item, index) => (
        <div key={index}>{props.renderItem({ item })}</div>
      ))}
      {props.ListFooterComponent}
    </div>
  ),
  Pressable: (props: { children?: ReactNode; onPress?: () => void; disabled?: boolean }) => (
    <button disabled={props.disabled} onClick={props.onPress}>
      {props.children}
    </button>
  ),
  RefreshControl: () => null,
  StyleSheet: { create: (styles: object) => styles, hairlineWidth: 1 },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../ui/primitives.js", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Notice: () => null,
  SecondaryButton: () => null,
  SectionLabel: () => null,
  StatusDot: () => null,
}));
vi.mock("../ui/screen.js", () => ({ useListContentInsets: () => ({ paddingHorizontal: 16 }) }));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("./task-row.js", () => ({
  setTaskDone: vi.fn(),
  TaskRowView: ({ row }: { row: { title: string } }) => <span data-task>{row.title}</span>,
  taskTextInset: 12,
  taskTime: () => "",
}));
vi.mock("../client/mobile-client.js", () => ({
  operationDetail: (_error: unknown, fallback: string) => fallback,
}));
import { TasksPane } from "./tasks-pane.js";

it("keeps search pagination available without claiming unread pages have no matches", async () => {
  const client = new MockHostClient({ latencyMs: 0 });
  const snapshot = client.getSnapshot();
  vi.spyOn(client, "getSnapshot").mockReturnValue({
    ...snapshot,
    session: "authenticated",
    tasks: {
      entries: [],
      window: { ...snapshot.workspaceWindow, hasMore: true, nextBefore: "more" },
    },
  });
  const loadMore = vi.spyOn(client, "loadEarlierTasks").mockResolvedValue();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <TasksPane
          deploymentId="test"
          hostClient={client}
          onOpenTask={() => undefined}
          onSignIn={async () => undefined}
          query="older task"
          workspaceId={null}
        />,
      ),
    );
    expect(container.textContent).toContain("No matches in loaded tasks");
    expect(container.textContent).not.toContain("No tasks match");
    const more = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Show more",
    );
    expect(more).toBeDefined();
    await act(async () => more?.click());
    expect(loadMore).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it("keeps asked order across metadata updates and retains the open Done task", async () => {
  const client = new MockHostClient({ latencyMs: 0 });
  const base = client.getSnapshot();
  const template = base.tasks!.entries.find(({ thread }) => thread.role === "work")!;
  const a = {
    ...template,
    thread: {
      ...template.thread,
      title: "Older",
      status: "idle" as const,
      doneAt: "2026-10-01T00:00:00Z",
      askedAt: "2026-10-01T00:00:00Z",
    },
  };
  const b = {
    ...a,
    thread: {
      ...a.thread,
      id: "thr_00000000-0000-4000-8000-000000009999",
      title: "Newer",
      doneAt: null,
      askedAt: "2026-10-02T00:00:00Z",
    },
  };
  let entries = [a, b];
  vi.spyOn(client, "getSnapshot").mockImplementation(() => ({
    ...base,
    activeTasks: [],
    threads: [],
    threadReadStates: {},
    tasks: { ...base.tasks!, entries },
  }));
  const node = document.createElement("div");
  const root = createRoot(node);
  const render = () =>
    root.render(
      <TasksPane
        deploymentId="test"
        hostClient={client}
        openThreadId={a.thread.id}
        query=""
        workspaceId={null}
        onOpenTask={() => {}}
        onSignIn={async () => {}}
      />,
    );
  try {
    await act(async () => render());
    expect([...node.querySelectorAll("[data-task]")].map((row) => row.textContent)).toEqual([
      "Newer",
      "Older",
    ]);
    entries = [{ ...a, thread: { ...a.thread, askedAt: "2026-10-03T00:00:00Z" } }, b];
    await act(async () => render());
    expect([...node.querySelectorAll("[data-task]")].map((row) => row.textContent)).toEqual([
      "Older",
      "Newer",
    ]);
    expect(node.textContent).not.toContain("Done");
  } finally {
    await act(async () => root.unmount());
    client.dispose();
  }
});
