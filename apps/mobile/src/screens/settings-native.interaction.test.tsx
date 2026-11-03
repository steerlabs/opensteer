// @vitest-environment happy-dom
import { act, useId, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
import { hostApi, type HostApiCommandInput } from "@opensteer/protocol";
import type { HostClient } from "@opensteer/client/host";
import type { NativeSettingsPageProps, NativeSettingsRow } from "./native-settings-page.types.js";
import { settingsDestinations } from "./settings-home-model.js";
const state = vi.hoisted(() => ({
  connected: null as ((id: string) => Promise<void>) | null,
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
vi.mock("./settings-plugin-accounts.js", () => ({
  PluginAccounts: (props: { onConnected?: (id: string) => Promise<void> }) => {
    state.connected = props.onConnected ?? null;
    return null;
  },
}));
const { SettingsMessagingScreen } = await import("./settings-messaging.js");
const { SettingsPluginsScreen } = await import("./settings-plugins.js");
const { pluginGroups, pluginState } = await import("@opensteer/client/settings");
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
async function open(screen: "plugins" | "messaging") {
  host = new MockHostClient({ automations: "absent", latencyMs: 0 });
  await host.load();
  state.host = host;
  const element = document.createElement("div");
  root = createRoot(element);
  await act(async () =>
    root!.render(
      screen === "plugins" ? (
        <SettingsPluginsScreen route={{ params: { deploymentId: "deployment" } }} />
      ) : (
        <SettingsMessagingScreen route={{ params: { deploymentId: "deployment" } }} />
      ),
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
it("orders seven Settings destinations with one agent group", () => {
  expect(settingsDestinations.map((item) => item.title)).toEqual([
    "General",
    "Account",
    "Devices",
    "Messaging",
    "AI",
    "Plugins",
    "Sign-ins",
  ]);
});
it("preserves committed plugin state while enable is pending and ignores a late result after sign-out", async () => {
  await open("plugins");
  const before = rows().find(
    (row): row is Extract<NativeSettingsRow, { kind: "toggle" }> =>
      row.kind === "toggle" && !row.disabled,
  )!;
  expect(before).toBeDefined();
  let finish!: () => void;
  const dispatched = vi.spyOn(host, "dispatch").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () =>
          resolve({
            type: "settings.plugin.enabled.set",
            placement: {
              enabled: !before.value,
              revision: 2,
              mainIncluded: true,
              personalEverywhere: false,
              projectCount: 0,
            },
          });
      }),
  );
  await act(async () => before.onChange(!before.value));
  const held = rows().find((row) => row.key === before.key)!;
  expect(held.kind === "toggle" && held.value).toBe(before.value);
  expect(held.kind === "toggle" && held.disabled).toBe(true);
  expect(dispatched).toHaveBeenCalledOnce();
  state.host = null;
  await act(async () => finish());
  expect(rows().find((row) => row.key === before.key)?.kind).toBe("toggle");
});
it("searches by identity without promoting Waiting to Needs you", async () => {
  await open("plugins");
  const overview = await host.rpc["plugins.overview.get"]({});
  if (!overview.ok) throw new Error("No overview");
  const first = overview.data.rows[0]!;
  const waiting = {
    ...first,
    placement: { ...first.placement, enabled: true },
    issues: ["waiting-device" as const],
  };
  expect(pluginState(waiting).group).toBe("On");
  expect(pluginState({ ...waiting, issues: ["waiting-device", "needs-sign-in"] }).group).toBe(
    "Needs you",
  );
  expect(
    pluginState({
      ...waiting,
      placement: { ...waiting.placement, enabled: false },
      issues: ["needs-sign-in"],
    }).group,
  ).toBe("Turned off");
  expect(Object.values(pluginGroups([first], first.title.toUpperCase())).flat()).toEqual([first]);
});
it.each(["ios", "android"])("offers secure Messaging setup and linking on %s", async (os) => {
  state.os = os;
  await open("messaging");
  expect(rows().some((row) => row.label === "iMessage")).toBe(true);
  await press("Slack");
  const fields = rows().filter(
    (row) => row.kind === "input" && row.secure && row.label !== "Link code",
  );
  expect(fields.length).toBe(2);
  for (const field of fields) await input(field.label, "secret");
  const commands: HostApiCommandInput[] = [];
  vi.spyOn(host, "dispatch").mockImplementation(async (command) => {
    commands.push(command);
    throw new Error("Hold setup");
  });
  await press("Connect");
  expect(commands[0]).toMatchObject({
    type: "channel.connection.create",
    provider: "slack",
    credentials: { botToken: "secret", appToken: "secret" },
  });
  await input("Link code", "ABCDEFGH");
  await press("Link account");
  expect(commands[1]).toMatchObject({ type: "channel.identity.link", code: "ABCDEFGH" });
});
it("discards a deferred overview when the attachment changes", async () => {
  await open("plugins");
  let finish!: (value: Awaited<ReturnType<HostClient["rpc"]["plugins.overview.get"]>>) => void;
  const rpc = host.rpc;
  Object.defineProperty(host, "rpc", {
    value: new Proxy(rpc, {
      get(target, key, receiver) {
        if (key === "plugins.overview.get")
          return () =>
            new Promise((resolve) => {
              finish = resolve;
            });
        return Reflect.get(target, key, receiver);
      },
    }),
  });
  await press("Refresh");
  state.host = null;
  await act(async () =>
    finish({ ok: true, data: hostApi["plugins.overview.get"].success.parse({ rows: [] }) }),
  );
  expect(state.page!.sections.some((section) => section.key === "empty")).toBe(false);
});
it.each(["ios", "android"])(
  "sends every Messaging mutation with revision fences on %s",
  async (os) => {
    state.os = os;
    await open("messaging");
    const snapshot = host.getSnapshot();
    const workspaceId = snapshot.workspaces[0]!.id;
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
          workspaceId,
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
    const commands: HostApiCommandInput[] = [];
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

it("pushes validated plugin identity so Back returns to the searchable list", async () => {
  await open("plugins");
  const result = await host.rpc["plugins.overview.get"]({});
  if (!result.ok) throw new Error("Missing overview");
  const plugin = result.data.rows[0]!;
  await press(plugin.title === "Apple Messages" ? "iMessage" : plugin.title);
  expect(state.navigate).toHaveBeenCalledWith("SettingsPluginDetail", {
    deploymentId: "deployment",
    target: plugin.target,
  });
});

it("installs a folder, places it in Main and removes only after confirmation", async () => {
  await open("plugins");
  const dispatch = vi.spyOn(host, "dispatch");
  await press("Add plugins");
  await input("Folder on your computer", "/Users/me/plugins/notes");
  await press("Install plugin");
  expect(dispatch).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "plugin.install",
      input: { directory: "/Users/me/plugins/notes" },
    }),
  );
  const overview = await host.rpc["plugins.overview.get"]({});
  if (!overview.ok) throw new Error("Missing overview");
  const plugin = overview.data.rows.find((row) => row.title === "notes")!;
  expect(plugin).toBeDefined();
  await act(async () =>
    root!.render(
      <SettingsPluginsScreen
        route={{ params: { deploymentId: "deployment", target: plugin.target } }}
      />,
    ),
  );
  const place = rows().find((row) => row.kind === "toggle" && row.label === "Main");
  expect(place?.kind).toBe("toggle");
  if (place?.kind !== "toggle") throw new Error("Missing Main");
  await act(async () => place.onChange(true));
  expect(dispatch).toHaveBeenCalledWith(
    expect.objectContaining({ type: "settings.plugin.placement.set", mainIncluded: true }),
  );
  await press("Remove plugin");
  const { Alert } = await import("react-native");
  const buttons = vi.mocked(Alert.alert).mock.calls.at(-1)?.[2];
  expect(dispatch.mock.calls.some(([command]) => command.type === "plugin.remove")).toBe(false);
  await act(async () => buttons?.find((button) => button.style === "destructive")?.onPress?.());
  expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "plugin.remove" }));
});
it("withholds folder install from non-administrators", async () => {
  await open("plugins");
  const original = host.getSnapshot.bind(host);
  vi.spyOn(host, "getSnapshot").mockImplementation(() => ({
    ...original(),
    user: { ...original().user!, instanceRole: "user" },
  }));
  await press("Add plugins");
  expect(rows().some((row) => row.label === "Folder on your computer")).toBe(false);
});

it.each(["ios", "android"])(
  "fences retained Messaging actions and late checks on %s",
  async (os) => {
    state.os = os;
    await open("messaging");
    await input("Link code", "ABCDEFGH");
    const retained = row("Link account");
    const dispatch = vi.spyOn(host, "dispatch");
    state.host = null;
    if (retained.kind !== "button") throw new Error("Missing link action");
    await act(async () => retained.onPress());
    expect(dispatch).not.toHaveBeenCalled();
  },
);

it.each(["ios", "android"])(
  "reviews placement before Add consent and reads real installed detail on %s",
  async (os) => {
    state.os = os;
    await open("plugins");
    await press("Add plugins");
    const directory = await host.rpc["plugins.directory.get"]({});
    if (!directory.ok) throw new Error("Missing directory");
    const item = directory.data.catalog.find((item) => !item.added)!;
    const dispatch = vi.spyOn(host, "dispatch");
    await press(`${item.title} · Add`);
    expect(dispatch).not.toHaveBeenCalled();
    expect(rows().some((row) => row.label.startsWith("Allow "))).toBe(false);
    expect(rows().some((row) => row.kind === "toggle")).toBe(true);
    expect(row("Add and continue to sign-in")).toMatchObject({ disabled: false });
    await press("Add and continue to sign-in");
    expect(dispatch.mock.calls.map(([command]) => command.type)).toEqual([
      "integration.catalog.install",
      "settings.plugin.placement.set",
    ]);
    const overview = await host.rpc["plugins.overview.get"]({});
    if (!overview.ok) throw new Error("Missing overview");
    const installed = overview.data.rows.find(
      (row) =>
        (row.target.kind === "service" || row.target.kind === "device-app") &&
        row.target.definitionId === item.definitionId,
    );
    expect(installed).toBeDefined();
    const result = await host.rpc["plugins.detail.get"]({ target: installed!.target });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Installed detail missing");
    expect(result.data.row.title).toBe(item.title);
    expect(result.data.installationIds).toHaveLength(1);
    expect(result.data.accounts).toEqual([]);
    expect(state.connected).toBeTypeOf("function");
    const gmail = await host.rpc["plugins.detail.get"]({
      target: { kind: "service", definitionId: "google-gmail" },
    });
    if (!gmail.ok) throw new Error("Missing account fixture");
    const account = gmail.data.accounts[0]!;
    const rpc = host.rpc;
    Object.defineProperty(host, "rpc", {
      value: new Proxy(rpc, {
        get(target, key, receiver) {
          if (key === "plugins.detail.get")
            return async () => ({ ok: true, data: { ...result.data, accounts: [account] } });
          return Reflect.get(target, key, receiver);
        },
      }),
    });
    dispatch.mockRejectedValueOnce(new Error("Lost response"));
    await expect(state.connected!(account.connectionId)).rejects.toThrow("Lost response");
    const uncertain = dispatch.mock.calls.at(-1)![0];
    dispatch.mockResolvedValueOnce({
      type: "settings.plugin.placement.set",
      placement: result.data.row.placement,
    });
    await state.connected!(account.connectionId);
    expect(dispatch.mock.calls.at(-1)![0]).toEqual(uncertain);
    expect(uncertain).toMatchObject({ type: "settings.plugin.placement.set" });
    if (uncertain.type !== "settings.plugin.placement.set") throw new Error("Missing placement");
    expect(JSON.stringify(uncertain)).toContain(account.connectionId);
  },
);
