import { expect, test, vi } from "vitest";
import { FakePhoneBrowserNative } from "./fake-native.test-support.js";
import type { PhoneBrowserPlatform } from "./platform.js";

const state = vi.hoisted(() => ({
  change: (_state: string) => {},
  initialize: vi.fn<() => Promise<void>>(),
  dispose: vi.fn(async () => {}),
  foreground: vi.fn(async (_active: boolean) => {}),
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  AppState: {
    currentState: "active",
    addEventListener: (_name: string, listener: (value: string) => void) => {
      state.change = listener;
    },
  },
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => "uuid" }));
vi.mock("./manager.js", () => ({
  PhoneBrowserManager: class {
    initialize = state.initialize;
    dispose = state.dispose;
    setForeground = state.foreground;
  },
}));

test("leaving foreground fences an initializing manager before qualification completes", async () => {
  const initialization = Promise.withResolvers<void>();
  state.initialize.mockReturnValue(initialization.promise);
  const { startPhoneBrowserRuntime } = await import("./runtime.js");
  const platform: PhoneBrowserPlatform = {
    getEnrollment: () => ({
      deploymentId: "deployment",
      runnerId: "runner",
    }),
    subscribeEnrollment: () => () => {},
    loadNativePort: async () => new FakePhoneBrowserNative(),
    subscribeErasure: () => () => {},
    retryErasure: async () => {},
  };
  startPhoneBrowserRuntime(platform);
  await vi.waitFor(() => expect(state.initialize).toHaveBeenCalledOnce());
  state.change("background");
  expect(state.dispose).toHaveBeenCalledOnce();
  initialization.resolve();
  await vi.waitFor(() => expect(state.foreground).not.toHaveBeenCalled());
});
