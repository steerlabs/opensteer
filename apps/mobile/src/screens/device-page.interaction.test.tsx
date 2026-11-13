// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
import type { HostClient } from "@opensteer/client/host";
import type { NativeSettingsPageProps } from "./native-settings-page.types.js";

const state = vi.hoisted(() => ({
  host: null as HostClient | null,
  page: null as NativeSettingsPageProps | null,
  goBack: vi.fn(),
}));
vi.mock("react-native", () => ({ Platform: { OS: "android" }, Linking: {} }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ setOptions: () => undefined, goBack: state.goBack }),
}));
vi.mock("./deployment-gate.js", () => ({
  useAttachedHost: () => state.host,
  DeploymentGate: () => null,
}));
vi.mock("../ui/mobile-client-context.js", () => ({
  useMobileClient: () => ({}),
  useMobileState: () => ({ rows: [] }),
}));
vi.mock("../iphone-apps/context.js", () => ({
  useIphoneApps: () => ({}),
  useIphoneAppsState: () => ({ snapshot: { enrollment: null } }),
}));
vi.mock("../computers/use-computer-use-data.js", () => ({ useComputerUseData: () => ({}) }));
vi.mock("../navigation-ref.js", () => ({ resetToDeployments: () => undefined }));
vi.mock("../ui/notifications-context.js", () => ({
  useMobileNotifications: () => ({}),
  usePushRegistration: () => ({
    status: "signed-out",
    preferences: { approvalsEnabled: false, runOutcomesEnabled: false },
  }),
}));
vi.mock("./native-settings-page.js", () => ({
  NativeSettingsPage: (props: NativeSettingsPageProps) => {
    state.page = props;
    return null;
  },
}));
const { DevicePageScreen } = await import("./device-page.js");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => {
  state.goBack.mockClear();
  state.page = null;
  state.host = null;
});

it("keeps native Cancel setup on the device page when redemption won", async () => {
  const host = new MockHostClient({ latencyMs: 0 });
  const minted = await host.dispatch({
    type: "runner.enrollment.createLocal",
    name: "Server",
    allowedModules: ["shell"],
    idempotencyKey: "pending",
  });
  if (minted.type !== "runner.enrollment.createLocal") throw new Error("Setup was not minted");
  const send = host.dispatch.bind(host);
  const dispatch = vi.spyOn(host, "dispatch").mockImplementation(async (command) => {
    if (command.type === "runner.enrollment.retire") host.connectLocalRunner(minted.token);
    return send(command);
  });
  const refresh = vi.spyOn(host, "refresh");
  state.host = host;
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () =>
      root.render(
        <DevicePageScreen
          route={{ params: { deploymentId: "dep_fixture", machineId: minted.enrollmentId } }}
        />,
      ),
    );
    const cancel = state
      .page!.sections.flatMap(({ rows }) => rows)
      .find(({ key }) => key === "cancel");
    if (cancel?.kind !== "button") throw new Error("Cancel setup was not offered");
    await act(async () => cancel.onPress());
    await vi.waitFor(
      async () => {
        await act(async () => undefined);
        expect(
          state
            .page!.sections.flatMap(({ rows }) => rows)
            .some((row) => row.kind === "text" && row.label.includes("finished joining")),
          "The consumed setup notice never appeared",
        ).toBe(true);
      },
      { timeout: 1000 },
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "runner.enrollment.retire",
        enrollmentId: minted.enrollmentId,
      }),
    );
    expect(refresh).toHaveBeenCalled();
    expect(state.goBack).not.toHaveBeenCalled();
    expect(
      state
        .page!.sections.flatMap(({ rows }) => rows)
        .some((row) => row.kind === "text" && row.label.includes("finished joining")),
    ).toBe(true);
  } finally {
    act(() => root.unmount());
    host.dispose();
  }
});

it("refreshes and explains a conflicting device-page switch without retrying the edit", async () => {
  const host = new MockHostClient({ latencyMs: 0, devices: "seeded" });
  const machine = host
    .getSnapshot()
    .machines.find((entry) => entry.kind !== "home" && entry.status !== "pending" && entry.access)!;
  const update = vi.spyOn(host, "updateMachineAccess").mockResolvedValue({ outcome: "conflict" });
  const refresh = vi.spyOn(host, "refresh");
  state.host = host;
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () =>
      root.render(
        <DevicePageScreen
          route={{ params: { deploymentId: "dep_fixture", machineId: machine.id } }}
        />,
      ),
    );
    const toggle = state
      .page!.sections.flatMap(({ rows }) => rows)
      .find((row) => row.kind === "toggle");
    if (toggle?.kind !== "toggle") throw new Error("Device switch was not offered");
    await act(async () => {
      toggle.onChange(!toggle.value);
    });
    await vi.waitFor(
      async () => {
        await act(async () => undefined);
        expect(
          state.page!.sections.some(({ footer }) =>
            footer?.text.includes("changed on another device"),
          ),
          "The policy conflict notice never appeared",
        ).toBe(true);
      },
      { timeout: 1000 },
    );
    expect(update).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalled();
    expect(
      state.page!.sections.some(({ footer }) => footer?.text.includes("changed on another device")),
    ).toBe(true);
  } finally {
    act(() => root.unmount());
    host.dispose();
  }
});
