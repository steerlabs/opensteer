// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
import type { NativeSettingsPageProps, NativeSettingsRow } from "./native-settings-page.types.js";
const state = vi.hoisted(() => ({
  account: { identity: null, available: false } as object,
  openURL: vi.fn(async () => undefined),
  page: null as NativeSettingsPageProps | null,
  remote: null as import("@opensteer/protocol").PersonalRemoteAdministrationStatus | null,
  request: vi.fn(async () => undefined),
  calls: [] as string[],
  navigate: vi.fn(),
  remove: vi.fn(async () => undefined),
  host: null as MockHostClient | null,
}));
vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  Linking: { openURL: state.openURL },
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: state.navigate, goBack: vi.fn() }),
}));
vi.mock("@opensteer/client/react", async (original) => ({
  ...(await original<typeof import("@opensteer/client/react")>()),
  usePersonalRemoteAccess: () => ({
    status: state.remote,
    pairing: null,
    error: null,
    working: false,
    request: state.request,
  }),
}));
vi.mock("../client/mobile-client.js", () => ({ operationDetail: () => "Failed" }));
const mobile = {
  getSnapshot: () => ({ selection: { hostClient: state.host } }),
  portalOrigin: "https://portal.test",
  removeHostSession: state.remove,
  signInAccount: vi.fn(async () => void state.calls.push("sign-in")),
  linkSelectedPersonalAccount: vi.fn(async () => void state.calls.push("link")),
};
vi.mock("../ui/mobile-client-context.js", () => ({
  useMobileClient: () => mobile,
  useMobileState: () => ({
    account: { account: state.account },
    selection: { hostClient: state.host, deploymentId: "deployment" },
  }),
}));
vi.mock("../ui/notifications-context.js", () => ({ useMobileNotifications: () => ({}) }));
vi.mock("./native-settings-page.js", () => ({
  NativeSettingsPage: (props: NativeSettingsPageProps) => {
    if (!props.sheet) state.page = props;
    return null;
  },
}));
const { AccountSettingsController } = await import("./settings-account-controller.js");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const signedIn = {
  available: true,
  detail: null,
  identity: { email: "person@example.test", issuer: "https://accounts.test", subject: "acct" },
  status: "signed-in",
};

afterEach(() => {
  state.host?.dispose();
  state.host = null;
  state.remote = null;
  state.account = { identity: null, available: false };
  state.calls = [];
  state.request.mockClear();
  mobile.signInAccount.mockClear();
  mobile.linkSelectedPersonalAccount.mockClear();
});

async function mount(element: React.ReactElement) {
  const host = new MockHostClient({ latencyMs: 0 });
  await host.load();
  state.host = host;
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(element));
  return root;
}

function row(section: string, key: string): NativeSettingsRow {
  const found = state
    .page!.sections.find((candidate) => candidate.key === section)
    ?.rows.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`Missing ${section}/${key}`);
  return found;
}

function press(found: NativeSettingsRow): Promise<void> {
  if (!("onPress" in found)) throw new Error(`${found.key} is not pressable`);
  return act(async () => found.onPress());
}

it("pushes session identity only, then confirms Sign out in its detail", async () => {
  const root = await mount(<AccountSettingsController />);
  try {
    const first = state.page!.sections.find((section) => section.key === "sessions")!.rows[0]!;
    await press(first);
    expect(state.navigate).toHaveBeenCalledWith("SettingsSessionDetail", {
      deploymentId: "deployment",
      sessionId: first.key,
    });
    await act(async () => root.render(<AccountSettingsController sessionId={first.key} />));
    await press(row("session", "sign-out"));
    expect(state.remove).not.toHaveBeenCalled();
    const { Alert } = await import("react-native");
    const confirm = vi
      .mocked(Alert.alert)
      .mock.calls.at(-1)![2]!
      .find((button) => button.style === "destructive")!;
    await act(async () => confirm.onPress?.());
    expect(state.remove).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
  }
});

it("sends only a signed-in person to the portal to delete their Account", async () => {
  state.account = { available: true, detail: null, identity: null, status: "signed-out" };
  const root = await mount(<AccountSettingsController />);
  try {
    expect(state.page!.sections.some((section) => section.key === "account-actions")).toBe(false);
    state.account = signedIn;
    await act(async () => root.render(<AccountSettingsController key="signed-in" />));
    await press(row("account-actions", "account-delete"));
    expect(state.openURL).toHaveBeenCalledWith("https://portal.test/account/delete");
  } finally {
    act(() => root.unmount());
  }
});
