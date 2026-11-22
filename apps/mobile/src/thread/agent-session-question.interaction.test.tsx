// @vitest-environment happy-dom
import {
  MockHostClient,
  mockAgentQuestionRequestId,
  mockConnectedAgents,
} from "@opensteer/client/mock";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * The question a connected agent asked, answered on the phone with the card every task uses:
 * what a tap sends is the real Request, its reviewed revision and the chosen answer.
 */
vi.mock("react-native", () => ({
  AccessibilityInfo: { announceForAccessibility: vi.fn(async () => undefined) },
  ActivityIndicator: () => <span>Spinner</span>,
  AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: "active" },
  Platform: { OS: "ios", Version: "26", select: (options: { ios?: unknown }) => options.ios },
  PixelRatio: { get: () => 2, getFontScale: () => 1, roundToNearestPixel: (n: number) => n },
  Pressable: (props: {
    accessibilityLabel?: string;
    accessibilityRole?: string;
    children?: ReactNode | ((state: { pressed: boolean }) => ReactNode);
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button aria-label={props.accessibilityLabel} disabled={props.disabled} onClick={props.onPress}>
      {typeof props.children === "function" ? props.children({ pressed: false }) : props.children}
    </button>
  ),
  ScrollView: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  StyleSheet: { create: (styles: object) => styles, hairlineWidth: 1, flatten: (s: unknown) => s },
  TextInput: (props: { accessibilityLabel?: string; value: string }) => (
    <textarea aria-label={props.accessibilityLabel} readOnly value={props.value} />
  ),
  useWindowDimensions: () => ({ fontScale: 1, height: 800, width: 390 }),
  View: (props: { children?: ReactNode; testID?: string }) => (
    <div data-testid={props.testID}>{props.children}</div>
  ),
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: (props: { children?: ReactNode }) => <div>{props.children}</div> },
}));
vi.mock("../ui/motion.js", () => ({ appear: undefined }));
// The pane keeps off the bar and the screen's edges; here they take no room.
vi.mock("@react-navigation/elements", () => ({ useHeaderHeight: () => 0 }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaFrame: () => ({ height: 800, width: 390, x: 0, y: 0 }),
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));
vi.mock("expo-haptics", () => ({
  ImpactFeedbackStyle: { Heavy: "heavy", Medium: "medium" },
  NotificationFeedbackType: { Error: "error", Success: "success", Warning: "warning" },
  impactAsync: vi.fn(async () => undefined),
  notificationAsync: vi.fn(async () => undefined),
  selectionAsync: vi.fn(async () => undefined),
}));
vi.mock(
  "../ui/action-line.js",
  async () => (await import("../../test-support/action-line-mocks.js")).actionLine,
);
vi.mock(
  "../ui/placeholder.js",
  async () => (await import("../../test-support/action-line-mocks.js")).placeholder,
);
vi.mock("../ui/ai-sharing.js", () => import("../../test-support/ai-sharing.js"));
vi.mock("../client/mobile-client.js", () => ({
  operationDetail: (_reason: unknown, fallback: string) => fallback,
}));
vi.mock("./password-approval-auth.js", () => ({
  authenticatePasswordApproval: vi.fn(async () => true),
}));
vi.mock("../ui/primitives.js", () => ({
  AppText: (props: { children?: ReactNode }) => <span>{props.children}</span>,
}));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("../ui/task-mark.js", () => ({ TaskMark: () => null }));
vi.mock("../markdown/markdown.js", () => ({
  Markdown: ({ text }: { text: string }) => <p>{text}</p>,
}));
vi.mock("../navigation-ref.js", () => ({ pushSubagent: vi.fn() }));
vi.mock("./asker-byline.js", () => ({ AskerByline: () => null, useRequestAsker: () => null }));
vi.mock("./request-card.js", () => ({
  arrivalGuardMs: 450,
  RequestCard: () => null,
  WaitingMenu: () => null,
}));
vi.mock("../screens/external-agent-mark.js", () => ({ ExternalAgentMark: () => null }));
vi.mock("../ui/composer-action.js", () => ({
  ComposerAction: (props: { label: string; onPress: () => void }) => (
    <button aria-label={props.label} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../tabs/viewer-open.js", () => ({ useShowTab: () => vi.fn() }));
vi.mock("../ui/mobile-client-context.js", async (actual) => ({
  ...(await actual<typeof import("../ui/mobile-client-context.js")>()),
  useMobileClient: () => ({ drafts: {} }),
}));

const { AgentSessionPane } = await import("./agent-session.js");
const { useSessionTask } = await import("./agent-session-hooks.js");
const { resetRequestSessionsForTests } = await import("./request-session.js");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let host: MockHostClient | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.dispose();
  resetRequestSessionsForTests();
  vi.useRealTimers();
  document.body.replaceChildren();
});

function Pane(props: { readonly client: MockHostClient; readonly threadId: string }) {
  const view = useSessionTask(props.client, props.threadId);
  return view === null ? null : (
    <AgentSessionPane
      deploymentId="dep_mock"
      hostClient={props.client}
      threadId={props.threadId}
      title="t"
      view={view}
    />
  );
}

async function open(choices: readonly string[]) {
  host = new MockHostClient({
    latencyMs: 0,
    connections: mockConnectedAgents("seeded").connections,
  });
  host.mockAgentWork({ question: true, questionChoices: choices });
  const threadId = host
    .getSnapshot()
    .threads.find(({ title }) => title === "Find flights to Lisbon")!.id;
  const dispatch = vi.spyOn(host, "dispatch");
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<Pane client={host!} threadId={threadId} />));
  await vi.waitFor(() =>
    expect(container.textContent).toContain(
      "Connected agent Claude asks in Find flights to Lisbon",
    ),
  );
  // Past the moment a card ignores taps for, having just arrived under a thumb.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 1_000);
  return { container, dispatch };
}

const press = async (container: HTMLElement, label: string) => {
  const target = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === label || item.getAttribute("aria-label")?.startsWith(label),
  );
  if (!target) throw new Error(`No control named ${label}`);
  await act(async () => {
    target.click();
    await Promise.resolve();
  });
};

describe("a connected agent's question, answered on the phone", () => {
  it("draws allow and deny as the agent's own answers and sends the one tapped", async () => {
    const { container, dispatch } = await open(["allow", "deny"]);
    expect(container.textContent).not.toContain("Allow once");
    expect(container.textContent).not.toContain("Don’t allow");
    await press(container, "deny");
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalled());
    const sent = dispatch.mock.calls.find(([command]) => command.type === "request.respond")![0];
    expect(sent).toMatchObject({
      type: "request.respond",
      requestId: mockAgentQuestionRequestId,
      expectedRevision: expect.any(String),
      response: { kind: "form", answers: { question_1: ["deny"] } },
    });
  });

  it("dismisses as a decline, never as an answer", async () => {
    const { container, dispatch } = await open(["Done", "Unable to do it"]);
    await press(container, "Dismiss");
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalled());
    const sent = dispatch.mock.calls.find(([command]) => command.type === "request.respond")![0];
    expect(sent).toMatchObject({
      requestId: mockAgentQuestionRequestId,
      expectedRevision: expect.any(String),
      response: { kind: "external", value: { decision: "declined" } },
    });
  });
});
