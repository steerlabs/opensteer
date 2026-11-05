// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { UserIdSchema } from "@opensteer/core";
import { MockHostClient } from "@opensteer/client/mock";
import type { NativeSettingsPageProps } from "./native-settings-page.types.js";
const state = vi.hoisted(() => ({
  page: null as NativeSettingsPageProps | null,
  remote: null as import("@opensteer/protocol").PersonalRemoteAdministrationStatus | null,
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
vi.mock("@opensteer/client/react", async (importOriginal) => ({
  useConnectedAgents: (await importOriginal<typeof import("@opensteer/client/react")>())
    .useConnectedAgents,
  usePersonalRemoteAccess: () => ({
    status: state.remote,
    pairing: null,
    error: null,
    working: false,
  }),
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

it("keeps failed requested mode separate from committed access and exposes retry", async () => {
  const host = new MockHostClient({ latencyMs: 0 });
  await host.load();
  state.host = host;
  const result = await host.rpc["personal.remoteAccess.get"]({});
  if (!result.ok) throw new Error("Remote fixture missing");
  state.remote = {
    ...result.data,
    operation: {
      id: "00000000-0000-4000-8000-000000000001",
      executionId: "00000000-0000-4000-8000-000000000002",
      intent: { action: "configure", mode: "private", privateOrigin: "https://private.example" },
      state: "failed",
      detail: "Computer unavailable",
    },
  };
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<AccountSettingsController detail="remote" />));
    const labels = state.page!.sections.flatMap((section) => section.rows.map((row) => row.label));
    expect(labels).toContain(
      `Current: ${result.data.access.mode === "off" ? "Off" : result.data.access.mode === "connect" ? "Connect" : "Private network"}`,
    );
    expect(labels).toContain("Requested: Private network");
    expect(labels).toContain("Retry change");
    expect(labels).toContain("Refresh status");
  } finally {
    act(() => root.unmount());
    host.dispose();
    state.host = null;
    state.remote = null;
  }
});

it("lists connected agents on Account on iOS and Android, revokes one, and reads only there", async () => {
  const id = `mcn_${crypto.randomUUID()}`;
  const host = new MockHostClient({
    latencyMs: 0,
    connections: [
      {
        id,
        userId: UserIdSchema.parse("usr_0192f4a1-0000-4000-8000-000000000001"),
        label: "Research agent",
        clientName: "Example",
        accessMode: "auto",
        reach: { kind: "user" },
        createdAt: "2026-11-01T00:00:00Z",
        expiresAt: "2026-12-01T00:00:00Z",
        lastUsedAt: null,
      },
    ],
  });
  await host.load();
  state.host = host;
  const list = vi.fn(host.rpc["connections.list"]);
  Object.defineProperty(host.rpc, "connections.list", { value: list, configurable: true });
  const dispatch = vi.spyOn(host, "dispatch");
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<AccountSettingsController detail="remote" />));
    expect(list).not.toHaveBeenCalled();
    await act(async () => root.render(<AccountSettingsController />));
    const section = () =>
      state.page!.sections.find((candidate) => candidate.key === "connected-agents")!;
    const labels = section().rows.map((row) => row.label);
    expect(labels.join("\n")).toContain("Research agent · Example · Automatic");
    expect(labels.join("\n")).toContain("Everything you can access");
    expect(labels.join("\n")).toContain("Never used");
    const revoke = section().rows.find((row) => row.label === "Revoke Research agent")!;
    if (revoke.kind !== "button") throw new Error("Missing revoke");
    await act(async () => revoke.onPress());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "connection.revoke", connectionId: id }),
    );
    expect(section().rows.map((row) => row.label)).toContain("No connected agents.");
  } finally {
    act(() => root.unmount());
    host.dispose();
    state.host = null;
  }
});
