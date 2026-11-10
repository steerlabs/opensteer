import { beforeEach, expect, test, vi } from "vitest";
import type { IphoneAppsSnapshot } from "../platform/iphone-apps.js";
import { FakePhoneBrowserNative } from "./fake-native.test-support.js";

const state = vi.hoisted(() => ({
  snapshot: { supported: false, enrollment: null } as Pick<
    IphoneAppsSnapshot,
    "supported" | "enrollment"
  >,
  listeners: new Set<() => void>(),
  prepare: vi.fn(),
  retire: vi.fn(),
}));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("../../modules/phone-browser/index.js", () => ({
  phoneBrowser: new FakePhoneBrowserNative("android"),
}));
vi.mock("../platform/phone-connection.js", () => ({
  phoneConnection: {},
  retryPhoneRetirement: state.retire,
  setPhoneRetirementHandler: () => () => {},
  androidPhoneBridge: {
    getSnapshot: () => state.snapshot,
    prepare: state.prepare,
    subscribe: (listener: () => void) => {
      state.listeners.add(listener);
      return () => {
        state.listeners.delete(listener);
      };
    },
  },
}));
import { createAndroidBrowserPlatform } from "./android-platform.js";

beforeEach(() => {
  vi.clearAllMocks();
  state.snapshot = {
    supported: false,
    enrollment: {
      deploymentId: "enrolled-not-viewed",
      runnerId: "runner",
      state: "pending",
      name: "Phone",
      enrollmentId: "enrollment",
      deploymentName: "Home",
      hostUrl: "https://host.invalid",
    },
  };
  state.retire.mockResolvedValue(undefined);
  state.prepare.mockResolvedValue({ runnerId: "runner", mintKey: "idempotency" });
});

test("registration is event-driven, retirement precedes prepare, and pending enrollment starts qualification", async () => {
  const platform = createAndroidBrowserPlatform()!;
  expect(platform.getEnrollment()).toEqual(state.snapshot.enrollment);
  const loading = platform.loadNativePort();
  await vi.waitFor(() => expect(state.listeners.size).toBe(1));
  expect(state.prepare).not.toHaveBeenCalled();
  expect(state.retire).not.toHaveBeenCalled();
  state.snapshot = { ...state.snapshot, supported: true };
  for (const listener of state.listeners) listener();
  await loading;
  expect(state.prepare).toHaveBeenCalledWith({ deploymentId: "enrolled-not-viewed" });
  expect(state.retire.mock.invocationCallOrder[0]).toBeLessThan(
    state.prepare.mock.invocationCallOrder[0]!,
  );
  expect(state.listeners.size).toBe(0);
});

test("pending erasure prevents preparing or qualifying a replacement identity", async () => {
  state.snapshot = { ...state.snapshot, supported: true };
  state.retire.mockRejectedValue(new Error("erasure-pending"));
  await expect(createAndroidBrowserPlatform()!.loadNativePort()).rejects.toThrow("erasure-pending");
  expect(state.prepare).not.toHaveBeenCalled();
});

test("an enrollment replacement during preparation cannot initialize the previous runner", async () => {
  state.snapshot = { ...state.snapshot, supported: true };
  state.prepare.mockResolvedValue({ runnerId: "replacement", mintKey: "idempotency" });
  await expect(createAndroidBrowserPlatform()!.loadNativePort()).rejects.toThrow(
    "enrollment changed",
  );
});
