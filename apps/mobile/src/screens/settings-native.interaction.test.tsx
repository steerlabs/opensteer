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
  host: null as HostClient | null,
  page: null as NativeSettingsPageProps | null,
  pages: new Map<string, NativeSettingsPageProps>(),
}));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: vi.fn() }) }));
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
const { SettingsMessagingScreen } = await import("./settings-messaging.js");
const { SettingsPluginsScreen } = await import("./settings-plugins.js");
const { filterPlugins, pluginGroup } = await import("./settings-adapter.js");
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
  expect(pluginGroup(waiting)).toBe("On");
  expect(pluginGroup({ ...waiting, issues: ["waiting-device", "needs-sign-in"] })).toBe(
    "Needs you",
  );
  expect(
    pluginGroup({
      ...waiting,
      placement: { ...waiting.placement, enabled: false },
      issues: ["needs-sign-in"],
    }),
  ).toBe("Turned off");
  expect(filterPlugins([first], first.title.toUpperCase(), null)).toEqual([first]);
});
it("offers native Messaging setup on Android, secure transient credentials and linking", async () => {
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
it("sends Messaging route and sender mutations with their current revision fences", async () => {
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
  const rpc = host.rpc;
  Object.defineProperty(host, "rpc", {
    value: new Proxy(rpc, {
      get(target, key, receiver) {
        if (key === "channels.get") return async () => ({ ok: true, data });
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
  await press("Pause");
  expect(commands.at(-1)).toMatchObject({
    type: "channel.connection.status.set",
    connectionId,
    status: "paused",
  });
  await input("Conversation ID", "support");
  await press("Add route");
  expect(commands.at(-1)).toMatchObject({
    type: "channel.binding.create",
    accountId,
    selector: { conversationId: "support" },
  });
  await press("Direct messages: approved");
  expect(commands.at(-1)).toMatchObject({
    type: "channel.binding.update",
    bindingId,
    expectedRevision: 7,
  });
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
  await press("Repair");
  await input("Bot user OAuth token", "replacement");
  await input("App-level token", "replacement-app");
  await press("Replace credentials");
  expect(commands.at(-1)).toMatchObject({
    type: "channel.connection.credentials.replace",
    connectionId,
    credentials: { botToken: "replacement", appToken: "replacement-app" },
  });
});
