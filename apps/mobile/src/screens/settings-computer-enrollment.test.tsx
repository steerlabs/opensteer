// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
import type { NativeSettingsPageProps } from "./native-settings-page.types.js";
const state = vi.hoisted(() => ({ page: null as NativeSettingsPageProps | null }));
vi.mock("react-native", () => ({ Text: "span", View: "div" }));
vi.mock("./use-settings-read.js", () => ({ useSettingsLease: () => () => true }));
vi.mock("./native-settings-page.js", () => ({
  NativeSettingsPage: (props: NativeSettingsPageProps) => {
    state.page = props;
    return null;
  },
}));
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
    const create = state.page!.sections[0]!.rows.find((row) => row.kind === "button")!;
    if (create.kind !== "button") throw new Error("Missing create action");
    await act(async () => create.onPress());
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
