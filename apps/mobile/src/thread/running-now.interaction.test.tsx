// @vitest-environment happy-dom

import type { HostClient, HostSnapshot, NodeEntry } from "@opensteer/client/host";
import { MockHostClient, type MockSubagentScene } from "@opensteer/client/mock";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * Running now on a phone: a capsule over the composer while anything works
 * for the conversation, opening a sheet that lists each one. What can go
 * wrong: the capsule stays after the last one settles, or appears with
 * nothing running; the sheet offers Stop where the engine can't stop one, or
 * on a question; a row opens inside the sheet instead of over the
 * conversation; the sheet stays open and empty once nothing runs; iOS loses
 * its Done, or Android draws one where system back is the way out.
 */

const harness = vi.hoisted(() => ({
  dispatch: vi.fn(),
  goBack: vi.fn(),
  hostClient: null as HostClient | null,
  os: "ios" as "ios" | "android",
}));

vi.mock("./settings/engine-mark.js", () => ({
  EngineMark: ({ driverKind }: { driverKind: string }) => <i data-engine={driverKind} />,
}));
vi.mock("../ui/task-mark.js", () => ({ TaskMark: () => <i data-task-mark /> }));
vi.mock("react-native", () => {
  type Children = { readonly children?: ReactNode };
  return {
    ActivityIndicator: () => <i data-spinner />,
    Alert: { alert: vi.fn() },
    FlatList: (props: {
      readonly data: readonly unknown[];
      readonly keyExtractor: (item: never) => string;
      readonly ListHeaderComponent?: ReactNode;
      readonly renderItem: (info: { item: never; index: number }) => ReactNode;
    }) => (
      <div>
        {props.ListHeaderComponent}
        {props.data.map((item, index) => (
          <div key={props.keyExtractor(item as never)}>
            {props.renderItem({ index, item: item as never })}
          </div>
        ))}
      </div>
    ),
    Keyboard: { dismiss: vi.fn() },
    get Platform() {
      return { OS: harness.os };
    },
    Pressable: (props: {
      readonly accessibilityLabel?: string;
      readonly children?: ReactNode | ((state: { pressed: boolean }) => ReactNode);
      readonly onPress?: () => void;
    }) => (
      <button aria-label={props.accessibilityLabel} onClick={props.onPress}>
        {typeof props.children === "function" ? props.children({ pressed: false }) : props.children}
      </button>
    ),
    StyleSheet: { create: (styles: object) => styles, hairlineWidth: 1 },
    View: (props: Children & { readonly accessibilityLabel?: string }) => (
      <div aria-label={props.accessibilityLabel}>{props.children}</div>
    ),
    useWindowDimensions: () => ({ fontScale: 1, height: 844, width: 390 }),
  };
});
vi.mock("react-native-reanimated", () => ({
  default: { View: ({ children }: { children?: ReactNode }) => <div>{children}</div> },
  LayoutAnimationConfig: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("../ui/motion.js", () => ({ appear: undefined, enter: undefined, exit: undefined }));
vi.mock("../ui/primitives.js", () => ({
  AppText: ({ children }: { readonly children?: ReactNode }) => <span>{children}</span>,
  StatusDot: (props: { readonly tone: string }) => <i data-dot={props.tone} />,
  monoFontFamily: "monospace",
}));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("../ui/glass.js", () => ({
  GlassSurface: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../ui/keyboard.js", () => ({ useKeyboardVisible: () => false }));
vi.mock("../ui/action-review.js", () => ({ ActionReviewSheet: () => null }));
vi.mock("../client/mobile-client.js", () => ({
  operationDetail: (_error: unknown, fallback: string) => fallback,
}));
vi.mock("../ui/mobile-client-context.js", () => ({
  useMobileState: () => ({ selection: { deploymentId, hostClient: harness.hostClient } }),
}));
vi.mock("../ui/screen.js", () => ({ useGutter: () => 16 }));
vi.mock("../ui/pane.js", () => ({
  useContentInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));
vi.mock("@react-navigation/native", () => ({
  StackActions: { push: (name: string, params: object) => ({ name, params, type: "PUSH" }) },
  useNavigation: () => ({
    dispatch: harness.dispatch,
    goBack: harness.goBack,
    isFocused: () => true,
  }),
}));

const deploymentId = "deployment_running_now";
const { RunningNowCapsule } = await import("./running-now.js");
const { RunningNowScreen } = await import("../screens/running-now.js");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
const clients: MockHostClient[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const client of clients.splice(0)) client.dispose();
  document.body.replaceChildren();
  harness.dispatch.mockReset();
  harness.goBack.mockReset();
  harness.os = "ios";
});

/** A scene's conversation on a Host the test moves by hand. */
async function scene(name: MockSubagentScene) {
  const client = new MockHostClient({ latencyMs: 0, places: "absent", subagents: name });
  clients.push(client);
  await client.load();
  let current: HostSnapshot = { ...client.getSnapshot(), connection: "connected" };
  const thread = current.threads.find(({ title }) => title === "Fix checkout on mobile")!;
  const listeners = new Set<() => void>();
  const hostClient = {
    ...client,
    getSnapshot: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as HostClient;
  harness.hostClient = hostClient;
  const move = (next: HostSnapshot) => {
    current = next;
    act(() => {
      for (const listener of listeners) listener();
    });
  };
  /** Every subagent settles: nothing runs any more. */
  const settle = () =>
    move({
      ...current,
      transcripts: {
        ...current.transcripts,
        [thread.id]: (current.transcripts[thread.id] ?? []).map((entry) =>
          entry.kind === "node" && entry.status === "running"
            ? ({ ...entry, completedAt: entry.createdAt, status: "completed" } satisfies NodeEntry)
            : entry,
        ),
      },
    });
  const node = (title: string) =>
    (current.transcripts[thread.id] ?? []).find(
      (entry): entry is NodeEntry => entry.kind === "node" && entry.title === title,
    )!;
  return { hostClient, move, node, settle, snapshot: () => current, threadId: thread.id };
}

function render(element: ReactNode): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(element));
  return container;
}

const labels = (container: HTMLElement) =>
  [...container.querySelectorAll("button[aria-label]")].map((button) =>
    button.getAttribute("aria-label")!,
  );

describe("Running now on a phone", () => {
  it("stands over the composer only while something runs, and opens the list", async () => {
    const { hostClient, settle, threadId } = await scene("three");
    const onOpen = vi.fn();
    const container = render(
      <RunningNowCapsule hostClient={hostClient} onOpen={onOpen} reachable threadId={threadId} />,
    );
    const capsule = container.querySelector<HTMLButtonElement>("button")!;
    expect(capsule.getAttribute("aria-label")).toBe(
      "Running now: 2 subagents working. Show the list",
    );
    act(() => capsule.click());
    expect(onOpen).toHaveBeenCalledOnce();
    settle();
    expect(container.querySelector("button")).toBeNull();
  });

  it("says one needs the reader, and never offers Stop on a question", async () => {
    const { hostClient, threadId } = await scene("needs");
    const capsule = render(
      <RunningNowCapsule
        hostClient={hostClient}
        onOpen={() => undefined}
        reachable
        threadId={threadId}
      />,
    );
    expect(labels(capsule)[0]).toMatch(/^Running now: \d subagents, 2 need you/u);
    const sheet = render(<RunningNowScreen route={{ params: { deploymentId, threadId } }} />);
    const audit = labels(sheet).find((label) => label.startsWith("Subagent Audit mobile CSS"))!;
    expect(audit).toMatch(/, Needs you, /u);
    expect(sheet.textContent).toContain("Waiting for your answer");
    expect(sheet.textContent).not.toContain("Change the shared Button");
    expect(labels(sheet)).not.toContain(
      "Stop Audit mobile CSS for every breakpoint across cart, checkout and the order summary drawer",
    );
  });

  it("lists each one with Stop where its engine allows, opening it over the conversation", async () => {
    const { node, threadId } = await scene("three");
    const container = render(<RunningNowScreen route={{ params: { deploymentId, threadId } }} />);
    const rows = labels(container).filter((label) => label.startsWith("Subagent "));
    expect(rows.map((label) => /^Subagent (.+), Working, /u.exec(label)?.[1])).toEqual([
      "Trace the payment flow",
      "Audit mobile CSS for every breakpoint across cart, checkout and the order summary drawer",
    ]);
    expect(labels(container)).toContain("Stop Trace the payment flow");
    expect(container.textContent).toContain("Checking the Stripe confirm call");
    act(() =>
      container.querySelector<HTMLButtonElement>(`button[aria-label="${rows[0]}"]`)!.click(),
    );
    expect(harness.goBack).toHaveBeenCalledOnce();
    expect(harness.dispatch).toHaveBeenCalledExactlyOnceWith({
      name: "Subagent",
      params: { deploymentId, nodeId: node("Trace the payment flow").nodeId, threadId },
      type: "PUSH",
    });
  });

  it("closes itself once nothing runs", async () => {
    const { settle, threadId } = await scene("three");
    render(<RunningNowScreen route={{ params: { deploymentId, threadId } }} />);
    expect(harness.goBack).not.toHaveBeenCalled();
    settle();
    expect(harness.goBack).toHaveBeenCalledOnce();
  });

  it("offers Done on iOS, and leaves closing to system back on Android", async () => {
    const { threadId } = await scene("three");
    expect(
      render(<RunningNowScreen route={{ params: { deploymentId, threadId } }} />).textContent,
    ).toContain("Done");
    harness.os = "android";
    expect(
      render(<RunningNowScreen route={{ params: { deploymentId, threadId } }} />).textContent,
    ).not.toContain("Done");
  });

  it("says what was last known, with no Stop, while the computer is out of reach", async () => {
    const { move, snapshot, threadId } = await scene("three");
    move({ ...snapshot(), connection: "offline" });
    const container = render(<RunningNowScreen route={{ params: { deploymentId, threadId } }} />);
    expect(container.textContent).toContain("Last known");
    expect(labels(container).filter((label) => label.startsWith("Stop "))).toEqual([]);
  });
});
