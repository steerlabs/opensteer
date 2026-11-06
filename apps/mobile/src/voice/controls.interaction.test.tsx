// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { VoiceContext } from "@opensteer/client/react";
import {
  idleVoiceSnapshot,
  type VoiceControls,
  type VoiceLevels,
  type VoiceSnapshot,
} from "@opensteer/client/voice";

const renders = vi.hoisted(() => ({ marks: 0, symbols: 0, words: 0 }));
vi.mock("react-native", () => {
  const view = (props: { readonly children?: ReactNode }) =>
    createElement("div", null, props.children);
  return {
    Pressable: (props: { readonly children?: ReactNode | ((state: object) => ReactNode) }) =>
      createElement(
        "button",
        null,
        typeof props.children === "function" ? props.children({ pressed: false }) : props.children,
      ),
    Platform: { OS: "ios", Version: "27.0", select: () => undefined },
    StyleSheet: { absoluteFill: {}, create: (styles: object) => styles },
    View: view,
    useWindowDimensions: () => ({ width: 402 }),
  };
});
vi.mock("react-native-reanimated", async () => {
  const { View } = await import("react-native");
  return {
    default: { View },
    Easing: { inOut: () => undefined, out: () => undefined, quad: undefined, sin: undefined },
    useAnimatedStyle: () => ({}),
    useReducedMotion: () => false,
    useSharedValue: (value: unknown) => ({ value }),
    withRepeat: (value: unknown) => value,
    withSequence: (value: unknown) => value,
    withSpring: (value: unknown) => value,
    withTiming: (value: unknown) => value,
  };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => true }));
vi.mock("expo-haptics", () => ({}));
vi.mock("../thread/composer-bar.js", () => ({ ComposerGlyph: () => null }));
vi.mock("../ui/activity-symbol.js", () => ({ activitySymbol: {} }));
vi.mock("../ui/motion.js", () => ({
  appear: undefined,
  duration: { enter: 0, exit: 0 },
  enter: undefined,
  exit: undefined,
}));
vi.mock("../ui/pane.js", () => ({ usePaneInView: () => true }));
vi.mock("../ui/primitives.js", () => ({
  AppText: (props: { readonly children?: ReactNode }) => {
    if (props.children !== undefined) renders.words += 1;
    return createElement("span", null, props.children);
  },
}));
vi.mock("../ui/symbol.js", () => ({
  Symbol: () => {
    renders.symbols += 1;
    return null;
  },
}));
vi.mock("./ask.js", () => ({ VoiceAsk: () => null }));
vi.mock("./call-timer.js", () => ({ CallTimer: () => null }));
vi.mock("./cursor-mark.js", () => ({
  PillMic: () => {
    renders.symbols += 1;
    return null;
  },
  VoiceCursor: () => {
    renders.marks += 1;
    return null;
  },
}));
vi.mock("./keyboard-height.js", () => ({ useKeyboardHeight: () => ({ value: 0 }) }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.replaceChildren();
});

function fakeCall(start: Partial<VoiceSnapshot>) {
  let snapshot: VoiceSnapshot = { ...idleVoiceSnapshot, ...start };
  const listeners = new Set<() => void>();
  const levels = new Set<(levels: VoiceLevels) => void>();
  const controls: VoiceControls = {
    dismissNotice: () => {},
    getSnapshot: () => snapshot,
    openThread: async () => null,
    setMuted: () => {},
    start: async () => {},
    stop: () => {},
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeLevel: (listener) => {
      levels.add(listener);
      return () => levels.delete(listener);
    },
  };
  return {
    controls,
    level: (input: number) => {
      for (const listener of levels) listener({ input, output: input });
    },
    publish: (patch: Partial<VoiceSnapshot>) => {
      snapshot = { ...snapshot, ...patch };
      for (const listener of listeners) listener();
    },
  };
}

it("redraws only the words for a caption's tokens and nothing for its levels", async () => {
  const { VoiceOverlay } = await import("./controls.js");
  const call = fakeCall({ phase: "speaking", since: 1, spoken: "Six" });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <VoiceContext value={call.controls}>
        <VoiceOverlay />
      </VoiceContext>,
    ),
  );
  const shell = { ...renders };
  const tokens = ["Six fifteen", "Six fifteen is", "Six fifteen is open."];
  for (const spoken of tokens) {
    await act(async () => call.publish({ spoken }));
    await act(async () => call.level(0.5));
  }
  expect(container.textContent).toContain("Six fifteen is open.");
  expect(renders.words - shell.words).toBe(tokens.length);
  expect(renders.marks).toBe(shell.marks);
  expect(renders.symbols).toBe(shell.symbols);
});
