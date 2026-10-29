// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
vi.mock("@opensteer/client/react", () => ({
  useHostSnapshot: (client: { getSnapshot: () => unknown }) => ({
    snapshot: client.getSnapshot(),
    loadError: null,
    reload: vi.fn(),
  }),
}));
vi.mock("react-native", () => ({
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
  TaskRowView: () => null,
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
