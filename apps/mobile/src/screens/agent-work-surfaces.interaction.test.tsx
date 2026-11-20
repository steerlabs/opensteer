// @vitest-environment happy-dom
import { MockHostClient, mockConnectedAgents } from "@opensteer/client/mock";
import { taskList, type PlaceAgents, type TaskRow } from "@opensteer/client/host";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ client: null as unknown, navigate: vi.fn() }));

vi.mock("react-native", () => ({
  AccessibilityInfo: { announceForAccessibility: vi.fn(async () => undefined) },
  ActivityIndicator: () => <span>Spinner</span>,
  Alert: { alert: vi.fn() },
  AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: "active" },
  Platform: { OS: "ios", Version: "26", select: (options: { ios?: unknown }) => options.ios },
  PixelRatio: { get: () => 2, getFontScale: () => 1, roundToNearestPixel: (n: number) => n },
  Pressable: (props: {
    accessibilityLabel?: string;
    children?: ReactNode | ((state: { pressed: boolean }) => ReactNode);
    onPress?: () => void;
  }) => (
    <button aria-label={props.accessibilityLabel} onClick={props.onPress}>
      {typeof props.children === "function" ? props.children({ pressed: false }) : props.children}
    </button>
  ),
  ScrollView: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  StyleSheet: { create: (styles: object) => styles, hairlineWidth: 1, flatten: (s: unknown) => s },
  View: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  useWindowDimensions: () => ({ fontScale: 1, height: 800, width: 390 }),
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: (props: { children?: ReactNode }) => <div>{props.children}</div> },
  LayoutAnimationConfig: (props: { children?: ReactNode }) => props.children,
  useReducedMotion: () => true,
}));
vi.mock("expo-haptics", () => ({
  ImpactFeedbackStyle: { Heavy: "heavy" },
  NotificationFeedbackType: { Error: "error", Success: "success", Warning: "warning" },
  impactAsync: vi.fn(async () => undefined),
  notificationAsync: vi.fn(async () => undefined),
}));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: (props: { children?: ReactNode }) => props.children,
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: state.navigate }),
}));
vi.mock("./deployment-gate.js", () => ({
  DeploymentGate: () => null,
  useAttachedHost: () => state.client,
}));
vi.mock("../ui/mobile-client-context.js", async (load) => ({
  ...(await load<typeof import("../ui/mobile-client-context.js")>()),
  useSelectedHostClient: () => state.client,
}));
vi.mock("../ui/connection-live.js", () => ({ useShowsLive: () => true }));
vi.mock(
  "../ui/action-line.js",
  async () => (await import("../../test-support/action-line-mocks.js")).actionLine,
);
vi.mock(
  "../ui/placeholder.js",
  async () => (await import("../../test-support/action-line-mocks.js")).placeholder,
);
vi.mock("../ui/primitives.js", () => ({
  AppText: (props: { children?: ReactNode }) => <span>{props.children}</span>,
  StatusDot: () => null,
}));
vi.mock("../ui/screen.js", () => ({
  Screen: (props: { children?: ReactNode }) => <main>{props.children}</main>,
}));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("../ui/task-mark.js", () => ({ TaskMark: () => <i data-mark="task" /> }));
vi.mock("./external-agent-mark.js", () => ({
  ExternalAgentMark: (props: { providerId: string | null; initial?: string }) => (
    <i data-mark={props.providerId ?? props.initial} />
  ),
}));
vi.mock("../ui/composer-action.js", () => ({
  ComposerAction: (props: { label: string; onPress: () => void }) => (
    <button aria-label={props.label} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../thread/answer-pill.js", () => ({ AnswerPill: () => null }));
vi.mock("../browser/agent-marks.js", () => ({ AgentMarks: () => null }));
vi.mock("../thread/task-status.js", () => ({ taskHeading: () => null }));

const { NeedsYouScreen } = await import("./needs-you.js");
const { usePlaceStatusRow } = await import("../browser/place-status.js");
const { TaskRowView } = await import("../threads/task-row.js");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let host: MockHostClient | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.dispose();
  document.body.replaceChildren();
});

function seeded() {
  host = new MockHostClient({
    latencyMs: 0,
    connections: mockConnectedAgents("seeded").connections,
  });
  host.mockAgentWork();
  state.client = host;
  return host;
}
const idOf = (client: MockHostClient, title: string) =>
  client.getSnapshot().threads.find((thread) => thread.title === title)!.id;
async function render(element: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(element));
  return container;
}

describe("Needs you on the phone", () => {
  it("names a direct operation by its agent and the Home's question, with the agent's mark", async () => {
    const client = seeded();
    await client.loadEarlierNeedsYou();
    const page = await render(
      <NeedsYouScreen
        {...({ route: { params: { deploymentId: "dep" } } } as Parameters<
          typeof NeedsYouScreen
        >[0])}
      />,
    );
    await vi.waitFor(() => expect(page.textContent).toContain("Grok: Run a script in Shopping?"));
    expect(page.querySelector('[data-mark="G"]')).not.toBeNull();
    // Every other Request keeps its own title.
    expect(page.textContent).toContain("Book a table for Friday");
  });
});

describe("a tab a connected agent uses, on the phone", () => {
  function Status(props: {
    readonly client: MockHostClient;
    readonly agents: PlaceAgents;
    readonly tabId: string;
  }) {
    return (
      usePlaceStatusRow({
        agents: props.agents,
        hostClient: props.client,
        onAnswer: () => undefined,
        tabId: props.tabId,
        threadId: null,
      }) ?? <p>nothing</p>
    );
  }
  const agentsOf = (threadId: string, title: string): PlaceAgents => ({
    agents: [
      { threadId, acting: true, title, mark: null, lastActiveAt: "2026-11-20T12:00:00.000Z" },
    ],
    unnamedActing: false,
  });

  it("says who is using it for which task, with Stop that ends that session", async () => {
    const client = seeded();
    const threadId = idOf(client, "Find flights to Lisbon");
    const dispatch = vi.spyOn(client, "dispatch");
    const page = await render(
      <Status
        agents={agentsOf(threadId, "Find flights to Lisbon")}
        client={client}
        tabId="mock-tab-1-0"
      />,
    );
    expect(page.textContent).toContain("Claude is using this page for “Find flights to Lisbon”");
    await act(async () =>
      [...page.querySelectorAll("button")].find((b) => b.textContent === "Stop Claude")!.click(),
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "agent.session.stop", threadId }),
    );
  });

  it("says both of you on a tab the person shares", async () => {
    const client = seeded();
    const threadId = idOf(client, "Buy the phone case");
    const page = await render(
      <Status
        agents={agentsOf(threadId, "Buy the phone case")}
        client={client}
        tabId="mock-tab-0-0"
      />,
    );
    expect(page.textContent).toContain(
      "You and Grok are using this page, for “Buy the phone case”",
    );
  });
});

describe("a connected agent's task in Tasks, on the phone", () => {
  it("wears the agent's mark and says what it is using", async () => {
    const client = seeded();
    const threadId = idOf(client, "Find flights to Lisbon");
    const list = taskList(client.getSnapshot());
    const row: TaskRow =
      [...list.working, ...list.ready, ...list.done].find(
        (candidate) => candidate.threadId === threadId,
      ) ?? ({ threadId, title: "Find flights to Lisbon", tone: "working" } as TaskRow);
    const page = await render(
      <TaskRowView
        onOpen={() => undefined}
        onSetDone={() => undefined}
        row={row}
        selected={false}
        shelf="open"
        time={null}
      />,
    );
    expect(page.querySelector('[data-mark="anthropic"]')).not.toBeNull();
    expect(page.querySelector('[data-mark="task"]')).toBeNull();
    expect(page.textContent).toContain("Claude is working");
  });
});
