// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  MockCloudComputerAccount,
  mockCloudComputerAddress,
  mockCloudComputerId,
  type MockCloudComputerScene,
} from "@opensteer/client/mock";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  NativeSettingsPageProps,
  NativeSettingsRow,
  NativeSettingsSection,
} from "./native-settings-page.types.js";

interface AlertButton {
  readonly text: string;
  readonly onPress?: () => void;
}
const state = vi.hoisted(() => ({
  page: null as NativeSettingsPageProps | null,
  sheet: null as NativeSettingsPageProps | null,
  alerts: [] as { title: string; buttons: readonly AlertButton[] }[],
  appState: null as ((state: string) => void) | null,
  client: null as unknown,
  rows: [] as { deploymentId: string; origin: string }[],
  navigate: vi.fn(),
  goBack: vi.fn(),
  reset: vi.fn(),
  copy: vi.fn(async () => undefined),
}));

vi.mock("react-native", () => ({
  Alert: {
    alert: (title: string, _body: string, buttons: readonly AlertButton[]) =>
      state.alerts.push({ title, buttons }),
  },
  AppState: {
    addEventListener: (_event: string, listener: (value: string) => void) => {
      state.appState = listener;
      return { remove: () => (state.appState = null) };
    },
  },
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: state.navigate, goBack: state.goBack }),
}));
vi.mock("../navigation-ref.js", () => ({ resetToDeployment: state.reset }));
vi.mock("../ui/copy-mark.js", () => ({ useCopy: () => ({ copied: false, copy: state.copy }) }));
vi.mock("../ui/mobile-client-context.js", () => ({
  useMobileClient: () => state.client,
  useMobileState: () => ({ rows: state.rows }),
}));
vi.mock("./native-settings-page.js", async () => {
  const { useEffect } = await import("react");
  return {
    NativeSettingsPage: (props: NativeSettingsPageProps) => {
      const sheet = props.sheet !== undefined;
      if (sheet) state.sheet = props;
      else state.page = props;
      useEffect(
        () => () => {
          if (sheet) state.sheet = null;
        },
        [sheet],
      );
      return null;
    },
  };
});

const { CloudComputerScreen } = await import("./cloud-computer.js");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
  state.page = null;
  state.sheet = null;
  state.alerts = [];
  state.rows = [];
  vi.clearAllMocks();
});

const cloudDeployment = "dep_00000000-0000-4000-8000-0000000000cc";

async function open(
  scene: MockCloudComputerScene,
  options: { readonly listed?: boolean; readonly portalOrigin?: string | null } = {},
) {
  const account = new MockCloudComputerAccount(scene);
  const read = vi.spyOn(account, "read");
  const actSpy = vi.spyOn(account, "act");
  state.client = {
    cloudComputers: account,
    portalOrigin:
      options.portalOrigin === undefined ? "https://app.opensteer.example" : options.portalOrigin,
    openDeployment: vi.fn(async () => undefined),
  };
  if (options.listed !== false)
    state.rows = [{ deploymentId: cloudDeployment, origin: mockCloudComputerAddress }];
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(<CloudComputerScreen />));
  await vi.waitFor(() => expect(section("loading")).toBeUndefined());
  return { account, read, act: actSpy };
}
function section(key: string, page = state.page): NativeSettingsSection | undefined {
  return page?.sections.find((candidate) => candidate.key === key);
}
function row(sectionKey: string, key: string, page = state.page): NativeSettingsRow {
  const found = section(sectionKey, page)?.rows.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`no row ${sectionKey}/${key}`);
  return found;
}
async function press(target: NativeSettingsRow) {
  if (target.kind !== "button") throw new Error(`${target.kind} can't be pressed`);
  await act(async () => target.onPress());
}

describe("Opensteer Cloud Computer on the phone", () => {
  it("says what it is, its price from the plan, what changes, and the website to set it up on, with no purchase button", async () => {
    await open("none");
    expect(section("points")?.rows.map((candidate) => candidate.label)).toEqual([
      "Works while your Mac sleeps",
      "A browser with a steady address",
      "Encrypted backups",
      "Your Mac stays connected",
    ]);
    expect(row("price", "price")).toMatchObject({ label: "$20.00 a month" });
    expect(section("changes")?.rows[0]?.label).toContain(
      "Your Cloud Computer starts as a new Opensteer.",
    );
    expect(row("website-checkout", "address")).toMatchObject({
      kind: "status",
      detail: "https://app.opensteer.example/cloud-computer/checkout",
    });
    expect(section("website-checkout")?.footer?.text).toContain(
      "Set up your Cloud Computer on the Opensteer website",
    );
    const labels = state.page!.sections.flatMap((candidate) => candidate.rows.map((r) => r.label));
    expect(labels).not.toContain("Continue to checkout");
    await press(row("website-checkout", "copy"));
    expect(state.copy).toHaveBeenCalledWith(
      "https://app.opensteer.example/cloud-computer/checkout",
    );
  });

  it("reads again whenever the person comes back to the app", async () => {
    const { read } = await open("none");
    await act(async () => state.appState!("active"));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("shows one honest step while preparing", async () => {
    await open("preparing");
    expect(row("preparing", "status")).toMatchObject({
      label: "Preparing your Cloud Computer",
      steps: [
        { label: "Setting up your computer", state: "current" },
        { label: "Ready", state: "pending" },
      ],
    });
  });

  it("is ready: opens the Home and its Connected agents through the existing open-a-Home path", async () => {
    await open("ready");
    await press(row("ready", "open"));
    const client = state.client as { openDeployment: ReturnType<typeof vi.fn> };
    expect(client.openDeployment).toHaveBeenCalledWith(cloudDeployment);
    await vi.waitFor(() => expect(state.reset).toHaveBeenCalledWith(cloudDeployment));
    await press(row("ready", "agents"));
    await vi.waitFor(() =>
      expect(state.navigate).toHaveBeenCalledWith("SettingsExternalAgents", {
        deploymentId: cloudDeployment,
      }),
    );
    expect(row("status", "status")).toMatchObject({
      label: "Running",
      tone: "good",
      detail: mockCloudComputerAddress,
    });
    expect(row("status", "ip").label).toBe("Browser IP · Assigned");
    expect(row("plan", "plan").label).toBe("$20.00 a month");
    expect(row("website-billing", "address")).toMatchObject({
      detail: "https://app.opensteer.example/cloud-computer/billing",
    });
  });

  it("says when the Account hasn't listed it yet", async () => {
    await open("ready", { listed: false });
    expect(row("ready", "open")).toMatchObject({ disabled: true });
    expect(section("ready")?.footer?.text).toContain("It isn’t in your Opensteer list yet.");
  });

  it("suspends after confirming, then resumes", async () => {
    const { act: acted } = await open("ready");
    await press(row("power", "suspend"));
    expect(state.alerts.at(-1)?.title).toBe("Suspend Cloud Computer?");
    expect(acted).not.toHaveBeenCalled();
    await act(async () =>
      state.alerts.at(-1)!.buttons.find((button) => button.text === "Suspend")!.onPress!(),
    );
    expect(acted).toHaveBeenCalledWith({ action: "suspend", id: mockCloudComputerId });
    await vi.waitFor(() => expect(row("status", "status").label).toBe("Suspended"));
    expect(section("status")?.footer?.text).toBe("Suspended by you.");
    await press(row("power", "resume"));
    expect(acted).toHaveBeenLastCalledWith({ action: "resume", id: mockCloudComputerId });
  });

  it("deletes only once the word is typed, in a sheet that works on both phones", async () => {
    const { act: acted } = await open("ready");
    await press(row("power", "delete"));
    expect(state.sheet?.sheet?.title).toBe("Delete Cloud Computer?");
    expect(row("delete", "confirm", state.sheet)).toMatchObject({ disabled: true });
    const word = row("delete", "word", state.sheet);
    if (word.kind !== "input") throw new Error("not an input");
    await act(async () => word.onChange("delete"));
    expect(row("delete", "confirm", state.sheet)).toMatchObject({
      disabled: false,
      destructive: true,
    });
    await press(row("delete", "confirm", state.sheet));
    expect(acted).toHaveBeenCalledWith({
      action: "delete",
      id: mockCloudComputerId,
      confirmation: `DELETE:${mockCloudComputerId}`,
    });
    await vi.waitFor(() =>
      expect(section("deleted")?.footer?.text).toBe("Your Cloud Computer was deleted."),
    );
  });

  it("shows the Account's refusal as it is", async () => {
    await open("refused");
    await press(row("power", "suspend"));
    await act(async () =>
      state.alerts.at(-1)!.buttons.find((button) => button.text === "Suspend")!.onPress!(),
    );
    await vi.waitFor(() =>
      expect(section("power")?.footer).toEqual({
        text: "Cloud Computers can’t be changed right now. Try again later.",
        tone: "danger",
      }),
    );
  });

  it("shows needs attention with the Account's reason", async () => {
    await open("attention");
    expect(row("status", "status")).toMatchObject({ label: "Needs attention", tone: "attention" });
    expect(section("status")?.footer?.text).toContain("The computer didn’t start in time.");
    expect(row("status", "ip").label).toBe("Browser IP · Browsing paused");
    expect(section("ready")).toBeUndefined();
  });

  it("says signed out, unreachable and no Account, each with its one way on", async () => {
    await open("signed-out");
    expect(section("failed")?.footer).toMatchObject({ tone: "danger" });
    expect(row("failed", "sign-in").label).toBe("Sign in");
    act(() => root?.unmount());
    const { read } = await open("unreachable");
    expect(section("failed")?.footer?.text).toBe(
      "Opensteer Account isn’t answering. Try again in a moment.",
    );
    await press(row("failed", "retry"));
    expect(read).toHaveBeenCalledTimes(2);
    act(() => root?.unmount());
    await open("unavailable");
    expect(section("failed")?.rows).toEqual([]);
    expect(section("failed")?.footer?.text).toBe(
      "This build of Opensteer has no Opensteer Account.",
    );
  });

  it("names no website it doesn't have", async () => {
    await open("none", { portalOrigin: null });
    expect(section("website-checkout")?.rows).toEqual([]);
  });
});
