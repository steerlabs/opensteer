// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createId } from "@opensteer/core";
import type { AgentConnectionConsent } from "@opensteer/protocol";
import { mockConnectedAgents } from "@opensteer/client/mock";
import { HostClientRequestError, type HostSnapshot } from "@opensteer/client/host";
import { MockHostClient, mockWorkPolicy, type MockWorkHomeScene } from "@opensteer/client/mock";
import type { MachineSummary } from "@opensteer/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentAuthorizationFormProps } from "./agent-authorization-form.types.js";
import type { NativeSettingsRow, NativeSettingsSection } from "./native-settings-page.types.js";

type Ready = Extract<AgentAuthorizationFormProps, { kind: "ready" }>;
interface SheetProps {
  readonly sheet: string;
  readonly draft: unknown;
  readonly onChange: (draft: unknown) => void;
  readonly onClose: () => void;
}

const state = vi.hoisted(() => ({
  host: null as unknown,
  form: null as AgentAuthorizationFormProps | null,
  sheet: null as SheetProps | null,
  openURL: vi.fn(async () => undefined),
  goBack: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("react-native", () => ({ Linking: { openURL: state.openURL } }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: state.goBack, navigate: state.navigate }),
}));
vi.mock("./deployment-gate.js", () => ({
  DeploymentGate: () => null,
  useAttachedHost: () => state.host,
}));
vi.mock("./agent-authorization-form.js", () => ({
  AgentAuthorizationForm: (props: AgentAuthorizationFormProps) => {
    state.form = props;
    return props.kind === "ready" ? <span>{props.title}</span> : null;
  },
}));
vi.mock("./agent-grant-sheet.js", async () => {
  const sections = await import("./agent-grant-sections.js");
  const { useEffect } = await import("react");
  return {
    AgentGrantSheetPage: (props: SheetProps & { context: never; onOpenDevices: () => void }) => {
      useEffect(
        () => () => {
          state.sheet = null;
        },
        [],
      );
      state.sheet = {
        ...props,
        sections: sections.agentGrantSheetSections(
          props.sheet as never,
          {
            ...(props.context as object),
            draft: props.draft,
            onChange: props.onChange,
            onOpenDevices: props.onOpenDevices,
          } as never,
        ),
      } as SheetProps;
      return null;
    },
  };
});

const { AgentAuthorizationScreen } = await import("./agent-authorization.js");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let host: MockHostClient | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.dispose();
  document.body.replaceChildren();
  state.form = null;
  state.sheet = null;
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

const requestId = "g".repeat(43);
const cloudRunner = "rnr_00000000-0000-4000-8000-0000000000c1";
const macRunner = "rnr_00000000-0000-4000-8000-0000000000c2";
const shopping = "bpr_00000000-0000-4000-8000-000000000003";
const created = "bpr_00000000-0000-4000-8000-0000000000aa";
const macDevice = "dev_00000000-0000-4000-8000-0000000000d2";

function consentHost(
  options: {
    readonly homes?: readonly string[];
    readonly macOnline?: boolean;
    readonly consent?: Partial<AgentConnectionConsent>;
    readonly grants?: boolean;
    readonly work?: MockWorkHomeScene;
  } = {},
) {
  const client = new MockHostClient({
    latencyMs: 0,
    grantsAvailable: options.grants ?? true,
    ...(options.work ? { workPolicy: mockWorkPolicy(options.work) } : {}),
    connectionConsent: {
      requestId,
      clientName: "Grok",
      redirectUri: "https://grok.com/oauth/callback",
      resource: "https://home.example/internal/v1/mcp",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ...options.consent,
    },
  });
  const machines = [
    {
      id: "dev_cloud",
      name: "Cloud Computer",
      status: "online",
      selfRunnerId: cloudRunner,
      kind: "home",
    },
    {
      id: macDevice,
      name: "MacBook Pro",
      status: options.macOnline === false ? "offline" : "online",
      selfRunnerId: macRunner,
    },
  ] as unknown as MachineSummary[];
  const real = client.getSnapshot.bind(client);
  type Snapshot = ReturnType<typeof real>;
  const patched = new WeakMap<HostSnapshot, Snapshot>();
  vi.spyOn(client, "getSnapshot").mockImplementation(() => {
    const base = real();
    let next = patched.get(base);
    if (!next) {
      next = {
        ...base,
        machines,
        browserProfiles: [{ id: shopping, name: "Shopping", homeRunnerId: macRunner }],
        browserProfileHomes: [...(options.homes ?? [cloudRunner, macRunner])],
      } as Snapshot;
      patched.set(base, next);
    }
    return next;
  });
  return client;
}

async function open(client: MockHostClient, id = requestId) {
  host = client;
  state.host = client;
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root!.render(
      <AgentAuthorizationScreen
        route={{ params: { deploymentId: "deployment-a", requestId: id } } as never}
      />,
    ),
  );
  await vi.waitFor(() => expect(state.form?.kind).not.toBe("loading"));
}
function ready(): Ready {
  if (state.form?.kind !== "ready") throw new Error(`form is ${state.form?.kind}`);
  return state.form;
}
function section(key: string, sections = ready().sections): NativeSettingsSection {
  const found = sections?.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`no section ${key}`);
  return found;
}
function row(sectionKey: string, key: string, sections?: readonly NativeSettingsSection[]) {
  const found = section(sectionKey, sections).rows.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`no row ${key}`);
  return found;
}
function press(target: NativeSettingsRow) {
  if (target.kind === "button" || target.kind === "choice")
    return act(async () => target.onPress());
  throw new Error(`${target.kind} can't be pressed`);
}
const detail = (target: NativeSettingsRow) => ("detail" in target ? target.detail : undefined);
const sheetSections = () =>
  (state.sheet as unknown as { sections: readonly NativeSettingsSection[] }).sections;

describe("agent consent on the phone", () => {
  it.each([390, 1440])(
    "keeps the name as a claim and grants a paired Chrome at %d px",
    async (width) => {
      const sourceId = createId("browserSource");
      vi.spyOn(window, "innerWidth", "get").mockReturnValue(width);
      const client = consentHost({
        homes: [],
        consent: {
          clientName: "Grok\u202e\nVerified",
          chromeTabs: [{ sourceId, computerName: "Work Mac", paired: true }],
          chromeTabsNeedPairing: true,
          chromeTabsRepairNames: ["Home Mac"],
        },
      });
      const dispatch = vi.spyOn(client, "dispatch");
      await open(client);
      expect(ready()).toMatchObject({
        title: "An agent wants to connect",
        mark: null,
        label: "Grok Verified",
        who: { heading: "It calls itself: Grok Verified" },
      });
      const choice = row("resources", sourceId);
      expect(choice).toMatchObject({
        label: "Tabs you share from Chrome on Work Mac",
        detail: expect.stringContaining("only while you share it from Chrome’s toolbar"),
      });
      expect(section("chrome-pairing").footer?.text).toBe(
        "To share tabs from Chrome on Home Mac, pair it again.",
      );
      expect(
        section("resources").rows.some(
          ({ label }) => label === "Tabs you share from Chrome on Home Mac",
        ),
      ).toBe(false);
      if (choice.kind !== "toggle") throw new Error("Expected a Chrome toggle");
      await act(async () => choice.onChange(true));
      await act(async () => ready().onAllow());
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: expect.objectContaining({
            grant: {
              scope: "selected",
              resources: [{ kind: "chrome-tabs", sourceId }],
              tasks: false,
            },
          }),
        }),
      );
    },
  );

  it.each([390, 1440])(
    "renders both verified origins and a pairing hint at %d px",
    async (width) => {
      vi.spyOn(window, "innerWidth", "get").mockReturnValue(width);
      const { identity, identityAtConsent } = mockConnectedAgents("seeded").connections.find(
        ({ label }) => label === "Errand",
      )!;
      await open(
        consentHost({
          consent: {
            clientName: "Client-supplied name",
            ...(identity ? { identity } : {}),
            ...(identityAtConsent ? { identityAtConsent } : {}),
            chromeTabs: [],
            chromeTabsNeedPairing: true,
          },
        }),
      );
      expect(ready()).toMatchObject({
        title: "Errand via AgentPay",
        who: {
          origins: [
            "Asked for this: Errand · https://errand.example",
            "Holds the access: AgentPay · https://agentpay.example",
          ],
        },
      });
      expect(section("chrome-pairing").footer?.text).toBe(
        "To share tabs with a connected agent, pair Chrome again.",
      );
    },
  );

  it("opens on Choose what it can use, with a new dedicated profile on the Home", async () => {
    await open(consentHost());
    const form = ready();
    expect(form.title).toBe("An agent wants to connect");
    expect(form.mark).toBeNull();
    // Grok named itself: the Home verified nothing, so no check and no logo.
    expect(form.who).toEqual({
      heading: "It calls itself: Grok",
      origins: [],
      verified: false,
      warning: "Only allow this if you started it yourself.",
    });
    expect(form.destination).toBe("Access goes to grok.com. Anyone who runs that service gets it.");
    expect(form.sections?.map(({ key }) => key)).toEqual(["scope", "resources", "tasks", "mode"]);
    expect(row("scope", "selected")).toMatchObject({ kind: "choice", selected: true });
    expect(detail(row("resources", "browser"))).toBe(
      "New dedicated profile · On Cloud Computer · starts signed out",
    );
    expect(detail(row("resources", "apps"))).toBe("None");
    expect(detail(row("resources", "plugins"))).toBe("None");
    expect(row("tasks", "tasks")).toMatchObject({ kind: "toggle", value: false });
    expect(section("tasks").footer).toBeUndefined();
    expect(row("mode", "approval-required")).toMatchObject({
      selected: true,
      detail: "Asks you before anything that changes something.",
    });
    // Saved passwords stay closed to it; a filled one is readable in the page, so never "can't see".
    expect(form.finePrint).toBe(
      "This connected agent can’t approve its own requests, open your saved passwords or cards, or change your settings. It lasts 30 days. Disconnect it any time in Settings → Connected agents.",
    );
  });

  it("keeps the simple consent on a Home without grants", async () => {
    const client = consentHost({ grants: false });
    const dispatch = vi.spyOn(client, "dispatch");
    await open(client);
    expect(ready()).toMatchObject({
      sections: null,
      mark: null,
      title: "An agent wants to connect",
    });
    // Each mode reads as it does for a connection: its work never runs with
    // the person's own engine settings.
    const modes = (ready() as { modes: { description: string; mode: string }[] }).modes;
    expect(modes.find(({ mode }) => mode === "approval-required")?.description).toBe(
      "Asks you before anything that changes something.",
    );
    expect(JSON.stringify(modes)).not.toContain("a rule you set in the engine");
    expect(ready().finePrint).toBe(
      "It can’t approve requests, open your saved passwords or give anyone access. This lasts 30 days, and you can remove it any time in Settings → Connected agents.",
    );
    await act(async () => ready().onAllow());
    expect(dispatch.mock.calls.map(([command]) => command.type)).toEqual(["connection.authorize"]);
    expect(dispatch.mock.calls[0]![0]).toMatchObject({
      decision: { kind: "approve", label: "Grok", accessMode: "approval-required" },
    });
    expect(dispatch.mock.calls[0]![0]).not.toHaveProperty("decision.grant");
  });

  it("lists profiles in the Browser sheet and warns about shared sign-ins", async () => {
    await open(consentHost());
    await press(row("resources", "browser"));
    expect(state.sheet?.sheet).toBe("browser");
    expect(detail(row("profiles", shopping, sheetSections()))).toBe("MacBook Pro · Online");
    expect(row("new", "keep-on", sheetSections())).toMatchObject({
      kind: "chips",
      value: cloudRunner,
      menu: true,
    });
    expect(section("profiles", sheetSections()).footer?.text).toBe(
      "This connected agent gets full control of each profile you pick, including every site signed in there. It can’t open your saved passwords or cards. When it needs one, it asks you and Opensteer fills it in; once filled, the page and the agent can read it. A page it works in can replace what is on the clipboard.",
    );
    await press(row("profiles", shopping, sheetSections()));
    expect(detail(row("resources", "browser"))).toBe(
      "New dedicated profile · On Cloud Computer · starts signed out, Shopping",
    );
    expect(section("resources").footer?.text).toBe(
      "This connected agent can use every site you’re signed in to in Shopping, as you. A new profile starts signed out.",
    );
    await act(async () => state.sheet!.onClose());
    expect(state.sheet).toBeNull();
  });

  it("reads approved apps only when that sheet opens, and says when there are none", async () => {
    const client = consentHost();
    const approved = vi.fn(async () => ({ ok: true as const, data: { apps: [] } }));
    Object.defineProperty(client.rpc, "integration.computer.apps.approved", {
      value: approved,
      configurable: true,
    });
    await open(client);
    expect(approved).not.toHaveBeenCalled();
    await press(row("resources", "apps"));
    await vi.waitFor(() =>
      expect(row("apps", "empty", sheetSections())).toMatchObject({
        label: "No apps approved yet",
      }),
    );
    expect(approved).toHaveBeenCalledOnce();
    await press(row("apps", "devices", sheetSections()));
    expect(state.navigate).toHaveBeenCalledWith("SettingsDevices", {
      deploymentId: "deployment-a",
    });
  });

  it("says when a list could not be read, with Try again", async () => {
    const client = consentHost();
    const approved = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ ok: true, data: { apps: [] } });
    Object.defineProperty(client.rpc, "integration.computer.apps.approved", {
      value: approved,
      configurable: true,
    });
    await open(client);
    await press(row("resources", "apps"));
    await vi.waitFor(() => expect(section("apps", sheetSections()).footer?.tone).toBe("danger"));
    await act(async () => section("apps", sheetSections()).footer!.link!.onPress());
    await vi.waitFor(() => expect(row("apps", "empty", sheetSections()).kind).toBe("text"));
  });

  it("turns Tasks on with its plain warning", async () => {
    await open(consentHost());
    const tasks = row("tasks", "tasks");
    if (tasks.kind !== "toggle") throw new Error("Tasks is a switch");
    await act(async () => tasks.onChange(true));
    expect(section("tasks").footer).toEqual({
      text: "This is the most powerful choice. Work it starts can change anything on Cloud Computer that your own agents can, inside the safety mode below. Opensteer can stop what happens next, but can’t undo what an agent already did.",
      tone: "danger",
    });
  });

  it("approves with exactly the chosen grant, creating the dedicated profile once across a retry", async () => {
    const client = consentHost();
    let attempts = 0;
    const dispatch = vi.spyOn(client, "dispatch").mockImplementation(async (command) => {
      if (command.type === "browser.profile.create")
        return {
          type: "browser.profile.create",
          profile: { id: created, name: "Grok", homeRunnerId: cloudRunner },
        } as never;
      if (command.type === "connection.authorize" && ++attempts === 1)
        throw new HostClientRequestError({ code: "bad_request", message: "no", status: 400 });
      return {
        type: "connection.authorize",
        completionPath: `/oauth/mcp/complete?request=${requestId}`,
      } as never;
    });
    await open(client);
    await press(row("mode", "auto"));
    await act(async () => ready().onAllow());
    expect(ready().error).toBe("The connection couldn’t be approved. Try again.");
    await act(async () => ready().onAllow());
    expect(dispatch.mock.calls.map(([command]) => command.type)).toEqual([
      "browser.profile.create",
      "connection.authorize",
      "connection.authorize",
    ]);
    expect(dispatch.mock.calls[0]![0]).toMatchObject({
      input: { name: "Grok", homeRunnerId: cloudRunner },
    });
    expect(dispatch.mock.calls[2]![0]).toMatchObject({
      decision: {
        kind: "approve",
        label: "Grok",
        accessMode: "auto",
        grant: {
          scope: "selected",
          tasks: false,
          resources: [{ kind: "browser-profile", profileId: created }],
        },
      },
    });
    expect(state.openURL).toHaveBeenCalledWith(
      `https://home.example/oauth/mcp/complete?request=${requestId}`,
    );
    expect(state.goBack).toHaveBeenCalledOnce();
  });

  it("gives everything without creating a profile, and says what settings also need", async () => {
    const client = consentHost();
    const dispatch = vi.spyOn(client, "dispatch");
    await open(client);
    await press(row("scope", "everything"));
    expect(ready().sections?.map(({ key }) => key)).toEqual(["scope", "mode"]);
    expect(section("scope").footer?.text).toBe("Changing your settings also needs Full access.");
    await act(async () => ready().onAllow());
    expect(dispatch.mock.calls.map(([command]) => command.type)).toEqual(["connection.authorize"]);
    expect(dispatch.mock.calls[0]![0]).toMatchObject({
      decision: { grant: { scope: "everything" } },
    });
  });

  it("denies without creating anything", async () => {
    const client = consentHost();
    const dispatch = vi.spyOn(client, "dispatch");
    await open(client);
    await act(async () => ready().onDeny());
    expect(dispatch.mock.calls.map(([command]) => command)).toEqual([
      expect.objectContaining({ type: "connection.authorize", decision: { kind: "deny" } }),
    ]);
  });

  it("says when nothing is chosen, without blocking Allow", async () => {
    await open(consentHost());
    await press(row("resources", "browser"));
    await press(row("new", "new", sheetSections()));
    expect(section("resources").footer?.text).toBe(
      "This connected agent can connect, but can’t use anything until you choose something.",
    );
  });

  it("asks for Browser on a Device first when no Device can keep a profile", async () => {
    await open(consentHost({ homes: [] }));
    expect(detail(row("resources", "browser"))).toBe("None");
    await press(row("resources", "browser"));
    expect(row("new", "no-browser", sheetSections())).toMatchObject({
      label: "Turn on Browser on a device first",
    });
  });

  it("says the new profile waits for its Device when that Device is offline", async () => {
    await open(consentHost({ homes: [macRunner], macOnline: false }));
    expect(section("resources").footer?.text).toBe(
      "None of your devices are online. This connected agent can use its profile once MacBook Pro is back.",
    );
  });

  it("says a request expired, and never offers Allow", async () => {
    await open(consentHost(), "x".repeat(43));
    expect(state.form).toMatchObject({
      kind: "failed",
      title: "This request expired",
      detail: "Start connecting again from the agent.",
      onRetry: null,
    });
  });

  it("reads the consent again when its verification changed, keeping the choices still offered", async () => {
    const [workMac, homeMac] = [createId("browserSource"), createId("browserSource")];
    const claude = mockConnectedAgents("seeded").connections.find(
      ({ label }) => label === "Claude",
    )!;
    const client = consentHost();
    const consent = {
      requestId,
      clientName: "Claude",
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
      resource: "https://home.example/internal/v1/mcp",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      grantsAvailable: true as const,
    };
    const reads = [
      {
        ...consent,
        identity: claude.identity!,
        identityAtConsent: claude.identityAtConsent!,
        verificationSnapshot: "a".repeat(64),
        chromeTabs: [
          { sourceId: workMac, computerName: "Work Mac", paired: true },
          { sourceId: homeMac, computerName: "Home Mac", paired: true },
        ],
      },
      // Read again: no longer verified, and one Chrome is no longer paired.
      {
        ...consent,
        verificationSnapshot: "b".repeat(64),
        chromeTabs: [{ sourceId: workMac, computerName: "Work Mac", paired: true }],
      },
    ];
    let read = 0;
    Object.defineProperty(client.rpc, "connections.authorization.get", {
      value: vi.fn(async () => ({ ok: true, data: reads[Math.min(read++, 1)] })),
      configurable: true,
    });
    let attempts = 0;
    const dispatch = vi.spyOn(client, "dispatch").mockImplementation(async (command) => {
      if (command.type === "browser.profile.create")
        return {
          type: "browser.profile.create",
          profile: { id: created, name: "Mine", homeRunnerId: cloudRunner },
        } as never;
      if (command.type === "connection.authorize" && ++attempts === 1)
        throw new HostClientRequestError({
          code: "conflict",
          reason: "consent-verification-changed",
          message: "This agent’s verification changed. Review it again.",
          status: 409,
        });
      return { type: "connection.authorize", completionPath: "/oauth/done" } as never;
    });
    await open(client);
    expect(ready()).toMatchObject({
      title: "Claude",
      who: { heading: "Verified", verified: true },
    });
    await act(async () => ready().onLabel("Mine"));
    for (const source of [workMac, homeMac]) {
      const toggle = row("resources", source);
      if (toggle.kind !== "toggle") throw new Error("Expected a Chrome toggle");
      await act(async () => toggle.onChange(true));
    }
    const tasks = row("tasks", "tasks");
    if (tasks.kind !== "toggle") throw new Error("Tasks is a switch");
    await act(async () => tasks.onChange(true));
    await press(row("mode", "auto"));
    expect(ready().notice).toBeNull();

    await act(async () => ready().onAllow());
    // The agent as the Home now presents it, with one line beside Allow; not "Already answered".
    expect(ready()).toMatchObject({
      title: "An agent wants to connect",
      mark: null,
      who: { heading: "It calls itself: Claude", verified: false },
      notice: "This agent’s verification changed. Review it again.",
      error: null,
      label: "Mine",
      mode: "auto",
      busy: null,
    });
    expect(row("resources", workMac)).toMatchObject({ kind: "toggle", value: true });
    expect(() => row("resources", homeMac)).toThrow();
    expect(row("tasks", "tasks")).toMatchObject({ kind: "toggle", value: true });

    await act(async () => ready().onAllow());
    const authorizations = dispatch.mock.calls
      .map(([command]) => command)
      .filter((command) => command.type === "connection.authorize");
    expect(authorizations[0]).toMatchObject({
      decision: { verificationSnapshot: "a".repeat(64) },
    });
    expect(authorizations[1]).toMatchObject({
      decision: {
        kind: "approve",
        label: "Mine",
        accessMode: "auto",
        verificationSnapshot: "b".repeat(64),
        grant: {
          scope: "selected",
          tasks: true,
        },
      },
    });
    const { resources } = (authorizations[1] as { decision: { grant: { resources: unknown[] } } })
      .decision.grant;
    expect(resources).toHaveLength(2);
    expect(resources).toEqual(
      expect.arrayContaining([
        { kind: "chrome-tabs", sourceId: workMac },
        { kind: "browser-profile", profileId: created },
      ]),
    );
    expect(
      dispatch.mock.calls.filter(([command]) => command.type === "browser.profile.create"),
    ).toHaveLength(1);
    expect(state.openURL).toHaveBeenCalledOnce();
  });

  it("on a work Home, shows what its organization rules out as unavailable, with why", async () => {
    await open(consentHost({ work: "strict" }));
    const reason = "Your organization doesn’t allow this";
    expect(ready().work).toBe("Work · Northwind Logistics");
    expect(row("scope", "selected")).toMatchObject({ selected: true, disabled: false });
    expect(row("scope", "everything")).toMatchObject({ disabled: true, detail: reason });
    expect(row("tasks", "tasks")).toMatchObject({ kind: "toggle", disabled: true, detail: reason });
    expect(row("mode", "approval-required")).toMatchObject({ selected: true, disabled: false });
    for (const mode of ["auto-accept-edits", "auto", "full-access"])
      expect(row("mode", mode)).toMatchObject({ disabled: true, detail: reason });
  });

  it("follows a new policy version while it is open, and Allow asks only for what it allows", async () => {
    const client = consentHost({ work: "open" });
    const dispatch = vi.spyOn(client, "dispatch").mockImplementation(async (command) =>
      command.type === "browser.profile.create"
        ? ({
            type: "browser.profile.create",
            profile: { id: created, name: "Claude", homeRunnerId: cloudRunner },
          } as never)
        : ({ type: "connection.authorize", completionPath: "/oauth/done" } as never),
    );
    await open(client);
    await press(row("mode", "auto"));
    const tasks = row("tasks", "tasks");
    if (tasks.kind !== "toggle") throw new Error("Tasks is a switch");
    await act(async () => tasks.onChange(true));
    expect(row("mode", "auto")).toMatchObject({ selected: true });
    expect(row("tasks", "tasks")).toMatchObject({ value: true });

    // The organization narrows its policy; the open screen follows with no reload.
    await act(async () => client.applyWorkPolicy(mockWorkPolicy("strict")));
    const reason = "Your organization doesn’t allow this";
    expect(row("mode", "approval-required")).toMatchObject({ selected: true });
    expect(row("mode", "auto")).toMatchObject({ selected: false, disabled: true, detail: reason });
    expect(row("tasks", "tasks")).toMatchObject({ value: false, disabled: true, detail: reason });

    await act(async () => ready().onAllow());
    const authorize = dispatch.mock.calls
      .map(([command]) => command)
      .find((command) => command.type === "connection.authorize");
    expect(authorize).toMatchObject({
      decision: { accessMode: "approval-required", grant: { tasks: false } },
    });
  });

  it("on a personal Home, offers every choice with no mark and no reason", async () => {
    await open(consentHost());
    expect(ready().work).toBeNull();
    for (const key of ["scope", "tasks", "mode"])
      for (const candidate of section(key).rows)
        expect("disabled" in candidate ? candidate.disabled : false).toBe(false);
  });

  it("says when the request was already answered on another device", async () => {
    const client = consentHost();
    vi.spyOn(client, "dispatch").mockImplementation(async (command) => {
      if (command.type === "browser.profile.create")
        return {
          type: "browser.profile.create",
          profile: { id: created, name: "Grok", homeRunnerId: cloudRunner },
        } as never;
      throw new HostClientRequestError({ code: "conflict", message: "answered", status: 409 });
    });
    await open(client);
    await act(async () => ready().onAllow());
    expect(state.form).toMatchObject({ kind: "failed", title: "Already answered", onRetry: null });
  });

  it("offers Try again when the request could not be read", async () => {
    const client = consentHost();
    const get = client.rpc["connections.authorization.get"];
    Object.defineProperty(client.rpc, "connections.authorization.get", {
      value: vi.fn(get).mockRejectedValueOnce(new Error("offline")),
      configurable: true,
    });
    await open(client);
    expect(state.form).toMatchObject({ kind: "failed", title: "Can’t review this request" });
    if (state.form?.kind !== "failed" || !state.form.onRetry) throw new Error("no retry");
    await act(async () => (state.form as { onRetry: () => void }).onRetry());
    await vi.waitFor(() => expect(state.form?.kind).toBe("ready"));
  });

  it("never opens the completion of a request another request has replaced", async () => {
    const client = consentHost({ grants: false });
    host = client;
    state.host = client;
    Object.defineProperty(client.rpc, "connections.authorization.get", {
      value: vi.fn(async ({ requestId: id }: { requestId: string }) => ({
        ok: true,
        data: {
          requestId: id,
          clientName: id[0] === "a" ? "First agent" : "Second agent",
          redirectUri: "https://agent.example/callback",
          resource: "https://mac.connect.example/internal/v1/mcp",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      })),
      configurable: true,
    });
    let finish:
      ((output: { type: "connection.authorize"; completionPath: string }) => void) | undefined;
    vi.spyOn(client, "dispatch").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    root = createRoot(document.body.appendChild(document.createElement("div")));
    const render = (id: string) =>
      root!.render(
        <AgentAuthorizationScreen
          route={{ params: { deploymentId: "deployment-a", requestId: id } } as never}
        />,
      );
    await act(async () => render("a".repeat(43)));
    await vi.waitFor(() => expect(state.form?.kind).toBe("ready"));
    await act(async () => ready().onAllow());
    expect(finish).toBeTypeOf("function");
    await act(async () => render("b".repeat(43)));
    await vi.waitFor(() => expect(ready().label).toBe("Second agent"));
    await act(async () =>
      finish!({ type: "connection.authorize", completionPath: "/oauth/mcp/complete?request=a" }),
    );
    expect(state.openURL).not.toHaveBeenCalled();
    expect(state.goBack).not.toHaveBeenCalled();
  });
});
