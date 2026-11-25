// @vitest-environment happy-dom
import { MockHostClient, mockAgentWorkThreads, mockConnectedAgents } from "@opensteer/client/mock";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testUnsentSessionStops } from "../../../../tests/session-stop-feedback.test-support.js";

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
// The pane keeps off the bar and the screen's edges; here they take no room.
vi.mock("@react-navigation/elements", () => ({ useHeaderHeight: () => 0 }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaFrame: () => ({ height: 800, width: 390, x: 0, y: 0 }),
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
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
  SectionLabel: (props: { children?: ReactNode }) => <h2>{props.children}</h2>,
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

const showTab = vi.fn();
vi.mock("../tabs/viewer-open.js", () => ({ useShowTab: () => showTab }));
vi.mock("../ui/mobile-client-context.js", async (actual) => ({
  ...(await actual<typeof import("../ui/mobile-client-context.js")>()),
  useMobileClient: () => ({ drafts: {} }),
}));
// The question card itself is the one every task uses; here it shows what it was handed.
vi.mock("./waiting-questions.js", () => ({
  QuestionCard: (props: {
    readonly canRespond: boolean;
    readonly title?: string;
    readonly surface: {
      readonly request: {
        readonly presentation: {
          readonly title: string;
          readonly detail?: string;
          readonly fields?: readonly { readonly choices?: readonly { readonly label: string }[] }[];
        };
      };
    };
  }) => (
    <section data-testid="question-card">
      <h2>{props.title ?? props.surface.request.presentation.title}</h2>
      <p>{props.surface.request.presentation.detail}</p>
      {props.surface.request.presentation.fields?.[0]?.choices?.map(({ label }) => (
        <button disabled={!props.canRespond} key={label}>
          {label}
        </button>
      ))}
    </section>
  ),
}));

const { ConnectedAgentsSection } = await import("../sidebar/connected-agents-section.js");
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

function seeded(options: { readonly question?: boolean } = {}) {
  host = new MockHostClient({
    latencyMs: 0,
    connections: mockConnectedAgents("seeded").connections,
  });
  host.mockAgentWork(options);
  return host;
}
const idOf = (client: MockHostClient, title: string) =>
  client.getSnapshot().threads.find((thread) => thread.title === title)!.id;

function Pane(props: { readonly client: MockHostClient; readonly threadId: string }) {
  const view = useSessionTask(props.client, props.threadId)!;
  return (
    <AgentSessionPane
      deploymentId="dep_mock"
      hostClient={props.client}
      threadId={props.threadId}
      title="t"
      view={view}
    />
  );
}

function mountMobile() {
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  return container;
}

async function render(client: MockHostClient, threadId: string) {
  const container = mountMobile();
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
    expect(text).toContain("Listed tabs in \u2068Travel\u2069 on \u2068Studio Mac\u2069");
    expect(text).toContain("Reading only · Done");
    expect(text).toContain("Allowed by you · Failed");
    expect(text).toContain("Uncertain");
    expect(text).toContain("can’t say whether this happened");
    expect(text).toContain("“\u2068Claude\u2069” is working");
    expect(text).toContain(
      "“\u2068Claude\u2069” works this task itself. You can’t write to it here.",
    );
    expect(page.querySelector("textarea, input")).toBeNull();
  });

  it("ends the agent's session with Stop, bound to the session the person saw", async () => {
    const client = seeded();
    const threadId = idOf(client, "Find flights to Lisbon");
    const sessionId = sessionTaskOf(client.getSnapshot(), threadId)!.stop!.sessionId;
    const dispatch = vi.spyOn(client, "dispatch");
    const page = await render(client, threadId);
    await act(async () => button(page, "Stop “\u2068Claude\u2069”")!.click());
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
    expect(page.textContent).toContain("\u2068Shopping\u2069 · \u2068Studio Mac\u2069");
    const card = [...page.querySelectorAll("div")].find((node) =>
      node.getAttribute("data-testid")?.startsWith("operation-request:"),
    );
    expect(card?.textContent).toContain("“\u2068Grok\u2069”Run a script in Shopping?");
    expect(page.textContent).toContain("“\u2068Grok\u2069” says:");
    expect(page.textContent).toContain("Buy the $12 phone case you asked for.");
    expect(page.textContent).not.toContain("Place order");
    await act(async () => button(page, "Show exactly what it will run")!.click());
    expect(page.textContent).toContain("Place order");
    expect(page.textContent).toContain(
      "“\u2068Grok\u2069” is told your answer. Allowing this once doesn’t give it any more access.",
    );
    await act(async () => button(page, "Allow once")!.click());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "request.respond",
        response: { kind: "form", answers: { "operation-decision": ["allow"] } },
      }),
    );
  });

  it("shows what the agent asked the person itself, with the Request's own choices", async () => {
    const client = seeded({ question: true });
    const threadId = idOf(client, "Find flights to Lisbon");
    const page = await render(client, threadId);
    await vi.waitFor(() =>
      expect(page.textContent).toContain(
        "Connected agent Claude asks in “\u2068Find flights to Lisbon\u2069”",
      ),
    );
    const card = page.querySelector('[data-testid="question-card"]')!;
    expect(card.textContent).toContain("Enter passwords and codes only in the page.");
    expect([...card.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Done",
      "Unable to do it",
    ]);
    // Never a direct operation's answers: this Request carries its own.
    expect(button(page, "Allow once")).toBeUndefined();
    expect(button(page, "Don’t allow")).toBeUndefined();
  });

  it("opens the page the question is about, and the place the agent is using, in one tap", async () => {
    const client = seeded({ question: true });
    const threadId = idOf(client, "Find flights to Lisbon");
    const page = await render(client, threadId);
    await vi.waitFor(() => expect(button(page, "Open the page")).toBeDefined());
    await act(async () => button(page, "Open the page")!.click());
    expect(showTab).toHaveBeenLastCalledWith("mock-tab-1-0");
    const using = [...page.querySelectorAll("button")].find((b) =>
      b.getAttribute("aria-label")?.startsWith("Open "),
    )!;
    expect(using.getAttribute("aria-label")).not.toBe("Open the page");
    await act(async () => using.click());
    expect(showTab).toHaveBeenLastCalledWith("mock-tab-1-0");
  });

  it("offers no page for a task whose agent holds none", async () => {
    const client = seeded();
    const page = await render(client, idOf(client, "Renew the parking permit"));
    expect(button(page, "Open the page")).toBeUndefined();
    expect(page.textContent).not.toContain("Using now");
  });
});

testUnsentSessionStops(
  async (stop) => {
    await act(async () => stop.click());
  },
  {
    "phone drawer": async () => {
      const client = seeded();
      client.mockAgentWork({ livePanel: "one" });
      const shown = mountMobile();
      await act(async () =>
        root!.render(<ConnectedAgentsSection host={client} onOpen={vi.fn()} />),
      );
      return { client, shown, stop: button(shown, "Stop ChatGPT") };
    },
    "phone task": async () => {
      const client = seeded();
      client.mockAgentWork({ livePanel: "one" });
      const shown = await render(client, mockAgentWorkThreads.shopping);
      return { client, shown, stop: button(shown, "Stop “\u2068ChatGPT\u2069”") };
    },
  },
);
