import { expect, test, vi } from "vitest";
import { FakePhoneBrowserNative } from "./fake-native.test-support.js";
import type { PhoneBrowserPlatform } from "./platform.js";

const state = vi.hoisted(() => ({
  change: (_state: string) => {},
  initialize: vi.fn<() => Promise<void>>(),
  dispose: vi.fn(async () => {}),
  foreground: vi.fn(async (_active: boolean) => {}),
  erase: vi.fn(async () => {}),
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
    eraseDeployment = state.erase;
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

test("erasure waits for lifecycle disposal instead of racing a second native deletion", async () => {
  vi.resetModules();
  vi.clearAllMocks();
  state.initialize.mockResolvedValue();
  const disposal = Promise.withResolvers<void>();
  state.dispose.mockReturnValue(disposal.promise);
  const { startPhoneBrowserRuntime } = await import("./runtime.js");
  let enrollment: ReturnType<PhoneBrowserPlatform["getEnrollment"]> = {
    deploymentId: "deployment",
    runnerId: "runner",
  };
  let changed = () => {};
  let erase: (deploymentId: string) => Promise<void> = async () => {};
  startPhoneBrowserRuntime({
    getEnrollment: () => enrollment,
    subscribeEnrollment: (listener) => {
      changed = listener;
      return () => {};
    },
    loadNativePort: async () => new FakePhoneBrowserNative(),
    subscribeErasure: (listener) => {
      erase = listener;
      return () => {};
    },
    retryErasure: async () => {},
  });
  await vi.waitFor(() => expect(state.foreground).toHaveBeenCalledWith(true));
  enrollment = null;
  changed();
  let confirmed = false;
  const retired = erase("deployment").then(() => {
    confirmed = true;
  });
  await Promise.resolve();
  expect(confirmed).toBe(false);
  expect(state.erase).not.toHaveBeenCalled();
  disposal.resolve();
  await retired;
  expect(confirmed).toBe(true);
  expect(state.dispose).toHaveBeenCalledOnce();
});

test("a browser that failed to start tries again the next time the app opens", async () => {
  vi.resetModules();
  vi.clearAllMocks();
  state.dispose.mockResolvedValue();
  state.initialize.mockRejectedValueOnce(new Error("forbidden")).mockResolvedValue();
  const { startPhoneBrowserRuntime } = await import("./runtime.js");
  startPhoneBrowserRuntime({
    getEnrollment: () => ({ deploymentId: "deployment", runnerId: "runner" }),
    subscribeEnrollment: () => () => {},
    loadNativePort: async () => new FakePhoneBrowserNative(),
    subscribeErasure: () => () => {},
    retryErasure: async () => {},
  });
  await vi.waitFor(() => expect(state.dispose).toHaveBeenCalledOnce(), {
    timeout: 2_000,
    interval: 5,
  });
  // Each switch settles (every queued microtask) long before a person makes the next one.
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  await settle();
  state.change("background");
  await settle();
  state.change("active");
  await vi.waitFor(() => expect(state.foreground).toHaveBeenCalledWith(true), {
    timeout: 2_000,
    interval: 5,
  });
  expect(state.initialize).toHaveBeenCalledTimes(2);
});
