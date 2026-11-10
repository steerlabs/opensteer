import { expect, test, vi } from "vitest";
import { FakePhoneBrowserNative } from "./fake-native.test-support.js";
import { composeAndroidBrowserPort } from "./android-port.js";

const lifecycle = vi.hoisted(() => ({ change: (_state: string) => {} }));
vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: (_event: string, listener: (state: string) => void) => {
      lifecycle.change = listener;
    },
  },
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => "uuid" }));

test("the shared runtime fences Android on background and disposes it before enrollment removal", async () => {
  const native = new FakePhoneBrowserNative("android");
  Object.defineProperty(native, "listProfiles", {
    value: native.listProfiles.bind(native),
    enumerable: true,
  });
  const port = composeAndroidBrowserPort(native, native);
  const { startPhoneBrowserRuntime } = await import("./runtime.js");
  let enrolled = true;
  let changed = () => {};
  startPhoneBrowserRuntime({
    getEnrollment: () => (enrolled ? { deploymentId: "deployment", runnerId: "runner" } : null),
    subscribeEnrollment: (listener) => {
      changed = listener;
      return () => {};
    },
    loadNativePort: async () => port,
    subscribeErasure: () => () => {},
    retryErasure: async () => {},
  });
  try {
    await vi.waitFor(() =>
      expect(native.calls).toContainEqual({
        method: "setForeground",
        input: { epoch: native.epoch, active: true },
      }),
    );
    const initializedEpoch = native.epoch;
    lifecycle.change("background");
    expect(native.epoch).toBeGreaterThan(initializedEpoch);
    await vi.waitFor(() =>
      expect(native.calls).toContainEqual({
        method: "setForeground",
        input: { epoch: native.epoch, active: false },
      }),
    );
    const backgroundEpoch = native.epoch;
    lifecycle.change("active");
    await vi.waitFor(() =>
      expect(native.calls).toContainEqual({
        method: "setForeground",
        input: { epoch: native.epoch, active: true },
      }),
    );
    expect(native.epoch).toBe(backgroundEpoch);
  } finally {
    enrolled = false;
    changed();
    await vi.waitFor(() =>
      expect(native.calls).toContainEqual({ method: "fence", input: "disposed" }),
    );
  }
});
