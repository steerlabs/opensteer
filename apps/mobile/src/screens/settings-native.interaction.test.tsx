// @vitest-environment happy-dom
import { act, useId, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
import { hostApi } from "@opensteer/protocol";
import type { HostClient } from "@opensteer/client/host";
import type { NativeSettingsPageProps } from "./native-settings-page.types.js";
const state = vi.hoisted(() => ({
  os: "ios",
  navigate: vi.fn(),
  host: null as HostClient | null,
  page: null as NativeSettingsPageProps | null,
  pages: new Map<string, NativeSettingsPageProps>(),
}));
vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return state.os;
    },
  },
  Alert: { alert: vi.fn() },
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: state.navigate }),
}));
vi.mock("../ui/sheet.js", () => ({
  Sheet: ({ children, open }: { children: ReactNode; open: boolean }) => (open ? children : null),
}));
vi.mock("./native-settings-page.js", () => ({
  NativeSettingsPage: (props: NativeSettingsPageProps) => {
    const id = useId();
    state.page = props;
    state.pages.set(id, props);
    useEffect(
      () => () => {
        state.pages.delete(id);
      },
      [id],
    );
    return null;
  },
}));
vi.mock("./deployment-gate.js", () => ({
  useAttachedHost: () => state.host,
  DeploymentGate: () => null,
}));
vi.mock("../ui/mobile-client-context.js", () => {
  const mobile = { getSnapshot: () => ({ selection: { hostClient: state.host } }) };
  return { useMobileClient: () => mobile };
});
const { useLocalServerSections } = await import("./local-server-sections.js");
const { NativeSettingsPage } = await import("./native-settings-page.js");
const { SettingsMessagingScreen } = await import("./settings-messaging.js");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;
let host: MockHostClient;
afterEach(() => {
  act(() => root?.unmount());
  host?.dispose();
  state.host = null;
  state.page = null;
  state.pages.clear();
  vi.restoreAllMocks();
});
async function open(screen: "messaging") {
  host = new MockHostClient({ automations: "absent", latencyMs: 0 });
  await host.load();
  state.host = host;
  const element = document.createElement("div");
  root = createRoot(element);
  await act(async () =>
    root!.render(
      screen === "messaging" ? (
        <SettingsMessagingScreen route={{ params: { deploymentId: "deployment" } }} />
      ) : null,
    ),
  );
}
function rows() {
  return [...state.pages.values()].flatMap((page) =>
    page.sections.flatMap((section) => section.rows),
  );
}
function row(label: string) {
  const found = rows().find((row) => row.label === label);
  expect(found, `Missing control: ${label}`).toBeDefined();
  return found!;
}
async function press(label: string) {
  const found = row(label);
  if (found.kind !== "button") throw new Error("Not a button");
  await act(async () => found.onPress());
}
async function input(label: string, value: string) {
  const found = row(label);
  if (found.kind !== "input") throw new Error("Not an input");
  await act(async () => found.onChange(value));
}

it.each(["ios", "android"])(
  "sends every Messaging mutation with revision fences on %s",
  async (os) => {
    state.os = os;
    await open("messaging");
    const snapshot = host.getSnapshot();
    const now = new Date().toISOString();
    const accountId = `cha_${crypto.randomUUID()}`;
    const connectionId = `con_${crypto.randomUUID()}`;
    const bindingId = `chb_${crypto.randomUUID()}`;
    const response = await host.rpc["channels.get"]({});
    if (!response.ok) throw new Error("Missing messaging catalog");
    const base = response.data;
    const data = hostApi["channels.get"].success.parse({
      ...base,
      accounts: [
        {
          id: accountId,
          connectionId,
          provider: "slack",
          displayName: "Team bot",
          externalAccountId: "team",
          handle: null,
          metadata: {},
          routingMode: "shared",
          status: "connected",
          createdAt: now,
          updatedAt: now,
        },
      ],
      bindings: [
        {
          id: bindingId,
          accountId,
          createdBy: snapshot.user!.id,
          createdAt: now,
          updatedAt: now,
          revision: 7,
          status: "active",
          selector: {
            conversationId: "general",
            conversationType: null,
            scopeId: null,
            threadId: null,
          },
          accessPolicy: {
            channels: {
              scope: "selected",
              conversationIds: [],
              sender: { mode: "approved", allowedExternalUserIds: [] },
            },
            directMessages: { mode: "owner", allowedExternalUserIds: [] },
          },
          executionPolicy: { harness: "default", harnessInstanceId: null },
        },
      ],
      accessGrants: [
        {
          accountId,
          bindingId,
          externalUserId: "alice",
          displayName: "Alice",
          status: "pending",
          revision: 4,
          requestedAt: now,
          decidedAt: null,
          decidedBy: null,
        },
      ],
    });
    const check = vi.fn(async () => ({
      ok: true,
      data: { ready: true, capabilities: [], identity: null, issues: [] },
    }));
    const rpc = host.rpc;
    Object.defineProperty(host, "rpc", {
      value: new Proxy(rpc, {
        get(target, key, receiver) {
          if (key === "channel.connection.check") return check;
          if (key === "channels.get")
            return async () => ({ ok: true, data: { ...data, accounts: [...data.accounts] } });
          return Reflect.get(target, key, receiver);
        },
      }),
    });
    await press("Refresh");
    const commands: Parameters<HostClient["dispatch"]>[0][] = [];
    vi.spyOn(host, "dispatch").mockImplementation(async (command) => {
      commands.push(command);
      throw new Error("Keep the current state");
    });
    await press("Check connection");
    expect(check).toHaveBeenCalledWith({ connectionId });
    await press("Pause");
    expect(commands.at(-1)).toMatchObject({
      type: "channel.connection.status.set",
      connectionId,
      status: "paused",
    });
    data.accounts[0]!.status = "paused";
    await press("Refresh");
    await press("Resume");
    expect(commands.at(-1)).toMatchObject({
      type: "channel.connection.status.set",
      status: "connected",
      connectionId,
    });
    await input("Conversation ID", "support");
    await press("Add route");
    expect(commands.at(-1)).toMatchObject({
      type: "channel.binding.create",
      accountId,
      selector: { conversationId: "support" },
    });
    for (const label of [
      "Direct messages: approved",
      "Channel senders: anyone",
      "Channels: all",
      "✓ Channels: selected",
      "Channels: off",
    ]) {
      await press(label);
      expect(commands.at(-1)).toMatchObject({
        type: "channel.binding.update",
        bindingId,
        expectedRevision: 7,
      });
    }
    for (const [label, decision] of [
      ["Approve", "approved"],
      ["Decline", "declined"],
      ["Revoke", "revoked"],
    ]) {
      await press(label!);
      expect(commands.at(-1)).toMatchObject({
        type: "channel.access.review",
        bindingId,
        externalUserId: "alice",
        expectedRevision: 4,
        decision,
      });
    }
    await press("Remove route");
    expect(commands.at(-1)).toMatchObject({ type: "channel.binding.revoke", bindingId });
    const { Alert } = await import("react-native");
    await press("Remove");
    const buttons = vi.mocked(Alert.alert).mock.calls.at(-1)?.[2];
    expect(buttons?.find((button) => button.style === "destructive")).toBeDefined();
    await act(async () => buttons?.find((button) => button.style === "destructive")?.onPress?.());
    expect(commands.at(-1)).toMatchObject({
      type: "channel.connection.status.set",
      status: "revoked",
      connectionId,
    });
    await press("iMessage");
    await input("Your iMessage addresses, separated by commas", "owner@example.com");
    await press("Connect");
    expect(commands.at(-1)).toMatchObject({
      type: "channel.connection.computer.create",
      ownerHandles: ["owner@example.com"],
    });
    await press("Cancel");
    await press("Repair");
    await input("Bot user OAuth token", "replacement");
    await input("App-level token", "replacement-app");
    await press("Replace credentials");
    expect(commands.at(-1)).toMatchObject({
      type: "channel.connection.credentials.replace",
      connectionId,
      credentials: { botToken: "replacement", appToken: "replacement-app" },
    });
  },
);

it.each(["ios", "android"])(
  "fences a retained Messaging Link action after the session stops on %s",
  async (os) => {
    state.os = os;
    await open("messaging");
    await input("Link code", "ABCDEFGH");
    const retained = row("Link account");
    const dispatch = vi.spyOn(host, "dispatch");
    await act(async () => host.connection.stop());
    if (retained.kind !== "button") throw new Error("Missing link action");
    await act(async () => retained.onPress());
    expect(dispatch).not.toHaveBeenCalled();
  },
);

it.each(["ios", "android"])(
  "keeps local-server values secure and submits only changed values on %s",
  async (os) => {
    state.os = os;
    await open("messaging");
    const serverId = "isv_00000000-0000-4000-8000-000000000009";
    const installed = {
      installation: { id: "install-camera", pluginId: "camera", title: "Camera" },
      servers: [{ id: serverId, status: "active", statusDetail: null }],
    };
    const secrets = [
      { name: "PASSWORD", title: "Camera password" },
      { name: "TOKEN", title: "Token" },
    ];
    Object.defineProperty(host, "rpc", {
      value: {
        ...host.rpc,
        "integration.platform.get": async () => ({
          ok: true,
          data: { installations: [installed] },
        }),
        "integration.server.secrets.list": async () => ({
          ok: true,
          data: {
            servers: [
              {
                id: serverId,
                installationId: installed.installation.id,
                plugin: "Camera",
                computer: "Studio Mac",
                name: "camera",
                secrets,
              },
            ],
          },
        }),
      },
    });
    function ServerSettings() {
      const local = useLocalServerSections({
        host,
        by: { serverId },
        deploymentId: "deployment",
        name: "Camera",
        onRemoved: () => {},
      });
      return (
        <>
          <NativeSettingsPage sections={local.sections} />
          {local.sheet}
        </>
      );
    }
    await act(async () => root!.render(<ServerSettings />));
    const dispatch = vi
      .spyOn(host, "dispatch")
      .mockResolvedValue({ type: "integration.server.secrets.set" } as never);
    await press("Change secrets");
    const save = row("Save");
    if (save.kind !== "primary") throw new Error("Missing save action");
    await act(async () => save.onPress());
    expect(dispatch).not.toHaveBeenCalled();
    expect(
      [...state.pages.values()].some((page) =>
        page.sections.some((section) => section.footer?.text === "Enter a new value to change."),
      ),
    ).toBe(true);
    const field = row("Camera password");
    expect(field.kind === "input" && field.secure).toBe(true);
    await input("Camera password", "new-secret");
    const changed = row("Save");
    if (changed.kind !== "primary") throw new Error("Missing save action");
    await act(async () => changed.onPress());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "integration.server.secrets.set",
        serverId,
        secrets: { PASSWORD: "new-secret" },
      }),
    );
    expect(
      [...state.pages.values()].some((page) =>
        page.sections.some((section) => section.footer?.text === "Secrets changed"),
      ),
    ).toBe(true);
    expect(rows().some((row) => row.kind === "input" && row.secure)).toBe(false);
  },
);
