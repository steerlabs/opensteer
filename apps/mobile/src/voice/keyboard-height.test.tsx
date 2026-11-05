// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { floatLift, floatRest } from "./float-lift.js";

type KeyboardListener = (event: { endCoordinates: { height: number } }) => void;

const native = vi.hoisted(() => ({
  listeners: new Map<string, KeyboardListener>(),
  metrics: undefined as { height: number } | undefined,
  removed: 0,
}));
vi.mock("react-native", () => ({
  Keyboard: {
    addListener: (name: string, listener: KeyboardListener) => {
      native.listeners.set(name, listener);
      return { remove: () => (native.removed += 1) };
    },
    isVisible: () => native.metrics !== undefined,
    metrics: () => native.metrics,
  },
}));
vi.mock("react-native-reanimated", () => ({
  FadeIn: { duration: () => undefined },
  FadeInDown: { duration: () => undefined },
  FadeOut: { duration: () => undefined },
  LinearTransition: { duration: () => undefined },
  useSharedValue: (value: number) => ({ value }),
  withTiming: (value: number) => value,
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ bottom: 24, left: 0, right: 0, top: 0 }),
}));

const { useKeyboardHeight } = await import("./keyboard-height.js");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  native.listeners.clear();
  native.metrics = undefined;
  native.removed = 0;
});

async function watch() {
  const seen: { current: { value: number } | null } = { current: null };
  function Probe() {
    seen.current = useKeyboardHeight();
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  return { height: seen.current!, root };
}

it("rests until the keyboard reaches the bar, then keeps a gap above it", () => {
  const rest = 34 + floatRest;
  expect(floatLift(0, rest)).toBe(0);
  expect(floatLift(rest - 8, rest)).toBe(0);
  expect(floatLift(336, rest)).toBe(336 + 8 - rest);
});

it("measures Android's keyboard from the window's edge, not the navigation bar", async () => {
  const { height, root } = await watch();
  await act(async () =>
    native.listeners.get("keyboardDidShow")?.({ endCoordinates: { height: 300 } }),
  );
  expect(height.value).toBe(324);
  await act(async () =>
    native.listeners.get("keyboardDidHide")?.({ endCoordinates: { height: 0 } }),
  );
  expect(height.value).toBe(0);
  await act(async () => root.unmount());
  expect(native.removed).toBe(2);
});

it("clears a keyboard already open when a call's bar appears", async () => {
  native.metrics = { height: 300 };
  const { height, root } = await watch();
  expect(height.value).toBe(324);
  await act(async () => root.unmount());
});
