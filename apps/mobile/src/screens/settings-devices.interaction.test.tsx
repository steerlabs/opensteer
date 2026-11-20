// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
import type { HomeKindFact } from "@opensteer/client/computers";
import type { HostClient, HostSnapshot } from "@opensteer/client/host";
import type { NativeSettingsPageProps, NativeSettingsRow } from "./native-settings-page.types.js";

const state = vi.hoisted(() => ({
  host: null as HostClient | null,
  page: null as NativeSettingsPageProps | null,
  home: null as HomeKindFact | null,
  navigated: [] as { route: string; params: unknown }[],
}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" }, Alert: { alert: () => undefined } }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({
    setOptions: () => undefined,
    navigate: (route: string, params: unknown) => state.navigated.push({ route, params }),
  }),
}));
vi.mock("../navigation-header.js", () => ({ headerActions: () => ({}) }));
vi.mock("../ui/mobile-client-context.js", () => ({
  useMobileClient: () => ({}),
  useMobileState: () => ({
    rows: [{ deploymentId: "dep_fixture", name: "Opensteer" }],
    selection: { deploymentId: "dep_fixture", hostClient: state.host },
  }),
  useHostValue: <T,>(
    host: HostClient | null,
    select: (snapshot: HostSnapshot) => T,
    detached: T,
  ) => (host === null ? detached : select(host.getSnapshot())),
}));
vi.mock("../computers/home-kind.js", () => ({
  selectHomeExposure: () => undefined,
  selectHomeKind: () => undefined,
  selectHomeDeploymentId: () => null,
  usePhoneHome: () => ({ kind: state.home, computer: null }),
}));
vi.mock("../iphone-apps/context.js", () => ({
  useIphoneApps: () => ({}),
  useIphoneAppsState: () => ({ snapshot: { enrollment: null, deviceName: "Alex's iPhone" } }),
}));
vi.mock("../phone-setup/phone-setup.js", () => ({ phoneMembership: () => ({ state: "none" }) }));
vi.mock("../phone-setup/move-phone-here.js", () => ({ movePhoneHere: async () => undefined }));
vi.mock("./leave-sheets.js", () => ({ useLeaveSheets: () => ({}) }));
vi.mock("../ui/sheet.js", () => ({ Sheet: () => null }));
vi.mock("./settings-computer-enrollment.js", () => ({ SettingsComputerEnrollment: () => null }));
vi.mock("./native-settings-page.js", () => ({
  NativeSettingsPage: (props: NativeSettingsPageProps) => {
    if (props.sections.some(({ key }) => key === "home")) state.page = props;
    return null;
  },
}));
const { DevicesSettingsController } = await import("./settings-devices-controller.js");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  state.page = null;
  state.host = null;
  state.home = null;
  state.navigated.length = 0;
});

async function render(home: HomeKindFact, run: () => Promise<void>) {
  const host = new MockHostClient({ latencyMs: 0 });
  host.connection.start();
  await vi.waitFor(() => expect(host.connection.getSnapshot().phase).toBe("ready"), {
    timeout: 2000,
  });
  await vi.waitFor(() => expect(host.getSnapshot().machines.length).toBeGreaterThan(0));
  state.host = host;
  state.home = home;
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<DevicesSettingsController />));
    await vi.waitFor(() => expect(state.page).not.toBeNull());
    await run();
  } finally {
    act(() => root.unmount());
    host.dispose();
  }
}

const section = (key: string) => state.page!.sections.find((candidate) => candidate.key === key);
const label = (row: NativeSettingsRow) =>
  row.kind === "button" ? `${row.label} — ${row.detail ?? ""}` : row.label;

it("leads with the Home, says where Opensteer lives, then lists every other Device", async () => {
  await render({ kind: "mac", from: "exposure", organization: null }, async () => {
    const home = section("home");
    expect(home?.title).toBe("Home");
    expect(home?.rows.map(label)).toEqual(["Mac mini — Home · Online"]);
    expect(home?.footer?.text).toBe(
      "Your Opensteer lives on Mac mini. Agents reach your other devices through it.",
    );
    const devices = section("devices");
    expect(devices?.title).toBe("Devices");
    const lines = devices!.rows.map(label);
    expect(lines.some((line) => line.startsWith("Alex's MacBook Pro — Online"))).toBe(true);
    expect(lines.some((line) => line.startsWith("Studio iMac — Offline"))).toBe(true);
    expect(lines.some((line) => line.startsWith("Mac mini"))).toBe(false);

    const row = home!.rows[0];
    if (row?.kind !== "button") throw new Error("The Home row does not open");
    await act(async () => row.onPress());
    expect(state.navigated).toEqual([
      {
        route: "SettingsDeviceDetail",
        params: {
          deploymentId: "dep_fixture",
          machineId: "rnr_11111111-1111-4111-8111-111111111111",
        },
      },
    ]);
  });
});

it("names a Cloud Computer Home and a work Home for what they are", async () => {
  await render({ kind: "cloud", from: "account", organization: null }, async () => {
    expect(section("home")?.rows.map(label)).toEqual(["Cloud Computer — Home · Always on"]);
  });
  await render({ kind: "work", from: "account", organization: "Acme" }, async () => {
    expect(section("home")?.rows.map(label)).toEqual(["Work Home — Home · Always on"]);
    expect(section("home")?.footer?.text).toContain("your Acme work Home");
  });
});
