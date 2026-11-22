// @vitest-environment happy-dom
import { MockHostClient, mockConnectedAgents } from "@opensteer/client/mock";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  coveringOf,
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
});

/** The phones the app runs on, as their safe area and the bar's height leave them. */
const phones = [
  {
    // The smallest phone width the app supports, with its status bar and a plain bar.
    name: "the smallest phone",
    window: { height: 568, width: 320 },
    header: 64,
    insets: { bottom: 0, left: 0, right: 0, top: 20 },
  },
  {
    // iPhone Duo's inner screen as the walk measured it: the vertical bar, with the bar's
    // controls standing in it, takes 84 points on the right; the task's title floats at the top.
    name: "iPhone Duo beside its vertical bar",
    window: { height: 678, width: 466 },
    header: 72,
    insets: { bottom: 20, left: 0, right: 84, top: 0 },
  },
] as const;
const textSizes = [1, 3.1] as const;

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
  return { container, frames: await layout(container, phone.window) };
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
        // The agent's state and its Stop, above the screen's own bottom edge.
        const stop = container.querySelector('[aria-label="Stop Claude"]');
        if (!stop) throw new Error("No Stop");
        expectClear(container, frames, phone, stop, "Stop");
        expect(frames.frame(stop).y + frames.frame(stop).height).toBeLessThanOrEqual(
          phone.window.height - phone.insets.bottom + 0.5,
        );
      });
});
