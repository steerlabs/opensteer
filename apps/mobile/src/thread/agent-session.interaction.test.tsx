// @vitest-environment happy-dom
import { MockHostClient, mockConnectedAgents } from "@opensteer/client/mock";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  AccessibilityInfo: { announceForAccessibility: vi.fn(async () => undefined) },
  AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: "active" },
  Platform: { OS: "ios", Version: "26", select: (options: { ios?: unknown }) => options.ios },
  PixelRatio: { get: () => 2, getFontScale: () => 1, roundToNearestPixel: (n: number) => n },
  useWindowDimensions: () => ({ fontScale: 1, height: 800, width: window.innerWidth }),
  Pressable: (props: {
    accessibilityLabel?: string;
    children?: ReactNode;
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button aria-label={props.accessibilityLabel} disabled={props.disabled} onClick={props.onPress}>
      {props.children}
    </button>
  ),
  ScrollView: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  StyleSheet: { create: (styles: object) => styles, hairlineWidth: 1 },
  View: (props: { children?: ReactNode; testID?: string }) => (
    <div data-testid={props.testID}>{props.children}</div>
  ),
}));
vi.mock("expo-haptics", () => ({
  ImpactFeedbackStyle: { Heavy: "heavy" },
  NotificationFeedbackType: { Error: "error", Success: "success", Warning: "warning" },
  impactAsync: vi.fn(async () => undefined),
  notificationAsync: vi.fn(async () => undefined),
}));
vi.mock(
  "../ui/action-line.js",
  async () => (await import("../../test-support/action-line-mocks.js")).actionLine,
);
vi.mock("../ui/primitives.js", () => ({
  AppText: (props: { children?: ReactNode }) => <span>{props.children}</span>,
}));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("../screens/external-agent-mark.js", () => ({
  ExternalAgentMark: (props: { providerId: string | null; initial?: string }) => (
    <i data-mark={props.providerId ?? props.initial} />
  ),
}));
vi.mock("../ui/composer-action.js", () => ({
  ComposerAction: (props: { label: string; busy: boolean; onPress: () => void }) => (
    <button aria-label={props.label} disabled={props.busy} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));

const { AgentSessionPane, useSessionTask } = await import("./agent-session.js");
const { sessionTaskOf } = await import("./agent-session-model.js");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let host: MockHostClient | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.dispose();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function seeded() {
  host = new MockHostClient({
    latencyMs: 0,
    connections: mockConnectedAgents("seeded").connections,
  });
  host.mockAgentWork();
  return host;
}
const idOf = (client: MockHostClient, title: string) =>
  client.getSnapshot().threads.find((thread) => thread.title === title)!.id;

function Pane(props: { readonly client: MockHostClient; readonly threadId: string }) {
  const view = useSessionTask(props.client, props.threadId)!;
  return (
    <AgentSessionPane hostClient={props.client} threadId={props.threadId} title="t" view={view} />
  );
}

async function render(client: MockHostClient, threadId: string) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<Pane client={client} threadId={threadId} />));
  return container;
}
const button = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll("button")].find(
    (candidate) =>
      candidate.getAttribute("aria-label") === label || candidate.textContent === label,
  );

describe("a connected agent's own task on the phone", () => {
  it.each([390, 1440])("reads the task activity and has no composer at %d px", async (width) => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(width);
    const client = seeded();
    const read = vi.fn(client.rpc["threads.activity"]);
    Object.defineProperty(client.rpc, "threads.activity", { value: read, configurable: true });
    const threadId = idOf(client, "Find flights to Lisbon");
    const page = await render(client, threadId);
    expect(read).toHaveBeenCalledWith({ threadId }, { signal: expect.any(AbortSignal) });
    const text = page.textContent ?? "";
    expect(text).toContain("Listed tabs in Travel on Studio Mac");
    expect(text).toContain("Reading only · Done");
    expect(text).toContain("Allowed by Auto · Failed");
    expect(text).toContain("Uncertain");
    expect(text).toContain("can’t say whether this happened");
    expect(text).toContain("Claude is working");
    expect(text).toContain("Claude works this task itself. You can’t write to it here.");
    expect(page.querySelector("textarea, input")).toBeNull();
  });

  it("ends the agent's session with Stop, bound to the session the person saw", async () => {
    const client = seeded();
    const threadId = idOf(client, "Find flights to Lisbon");
    const sessionId = sessionTaskOf(client.getSnapshot(), threadId)!.stop!.sessionId;
    const dispatch = vi.spyOn(client, "dispatch");
    const page = await render(client, threadId);
    await act(async () => button(page, "Stop Claude")!.click());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "agent.session.stop", threadId, agentSessionId: sessionId }),
    );
    expect(sessionTaskOf(client.getSnapshot(), threadId)).toMatchObject({
      state: "stopped",
      stop: null,
    });
  });

  it("says a stopped task is stopped and offers no Stop", async () => {
    const client = seeded();
    const page = await render(client, idOf(client, "Renew the parking permit"));
    expect(page.textContent).toContain("Stopped by you");
    expect(page.textContent).toContain("You didn’t allow it");
    expect(button(page, "Stop Errand")).toBeUndefined();
  });

  it("asks with the Home's words, keeps the agent's apart, shows the calls on a tap, and answers once", async () => {
    const client = seeded();
    const threadId = idOf(client, "Buy the phone case");
    const dispatch = vi.spyOn(client, "dispatch");
    const page = await render(client, threadId);
    await vi.waitFor(() => expect(page.textContent).toContain("Run a script in Shopping?"));
    expect(page.textContent).toContain("Shopping · Studio Mac");
    expect(page.textContent).toContain("Grok says:");
    expect(page.textContent).toContain("Buy the $12 phone case you asked for.");
    expect(page.textContent).not.toContain("Place order");
    await act(async () => button(page, "Show exactly what it will run")!.click());
    expect(page.textContent).toContain("Place order");
    expect(page.textContent).toContain(
      "Grok is told your answer. Allowing this once doesn’t give it any more access.",
    );
    await act(async () => button(page, "Allow once")!.click());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "request.respond",
        response: { kind: "form", answers: { "operation-decision": ["allow"] } },
      }),
    );
  });
});
