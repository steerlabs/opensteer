// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { externalAgentGuides } from "@opensteer/client/host";
import { MockHostClient, mockConnectedAgents } from "@opensteer/client/mock";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeSettingsPageProps, NativeSettingsRow } from "./native-settings-page.types.js";

const state = vi.hoisted(() => ({
  host: null as unknown,
  page: null as NativeSettingsPageProps | null,
  remote: { status: null, error: "The computer did not answer." } as {
    status: unknown;
    error: string | null;
  },
  navigate: vi.fn(),
  exposure: "networked" as "networked" | "loopback",
}));

vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: state.navigate }),
}));
vi.mock("@opensteer/client/react", async (load) => ({
  ...(await load<typeof import("@opensteer/client/react")>()),
  usePersonalRemoteAccess: () => state.remote,
}));
vi.mock("../ui/mobile-client-context.js", () => ({
  useMobileState: () => ({ selection: { deploymentId: "deployment-a", hostClient: state.host } }),
}));
vi.mock("./use-settings-host.js", () => ({
  useSettingsHost: () => ({
    machines: [],
    identityConfig: {
      exposure: state.exposure,
      publicOrigin: "https://home.example",
      deployment: { name: "Cloud Computer" },
    },
  }),
}));
vi.mock("./native-settings-page.js", () => ({
  NativeSettingsPage: (props: NativeSettingsPageProps) => {
    state.page = props;
    return null;
  },
}));
vi.mock("./external-agent-mark.js", () => ({ ExternalAgentMark: () => null }));
vi.mock("./external-agent-setup-sheet.js", () => ({ ExternalAgentSetupSheet: () => null }));

const { ExternalAgentsSettingsController } =
  await import("./settings-external-agents-controller.js");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let host: MockHostClient | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.dispose();
  document.body.replaceChildren();
  state.page = null;
  state.exposure = "networked";
  state.remote = { status: null, error: "The computer did not answer." };
  vi.clearAllMocks();
});

async function open(client: MockHostClient) {
  host = client;
  state.host = client;
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(<ExternalAgentsSettingsController />));
}
const section = (key: string) => state.page?.sections.find((candidate) => candidate.key === key);
const lines = (key: string) =>
  section(key)?.rows.map((row) => [row.label, "detail" in row ? row.detail : undefined]);

describe("Connected agents on the phone", () => {
  it("says who is connected and what each can use, then the disconnected ones with their outcome", async () => {
    await open(
      new MockHostClient({ latencyMs: 0, connections: mockConnectedAgents("seeded").connections }),
    );
    await vi.waitFor(() => expect(section("disconnected")).toBeDefined());
    expect(section("lead")?.footer?.text).toBe(
      "Connect Opensteer to ChatGPT, Claude and other agents, so they can get things done for you. You choose what each can use.",
    );
    expect(section("connected")?.title).toBe("Connected");
    expect(lines("connected")).toEqual([
      ["Grok", "Shopping profile · Supervised"],
      ["Claude", "Everything · Full access"],
      ["Trip planner", "Tasks · Auto"],
      ["Errand", "Nothing chosen · Supervised"],
      ["Claude Code", "Tasks · Auto"],
      ["ChatGPT", "Nothing chosen · Supervised"],
    ]);
    expect(lines("disconnected")).toEqual([
      ["Shop helper", "Check its last action"],
      ["Old notes agent", "Disconnected"],
    ]);
    const grok = section("connected")!.rows[0] as Extract<NativeSettingsRow, { kind: "button" }>;
    expect(grok).toMatchObject({ opens: true });
    expect(grok.lead).toBeDefined();
    await act(async () => grok.onPress());
    expect(state.navigate).toHaveBeenCalledWith("ConnectedAgent", {
      deploymentId: "deployment-a",
      connectionId: "mcn_00000000-0000-4000-8000-000000000001",
    });
  });

  it("lists only connected agents from a Home without grants", async () => {
    await open(
      new MockHostClient({
        latencyMs: 0,
        grantsAvailable: false,
        connections: mockConnectedAgents("seeded").connections,
      }),
    );
    await vi.waitFor(() => expect(section("connected")?.rows).toHaveLength(6));
    // Without includeRevoked an older Home leaves a stopped connection off the list.
    expect(section("disconnected")?.rows.map((row) => row.label)).toEqual(["Shop helper"]);
  });

  it("draws placeholders until the list arrives, and Try again when it can't be read", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    const list = client.rpc["connections.list"];
    let fail: ((error: Error) => void) | undefined;
    Object.defineProperty(client.rpc, "connections.list", {
      value: vi
        .fn()
        .mockImplementationOnce(() => new Promise((_resolve, reject) => (fail = reject)))
        .mockImplementation(list),
      configurable: true,
    });
    await open(client);
    expect(section("connected")?.rows.every((row) => row.kind === "placeholder")).toBe(true);
    await act(async () => fail!(new Error("offline")));
    await vi.waitFor(() =>
      expect(section("connected")?.footer?.text).toBe("Couldn’t load your connected agents."),
    );
    await act(async () => section("connected")!.footer!.link!.onPress());
    await vi.waitFor(() => expect(section("connected")).toBeUndefined());
  });

  it("blocks setup and says why when Remote access can't be read", async () => {
    state.exposure = "loopback";
    await open(new MockHostClient({ latencyMs: 0 }));
    await vi.waitFor(() => expect(section("notice")).toBeDefined());
    expect(lines("notice")).toEqual([
      ["Couldn’t check Remote access", "The computer did not answer."],
    ]);
    expect(
      section("add")?.rows.every((row) => row.kind === "button" && row.disabled === true),
    ).toBe(true);
  });

  it("asks for Remote access first, with the way to turn it on", async () => {
    state.exposure = "loopback";
    state.remote = { status: { access: { mode: "off", route: null } }, error: null };
    await open(new MockHostClient({ latencyMs: 0 }));
    await vi.waitFor(() => expect(section("notice")).toBeDefined());
    expect(section("notice")?.rows.map((row) => row.label)).toEqual([
      "Turn on Remote access first",
      "Turn on",
    ]);
    const turnOn = section("notice")!.rows[1] as Extract<NativeSettingsRow, { kind: "button" }>;
    await act(async () => turnOn.onPress());
    expect(state.navigate).toHaveBeenCalledWith("SettingsAccount", {
      deploymentId: "deployment-a",
    });
  });

  it("offers each guide once the list has loaded on a networked Home", async () => {
    await open(new MockHostClient({ latencyMs: 0 }));
    await vi.waitFor(() =>
      expect(section("add")?.rows.every((row) => row.kind === "button" && !row.disabled)).toBe(
        true,
      ),
    );
    expect(section("add")?.rows.map((row) => row.label)).toEqual(
      externalAgentGuides.map((guide) => guide.name),
    );
    expect(section("notice")).toBeUndefined();
  });
});
