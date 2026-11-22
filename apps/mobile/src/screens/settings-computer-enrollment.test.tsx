// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
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
  NotificationFeedbackType: { Error: "error", Success: "success", Warning: "warning" },
  notificationAsync: async () => undefined,
  selectionAsync: async () => undefined,
}));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
const { SettingsComputerEnrollment } = await import("./settings-computer-enrollment.js");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it("issues only after a tap and discards the enrollment command on dismissal", async () => {
  const host = new MockHostClient({ latencyMs: 0 });
  await host.load();
  const target = vi.fn(async () => ({
    ok: true,
    data: {
      deploymentId: "dep_0192f4a1-1111-4111-8111-111111111111",
      deploymentName: "Home",
      hostInstanceId: "hst_test",
      hostUrl: "https://reachable.example",
    },
  }));
  Object.defineProperty(host, "rpc", {
    value: new Proxy(host.rpc, {
      get: (rpc, key) => (key === "agentPhone.target.get" ? target : Reflect.get(rpc, key)),
    }),
  });
  const dispatch = vi.spyOn(host, "dispatch");
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<SettingsComputerEnrollment host={host} />));
    expect(dispatch).not.toHaveBeenCalled();
    const create = [...container.querySelectorAll("[data-pressable]")].find(
      (element) => element.textContent === "Create connection command",
    ) as HTMLElement | undefined;
    if (!create) throw new Error(`Missing create action: ${container.textContent}`);
    await act(async () => create.click());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "runner.enrollment.createLocal",
        allowedModules: ["agents", "shell"],
      }),
    );
    expect(target).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("https://reachable.example");
    expect(container.textContent).not.toContain("localhost");
    expect(container.textContent).toContain("OPENSTEER_RUNNER_ENROLLMENT_TOKEN");
    await act(async () => root.render(<SettingsComputerEnrollment key="new-sheet" host={host} />));
    expect(container.textContent).not.toContain("OPENSTEER_RUNNER_ENROLLMENT_TOKEN");
  } finally {
    act(() => root.unmount());
    host.dispose();
  }
});
