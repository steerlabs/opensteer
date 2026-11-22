// @vitest-environment happy-dom
import { MockHostClient, mockConnectedAgents } from "@opensteer/client/mock";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { layoutPhones, layoutTextSizes } from "../../test-support/layout-phones.js";
import {
  coveringOf,
  reachable,
  inside,
  layout,
  layoutWindow,
  overlaps,
  textElement,
  type Frames,
  type Rect,
} from "../../test-support/yoga-frames.js";

/*
 * A connected agent's own task on the phone, laid out by React Native's own layout engine at
 * the smallest phone width and beside iPhone Duo's vertical bar, at the app's smallest and
 * largest text sizes. The walk saw the task's floating title over "Using now" and its link,
 * the bar's controls over the agent's message, and a choice that works faded as if it did not.
 * Here nothing a person has to read or press is under the bar's title, under the vertical
 * bar, cut short, or covered by anything drawn over it: asserted by frames.
 */

const geometry = vi.hoisted(() => ({
  header: 0,
  insets: { bottom: 0, left: 0, right: 0, top: 0 },
}));
/** What the last answer came to, when a case says it failed: the card's own outcome line. */
const answered = vi.hoisted(() => ({ failure: null as null | { key: string; text: string } }));
vi.mock("./use-question-answering.js", async (actual) => {
  const real = await actual<typeof import("./use-question-answering.js")>();
  return {
    ...real,
    useQuestionAnswering: (input: Parameters<typeof real.useQuestionAnswering>[0]) => {
      const question = real.useQuestionAnswering(input);
      if (answered.failure === null) return question;
      const failure = { ...answered.failure, tone: "danger" as const };
      return {
        ...question,
        responder: { ...question.responder, session: { ...question.responder.session, failure } },
      };
    },
  };
});

vi.mock(
  "react-native",
  async () => (await import("../../test-support/yoga-frames.js")).layoutReactNative,
);
vi.mock(
  "react-native-reanimated",
  async () => (await import("../../test-support/yoga-frames.js")).layoutReanimated,
);
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => geometry.insets,
  useSafeAreaFrame: () => ({ height: 0, width: 0, x: 0, y: 0 }),
  SafeAreaProvider: (props: { children?: ReactNode }) => props.children,
}));
vi.mock("@react-navigation/elements", () => ({ useHeaderHeight: () => geometry.header }));
vi.mock("@react-navigation/native", () => ({
  StackActions: { push: () => ({}) },
  useNavigation: () => ({ dispatch: () => undefined, navigate: () => undefined }),
  useIsFocused: () => true,
}));
vi.mock("../navigation-ref.js", () => ({ pushSubagent: () => undefined }));
vi.mock("expo-clipboard", () => ({ setStringAsync: async () => true }));
vi.mock("expo-haptics", () => ({
  ImpactFeedbackStyle: { Heavy: "heavy", Light: "light", Medium: "medium" },
  NotificationFeedbackType: { Error: "error", Success: "success", Warning: "warning" },
  impactAsync: async () => undefined,
  notificationAsync: async () => undefined,
  selectionAsync: async () => undefined,
}));
// Marks are their size: what they draw inside is not what this reads.
vi.mock("../ui/symbol.js", async () => {
  const { View } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;
  return {
    Symbol: (props: { size?: number }) => (
      <View style={{ height: props.size ?? 17, width: props.size ?? 17 }} />
    ),
  };
});
vi.mock("../screens/external-agent-mark.js", async () => {
  const { View } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;
  return {
    ExternalAgentMark: (props: { size: number }) => (
      <View style={{ height: props.size, width: props.size }} />
    ),
  };
});
vi.mock("./composer-menu.js", async () => {
  const { View } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;
  return {
    NativeMenu: (props: { children?: ReactNode; style?: unknown }) => (
      <View style={props.style}>{props.children}</View>
    ),
  };
});
// The agent's words as text a person reads, a paragraph each: how Markdown styles them is its
// own test's concern, where they stand on screen is this one's.
vi.mock("../markdown/markdown.js", async () => {
  const { Text, View } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;
  return {
    Markdown: (props: { text: string }) => (
      <View style={{ gap: 12 }}>
        {props.text.split(/\n\s*\n/u).map((paragraph, index) => (
          <Text key={index} style={{ fontSize: 17, lineHeight: 22 }}>
            {paragraph.replace(/^> ?/gmu, "").replace(/\n/gu, " ")}
          </Text>
        ))}
      </View>
    ),
  };
});
vi.mock("./asker-byline.js", () => ({ AskerByline: () => null, useRequestAsker: () => null }));
vi.mock("./request-card.js", () => ({ arrivalGuardMs: 450, WaitingMenu: () => null }));
vi.mock("../client/mobile-client.js", () => ({
  operationDetail: (_error: unknown, fallback: string) => fallback,
}));
vi.mock("../ui/ai-sharing.js", () => import("../../test-support/ai-sharing.js"));
vi.mock("./password-approval-auth.js", () => ({ authenticatePasswordApproval: async () => true }));
vi.mock("./device-owner.js", () => ({ DeviceOwnerUnconfirmed: class extends Error {} }));
vi.mock("../ui/task-mark.js", async () => {
  const { View } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;
  return {
    TaskMark: (props: { size?: number }) => (
      <View style={{ height: props.size ?? 20, width: props.size ?? 20 }} />
    ),
  };
});
vi.mock("../tabs/viewer-open.js", () => ({ useShowTab: () => () => undefined }));
vi.mock("../ui/mobile-client-context.js", async (actual) => ({
  ...(await actual<typeof import("../ui/mobile-client-context.js")>()),
  useMobileClient: () => ({ drafts: { get: () => null, set: () => undefined } }),
}));

const { AgentSessionPane, useSessionTask } = await import("./agent-session.js");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let host: MockHostClient | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.dispose();
  document.body.replaceChildren();
  layoutWindow.fontScale = 1;
  answered.failure = null;
});

const phones = layoutPhones;
const textSizes = layoutTextSizes;

function Pane(props: { readonly client: MockHostClient; readonly threadId: string }) {
  const view = useSessionTask(props.client, props.threadId)!;
  return (
    <AgentSessionPane
      deploymentId="dep_mock"
      hostClient={props.client}
      threadId={props.threadId}
      title="Find flights to Lisbon"
      view={view}
    />
  );
}

async function draw(phone: (typeof phones)[number], fontScale: number) {
  geometry.header = phone.header;
  geometry.insets = phone.insets;
  layoutWindow.fontScale = fontScale;
  layoutWindow.width = phone.window.width;
  layoutWindow.height = phone.window.height;
  host = new MockHostClient({
    latencyMs: 0,
    connections: mockConnectedAgents("seeded").connections,
  });
  host.mockAgentWork({ question: true, questionChoices: ["allow", "deny"] });
  const threadId = host
    .getSnapshot()
    .threads.find((thread) => thread.title === "Find flights to Lisbon")!.id;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const { View } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;
  await act(async () =>
    root!.render(
      <View style={{ height: phone.window.height, width: phone.window.width }}>
        <Pane client={host!} threadId={threadId} />
      </View>,
    ),
  );
  await vi.waitFor(() => expect(container.textContent).toContain("Sign in to TAP Air Portugal"));
  const frames = await layout(container, phone.window);
  // A layout that never comes to rest is a measure loop: the phone's main thread stays busy.
  expect(frames.settled, "the layout never comes to rest").toBe(true);
  return { container, frames };
}

/** What stands over the pane: the bar's floating title at the top, the vertical bar at the side. */
function obstructions(phone: (typeof phones)[number]): readonly { name: string; rect: Rect }[] {
  const { header, insets, window } = phone;
  return [
    { name: "the bar's title", rect: { height: header, width: window.width, x: 0, y: 0 } },
    ...(insets.right > 0
      ? [
          {
            name: "the vertical bar",
            rect: {
              height: window.height,
              width: insets.right,
              x: window.width - insets.right,
              y: 0,
            },
          },
        ]
      : []),
  ];
}

/**
 * Clear of what stands over the pane, at rest: below the bar's title, off the vertical bar,
 * within the screen's width, and with nothing drawn over what is visible of it. What lies
 * further down is scrolled to, so its height on the screen is not asked.
 */
function expectClear(
  container: Element,
  frames: Frames,
  phone: (typeof phones)[number],
  element: Element,
  what: string,
) {
  const frame = frames.frame(element);
  for (const { name, rect } of obstructions(phone))
    expect(overlaps(frame, rect), `${name} covers ${what}`).toBe(false);
  expect(
    inside(frame, { height: Infinity, width: phone.window.width, x: 0, y: 0 }),
    `${what} runs off the side of the screen`,
  ).toBe(true);
  expect(coveringOf(container, frames, element).length, `something is drawn over ${what}`).toBe(0);
}

describe("what a person reads and presses in a connected agent's task", () => {
  for (const phone of phones)
    for (const fontScale of textSizes)
      it(`stays clear on ${phone.name} at text size ${fontScale}`, async () => {
        const { container, frames } = await draw(phone, fontScale);
        // Who is using what, and the way there.
        const using = container.querySelector('[aria-label^="Open "][role="link"]');
        if (!using) throw new Error(`No place link: ${container.textContent}`);
        expectClear(container, frames, phone, using, "the place the agent is using");
        for (const words of ["Using now", "Open the page"]) {
          const text = textElement(container, words);
          expect(frames.cut(text), `"${words}" is cut`).toBe(false);
          expectClear(container, frames, phone, text, `"${words}"`);
        }
        // The agent's whole message, every choice and Dismiss.
        for (const words of [
          "Connected agent Claude asks in Find flights to Lisbon",
          "The site signed you out.",
          "Sign in to TAP Air Portugal in the Travel tab, then tap Done.",
          "allow",
          "deny",
          "Dismiss",
        ]) {
          const text = textElement(container, words);
          expect(frames.cut(text), `"${words}" is cut`).toBe(false);
          expectClear(container, frames, phone, text, `"${words}"`);
        }
        // The place's words wrap rather than being cut to a stub.
        const placeWords = [...using.querySelectorAll('[data-rn="Text"]')].at(-1)!;
        expect(frames.cut(placeWords), "the place the agent is using is cut").toBe(false);
        // Each choice scrolls with the task, not in a box of its own, and is a touch high.
        const pane = container.querySelector(
          '[data-testid="agent-session"] [data-rn="ScrollView"]',
        );
        for (const words of ["allow", "deny"]) {
          const text = textElement(container, words);
          // Any scroll view between the choice and the task's own holds it whole: none hides it.
          for (
            let box = text.closest('[data-rn="ScrollView"]');
            box !== null && box !== pane;
            box = box.parentElement?.closest('[data-rn="ScrollView"]') ?? null
          )
            expect(
              inside(frames.frame(text), frames.frame(box)),
              `"${words}" scrolls in a box`,
            ).toBe(true);
          expect(reachable(frames, text, phone.window), `"${words}" can't be reached`).toBe(true);
          const control = text.closest("[data-pressable]")!;
          expect(
            frames.frame(control).height,
            `"${words}" is smaller than a touch`,
          ).toBeGreaterThanOrEqual(43.5);
        }
        // The footer stands where a composer would: it says the agent's state whole and leaves
        // the task most of the screen.
        const state = textElement(container, "Claude is working");
        expect(frames.cut(state), "the agent's state is cut").toBe(false);
        const footer = container.querySelector('[data-testid="agent-session-footer"]')!;
        expect(frames.frame(footer).height, "the footer takes the task's room").toBeLessThanOrEqual(
          phone.window.height * 0.4,
        );
        // The agent's state and its Stop, above the screen's own bottom edge.
        const stop = container.querySelector('[aria-label="Stop Claude"]');
        if (!stop) throw new Error("No Stop");
        expectClear(container, frames, phone, stop, "Stop");
        expect(frames.frame(stop).y + frames.frame(stop).height).toBeLessThanOrEqual(
          phone.window.height - phone.insets.bottom + 0.5,
        );
      });
});

describe("an answer that didn't go through, on the agent's question", () => {
  const sentence = "Couldn't send your answer. Check that this phone is online, then answer again.";
  for (const phone of phones)
    for (const fontScale of textSizes)
      it(`says so whole and clear on ${phone.name} at text size ${fontScale}`, async () => {
        answered.failure = { key: "answer-failed", text: sentence };
        const { container, frames } = await draw(phone, fontScale);
        const text = textElement(container, sentence);
        expect(frames.cut(text), "the failure is cut").toBe(false);
        expect(frames.shown(text), "the failure is cut").toBe(sentence);
        expectClear(container, frames, phone, text, "the failure");
      });
});
