// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  layout,
  layoutWindow,
  overlaps,
  inside,
  textElement,
} from "../../test-support/yoga-frames.js";

vi.mock(
  "react-native",
  async () => (await import("../../test-support/yoga-frames.js")).layoutReactNative,
);
vi.mock(
  "react-native-reanimated",
  async () => (await import("../../test-support/yoga-frames.js")).layoutReanimated,
);
vi.mock("expo-clipboard", () => ({ setStringAsync: async () => true }));
vi.mock("expo-haptics", () => ({
  ImpactFeedbackStyle: { Heavy: "heavy" },
  impactAsync: async () => undefined,
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
vi.mock("./agent-marks.js", async () => {
  const { View } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;
  return {
    AgentMarks: (props: { size: number }) => (
      <View style={{ height: props.size, width: props.size }} />
    ),
  };
});

// The row's own drawing is what this reads; where it gets its words from is not.
vi.mock("../ui/mobile-client-context.js", () => ({ useHostValue: () => null }));
vi.mock("../thread/agent-session-hooks.js", () => ({
  useAgentSessionStop: () => ({ run: async () => undefined, running: false }),
}));
vi.mock("../thread/task-status.js", () => ({ taskHeading: () => null }));

// The row stands where the page puts it: in the stage's foot, or floating on the bar's glass.
const shown = vi.hoisted(() => ({ row: null as ReactNode }));
vi.mock("./place-bar.js", () => ({ usePlaceBarStatus: () => shown.row }));
vi.mock("../ui/glass.js", async () => {
  const { View } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;
  return {
    GlassSurface: (props: { children?: ReactNode; style?: unknown }) => (
      <View style={props.style}>{props.children}</View>
    ),
  };
});
vi.mock("../voice/controls.js", () => ({ VoiceDock: () => null }));
vi.mock("../voice/use-voice-value.js", () => ({ useVoiceValue: () => false }));

const { SessionStatusRow, PlaceStatusRow } = await import("./place-status.js");
const { FloatingPlaceStatus, usePlaceStatus } = await import("./place-foot.js");
const { View } = (await import("../../test-support/yoga-frames.js")).layoutReactNative;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  layoutWindow.fontScale = 1;
});

/*
 * The row under a tab says who is using it and for what. When the agent waits on the person,
 * Answer joins Stop on it, and the walk saw the row cut to "Claude is using this page f…": the
 * task's name gone. At the smallest phone width, at the vertical bar's width, and at the
 * largest text the row allows, every word stays readable and nothing covers anything else.
 */
const line = "Claude is using this page for “Find flights to Lisbon”";
const sizes = [
  { name: "the smallest phone", width: 320, height: 568 },
  { name: "beside iPhone Duo's vertical bar", width: 382, height: 678 },
] as const;
const textSizes = [1, 1.35, 3.1] as const;

/** The foot of a page: the stage's own row, which the page makes room for. */
function StageFoot(): ReactNode {
  return usePlaceStatus(false).row;
}

async function draw(
  node: ReactNode,
  window: { width: number; height: number },
  where: "stage" | "floating",
) {
  shown.row = node;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <View style={{ height: window.height, width: window.width }}>
        {where === "stage" ? (
          <StageFoot />
        ) : (
          <View style={{ bottom: 0, left: 0, position: "absolute", right: 0 }}>
            <FloatingPlaceStatus />
          </View>
        )}
      </View>,
    ),
  );
  return { container, frames: await layout(container, window) };
}

function expectReadable(
  container: HTMLElement,
  frames: Awaited<ReturnType<typeof layout>>,
  words: string,
  controls: readonly string[],
  window: { readonly width: number; readonly height: number },
) {
  const screen = { height: window.height, width: window.width, x: 0, y: 0 };
  const said = textElement(container, words);
  expect(frames.cut(said), `"${words}" is cut`).toBe(false);
  const row = frames.frame(container.querySelector('[data-testid="place-status"]')!);
  expect(inside(frames.frame(said), row), "the words run outside their row").toBe(true);
  expect(inside(row, screen), "the row runs off the screen").toBe(true);
  for (const label of controls) {
    const control = container.querySelector(`[aria-label="${label}"]`);
    if (!control) throw new Error(`No ${label}`);
    const frame = frames.frame(control);
    expect(overlaps(frame, frames.frame(said)), `${label} covers the words`).toBe(false);
    expect(inside(frame, row), `${label} is outside its row`).toBe(true);
    expect(frame.width, `${label} is smaller than a touch`).toBeGreaterThanOrEqual(43.5);
  }
}

const where = ["stage", "floating"] as const;

describe("who is using a tab, and for what, with Answer beside Stop", () => {
  for (const size of sizes)
    for (const fontScale of textSizes)
      for (const place of where)
        it(`stays whole on ${size.name} at text size ${fontScale}, ${place}`, async () => {
          layoutWindow.fontScale = fontScale;
          const { container, frames } = await draw(
            <SessionStatusRow
              busy={false}
              onAnswer={() => undefined}
              onStop={() => undefined}
              session={{
                agent: { initial: "C", name: "Claude", providerId: "anthropic" } as never,
                line,
                stop: { sessionId: "ses_1" },
                threadId: "thr_1",
              }}
            />,
            size,
            place,
          );
          expectReadable(
            container,
            frames,
            "Find flights to Lisbon",
            ["Answer", "Stop Claude"],
            size,
          );
        });

  it("keeps your own agent's task named beside Answer and Stop", async () => {
    layoutWindow.fontScale = 3.1;
    const { container, frames } = await draw(
      <PlaceStatusRow
        agent={
          {
            acting: true,
            lastActiveAt: "",
            mark: null as never,
            threadId: "thr_1",
            title: "Find flights to Lisbon",
          } as never
        }
        canRespond
        named
        onAnswer={() => undefined}
        onStop={async () => undefined}
        stopLabel="Stop this run"
        watch={{ kind: "needs-you", runId: "run_1", stopping: false } as never}
      />,
      sizes[0],
      "stage",
    );
    expectReadable(
      container,
      frames,
      "Find flights to Lisbon",
      ["Answer", "Stop this run"],
      sizes[0],
    );
  });
});
