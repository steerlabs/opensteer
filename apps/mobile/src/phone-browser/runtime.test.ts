import { expect, test, vi } from "vitest";
import type { IphoneAppsBridge } from "../platform/iphone-apps.js";

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
vi.mock("expo", () => ({
  NativeModule: class {},
  requireNativeModule: () => ({}),
  requireNativeView: () => () => null,
}));
vi.mock("../iphone-apps/browser-transport.js", () => ({
  createIphoneBrowserConnection: () => ({
    onErasure: () => {},
    retryErasure: async () => {},
  }),
}));
vi.mock("../../modules/phone-browser/index.js", () => ({ phoneBrowser: {} }));
vi.mock("./iphone-port.js", () => ({ composeIphoneBrowserPort: () => ({}) }));
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
  const { startIphoneBrowserRuntime } = await import("./runtime.js");
  const bridge = {
    getSnapshot: () => ({
      supported: true,
      enrollment: {
        state: "enrolled",
        deploymentId: "deployment",
        runnerId: "runner",
      },
    }),
    subscribe: () => () => {},
  } as unknown as IphoneAppsBridge;
  startIphoneBrowserRuntime(bridge);
  await vi.waitFor(() => expect(state.initialize).toHaveBeenCalledOnce());
  state.change("background");
  expect(state.dispose).toHaveBeenCalledOnce();
  initialization.resolve();
  await vi.waitFor(() => expect(state.foreground).not.toHaveBeenCalled());
});
