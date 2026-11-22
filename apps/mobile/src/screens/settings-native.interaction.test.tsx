// @vitest-environment happy-dom
import { act, useId, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { MockHostClient, mockConnectedAgents } from "@opensteer/client/mock";
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
vi.mock("./device-app-setup-sheet.js", () => ({ DeviceAppSetupSheet: () => null }));
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

it.each(["ios", "android"])("sends every Messaging change from the phone on %s", async (os) => {
  state.os = os;
  await open("messaging");
  const now = new Date().toISOString();
  const accountId = `cha_${crypto.randomUUID()}`;
  const connectionId = `con_${crypto.randomUUID()}`;
  const response = await host.rpc["channels.get"]({});
  if (!response.ok) throw new Error("Missing messaging catalog");
  const data = hostApi["channels.get"].success.parse({
    ...response.data,
    accounts: [
      {
        id: accountId,
        connectionId,
        provider: "slack",
        displayName: "Team bot",
        externalAccountId: "team",
        handle: null,
        metadata: {},
        routingMode: "dedicated",
        status: "connected",
        createdAt: now,
        updatedAt: now,
      },
    ],
    connections: [
      {
        capabilities: [],
        connectionMethod: "api-key",
        createdAt: now,
        displayName: "Team bot",
        externalIdentityId: null,
        externalTenantId: null,
        id: connectionId,
        ownerUserId: host.getSnapshot().user!.id,
        provider: "slack",
        status: "connected",
        statusDetail: null,
        statusReason: null,
        transportKind: "socket",
        updatedAt: now,
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
  await press("Check again");
  expect(check).toHaveBeenCalledWith({ connectionId });
  await press("Pause");
  expect(commands.at(-1)).toMatchObject({
    type: "channel.connection.status.set",
    connectionId,
    status: "paused",
  });
  data.accounts[0]!.status = "paused";
  data.connections[0]!.status = "paused";
  await press("Refresh");
  // Paused Slack: what becomes of what is sent meanwhile, in the Home's words for Slack.
  expect(row("Paused").kind).toBe("status");
  expect(
    rows().some(
      (candidate) =>
        candidate.label ===
        "Paused: its chats hold their replies until you resume it. Messages sent while this is paused are not delivered.",
    ),
  ).toBe(true);
  await press("Resume");
  expect(commands.at(-1)).toMatchObject({
    type: "channel.connection.status.set",
    status: "connected",
    connectionId,
  });
  // Back, the Home says it is connecting first: the phone says so too, as the web does.
  data.accounts[0]!.status = "connected";
  data.connections[0]!.status = "pending";
  await press("Refresh");
  expect(row("Connecting").kind).toBe("status");
  // Needs attention: what the connection reports, and Fix setup, for a provider app's tokens.
  data.connections[0]!.status = "needs-attention";
  data.connections[0]!.statusDetail = "Slack says the token was revoked.";
  await press("Refresh");
  expect(row("Needs attention").kind).toBe("status");
  expect(row("Slack says the token was revoked.").kind).toBe("text");
  expect(rows().some((candidate) => candidate.label === "Pause")).toBe(false);
  await press("Link my account");
  expect(commands.at(-1)).toMatchObject({ type: "channel.me.link", accountId });
  const { Alert } = await import("react-native");
  await press("Remove account");
  const buttons = vi.mocked(Alert.alert).mock.calls.at(-1)?.[2];
  expect(vi.mocked(Alert.alert).mock.calls.at(-1)?.[1]).toContain("Every chat on it ends");
  await act(async () => buttons?.find((button) => button.style === "destructive")?.onPress?.());
  expect(commands.at(-1)).toMatchObject({
    type: "channel.connection.status.set",
    status: "revoked",
    connectionId,
  });
  await press("iMessage");
  // Nothing is asked that the Home would throw away: who "me" is comes after, by a code.
  expect(rows().some((candidate) => candidate.kind === "input")).toBe(false);
  expect(
    row(
      "Choose the Mac signed into Messages with the bot's Apple account. Once it is connected, link your own iMessage account with a code, then add a chat.",
    ).kind,
  ).toBe("text");
  // No Mac here can run it: the page says what to do, and Connect sends nothing.
  expect(
    row(
      "No online Mac of yours has Messages turned on yet. Turn it on from that Mac’s Devices page first.",
    ).kind,
  ).toBe("text");
  expect(row("Connect")).toMatchObject({ disabled: true });
  await press("Cancel");
  await press("Fix setup");
  await input("Bot user OAuth token", "replacement");
  await input("App-level token", "replacement-app");
  await press("Replace credentials");
  expect(commands.at(-1)).toMatchObject({
    type: "channel.connection.credentials.replace",
    connectionId,
    credentials: { botToken: "replacement", appToken: "replacement-app" },
  });
  // Nothing a person reads names the machinery.
  expect(
    rows().some((candidate) =>
      /bridge|lineage|ingress|route|binding|waiting/iu.test(
        `${candidate.label} ${"detail" in candidate ? (candidate.detail ?? "") : ""}`,
      ),
    ),
  ).toBe(false);
});

it.each(["ios", "android"])(
  "shows each account's chats with their state, who is me and the code that links it, on %s",
  async (os) => {
    state.os = os;
    host = new MockHostClient({ latencyMs: 0, ...mockConnectedAgents("chats") });
    await host.load();
    state.host = host;
    const element = document.createElement("div");
    root = createRoot(element);
    await act(async () =>
      root!.render(<SettingsMessagingScreen route={{ params: { deploymentId: "deployment" } }} />),
    );
    await vi.waitFor(() => expect(rows().some((r) => r.label === "Slack · #team")).toBe(true));
    const chat = row("Slack · #team");
    expect(chat.kind === "button" && chat.detail).toBe(
      "#team on Slack, through Workshop · Tasks · Supervised",
    );
    if (chat.kind !== "button") throw new Error("Not a button");
    await act(async () => chat.onPress());
    expect(state.navigate).toHaveBeenCalledWith("ConnectedAgent", {
      deploymentId: "deployment",
      connectionId: "mcn_00000000-0000-4000-8000-0000000000c2",
    });
    // iMessage, paused: what is sent meanwhile arrives when it is back.
    expect(
      rows().some(
        (candidate) =>
          candidate.label ===
          "Paused: its chats hold their replies until you resume it. Messages sent while this is paused arrive when it’s back; one sent more than an hour before is answered that it came too late.",
      ),
    ).toBe(true);
    expect(row("Needs attention").kind).toBe("status");
    // What the connection reports, and Fix setup only where the Home accepts it: the provider
    // app that needs attention, never a computer's Messages, never a healthy account.
    expect(row("Slack says the token was revoked.").kind).toBe("text");
    expect(rows().filter((candidate) => candidate.label === "Fix setup")).toHaveLength(1);
    const me = rows().find((candidate) => candidate.label === "You on Slack");
    expect(me && "detail" in me ? me.detail : null).toBe(
      "Tim is you. Messages from it count as you in your chats. Linking another account replaces Tim as you.",
    );
    const sections = [...state.pages.values()].flatMap((page) => page.sections);
    expect(
      sections.some((section) =>
        section.footer?.text?.startsWith("Add a chat from Opensteer on your computer"),
      ),
    ).toBe(true);
    await act(async () => {
      const link = rows().find((candidate) => candidate.label === "Link another account");
      if (link?.kind === "button") link.onPress();
    });
    await vi.waitFor(() =>
      expect(
        rows().some((candidate) =>
          /^Send MOCKCODE to Workshop in a direct message from your own Slack account\. It works once, until .+\. Nothing is said in the chat; this page shows your account once it’s linked\.$/u.test(
            candidate.label,
          ),
        ),
      ).toBe(true),
    );
  },
);

it.each(["ios", "android"])(
  "says an account's chats could not be read when that read failed, never that it has none, on %s",
  async (os) => {
    state.os = os;
    host = new MockHostClient({ latencyMs: 0, ...mockConnectedAgents("chats") });
    await host.load();
    Object.defineProperty(host.rpc, "connections.list", {
      value: vi.fn(async () => {
        throw new Error("down");
      }),
      configurable: true,
    });
    state.host = host;
    root = createRoot(document.createElement("div"));
    await act(async () =>
      root!.render(<SettingsMessagingScreen route={{ params: { deploymentId: "deployment" } }} />),
    );
    await vi.waitFor(() =>
      expect(rows().some((r) => r.label === "Couldn’t read this account’s chats.")).toBe(true),
    );
    expect(rows().some((r) => r.label === "No chat on this account yet.")).toBe(false);
  },
);

it.each(["ios", "android"])("says an account with no chat has none yet, on %s", async (os) => {
  state.os = os;
  host = new MockHostClient({ latencyMs: 0, ...mockConnectedAgents("chats-empty") });
  await host.load();
  state.host = host;
  root = createRoot(document.createElement("div"));
  await act(async () =>
    root!.render(<SettingsMessagingScreen route={{ params: { deploymentId: "deployment" } }} />),
  );
  await vi.waitFor(() =>
    expect(rows().filter((r) => r.label === "No chat on this account yet.")).toHaveLength(3),
  );
});

async function openChats(scene: "chats" | "chats-empty", edit?: (rpc: HostClient["rpc"]) => void) {
  host = new MockHostClient({ latencyMs: 0, ...mockConnectedAgents(scene) });
  await host.load();
  edit?.(host.rpc);
  state.host = host;
  root = createRoot(document.createElement("div"));
  await act(async () =>
    root!.render(<SettingsMessagingScreen route={{ params: { deploymentId: "deployment" } }} />),
  );
}
function footers() {
  return [...state.pages.values()].flatMap((page) =>
    page.sections.flatMap((section) => (section.footer ? [section.footer] : [])),
  );
}

it.each(["ios", "android"])(
  "says a failed read of Messaging in the web's words, with Try again, on %s",
  async (os) => {
    state.os = os;
    await openChats("chats", (rpc) =>
      Object.defineProperty(rpc, "channels.get", {
        value: vi.fn(async () => {
          throw new Error("down");
        }),
        configurable: true,
      }),
    );
    await vi.waitFor(() =>
      expect(footers().map((footer) => footer.text)).toContain(
        "Couldn’t read your messaging accounts.",
      ),
    );
    const footer = footers().find((f) => f.text === "Couldn’t read your messaging accounts.");
    expect(footer?.link?.label).toBe("Try again");
    expect(rows().some((r) => r.label === "Workshop" || r.label === "Connected")).toBe(false);
    expect(rows().some((r) => r.label.startsWith("No messaging account yet"))).toBe(false);
  },
);

it.each(["ios", "android"])("says there is no messaging account yet, on %s", async (os) => {
  state.os = os;
  await openChats("chats", (rpc) => {
    const read = rpc["channels.get"];
    Object.defineProperty(rpc, "channels.get", {
      value: async (input: Parameters<typeof read>[0]) => {
        const response = await read(input);
        return response.ok
          ? { ...response, data: { ...response.data, accounts: [], connections: [], me: [] } }
          : response;
      },
      configurable: true,
    });
  });
  await vi.waitFor(() =>
    expect(
      rows().some(
        (r) => r.label === "No messaging account yet. Add one to message your own agents.",
      ),
    ).toBe(true),
  );
});

it.each(["ios", "android"])(
  "reads Messaging again while a code is shown, and says a paused account links once resumed, on %s",
  async (os) => {
    state.os = os;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let reads = 0;
      await openChats("chats", (rpc) => {
        const read = rpc["channels.get"];
        Object.defineProperty(rpc, "channels.get", {
          value: (input: Parameters<typeof read>[0]) => {
            reads += 1;
            return read(input);
          },
          configurable: true,
        });
      });
      await vi.waitFor(() =>
        expect(rows().filter((r) => r.label === "Link another account")).toHaveLength(2),
      );
      // The second account is the paused iMessage one.
      const link = rows().filter((r) => r.label === "Link another account")[1]!;
      if (link.kind !== "button") throw new Error("Not a button");
      await act(async () => link.onPress());
      await vi.waitFor(() =>
        expect(rows().some((r) => r.label.startsWith("Send MOCKCODE to"))).toBe(true),
      );
      expect(
        rows().some(
          (r) => r.label === "Once this account is resumed, sending the code links your account.",
        ),
      ).toBe(true);
      const before = reads;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(reads).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  },
);

it.each(["ios", "android"])(
  "reads its chats again after an account is paused, and asks nothing the Home ignores, on %s",
  async (os) => {
    state.os = os;
    const list = vi.fn();
    await openChats("chats", (rpc) => {
      const read = rpc["connections.list"];
      Object.defineProperty(rpc, "connections.list", {
        value: (input: Parameters<typeof read>[0]) => {
          list();
          return read(input);
        },
        configurable: true,
      });
    });
    await vi.waitFor(() => expect(rows().some((r) => r.label === "Slack · #team")).toBe(true));
    const before = list.mock.calls.length;
    await press("Pause");
    await vi.waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(before));
    await press("Slack");
    expect(rows().some((r) => r.label === "Shared bot")).toBe(false);
  },
);

it.each(["ios", "android"])(
  "after a read that failed, each account reads Not read just now and offers no control, on %s",
  async (os) => {
    state.os = os;
    let fail = false;
    await openChats("chats", (rpc) => {
      const read = rpc["channels.get"];
      Object.defineProperty(rpc, "channels.get", {
        value: async (input: Parameters<typeof read>[0]) => {
          if (fail) throw new Error("down");
          return read(input);
        },
        configurable: true,
      });
    });
    await vi.waitFor(() => expect(rows().some((r) => r.label === "Connected")).toBe(true));
    fail = true;
    await press("Refresh");
    await vi.waitFor(() =>
      expect(footers().map((f) => f.text)).toContain("Couldn’t read your messaging accounts."),
    );
    const statuses = rows().filter((r) => r.kind === "status");
    expect(statuses.map((r) => r.label)).toEqual([
      "Not read just now",
      "Not read just now",
      "Not read just now",
    ]);
    // Every row that sends a command, by enumeration: only Refresh and moving around stay.
    const commands = rows().filter(
      (r) =>
        (r.kind === "button" && !r.opens && r.label !== "Refresh") ||
        r.kind === "toggle" ||
        r.kind === "input" ||
        r.kind === "chips",
    );
    expect(commands.map((r) => r.label)).toEqual([]);
  },
);

it.each(["ios", "android"])(
  "offers iMessage only on a Mac that can run it, and sends no empty Mac, on %s",
  async (os) => {
    state.os = os;
    await openChats("chats");
    const app = mockConnectedAgents("chats").channels!.providers.find(
      ({ provider }) => provider === "imessage",
    )!.computerApp!;
    const mac = (id: string, name: string, extra: object) => ({
      ...host.getSnapshot().machines[0],
      id,
      name,
      status: "online",
      allowedModules: ["messaging"],
      modules: { messaging: {} },
      apps: [{ definitionId: app }],
      ...extra,
    });
    const snapshot = host.getSnapshot();
    vi.spyOn(host, "getSnapshot").mockReturnValue({
      ...snapshot,
      machines: [
        mac("rnr_00000000-0000-4000-8000-0000000000a1", "Studio Mac", {}),
        mac("rnr_00000000-0000-4000-8000-0000000000a2", "Asleep Mac", { status: "offline" }),
        mac("rnr_00000000-0000-4000-8000-0000000000a3", "Mac without Messages", { apps: [] }),
      ],
    } as never);
    await vi.waitFor(() => expect(rows().some((r) => r.label === "iMessage")).toBe(true));
    await press("iMessage");
    const macs = rows().filter((r) => r.kind === "button" && r.label.includes("Mac"));
    expect(macs.map((r) => r.label.replace("✓ ", ""))).toEqual(["Studio Mac"]);
    const dispatch = vi.spyOn(host, "dispatch").mockRejectedValue(new Error("Keep the state"));
    await press("Connect");
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "channel.connection.computer.create",
        runnerId: "rnr_00000000-0000-4000-8000-0000000000a1",
      }),
    );
  },
);

it.each(["ios", "android"])(
  "says a code on an account that needs attention links it only once it is fixed, on %s",
  async (os) => {
    state.os = os;
    await openChats("chats");
    await vi.waitFor(() =>
      expect(rows().filter((r) => r.label === "Link my account")).toHaveLength(1),
    );
    await press("Link my account");
    await vi.waitFor(() =>
      expect(rows().some((r) => r.label.startsWith("Send MOCKCODE to On-call"))).toBe(true),
    );
    expect(
      rows().some(
        (r) =>
          r.label ===
          "Until this account is fixed, the code can’t link your account: fix its setup first, then send it.",
      ),
    ).toBe(true);
  },
);

it.each(["ios", "android"])(
  "fences a retained Messaging action after the session stops on %s",
  async (os) => {
    state.os = os;
    host = new MockHostClient({ latencyMs: 0, ...mockConnectedAgents("chats") });
    await host.load();
    state.host = host;
    root = createRoot(document.createElement("div"));
    await act(async () =>
      root!.render(<SettingsMessagingScreen route={{ params: { deploymentId: "deployment" } }} />),
    );
    await vi.waitFor(() =>
      expect(rows().some((r) => r.label === "Link another account")).toBe(true),
    );
    const retained = row("Link another account");
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
