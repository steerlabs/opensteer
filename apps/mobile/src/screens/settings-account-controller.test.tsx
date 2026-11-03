// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
import type { NativeSettingsPageProps } from "./native-settings-page.types.js";
const state = vi.hoisted(() => ({
  page: null as NativeSettingsPageProps | null,
  navigate: vi.fn(),
  remove: vi.fn(async () => undefined),
  host: null as MockHostClient | null,
}));
vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  TextInput: () => null,
  View: () => null,
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: state.navigate }),
}));
vi.mock("@opensteer/client/react", () => ({
  usePersonalRemoteAccess: () => ({ status: null, pairing: null, error: null, working: false }),
}));
vi.mock("../client/mobile-client.js", () => ({ operationDetail: () => "Failed" }));
const mobile = {
  getSnapshot: () => ({ selection: { hostClient: state.host } }),
  removeHostSession: state.remove,
};
vi.mock("../ui/mobile-client-context.js", () => ({
  useMobileClient: () => mobile,
  useMobileState: () => ({
    account: { account: { identity: null, available: false } },
    selection: { hostClient: state.host, deploymentId: "deployment" },
  }),
}));
vi.mock("../ui/notifications-context.js", () => ({ useMobileNotifications: () => ({}) }));
vi.mock("../ui/primitives.js", () => ({ AppText: () => null, SecondaryButton: () => null }));
vi.mock("../ui/sheet.js", () => ({ Sheet: () => null }));
vi.mock("./native-settings-page.js", () => ({
  NativeSettingsPage: (props: NativeSettingsPageProps) => {
    state.page = props;
    return null;
  },
}));
const { AccountSettingsController } = await import("./settings-account-controller.js");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it("pushes session identity only, then reviews sign-out effects in its detail", async () => {
  const host = new MockHostClient({ latencyMs: 0 });
  await host.load();
  state.host = host;
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<AccountSettingsController />));
    const sessions = state.page!.sections.find((section) => section.key === "sessions")!;
    const first = sessions.rows[0]!;
    expect(first.kind).toBe("button");
    if (first.kind !== "button") throw new Error("Missing session");
    await act(async () => first.onPress());
    expect(state.navigate).toHaveBeenCalledWith("SettingsSessionDetail", {
      deploymentId: "deployment",
      sessionId: first.key,
    });
    await act(async () =>
      root.render(<AccountSettingsController detail="session" sessionId={first.key} />),
    );
    const signOut = state.page!.sections[0]!.rows.find((row) => row.label === "Sign out")!;
    if (signOut.kind !== "button") throw new Error("Missing sign-out");
    await act(async () => signOut.onPress());
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
    host.dispose();
    state.host = null;
  }
});
