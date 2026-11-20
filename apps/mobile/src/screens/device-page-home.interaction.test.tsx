// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
import type { HomeKindFact } from "@opensteer/client/computers";
import type { CloudComputerView } from "@opensteer/control-plane-protocol";
import type { HostClient } from "@opensteer/client/host";
import type { NativeSettingsPageProps, NativeSettingsRow } from "./native-settings-page.types.js";

type AlertButton = { readonly text: string; readonly onPress?: () => void };
const state = vi.hoisted(() => ({
  host: null as HostClient | null,
  page: null as NativeSettingsPageProps | null,
  home: null as { kind: HomeKindFact; computer: CloudComputerView | null } | null,
  alerts: [] as { title: string; buttons: readonly AlertButton[] }[],
  navigated: [] as string[],
}));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  Linking: {},
  Alert: {
    alert: (title: string, _message: string, buttons: readonly AlertButton[]) =>
      state.alerts.push({ title, buttons }),
  },
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({
    setOptions: () => undefined,
    goBack: () => undefined,
    navigate: (route: string) => state.navigated.push(route),
  }),
}));
vi.mock("./deployment-gate.js", () => ({
  useAttachedHost: () => state.host,
  DeploymentGate: () => null,
}));
vi.mock("../ui/mobile-client-context.js", () => ({
  useMobileClient: () => ({}),
  useMobileState: () => ({ rows: [] }),
}));
vi.mock("../computers/home-kind.js", () => ({
  selectHomeExposure: () => undefined,
  selectHomeKind: () => undefined,
  selectHomeDeploymentId: () => null,
  usePhoneHome: () => state.home,
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

const homeMac = "rnr_11111111-1111-4111-8111-111111111111";
const laptop = "rnr_33333333-3333-4333-8333-333333333333";
const fact = (kind: HomeKindFact["kind"]): HomeKindFact => ({
  kind,
  from: kind === "cloud" ? "account" : "exposure",
  organization: null,
});

afterEach(() => {
  state.page = null;
  state.host = null;
  state.home = null;
  state.alerts.length = 0;
  state.navigated.length = 0;
});

async function open(machineId: string, run: (host: MockHostClient) => Promise<void>) {
  const host = new MockHostClient({ latencyMs: 0 });
  host.connection.start();
  await vi.waitFor(() => expect(host.connection.getSnapshot().phase).toBe("ready"), {
    timeout: 2000,
  });
  await vi.waitFor(() =>
    expect(host.getSnapshot().machines.some(({ id }) => id === machineId)).toBe(true),
  );
  state.host = host;
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () =>
      root.render(
        <DevicePageScreen route={{ params: { deploymentId: "dep_fixture", machineId } }} />,
      ),
    );
    await run(host);
  } finally {
    act(() => root.unmount());
    host.dispose();
  }
}

const rows = (): readonly NativeSettingsRow[] => state.page!.sections.flatMap(({ rows }) => rows);
const keys = () => rows().map(({ key }) => key);

it("says under the switches what connected agents also need, and offers Who can use it as chips", async () => {
  state.home = { kind: fact("mac"), computer: null };
  await open(laptop, async (host) => {
    const agent = state.page!.sections.find(({ key }) => key === "agent");
    expect(agent?.footer?.text).toContain(
      "Connected agents also need you to choose this device’s profile or app for them.",
    );
    const reach = rows().find(({ key }) => key === "reach");
    if (reach?.kind !== "chips") throw new Error("Who can use it was not a chips row");
    expect(reach.label).toBe("Who can use it");
    expect(reach.value).toBe("owner");
    expect(reach.choices.map(({ value }) => value)).toEqual(["nobody", "owner", "deployment"]);

    const update = vi.spyOn(host, "updateMachineAccess");
    await act(async () => reach.onChange("owner"));
    expect(state.alerts).toHaveLength(0);
    await act(async () => reach.onChange("deployment"));
    expect(state.alerts[0]?.title).toBe("Change device access?");
    expect(update).not.toHaveBeenCalled();
    await act(async () =>
      state.alerts[0]?.buttons.find(({ text }) => text === "Apply")?.onPress?.(),
    );
    await vi.waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceId: laptop,
          policy: expect.objectContaining({ reach: "deployment" }),
        }),
      ),
    );
  });
});

it("shows a Mac Home its Remote access and the Cloud Computer entry, and nothing a server shows", async () => {
  state.home = { kind: fact("mac"), computer: null };
  await open(homeMac, async () => {
    expect(keys()).toContain("remote-access");
    expect(keys()).toContain("cloud-computer");
    expect(keys()).not.toContain("address");
    const remote = rows().find(({ key }) => key === "remote-access");
    if (remote?.kind !== "button") throw new Error("Remote access was not a row");
    await act(async () => remote.onPress());
    expect(state.navigated).toEqual(["SettingsAccount"]);
  });
});

it("shows a server Home its address and owner, never Remote access or the Cloud Computer offer", async () => {
  state.home = { kind: fact("server"), computer: null };
  await open(homeMac, async (host) => {
    const address = rows().find(({ key }) => key === "address");
    expect(address).toMatchObject({
      label: "Address",
      detail: host.getSnapshot().identityConfig?.publicOrigin,
    });
    expect(keys()).not.toContain("remote-access");
    expect(keys()).not.toContain("cloud-computer");
  });
});

it("shows a Cloud Computer Home its status, and never the Cloud Computer offer", async () => {
  state.home = {
    kind: fact("cloud"),
    computer: {
      id: "cc_00000000-0000-4000-8000-000000000002",
      egress: "assigned",
      status: "suspended",
      reason: "You suspended this Cloud Computer.",
      reasonCode: "cloud-computer-owner-suspended",
    } as CloudComputerView,
  };
  await open(homeMac, async () => {
    const status = rows().find(({ key }) => key === "cloud-status");
    expect(status).toMatchObject({
      label: "Opensteer Cloud Computer",
      detail: "Suspended · You suspended this Cloud Computer.",
    });
    expect(keys()).not.toContain("cloud-computer");
    expect(keys()).not.toContain("remote-access");
  });
});
