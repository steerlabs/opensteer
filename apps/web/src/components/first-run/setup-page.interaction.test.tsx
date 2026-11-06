// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ThreadPlacementOption } from "@opensteer/client/host";
import { SetupPage } from "./setup-page.js";

type Listener = () => void;

const state = vi.hoisted(() => {
  const remoteListeners = new Set<() => void>();
  const accessListeners = new Set<(snapshot: unknown) => void>();
  return { accessListeners, remoteListeners };
});

function placement(overrides: Partial<ThreadPlacementOption>): ThreadPlacementOption {
  const modelSelection = { modelId: "model", options: {}, providerId: "anthropic" };
  return {
    accessModes: null,
    accountName: "Claude Code",
    available: true,
    availability: "configured",
    continuationIdentity: null,
    defaultAccount: true,
    detail: "",
    driverKind: "claude",
    engineName: "Claude Code",
    environmentId: "env_main",
    environmentKind: "main",
    harnessAuthenticationAllowed: true,
    harnessInstanceId: "hin_claude",
    models: [
      {
        displayName: "Model",
        isDefault: true,
        modelId: "model",
        options: [],
        providerId: "anthropic",
      },
    ],
    modelSelection,
    observedConnections: [],
    setupAvailable: true,
    setupMethods: [],
    source: null,
    sourceId: "anthropic",
    whereLabel: "Studio Mac",
    ...overrides,
  } as unknown as ThreadPlacementOption;
}

const codex = (overrides: Partial<ThreadPlacementOption> = {}) =>
  placement({
    accountName: "Codex",
    driverKind: "codex",
    engineName: "Codex",
    harnessInstanceId: "hin_codex",
    models: [
      { displayName: "GPT", isDefault: true, modelId: "gpt", options: [], providerId: "openai" },
    ] as never,
    modelSelection: { modelId: "gpt", options: {}, providerId: "openai" } as never,
    sourceId: "openai",
    ...overrides,
  });

function mainEnvironment(drivers: unknown[] = [driver("claude", "anthropic")]) {
  return {
    connected: true,
    harnessAuthenticationAllowed: true,
    harnessDrivers: drivers,
    id: "env_main",
    kind: "main",
    providerStateModes: ["ambient", "isolated"],
  };
}

function driver(driverKind: string, sourceId: string) {
  return {
    accessModes: [],
    driverKind,
    readiness: "configured",
    sources: [
      {
        fields: [],
        kind: "first-party",
        label: sourceId,
        sourceId,
        stateKinds: ["ambient", "isolated"],
      },
    ],
  };
}

const shell = vi.hoisted(() => ({
  deploymentAccess: null as unknown,
  desktopBridge: null as unknown,
  desktopDeployment: null as unknown,
  executionPreferences: { accessMode: "approval-required", history: [] as unknown[] },
  hostClient: {
    dispatch: vi.fn(),
    rememberExecution: vi.fn(),
    rpc: {
      "personal.remoteAccess.get": vi.fn(),
      "sessions.list": vi.fn(),
    },
    subscribePersonalRemoteAccess: vi.fn(),
  },
  openHarnessAuthentication: vi.fn(),
  placements: [] as ThreadPlacementOption[],
  refreshHarnessCatalog: vi.fn(async () => undefined),
  snapshot: {
    connection: "connected",
    deploymentId: "dep_6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b",
    environments: [] as unknown[],
    harnesses: [] as unknown[],
    homeThreadId: null as string | null,
    identityConfig: {
      deployment: { name: "Studio Mac" },
      portalOrigin: "https://app.opensteer.test",
    },
    threads: [] as unknown[],
    voiceThreadId: null,
  },
}));
vi.mock("../app-shell.js", () => ({ useShell: () => shell }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let container: HTMLDivElement;
let remoteStatus: Record<string, unknown>;

beforeEach(() => {
  localStorage.clear();
  state.remoteListeners.clear();
  state.accessListeners.clear();
  shell.placements = [placement({})];
  shell.executionPreferences = { accessMode: "approval-required", history: [] };
  shell.desktopBridge = null;
  shell.desktopDeployment = null;
  shell.deploymentAccess = null;
  shell.snapshot.homeThreadId = null;
  shell.snapshot.environments = [mainEnvironment()];
  shell.hostClient.rememberExecution.mockResolvedValue({});
  shell.hostClient.rpc["sessions.list"].mockResolvedValue({ data: { sessions: [] }, ok: true });
  remoteStatus = {
    access: { accountLink: null, generation: 1, mode: "off", route: null, schemaVersion: 2 },
    accountIssuer: "https://accounts.opensteer.test",
    executorConnected: true,
    operation: null,
    revision: 1,
  };
  shell.hostClient.rpc["personal.remoteAccess.get"].mockImplementation(async () => ({
    data: remoteStatus,
    ok: true,
  }));
  shell.hostClient.subscribePersonalRemoteAccess.mockImplementation((listener: Listener) => {
    state.remoteListeners.add(listener);
    return () => state.remoteListeners.delete(listener);
  });
  Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function mount() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await render();
}

async function render() {
  await act(async () =>
    root?.render(
      <MemoryRouter initialEntries={["/get-started"]}>
        <Routes>
          <Route element={<SetupPage />} path="/get-started" />
          <Route element={<p>Chat home</p>} path="/" />
          <Route element={<p>AI settings</p>} path="/settings/ai" />
        </Routes>
      </MemoryRouter>,
    ),
  );
}

async function remoteChanged(next: Record<string, unknown>) {
  remoteStatus = next;
  await act(async () => {
    for (const listener of state.remoteListeners) listener();
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`No button named ${label}: ${document.body.textContent ?? ""}`);
  return found;
}

function radio(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('[role="radio"]')].find((element) =>
    element.textContent?.includes(label),
  );
  if (!found) throw new Error(`No choice named ${label}`);
  return found as HTMLButtonElement;
}

function desktopBridge(overrides: Record<string, unknown> = {}) {
  const access = {
    account: { available: true, status: "signed-in" },
    personalAccountLink: { status: "linked" },
  };
  return {
    access,
    bridge: {
      computerUsePermissionsGet: vi.fn(async () => ({
        accessibility: "denied",
        screenRecording: "denied",
      })),
      getDeploymentAccessSnapshot: vi.fn(async () => access),
      linkPersonal: vi.fn(async () => undefined),
      onDeploymentAccessSnapshotChanged: vi.fn((listener: (snapshot: unknown) => void) => {
        state.accessListeners.add(listener);
        return () => state.accessListeners.delete(listener);
      }),
      onPasswordsStatusChanged: vi.fn(() => () => undefined),
      openComputerUsePermissionsPanel: vi.fn(async () => ({ opened: true })),
      openExternalUrl: vi.fn(async () => ({ opened: true })),
      openNotificationSettings: vi.fn(async () => undefined),
      passwordsOpen: vi.fn(async () => undefined),
      passwordsStatus: vi.fn(async () => ({ availability: "unsupported", reason: "platform" })),
      recheckLocalEngines: vi.fn(async () => undefined),
      tailscaleShare: vi.fn(),
      tailscaleStatus: vi.fn(async () => ({ state: "not-installed" })),
      testNotification: vi.fn(async () => ({ outcome: "sent" })),
      unlinkPersonal: vi.fn(),
      ...overrides,
    },
  };
}

function onThisMac(bridge: unknown, access: unknown) {
  shell.desktopBridge = bridge;
  shell.desktopDeployment = { kind: "personal", name: "Studio Mac", onThisComputer: true };
  shell.deploymentAccess = access;
}

it("starts Chat on the ready AI, named for the plan, with one press", async () => {
  await mount();
  expect(container.textContent).toContain("Claude");
  expect(container.textContent).toContain("Signed in");
  expect(radio("Claude").getAttribute("aria-checked")).toBe("true");
  // Off the computer the app runs on, the AI is the only step.
  expect(container.textContent).not.toContain("Connect your phone");
  await act(async () => button("Continue").click());
  expect(shell.hostClient.rememberExecution).toHaveBeenCalledWith({
    selection: {
      environmentId: "env_main",
      harnessInstanceId: "hin_claude",
      modelSelection: expect.objectContaining({ modelId: "model", providerId: "anthropic" }),
    },
  });
  expect(container.textContent).toContain("Chat home");
});

it("lets the person pick another ready AI", async () => {
  shell.placements = [placement({}), codex()];
  shell.snapshot.environments = [
    mainEnvironment([driver("claude", "anthropic"), driver("codex", "openai")]),
  ];
  await mount();
  await act(async () => radio("ChatGPT").click());
  expect(radio("ChatGPT").getAttribute("aria-checked")).toBe("true");
  await act(async () => button("Continue").click());
  expect(shell.hostClient.rememberExecution).toHaveBeenCalledWith({
    selection: expect.objectContaining({ harnessInstanceId: "hin_codex" }),
  });
});

it("signs a plan in through its own way in, skipping the API-key choice", async () => {
  shell.placements = [
    placement({}),
    codex({
      available: false,
      availability: "authentication-required",
      setupMethods: [
        { kind: "secret-input", label: "OpenAI API key", methodId: "codex-api-key" },
        { kind: "device-code", label: "ChatGPT subscription", methodId: "codex-subscription" },
      ] as never,
    }),
  ];
  shell.snapshot.environments = [
    mainEnvironment([driver("claude", "anthropic"), driver("codex", "openai")]),
  ];
  await mount();
  await act(async () => button("Sign in").click());
  expect(shell.openHarnessAuthentication).toHaveBeenCalledWith(
    expect.objectContaining({ harnessInstanceId: "hin_codex" }),
    { methodId: "codex-subscription" },
  );
  // Coming back to the window re-reads a sign-in finished in the browser.
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(shell.refreshHarnessCatalog).toHaveBeenCalledWith(
    expect.objectContaining({ harnessInstanceId: "hin_codex" }),
  );
});

it("offers to get a plan's app when it is not installed, and looks again on return", async () => {
  const { access, bridge } = desktopBridge();
  onThisMac(bridge, access);
  shell.placements = [codex()];
  shell.snapshot.environments = [
    mainEnvironment([
      driver("codex", "openai"),
      { driverKind: "claude", readiness: "unavailable", reason: "not installed" },
    ]),
  ];
  await mount();
  expect(container.textContent).toContain("Not on this computer");
  await act(async () => button("Get").click());
  expect(bridge.openExternalUrl).toHaveBeenCalledWith({
    url: "https://code.claude.com/docs/en/setup",
  });
  expect(container.textContent).toContain("Install it. It shows up here on its own.");
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(bridge.recheckLocalEngines).toHaveBeenCalled();
});

it("waits for this computer to report its AI instead of calling it empty", async () => {
  shell.placements = [];
  shell.snapshot.environments = [mainEnvironment([])];
  await mount();
  expect(container.textContent).not.toContain("No AI is available");
  expect(button("Continue").disabled).toBe(true);
});

it("keeps the step open with the reason when the choice cannot be saved", async () => {
  shell.hostClient.rememberExecution.mockRejectedValueOnce(new Error("Opensteer is offline."));
  await mount();
  await act(async () => button("Continue").click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Opensteer is offline.");
  expect(button("Continue").disabled).toBe(false);
});

it("walks a Mac through AI, permissions and phone, remembering the step until Finish", async () => {
  const { access, bridge } = desktopBridge();
  onThisMac(bridge, access);
  const key = `opensteer.setup.v1:${shell.snapshot.deploymentId}`;
  await mount();
  expect(container.querySelector(".setup-progress")?.getAttribute("aria-label")).toBe(
    "Step 1 of 3",
  );
  await act(async () => button("Continue").click());
  expect(container.textContent).toContain("Permissions");
  expect(localStorage.getItem(key)).toBe("permissions");

  // A setup left here resumes here.
  act(() => root?.unmount());
  await mount();
  expect(container.textContent).toContain("Permissions");

  await act(async () => button("Skip").click());
  expect(container.textContent).toContain("Connect your phone");
  await act(async () => button("Back").click());
  expect(container.textContent).toContain("Permissions");
  await act(async () => button("Continue").click());
  await act(async () => button("Finish").click());
  expect(container.textContent).toContain("Chat home");
  expect(localStorage.getItem(key)).toBeNull();
});

it("sends a real notification instead of claiming permission it cannot read", async () => {
  const { access, bridge } = desktopBridge({
    computerUsePermissionsGet: vi.fn(async () => ({
      accessibility: "granted",
      screenRecording: "granted",
    })),
  });
  onThisMac(bridge, access);
  localStorage.setItem(`opensteer.setup.v1:${shell.snapshot.deploymentId}`, "permissions");
  await mount();
  // The helper's grants are read, so a Mac that has them says so.
  expect(container.textContent).toContain("Allowed");
  // No Passwords row on a Mac that cannot run it.
  expect(container.textContent).not.toContain("Saved passwords");
  await act(async () => button("Turn on").click());
  expect(bridge.testNotification).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("Sent a test");
  expect(container.textContent).not.toContain("Notifications are on");
  await act(async () => button("Settings").click());
  expect(bridge.openNotificationSettings).toHaveBeenCalled();
});

it("connects a phone through Opensteer Connect and names the phone that signed in", async () => {
  const { bridge } = desktopBridge();
  const access = {
    account: { available: true, status: "signed-in" },
    personalAccountLink: { status: "unlinked" },
  };
  onThisMac(bridge, access);
  localStorage.setItem(`opensteer.setup.v1:${shell.snapshot.deploymentId}`, "phone");
  const operationId = "8f0b6c6e-2a4b-4f6d-9e1a-111111111111";
  shell.hostClient.dispatch.mockResolvedValue({
    operation: {
      detail: null,
      executionId: "8f0b6c6e-2a4b-4f6d-9e1a-222222222222",
      id: operationId,
      intent: { action: "configure", mode: "connect", privateOrigin: null },
      state: "pending",
    },
    type: "personal.remoteAccess.request",
  });
  await mount();
  expect(radio("Opensteer Connect").getAttribute("aria-checked")).toBe("true");
  await act(async () => button("Turn on").click());
  // The Desktop answers "linked" before the app's own snapshot catches up;
  // that gap must never start a second browser sign-in.
  for (let flush = 0; flush < 5; flush += 1) await act(async () => undefined);
  expect(bridge.linkPersonal).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("Adding this computer to your account");

  const linked = { ...access, personalAccountLink: { status: "linked" } };
  shell.deploymentAccess = linked;
  await act(async () => {
    for (const listener of state.accessListeners) listener(linked);
  });
  await remoteChanged({
    ...remoteStatus,
    access: { ...(remoteStatus.access as object), accountLink: { state: "active" } },
    revision: 2,
  });
  await render();
  expect(shell.hostClient.dispatch).toHaveBeenCalledWith(
    expect.objectContaining({
      intent: { action: "configure", mode: "connect", privateOrigin: null },
      type: "personal.remoteAccess.request",
    }),
  );
  // The code's wait for a phone polls on a timer from the moment it shows.
  vi.useFakeTimers();
  await remoteChanged({
    ...remoteStatus,
    access: { ...(remoteStatus.access as object), mode: "connect", route: {} },
    operation: { id: operationId, state: "succeeded" },
    revision: 3,
  });
  expect(container.querySelector(".setup-scan__svg")?.getAttribute("aria-label")).toContain(
    "opens this computer on your phone",
  );
  shell.hostClient.rpc["sessions.list"].mockResolvedValue({
    data: {
      sessions: [
        {
          absoluteExpiresAt: "2026-12-01T00:00:00.000Z",
          createdAt: "2026-11-03T10:05:00.000Z",
          current: false,
          deviceLabel: "Opensteer on iPhone",
          expiresAt: "2026-12-01T00:00:00.000Z",
          form: "mobile",
          id: "ses_phone",
          lastSeenAt: "2026-11-03T10:05:00.000Z",
        },
      ],
    },
    ok: true,
  });
  await act(async () => vi.advanceTimersByTimeAsync(4_000));
  expect(container.textContent).toContain("Opensteer on iPhone");
  expect(container.textContent).toContain("Signed in");
});

it("shares this Mac on the tailnet, then shows a one-time pairing code for the phone", async () => {
  const origin = "https://studio.tail2f9.ts.net";
  const { access, bridge } = desktopBridge({
    tailscaleShare: vi.fn(async () => ({ ok: true, origin })),
    tailscaleStatus: vi.fn(async () => ({
      dnsName: "studio.tail2f9.ts.net",
      sharedOrigin: null,
      state: "ready",
    })),
  });
  onThisMac(bridge, access);
  localStorage.setItem(`opensteer.setup.v1:${shell.snapshot.deploymentId}`, "phone");
  shell.hostClient.dispatch.mockImplementation(async (command: { type: string }) =>
    command.type === "personal.remoteAccess.pairing.create"
      ? {
          pairing: {
            code: `osp_${"a".repeat(43)}`,
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
            generation: 2,
            schemaVersion: 1,
          },
          type: "personal.remoteAccess.pairing.create",
        }
      : {
          operation: { id: "8f0b6c6e-2a4b-4f6d-9e1a-444444444444", state: "pending" },
          type: "personal.remoteAccess.request",
        },
  );
  await mount();
  await act(async () => radio("Tailscale").click());
  expect(container.textContent).toContain("studio.tail2f9.ts.net");
  await act(async () => button("Turn on").click());
  expect(bridge.tailscaleShare).toHaveBeenCalledTimes(1);
  expect(shell.hostClient.dispatch).toHaveBeenCalledWith(
    expect.objectContaining({
      intent: { action: "configure", mode: "private", privateOrigin: origin },
      type: "personal.remoteAccess.request",
    }),
  );
  // Tailscale's own status still says nothing is shared; the code must show
  // as soon as the Host answers at the address this visit shared.
  await remoteChanged({
    ...remoteStatus,
    access: {
      ...(remoteStatus.access as object),
      generation: 2,
      mode: "private",
      route: { document: { route: { origin } } },
    },
    revision: 2,
  });
  expect(shell.hostClient.dispatch).toHaveBeenCalledWith(
    expect.objectContaining({ type: "personal.remoteAccess.pairing.create" }),
  );
  expect(container.querySelector(".setup-scan__svg")?.getAttribute("aria-label")).toContain(
    "over Tailscale",
  );
  // A phone that cannot scan gets the same two things to type.
  expect(container.querySelector(".setup-manual")?.textContent).toContain(origin);
  expect(container.querySelector(".setup-manual")?.textContent).toContain(`osp_${"a".repeat(43)}`);
});

it("never undoes a mode another device chose after Connect came on", async () => {
  const { access, bridge } = desktopBridge();
  onThisMac(bridge, access);
  remoteStatus = {
    ...remoteStatus,
    access: { ...(remoteStatus.access as object), accountLink: { state: "active" } },
  };
  localStorage.setItem(`opensteer.setup.v1:${shell.snapshot.deploymentId}`, "phone");
  shell.hostClient.dispatch.mockResolvedValue({
    operation: { id: "8f0b6c6e-2a4b-4f6d-9e1a-555555555555", state: "pending" },
    type: "personal.remoteAccess.request",
  });
  await mount();
  await act(async () => button("Turn on").click());
  expect(shell.hostClient.dispatch).toHaveBeenCalledTimes(1);
  await remoteChanged({
    ...remoteStatus,
    access: { ...(remoteStatus.access as object), mode: "connect", route: {} },
    revision: 2,
  });
  expect(container.querySelector(".setup-scan__svg")).not.toBeNull();
  // Another device switches this computer to a private network.
  await remoteChanged({
    ...remoteStatus,
    access: {
      ...(remoteStatus.access as object),
      generation: 2,
      mode: "private",
      route: { document: { route: { origin: "https://mac.example.com" } } },
    },
    revision: 3,
  });
  // Connect is never asked for again on the person's behalf; the step now
  // shows the address the other device chose.
  const configures = shell.hostClient.dispatch.mock.calls.filter(
    ([command]) => (command as { type: string }).type === "personal.remoteAccess.request",
  );
  expect(configures).toHaveLength(1);
  expect(radio("Your own address").getAttribute("aria-checked")).toBe("true");
});

it("offers to try again when the phone's code could not be made", async () => {
  const origin = "https://mac.example.com";
  const { access, bridge } = desktopBridge();
  onThisMac(bridge, access);
  remoteStatus = {
    ...remoteStatus,
    access: {
      ...(remoteStatus.access as object),
      mode: "private",
      route: { document: { route: { origin } } },
    },
  };
  localStorage.setItem(`opensteer.setup.v1:${shell.snapshot.deploymentId}`, "phone");
  let failing = true;
  shell.hostClient.dispatch.mockImplementation(async () => {
    if (failing) throw new Error("Opensteer is offline.");
    return {
      pairing: {
        code: `osp_${"b".repeat(43)}`,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        generation: 1,
        schemaVersion: 1,
      },
      type: "personal.remoteAccess.pairing.create",
    };
  });
  await mount();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Opensteer is offline.");
  failing = false;
  await act(async () => button("Try again").click());
  expect(container.querySelector(".setup-scan__svg")?.getAttribute("aria-label")).toContain(
    "at your address",
  );
});

it("asks before replacing a way phones already connect", async () => {
  const { access, bridge } = desktopBridge({
    tailscaleStatus: vi.fn(async () => ({
      dnsName: "studio.tail2f9.ts.net",
      sharedOrigin: null,
      state: "ready",
    })),
  });
  onThisMac(bridge, access);
  remoteStatus = {
    ...remoteStatus,
    access: {
      accountLink: { state: "active" },
      generation: 1,
      mode: "connect",
      route: {},
      schemaVersion: 2,
    },
  };
  localStorage.setItem(`opensteer.setup.v1:${shell.snapshot.deploymentId}`, "phone");
  const confirm = vi.fn(() => false);
  Object.defineProperty(window, "confirm", { configurable: true, value: confirm });
  await mount();
  await act(async () => radio("Tailscale").click());
  await act(async () => button("Turn on").click());
  expect(confirm).toHaveBeenCalled();
  expect(bridge.tailscaleShare).not.toHaveBeenCalled();
});
