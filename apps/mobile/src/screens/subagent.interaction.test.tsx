// @vitest-environment happy-dom

import type {
  HostClient,
  HostSnapshot,
  NodeDetailSnapshot,
  NodeEntry,
} from "@opensteer/client/host";
import { MockHostClient, type MockSubagentScene } from "@opensteer/client/mock";
import { harnessCatalogEntry } from "@opensteer/core";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * An opened subagent on a phone, pushed over its conversation. What can go
 * wrong: the footer offers a composer, or Stop where the engine can't stop
 * one without saying why; it names the wrong parent; the sibling hop pushes
 * a pile of screens instead of hopping in place; the way up to a subagent
 * already below pushes a second copy; its own question is missing, or names
 * the asker it already is; one that is gone leaves a blank screen.
 */

const harness = vi.hoisted(() => ({
  dispatch: vi.fn(),
  hostClient: null as HostClient | null,
  options: {} as Record<string, unknown>,
  routes: [] as { name: string; params: object }[],
  watch: null as NodeDetailSnapshot | null,
}));

vi.mock("../thread/settings/engine-mark.js", () => ({ EngineMark: () => null }));
vi.mock("../ui/task-mark.js", () => ({ TaskMark: () => null }));
vi.mock("react-native", () => {
  type Children = { readonly children?: ReactNode };
  return {
    ActivityIndicator: () => <i data-spinner />,
    Alert: { alert: vi.fn() },
    FlatList: () => null,
    Platform: { OS: "ios" },
    Pressable: (props: {
      readonly accessibilityLabel?: string;
      readonly children?: ReactNode | ((state: { pressed: boolean }) => ReactNode);
      readonly disabled?: boolean;
      readonly onPress?: () => void;
    }) => (
      <button
        aria-label={props.accessibilityLabel}
        disabled={props.disabled}
        onClick={props.onPress}
      >
        {typeof props.children === "function" ? props.children({ pressed: false }) : props.children}
      </button>
    ),
    ScrollView: ({ children }: Children) => <div>{children}</div>,
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
  StatusDot: () => null,
  monoFontFamily: "monospace",
}));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("../ui/glass.js", () => ({ useLiquidGlass: () => false }));
vi.mock("../ui/action-review.js", () => ({ ActionReviewSheet: () => null }));
vi.mock("../ui/foreground.js", () => ({ useAppForeground: () => true }));
vi.mock("../ui/screen.js", () => ({
  Screen: ({ children }: { children?: ReactNode }) => <main>{children}</main>,
  useGutter: () => 16,
  useReadingColumn: () => null,
}));
vi.mock("../ui/pane.js", () => ({
  useContentInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));
vi.mock("../ui/mobile-client-context.js", () => ({
  useMobileClient: () => ({ drafts: {} }),
}));
vi.mock("../client/mobile-client.js", () => ({
  operationDetail: (_error: unknown, fallback: string) => fallback,
}));
vi.mock("../markdown/markdown.js", () => ({
  Markdown: ({ text }: { readonly text: string }) => <p>{text}</p>,
}));
vi.mock("../thread/around-button.js", () => ({ barOverContentOptions: () => ({}) }));
vi.mock("../thread/answer-pill.js", () => ({
  AnswerPill: (props: {
    readonly accessibilityLabel?: string;
    readonly label: string;
    readonly onPress: () => void;
  }) => (
    <button aria-label={props.accessibilityLabel ?? props.label} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../thread/composer-dock.js", () => ({
  ComposerDockLayout: (props: {
    readonly children: (clearance: number) => ReactNode;
    readonly dock: ReactNode;
  }) => (
    <>
      {props.children(0)}
      <footer>{props.dock}</footer>
    </>
  ),
}));
vi.mock("../thread/transcript.js", () => ({ SubagentSteps: () => <section data-steps /> }));
vi.mock("../thread/waiting-questions.js", () => ({
  QuestionCard: (props: {
    readonly asker?: boolean;
    readonly surface: { request: { id: string } };
  }) => <aside data-asker={String(props.asker)} data-request={props.surface.request.id} />,
}));
vi.mock("../thread/node-watch.js", () => ({
  useNodeWatch: () => ({ snapshot: harness.watch, unreachable: false, watch: null }),
}));
vi.mock("./deployment-gate.js", () => ({
  DeploymentGate: () => null,
  useAttachedHost: () => harness.hostClient,
}));
vi.mock("@react-navigation/elements", () => ({ useHeaderHeight: () => 0 }));
vi.mock("@react-navigation/native", () => ({
  StackActions: {
    pop: (count: number) => ({ payload: { count }, type: "POP" }),
    popTo: (name: string, params: object) => ({ name, params, type: "POP_TO" }),
    push: (name: string, params: object) => ({ name, params, type: "PUSH" }),
    replace: (name: string, params: object) => ({ name, params, type: "REPLACE" }),
  },
  useIsFocused: () => true,
  useNavigation: () => ({
    dispatch: harness.dispatch,
    getState: () => ({ index: harness.routes.length - 1, routes: harness.routes }),
    navigate: vi.fn(),
    setOptions: (options: Record<string, unknown>) => Object.assign(harness.options, options),
  }),
  useNavigationState: () => false,
}));

const deploymentId = "deployment_subagent";
const { SubagentScreen } = await import("./subagent.js");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
const clients: MockHostClient[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const client of clients.splice(0)) client.dispose();
  document.body.replaceChildren();
  harness.dispatch.mockReset();
  harness.options = {};
  harness.routes = [];
  harness.watch = null;
});

async function scene(name: MockSubagentScene) {
  const client = new MockHostClient({ latencyMs: 0, places: "absent", subagents: name });
  clients.push(client);
  await client.load();
  const current: HostSnapshot = { ...client.getSnapshot(), connection: "connected" };
  const thread = current.threads.find(({ title }) => title === "Fix checkout on mobile")!;
  harness.hostClient = {
    ...client,
    getSnapshot: () => current,
    subscribe: () => () => undefined,
  } as unknown as HostClient;
  const node = (title: string) =>
    (current.transcripts[thread.id] ?? []).find(
      (entry): entry is NodeEntry => entry.kind === "node" && entry.title === title,
    )!;
  const engine = current.harnesses.find(({ id }) => id === thread.harnessInstanceId)!.driverKind;
  return { engine, node, threadId: thread.id };
}

function open(
  threadId: string,
  nodeId: string,
  status: NodeDetailSnapshot["status"] = "ready",
): HTMLElement {
  harness.routes = [
    ...harness.routes,
    { name: "Subagent", params: { deploymentId, nodeId, threadId } },
  ];
  harness.watch = {
    entries: [],
    error: null,
    hasMore: false,
    loadingOlder: false,
    node: null,
    nodeId,
    status,
    threadId,
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<SubagentScreen route={{ params: { deploymentId, nodeId, threadId } }} />));
  return container;
}

/** The bar's own controls, drawn as the navigator would draw them. */
function headerRight(): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const draw = harness.options["headerRight"] as () => ReactNode;
  act(() => root.render(<>{draw()}</>));
  return container;
}

const button = (container: HTMLElement, label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

describe("an opened subagent on a phone", () => {
  it("says it can be watched, not messaged, with Stop beside it, and hops between its siblings", async () => {
    const { node, threadId } = await scene("three");
    const trace = node("Trace the payment flow");
    const container = open(threadId, trace.nodeId);
    const footer = container.querySelector("footer")!;
    expect(footer.textContent).toContain(
      "A subagent reports to Fix checkout on mobile. You can watch it, not message it.",
    );
    expect(button(footer, "Stop Trace the payment flow")).not.toBeNull();
    expect(container.textContent).toContain("Asked to");
    expect(container.textContent).toContain("Follow a tap on Pay");
    expect(harness.options["title"]).toBe("Trace the payment flow");

    const hop = headerRight();
    expect(hop.textContent).toContain("1/3");
    expect(button(hop, "Previous subagent").disabled).toBe(true);
    act(() => button(hop, "Next subagent").click());
    expect(harness.dispatch).toHaveBeenCalledExactlyOnceWith({
      name: "Subagent",
      params: {
        deploymentId,
        nodeId: node(
          "Audit mobile CSS for every breakpoint across cart, checkout and the order summary drawer",
        ).nodeId,
        threadId,
      },
      type: "REPLACE",
    });
  });

  it("names the subagent above a nested one, says why it has no Stop, and goes back up the stack", async () => {
    const { engine, node, threadId } = await scene("nested");
    const parent = node("Trace the payment flow");
    harness.routes = [
      { name: "Thread", params: { deploymentId, threadId } },
      { name: "Subagent", params: { deploymentId, nodeId: parent.nodeId, threadId } },
    ];
    const container = open(threadId, node("Check webhook retries").nodeId);
    const footer = container.querySelector("footer")!;
    expect(footer.textContent).toContain("A subagent reports to Trace the payment flow.");
    expect(footer.textContent).toContain(
      `${harnessCatalogEntry(engine)!.label} can't stop one subagent; it stops with its turn.`,
    );
    expect(footer.querySelector("button")).toBeNull();
    expect(headerRight().textContent).toContain("1/2");

    act(() => button(container, "Trace the payment flow").click());
    expect(harness.dispatch).toHaveBeenLastCalledWith({ payload: { count: 1 }, type: "POP" });
    act(() => button(container, "Started by Fix checkout on mobile").click());
    expect(harness.dispatch).toHaveBeenLastCalledWith({ payload: { count: 2 }, type: "POP" });
  });

  it("holds its own question in the composer's place, without naming itself as the asker", async () => {
    const { node, threadId } = await scene("needs");
    const container = open(
      threadId,
      node(
        "Audit mobile CSS for every breakpoint across cart, checkout and the order summary drawer",
      ).nodeId,
    );
    const question = container.querySelector<HTMLElement>("footer aside")!;
    expect(question.dataset.asker).toBe("false");
    expect(container.querySelector("footer")!.textContent).toContain(
      "You can watch it, not message it.",
    );
  });

  it("shows a failed subagent's whole report under how it ended, not the row's excerpt", async () => {
    const { node, threadId } = await scene("finished");
    const failed = node("Inspect the old checkout");
    const report = `Couldn't read apps/legacy-checkout. ${"The import chain stops at the vendored SDK. ".repeat(10)}End of report.`;
    Object.assign(failed, { result: report });
    const container = open(threadId, failed.nodeId);
    expect(container.textContent).toContain("What happened");
    expect(container.textContent).toContain("Couldn't finish.");
    expect(container.textContent).toContain("End of report.");
  });

  it("says one that is gone can't be shown, and leads back to the conversation", async () => {
    const { threadId } = await scene("three");
    harness.routes = [{ name: "Thread", params: { deploymentId, threadId } }];
    const container = open(threadId, "node_gone", "closed");
    expect(container.textContent).toContain("This subagent can't be shown");
    act(() => button(container, "Back to Fix checkout on mobile").click());
    expect(harness.dispatch).toHaveBeenLastCalledWith({ payload: { count: 1 }, type: "POP" });
  });
});
