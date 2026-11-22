// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { createId } from "@opensteer/core";
import { HostClientRequestError, type HostSnapshot } from "@opensteer/client/host";
import {
  MockHostClient,
  mockConnectedAgents,
  mockWorkPolicy,
  type MockWorkHomeScene,
} from "@opensteer/client/mock";
import type { MachineSummary } from "@opensteer/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpAuthorization, McpAuthorizationLaunch } from "./mcp-authorization.js";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
let host: MockHostClient | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const requestId = "g".repeat(43);
const cloudRunner = "rnr_00000000-0000-4000-8000-0000000000c1";
const macRunner = "rnr_00000000-0000-4000-8000-0000000000c2";
const shopping = "bpr_00000000-0000-4000-8000-000000000003";
const created = "bpr_00000000-0000-4000-8000-0000000000aa";
const approval = "con_00000000-0000-4000-8000-0000000000ab";
const macDevice = "dev_00000000-0000-4000-8000-0000000000d2";

function consentHost(
  options: {
    readonly homes?: readonly string[] | undefined;
    readonly macOnline?: boolean;
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
        ...("homes" in options && options.homes === undefined
          ? { browserProfileHomes: undefined }
          : { browserProfileHomes: [...(options.homes ?? [cloudRunner, macRunner])] }),
      } as Snapshot;
      patched.set(base, next);
    }
    return next;
  });
  return client;
}

async function mount(client: MockHostClient, id: string | null = requestId) {
  const openExternalUrl = vi.fn(async () => ({ opened: true as const }));
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <MemoryRouter>
        <McpAuthorization client={client} desktopBridge={{ openExternalUrl }} requestId={id} />
      </MemoryRouter>,
    ),
  );
  await vi.waitFor(() => expect(container.textContent).not.toContain("Loading connection request"));
  return { container, openExternalUrl };
}

function buttonNamed(container: HTMLElement, text: string) {
  const found = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === text || button.getAttribute("aria-label") === text,
  );
  if (!found) throw new Error(`No button ${text}`);
  return found;
}
function row(container: HTMLElement, title: string) {
  const found = [...container.querySelectorAll(".card__row, .agent-grant__check")].find((element) =>
    element.querySelector(".card__row-title")?.textContent?.startsWith(title),
  );
  if (!found) throw new Error(`No row ${title}`);
  return found as HTMLElement;
}
function detail(container: HTMLElement, title: string) {
  return row(container, title).querySelector(".card__row-detail")?.textContent;
}
const authorizeCalls = (dispatch: {
  readonly mock: { readonly calls: readonly (readonly unknown[])[] };
}) =>
  dispatch.mock.calls
    .map((call) => call[0] as { readonly type: string })
    .filter(({ type }) => type === "connection.authorize");

describe("agent consent with grants", () => {
  it("opens on Choose what it can use, with a new dedicated profile on the Home and nothing else", async () => {
    host = consentHost();
    const { container } = await mount(host);
    expect(container.querySelector("h1")?.textContent).toBe("An agent wants to connect");
    expect(container.textContent).toContain(
      "Access goes to grok.com. Anyone who runs that service gets it.",
    );
    // Grok's name is only the one it gave itself: no verified mark, and it says so.
    expect(container.querySelector(".agent-who--verified")).toBeNull();
    expect(container.textContent).toContain("It calls itself: Grok");
    expect(container.textContent).toContain("Only allow this if you started it yourself.");
    expect(container.textContent).not.toContain("Returns to");
    const checked = [
      ...container.querySelectorAll<HTMLInputElement>('input[type="radio"]:checked'),
    ];
    expect(checked.map((input) => input.value)).toEqual(["selected", "approval-required"]);
    expect(detail(container, "Browser")).toBe(
      "New dedicated profile · On Cloud Computer · starts signed out",
    );
    expect(detail(container, "Apps and phone screens")).toBe("None");
    expect(detail(container, "Plugins and data")).toBe("None");
    expect(
      container.querySelector<HTMLInputElement>('[aria-labelledby="agent-grant-tasks"]')!.checked,
    ).toBe(false);
    expect(container.textContent).toContain("Asks you before anything that changes something.");
    expect(container.textContent).not.toContain("This is the most powerful choice");
    expect(container.textContent).toContain(
      "This connected agent can’t approve its own requests, open your saved passwords or cards, or change your settings.",
    );
  });

  it("lists profiles with their Device in the Browser disclosure, and warns about shared sign-ins", async () => {
    host = consentHost();
    const { container } = await mount(host);
    await act(async () => buttonNamed(container, "Choose Browser").click());
    expect(detail(container, "Shopping")).toBe("MacBook Pro · Online");
    // A filled password is readable in the page, so the footer never says the agent "can't see" it.
    expect(container.textContent).toContain(
      "This connected agent gets full control of each profile you pick, including every site signed in there. It can’t open your saved passwords or cards. When it needs one, it asks you and Opensteer fills it in; once filled, the page and the agent can read it. A page it works in can replace what is on the clipboard.",
    );
    const keepOn = container.querySelector('[aria-label="Keep it on"]')!;
    expect([...keepOn.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "Cloud Computer",
      "MacBook Pro",
    ]);
    await act(async () => (keepOn.querySelectorAll("button")[1] as HTMLButtonElement).click());
    await act(async () => row(container, "Shopping").querySelector("input")!.click());
    expect(detail(container, "Browser")).toBe(
      "New dedicated profile · On MacBook Pro · starts signed out, Shopping",
    );
    expect(container.textContent).toContain(
      "This connected agent can use every site you’re signed in to in Shopping, as you.",
    );
  });

  it("reads approved apps only when that list opens, and says so when there are none", async () => {
    host = consentHost();
    const approved = vi.fn(async () => ({ ok: true as const, data: { apps: [] } }));
    Object.defineProperty(host.rpc, "integration.computer.apps.approved", {
      value: approved,
      configurable: true,
    });
    const plugins = vi.fn(host.rpc["plugins.installed.list"]);
    Object.defineProperty(host.rpc, "plugins.installed.list", {
      value: plugins,
      configurable: true,
    });
    const { container } = await mount(host);
    expect(approved).not.toHaveBeenCalled();
    expect(plugins).not.toHaveBeenCalled();
    await act(async () => buttonNamed(container, "Choose Apps and phone screens").click());
    await vi.waitFor(() => expect(container.textContent).toContain("No apps approved yet"));
    expect(approved).toHaveBeenCalledOnce();
    expect(container.querySelector('a[href="/settings/devices"]')?.textContent).toBe(
      "Open Devices",
    );
    expect(plugins).not.toHaveBeenCalled();
  });

  it("says when a list could not be read, and reads it again on Try again", async () => {
    host = consentHost();
    const approved = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ ok: true, data: { apps: [] } });
    Object.defineProperty(host.rpc, "integration.computer.apps.approved", {
      value: approved,
      configurable: true,
    });
    const { container } = await mount(host);
    await act(async () => buttonNamed(container, "Choose Apps and phone screens").click());
    await vi.waitFor(() => expect(container.textContent).toContain("Couldn’t load this list."));
    await act(async () => buttonNamed(container, "Try again").click());
    await vi.waitFor(() => expect(container.textContent).toContain("No apps approved yet"));
  });

  it("turns Tasks on with its plain warning", async () => {
    host = consentHost();
    const { container } = await mount(host);
    const tasks = container.querySelector<HTMLInputElement>(
      '[aria-labelledby="agent-grant-tasks"]',
    )!;
    expect(detail(container, "Tasks")).toBe(
      "Lets it ask your own agents to work on Cloud Computer: read and change files and run commands there.",
    );
    await act(async () => tasks.click());
    expect(container.textContent).toContain(
      "This is the most powerful choice. Work it starts can change anything on Cloud Computer that your own agents can, inside the safety mode below. Opensteer can stop what happens next, but can’t undo what an agent already did.",
    );
  });

  it("approves with exactly the chosen grant, creating the dedicated profile first", async () => {
    host = consentHost();
    const approved = vi.fn(async () => ({
      ok: true as const,
      data: {
        apps: [
          {
            connectionId: approval,
            machineId: macDevice,
            name: "Notes",
            iconPng: null,
            target: {
              kind: "app",
              app: { bundleId: "com.apple.Notes", displayName: "Notes", teamId: "ABCDE12345" },
            },
          },
        ],
      },
    }));
    Object.defineProperty(host.rpc, "integration.computer.apps.approved", {
      value: approved,
      configurable: true,
    });
    Object.defineProperty(host.rpc, "plugins.installed.list", {
      value: vi.fn(async () => ({
        ok: true,
        data: {
          engine: { state: "ready" },
          cursor: null,
          plugins: [{ id: "calendar", name: "Calendar", access: "all" }],
          local: [],
        },
      })),
      configurable: true,
    });
    const dispatch = vi.spyOn(host, "dispatch").mockImplementation(async (command) => {
      if (command.type === "browser.profile.create")
        return {
          type: "browser.profile.create",
          profile: { id: created, name: "Grok", homeRunnerId: cloudRunner },
        } as never;
      if (command.type === "connection.authorize")
        return {
          type: "connection.authorize",
          completionPath: `/oauth/mcp/complete?request=${requestId}`,
        } as never;
      throw new Error(`unexpected ${command.type}`);
    });
    const { container, openExternalUrl } = await mount(host);
    await act(async () => buttonNamed(container, "Choose Apps and phone screens").click());
    await vi.waitFor(() => expect(container.textContent).toContain("Notes"));
    // The consent says what an app or a phone screen gives the agent, the clipboard included.
    expect(container.textContent).toContain(
      "sees and controls each one you turn on as you would, so it can paste what’s on that device’s clipboard.",
    );
    await act(async () => row(container, "Notes").querySelector("input")!.click());
    await act(async () => buttonNamed(container, "Choose Plugins and data").click());
    await vi.waitFor(() => expect(container.textContent).toContain("Calendar"));
    const calendar = row(container, "Calendar").querySelector('[aria-label="Calendar"]')!;
    expect([...calendar.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "Off",
      "Read",
      "Read and write",
    ]);
    await act(async () => (calendar.querySelectorAll("button")[1] as HTMLButtonElement).click());
    await act(async () =>
      container.querySelector<HTMLInputElement>('input[value="auto"]')!.click(),
    );
    await act(async () => buttonNamed(container, "Allow").click());
    expect(dispatch.mock.calls.map(([command]) => command.type)).toEqual([
      "browser.profile.create",
      "connection.authorize",
    ]);
    expect(dispatch.mock.calls[0]![0]).toMatchObject({
      input: { name: "Grok", homeRunnerId: cloudRunner },
    });
    expect(dispatch.mock.calls[1]![0]).toMatchObject({
      requestId,
      decision: {
        kind: "approve",
        label: "Grok",
        accessMode: "auto",
        grant: {
          scope: "selected",
          tasks: false,
          resources: [
            { kind: "browser-profile", profileId: created },
            {
              kind: "computer-app",
              approvalId: approval,
              deviceId: macDevice,
              app: { kind: "mac-app", bundleId: "com.apple.notes", teamId: "ABCDE12345" },
            },
            { kind: "plugin", access: "read", target: { kind: "installed", pluginId: "calendar" } },
          ],
        },
      },
    });
    expect(openExternalUrl).toHaveBeenCalledOnce();
  });

  it("reuses the created profile when an approval is retried", async () => {
    host = consentHost();
    let authorizeAttempts = 0;
    const dispatch = vi.spyOn(host, "dispatch").mockImplementation(async (command) => {
      if (command.type === "browser.profile.create")
        return {
          type: "browser.profile.create",
          profile: { id: created, name: "Grok", homeRunnerId: cloudRunner },
        } as never;
      if (command.type === "connection.authorize" && ++authorizeAttempts === 1)
        throw new HostClientRequestError({ code: "bad_request", message: "no", status: 400 });
      return {
        type: "connection.authorize",
        completionPath: `/oauth/mcp/complete?request=${requestId}`,
      } as never;
    });
    const { container } = await mount(host);
    await act(async () => buttonNamed(container, "Allow").click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "The connection couldn’t be approved. Try again.",
    );
    await act(async () => buttonNamed(container, "Allow").click());
    expect(
      dispatch.mock.calls.filter(([command]) => command.type === "browser.profile.create"),
    ).toHaveLength(1);
    expect(authorizeCalls(dispatch)).toHaveLength(2);
  });

  it("gives everything without creating a profile, and notes what settings also need", async () => {
    host = consentHost();
    const dispatch = vi.spyOn(host, "dispatch");
    const { container } = await mount(host);
    await act(async () =>
      container.querySelector<HTMLInputElement>('input[value="everything"]')!.click(),
    );
    expect(container.textContent).not.toContain("Apps and phone screens");
    expect(container.textContent).toContain("Changing your settings also needs Full access.");
    await act(async () => buttonNamed(container, "Allow").click());
    expect(dispatch.mock.calls.map(([command]) => command.type)).toEqual(["connection.authorize"]);
    expect(dispatch.mock.calls[0]![0]).toMatchObject({
      decision: { grant: { scope: "everything" } },
    });
  });

  it("denies without creating anything", async () => {
    host = consentHost();
    const dispatch = vi.spyOn(host, "dispatch");
    const { container } = await mount(host);
    await act(async () => buttonNamed(container, "Deny").click());
    expect(dispatch.mock.calls.map(([command]) => command)).toEqual([
      expect.objectContaining({ type: "connection.authorize", decision: { kind: "deny" } }),
    ]);
  });

  it("says when nothing is chosen, without blocking Allow", async () => {
    host = consentHost();
    const { container } = await mount(host);
    await act(async () => buttonNamed(container, "Choose Browser").click());
    await act(async () => row(container, "New dedicated profile").querySelector("input")!.click());
    expect(container.textContent).toContain(
      "This connected agent can connect, but can’t use anything until you choose something.",
    );
    expect(buttonNamed(container, "Allow").disabled).toBe(false);
  });

  it("asks for Browser on a Device first when no Device can keep a profile", async () => {
    host = consentHost({ homes: [] });
    const { container } = await mount(host);
    expect(detail(container, "Browser")).toBe("None");
    await act(async () => buttonNamed(container, "Choose Browser").click());
    expect(container.textContent).toContain("Turn on Browser on a device first");
  });

  it("lets an older profile placement decide where the new profile lives", async () => {
    host = consentHost({ homes: undefined });
    const { container } = await mount(host);
    expect(detail(container, "Browser")).toBe("New dedicated profile · Starts signed out");
  });

  it("says the profile waits for its Device when that Device is offline", async () => {
    host = consentHost({ homes: [macRunner], macOnline: false });
    const { container } = await mount(host);
    expect(container.textContent).toContain(
      "None of your devices are online. This connected agent can use its profile once MacBook Pro is back.",
    );
  });

  it("reads the consent again when its verification changed, keeping the choices still offered", async () => {
    host = consentHost();
    const [workMac, homeMac] = [createId("browserSource"), createId("browserSource")];
    const claude = mockConnectedAgents("seeded").connections.find(
      ({ label }) => label === "Claude",
    )!;
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
      // Read again: the directory stopped vouching for it, and one Chrome is no longer paired.
      {
        ...consent,
        verificationSnapshot: "b".repeat(64),
        chromeTabs: [{ sourceId: workMac, computerName: "Work Mac", paired: true }],
      },
    ];
    let read = 0;
    Object.defineProperty(host.rpc, "connections.authorization.get", {
      value: vi.fn(async () => ({ ok: true, data: reads[Math.min(read++, 1)] })),
      configurable: true,
    });
    const dispatch = vi.spyOn(host, "dispatch").mockImplementation(async (command) => {
      if (command.type === "browser.profile.create")
        return {
          type: "browser.profile.create",
          profile: { id: created, name: "Mine", homeRunnerId: cloudRunner },
        } as never;
      if (authorizeCalls(dispatch).length === 1)
        throw new HostClientRequestError({
          code: "conflict",
          reason: "consent-verification-changed",
          message: "This agent’s verification changed. Review it again.",
          status: 409,
        });
      return { type: "connection.authorize", completionPath: "/oauth/done" } as never;
    });
    const { container, openExternalUrl } = await mount(host);
    expect(container.querySelector("h1")?.textContent).toBe("Claude");
    // A shared tab is one tab, with what the person already allowed its site in Chrome.
    expect(container.textContent).toContain("read that tab’s own cookies.");
    expect(container.textContent).toContain(
      "In this tab it can use what you already allowed the site in Chrome, such as the camera, microphone, location and notifications.",
    );
    const name = container.querySelector<HTMLInputElement>('input[placeholder="Connection name"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "Mine");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    for (const label of [
      "Tabs you share from Chrome on Work Mac",
      "Tabs you share from Chrome on Home Mac",
    ])
      await act(async () =>
        container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!.click(),
      );
    await act(async () =>
      container.querySelector<HTMLInputElement>('[aria-labelledby="agent-grant-tasks"]')!.click(),
    );
    await act(async () =>
      container.querySelector<HTMLInputElement>('input[value="auto"]')!.click(),
    );

    await act(async () => buttonNamed(container, "Allow").click());
    // The screen is the agent as the Home now presents it, with one line beside Allow.
    expect(container.querySelector("h1")?.textContent).toBe("An agent wants to connect");
    expect(container.textContent).toContain("It calls itself: Claude");
    expect(container.querySelector(".form-actions")?.previousElementSibling?.textContent).toBe(
      "This agent’s verification changed. Review it again.",
    );
    expect(container.textContent).not.toContain("Already answered");
    expect(name.value).toBe("Mine");
    expect(
      container.querySelector<HTMLInputElement>(
        '[aria-label="Tabs you share from Chrome on Work Mac"]',
      )!.checked,
    ).toBe(true);
    expect(
      container.querySelector('[aria-label="Tabs you share from Chrome on Home Mac"]'),
    ).toBeNull();
    expect(
      container.querySelector<HTMLInputElement>('[aria-labelledby="agent-grant-tasks"]')!.checked,
    ).toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[value="auto"]')!.checked).toBe(true);

    await act(async () => buttonNamed(container, "Allow").click());
    const [first, second] = authorizeCalls(dispatch) as unknown as {
      decision: { verificationSnapshot: string; label: string; accessMode: string; grant: unknown };
    }[];
    expect(first!.decision.verificationSnapshot).toBe("a".repeat(64));
    expect(second!.decision).toEqual({
      kind: "approve",
      label: "Mine",
      accessMode: "auto",
      verificationSnapshot: "b".repeat(64),
      grant: {
        scope: "selected",
        tasks: true,
        resources: expect.arrayContaining([
          { kind: "browser-profile", profileId: created },
          { kind: "chrome-tabs", sourceId: workMac },
        ]),
      },
    });
    expect((second!.decision.grant as { resources: unknown[] }).resources).toHaveLength(2);
    // The profile the first attempt created is reused, not made twice.
    expect(
      dispatch.mock.calls.filter(([command]) => command.type === "browser.profile.create"),
    ).toHaveLength(1);
    expect(openExternalUrl).toHaveBeenCalledOnce();
  });

  it("on a work Home, shows what its organization rules out as unavailable, with why", async () => {
    host = consentHost({ work: "strict" });
    const dispatch = vi.spyOn(host, "dispatch");
    const { container } = await mount(host);
    expect(container.querySelector(".agent-consent__work")?.textContent).toBe(
      "Work · Northwind Logistics",
    );
    const reason = "Your organization doesn’t allow this";
    const radio = (value: string) =>
      container.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`)!;
    // Choose leads; Everything stays in view, unavailable, saying why.
    expect(radio("selected").checked).toBe(true);
    expect(radio("everything").disabled).toBe(true);
    expect(radio("everything").closest("label")?.textContent).toContain(reason);
    const tasks = container.querySelector<HTMLInputElement>(
      '[aria-labelledby="agent-grant-tasks"]',
    )!;
    expect(tasks.disabled).toBe(true);
    expect(detail(container, "Tasks")).toBe(reason);
    // The safety modes stop at the ceiling: Supervised, chosen; the rest unavailable.
    expect(radio("approval-required")).toMatchObject({ checked: true, disabled: false });
    for (const mode of ["auto-accept-edits", "auto", "full-access"]) {
      expect(radio(mode).disabled).toBe(true);
      expect(radio(mode).closest("label")?.textContent).toContain(reason);
    }
    await act(async () => radio("everything").click());
    await act(async () => radio("full-access").click());
    expect(radio("selected").checked).toBe(true);
    expect(radio("approval-required").checked).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("follows a new policy version while it is open, and Allow asks only for what it allows", async () => {
    host = consentHost({ work: "open" });
    const dispatch = vi.spyOn(host, "dispatch").mockImplementation(async (command) =>
      command.type === "browser.profile.create"
        ? ({
            type: "browser.profile.create",
            profile: { id: created, name: "Claude", homeRunnerId: cloudRunner },
          } as never)
        : ({ type: "connection.authorize", completionPath: "/oauth/done" } as never),
    );
    const { container } = await mount(host);
    const radio = (value: string) =>
      container.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`)!;
    const tasks = () =>
      container.querySelector<HTMLInputElement>('[aria-labelledby="agent-grant-tasks"]')!;
    await act(async () => radio("auto").click());
    await act(async () => tasks().click());
    expect(radio("auto").checked).toBe(true);
    expect(tasks().checked).toBe(true);

    // The organization narrows its policy; the open screen follows with no reload.
    await act(async () => host!.applyWorkPolicy(mockWorkPolicy("strict")));
    const reason = "Your organization doesn’t allow this";
    expect(radio("approval-required").checked).toBe(true);
    expect(radio("auto")).toMatchObject({ checked: false, disabled: true });
    expect(radio("auto").closest("label")?.textContent).toContain(reason);
    expect(tasks()).toMatchObject({ checked: false, disabled: true });
    expect(detail(container, "Tasks")).toBe(reason);

    await act(async () => buttonNamed(container, "Allow").click());
    const [authorize] = authorizeCalls(dispatch) as unknown as {
      decision: { accessMode: string; grant: { tasks: boolean } };
    }[];
    expect(authorize!.decision.accessMode).toBe("approval-required");
    expect(authorize!.decision.grant.tasks).toBe(false);
  });

  it("on a personal Home, offers every choice with no mark and no reason", async () => {
    host = consentHost();
    const { container } = await mount(host);
    expect(container.querySelector(".agent-consent__work")).toBeNull();
    expect(container.textContent).not.toContain("Work ·");
    expect(container.textContent).not.toContain("doesn’t allow");
    expect(
      [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')].some(
        (input) => input.disabled,
      ),
    ).toBe(false);
  });

  it("says a request expired, or was already answered, and never offers Allow", async () => {
    host = consentHost();
    const { container } = await mount(host, "x".repeat(43));
    expect(container.textContent).toContain("This request expired");
    expect(container.textContent).toContain("Start connecting again from the agent.");
    expect(
      [...container.querySelectorAll("button")].some((button) => button.textContent === "Allow"),
    ).toBe(false);
    act(() => root?.unmount());
    host.dispose();

    host = consentHost();
    vi.spyOn(host, "dispatch").mockImplementation(async (command) => {
      if (command.type === "browser.profile.create")
        return {
          type: "browser.profile.create",
          profile: { id: created, name: "Grok", homeRunnerId: cloudRunner },
        } as never;
      throw new HostClientRequestError({ code: "conflict", message: "answered", status: 409 });
    });
    const second = await mount(host);
    await act(async () => buttonNamed(second.container, "Allow").click());
    expect(second.container.textContent).toContain("Already answered");
    expect(second.container.textContent).toContain("You answered this on another device.");
  });

  it("offers Try again when the request could not be read", async () => {
    host = consentHost();
    const get = host.rpc["connections.authorization.get"];
    Object.defineProperty(host.rpc, "connections.authorization.get", {
      value: vi.fn(get).mockRejectedValueOnce(new Error("offline")),
      configurable: true,
    });
    const { container } = await mount(host);
    expect(container.textContent).toContain("Can’t review this request");
    await act(async () => buttonNamed(container, "Try again").click());
    await vi.waitFor(() => expect(container.textContent).toContain("An agent wants to connect"));
  });
});

describe("agent consent launch page", () => {
  it("offers the request to the phone as a code on a computer, and approves nothing", async () => {
    const deploymentId = createId("deployment");
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Chrome/140 Safari/537.36",
    );
    vi.spyOn(navigator, "maxTouchPoints", "get").mockReturnValue(0);
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(<McpAuthorizationLaunch requestId={requestId} deploymentId={deploymentId} />),
    );
    const code = container.querySelector('svg[role="img"]');
    expect(code?.getAttribute("aria-label")).toBe(
      "Code that opens this request in Opensteer on your phone",
    );
    expect(container.textContent).toContain("Or scan with your phone to review it there.");
    expect(container.querySelectorAll("a")).toHaveLength(1);

    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)",
    );
    await act(async () =>
      root!.render(<McpAuthorizationLaunch requestId={requestId} deploymentId={deploymentId} />),
    );
    expect(container.querySelector('svg[role="img"]')).toBeNull();
  });
});
