import { expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  currentState: "active",
  receive: (_state: string) => {},
  remove: vi.fn(),
  cleanup: undefined as (() => void) | undefined,
}));
vi.mock("react", () => ({
  useEffect: (effect: () => () => void) => {
    state.cleanup = effect();
  },
}));
vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return state.currentState;
    },
    addEventListener: (_event: string, receive: (state: string) => void) => {
      state.receive = receive;
      return { remove: state.remove };
    },
  },
}));
import { useVoiceBackgroundStop } from "./use-voice-background-stop.js";

it("stops on loss of foreground, including when mounted in the background, and removes its listener", () => {
  const stop = vi.fn();
  useVoiceBackgroundStop({ stop });
  expect(stop).not.toHaveBeenCalled();
  state.receive("inactive");
  state.receive("background");
  state.receive("active");
  expect(stop).toHaveBeenCalledTimes(1);
  state.cleanup?.();
  expect(state.remove).toHaveBeenCalledOnce();
  state.currentState = "background";
  useVoiceBackgroundStop({ stop });
  expect(stop).toHaveBeenCalledTimes(2);
  state.cleanup?.();
});
