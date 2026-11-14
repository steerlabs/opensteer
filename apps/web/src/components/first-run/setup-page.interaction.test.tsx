// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HostClientRequestError, type ThreadPlacementOption } from "@opensteer/client/host";
import type { AddHarnessAccount } from "../account-sign-in-dialog.js";
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
  addHarnessAccount: null,
  openHarnessAuthentication: vi.fn(),
  placements: [] as ThreadPlacementOption[],
  refreshHarnessCatalog: vi.fn(async () => undefined),
  snapshot: {
    connection: "connected",
    deploymentId: "dep_6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b",
    environments: [] as unknown[],
    harnesses: [] as unknown[],
    machines: [] as unknown[],
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
  strict = false;
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function mount() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await render();
}

/** The app runs under StrictMode; a test opts in where effect replay matters. */
let strict = false;

async function render() {
  const tree = (
    <MemoryRouter initialEntries={["/get-started"]}>
      <Routes>
        <Route element={<SetupPage />} path="/get-started" />
        <Route element={<p>Task home</p>} path="/" />
        <Route element={<p>AI settings</p>} path="/settings/ai" />
      </Routes>
    </MemoryRouter>
  );
  await act(async () => root?.render(strict ? <StrictMode>{tree}</StrictMode> : tree));
}

function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** A computer already reachable at its own address, with a code on screen. */
function atOwnAddress(origin: string) {
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
}

function pairingCreated() {
  return {
    pairing: {
      code: `osp_${"c".repeat(43)}`,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      generation: 1,
      schemaVersion: 1,
    },
    type: "personal.remoteAccess.pairing.create",
  };
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
      signIn: vi.fn(async () => undefined),
      tailscaleShare: vi.fn(),
      tailscaleStatus: vi.fn(async () => ({ state: "not-installed" })),
      testNotification: vi.fn(async () => ({ outcome: "sent" })),
      checkFullDiskAccess: vi.fn(async () => ({ granted: false })),
      unlinkPersonal: vi.fn(),
      ...overrides,
    },
  };
}

function onThisMac(bridge: unknown, access: object) {
  shell.desktopBridge = bridge;
  shell.desktopDeployment = { kind: "personal", name: "Studio Mac", onThisComputer: true };
  // The deployment this window views is the desktop's own personal one.
  Object.assign(access, { personalSetup: { deploymentId: shell.snapshot.deploymentId } });
  shell.deploymentAccess = access;
}

it("starts the first task on the ready AI, named for the plan, with one press", async () => {
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
  expect(container.textContent).toContain("Task home");
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

it("walks a Mac through AI, Set up this Mac and phone, remembering the step until Finish", async () => {
  const { access, bridge } = desktopBridge();
  onThisMac(bridge, access);
  const key = `opensteer.setup.v1:${shell.snapshot.deploymentId}`;
  await mount();
  expect(container.querySelector(".setup-progress")?.getAttribute("aria-label")).toBe(
    "Step 1 of 3",
  );
  await act(async () => button("Continue").click());
  expect(container.textContent).toContain("Set up this Mac");
  expect(localStorage.getItem(key)).toBe("permissions");

  // A setup left here resumes here.
  act(() => root?.unmount());
  await mount();
  expect(container.textContent).toContain("Set up this Mac");

  // Apps is on, so macOS's grants for it come next; they can wait.
  await act(async () => button("Continue").click());
  expect(container.textContent).toContain("Let macOS allow it");
  await act(async () => button("Do this later").click());
  expect(container.textContent).toContain("Connect your phone");
  await act(async () => button("Back").click());
  expect(container.textContent).toContain("Set up this Mac");
  await act(async () => button("Continue").click());
  await act(async () => button("Continue").click());
  // Nothing on the phone step is on yet, so leaving it is skipping it.
  await act(async () => button("Skip for now").click());
  expect(container.textContent).toContain("Task home");
  expect(localStorage.getItem(key)).toBeNull();
});

it("shows Home only what it can change, and asks macOS once notifications stay on", async () => {
  const { access, bridge } = desktopBridge({
    computerUsePermissionsGet: vi.fn(async () => ({
      accessibility: "granted",
      screenRecording: "granted",
    })),
  });
  onThisMac(bridge, access);
  localStorage.setItem(`opensteer.setup.v1:${shell.snapshot.deploymentId}`, "permissions");
  await mount();
  expect(container.textContent).not.toContain("Files and commands");
  expect(container.textContent).not.toContain("Saved passwords");
  await act(async () => button("Continue").click());
  expect(bridge.testNotification).toHaveBeenCalledTimes(1);
  // The helper's grants are read, so a Mac that has them says so.
  expect(container.textContent).toContain("Allowed");
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
  await act(async () => button("Turn on Connect").click());
  // The Desktop answers "linked" before the app's own snapshot catches up;
  // that gap must never start a second browser sign-in.
  for (let flush = 0; flush < 5; flush += 1) await act(async () => undefined);
  expect(bridge.linkPersonal).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("Add Studio Mac to your account");
  expect(button("Connecting…").disabled).toBe(true);

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
    access: {
      ...(remoteStatus.access as object),
      mode: "connect",
      route: { document: { route: { origin: "https://studio.connect.test" } } },
    },
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

it("signs in through the browser first when Connect is turned on signed out", async () => {
  let current: Record<string, unknown> = {
    account: { available: true, status: "signed-out" },
    personalAccountLink: { status: "unlinked" },
  };
  const publish = (account: { available: boolean; status: string }) => {
    current = { ...current, account };
    shell.deploymentAccess = current;
    for (const listener of state.accessListeners) listener(current);
  };
  const { bridge } = desktopBridge({
    getDeploymentAccessSnapshot: vi.fn(async () => current),
    signIn: vi.fn(async () => publish({ available: true, status: "authorizing" })),
  });
  onThisMac(bridge, current);
  localStorage.setItem(`opensteer.setup.v1:${shell.snapshot.deploymentId}`, "phone");
  await mount();
  expect(container.textContent).toContain("sign in to your Opensteer account in your browser");
  await act(async () => button("Sign in and connect").click());
  for (let flush = 0; flush < 5; flush += 1) await act(async () => undefined);
  expect(bridge.signIn).toHaveBeenCalledTimes(1);
  // Linking needs the Account session the browser is still making.
  expect(bridge.linkPersonal).not.toHaveBeenCalled();
  expect(container.querySelector(".setup-checks__item--active")?.textContent).toBe(
    "Sign in to your Opensteer account",
  );

  await act(async () => publish({ available: true, status: "signed-in" }));
  await render();
  for (let flush = 0; flush < 5; flush += 1) await act(async () => undefined);
  expect(bridge.linkPersonal).toHaveBeenCalledTimes(1);
  expect(bridge.signIn).toHaveBeenCalledTimes(1);
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
  await act(async () => button("Turn on Connect").click());
  expect(shell.hostClient.dispatch).toHaveBeenCalledTimes(1);
  await remoteChanged({
    ...remoteStatus,
    access: {
      ...(remoteStatus.access as object),
      mode: "connect",
      route: { document: { route: { origin: "https://studio.connect.test" } } },
    },
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
    if (failing)
      throw new HostClientRequestError({
        code: "unavailable",
        message: "Opensteer is offline.",
        status: 503,
      });
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
      route: { document: { route: { origin: "https://studio.connect.test" } } },
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

it("adds a plan's account with only the plan's own way in, under StrictMode as the app runs", async () => {
  strict = true;
  const addHarnessAccount = vi.fn();
  (shell as { addHarnessAccount: unknown }).addHarnessAccount = addHarnessAccount;
  shell.snapshot.environments = [
    mainEnvironment([driver("claude", "anthropic"), driver("antigravity", "google")]),
  ];
  await mount();
  await act(async () => button("Sign in").click());
  expect(addHarnessAccount).toHaveBeenCalledTimes(1);
  const added = addHarnessAccount.mock.calls[0]![0] as AddHarnessAccount;
  expect(added.request).toMatchObject({
    driverKind: "antigravity",
    sourceId: "google",
    stateKind: "isolated",
    type: "harness.create",
  });
  expect(
    added.selectMethod?.([
      { inputLabel: "Key", kind: "secret-input", label: "Key", methodId: "key" },
      { kind: "browser-code", label: "Google account", methodId: "google" },
    ]),
  ).toBe("google");
  // A plan is never a pasted key, so an account offering only keys has no way in here.
  expect(
    added.selectMethod?.([
      { inputLabel: "Key", kind: "secret-input", label: "Key", methodId: "key" },
    ]),
  ).toBeUndefined();
});

it("asks before moving phones to a different address of the person's own", async () => {
  atOwnAddress("https://mac.example.com");
  shell.hostClient.dispatch.mockResolvedValue(pairingCreated());
  const confirm = vi.fn(() => false);
  Object.defineProperty(window, "confirm", { configurable: true, value: confirm });
  await mount();
  await act(async () => button("Change").click());
  type(
    container.querySelector('input[aria-label="Your HTTPS address"]')!,
    "https://studio.example.com",
  );
  await act(async () => button("Turn on").click());
  expect(confirm).toHaveBeenCalled();
  const requests = shell.hostClient.dispatch.mock.calls.filter(
    ([command]) => (command as { type: string }).type === "personal.remoteAccess.request",
  );
  expect(requests).toHaveLength(0);
});

it("keeps an address change and its failure on screen instead of the old code", async () => {
  atOwnAddress("https://mac.example.com");
  shell.hostClient.dispatch.mockImplementation(async (command: { type: string }) => {
    if (command.type === "personal.remoteAccess.request") {
      throw new Error("That address isn’t this computer’s.");
    }
    return pairingCreated();
  });
  Object.defineProperty(window, "confirm", { configurable: true, value: vi.fn(() => true) });
  await mount();
  await act(async () => button("Change").click());
  type(
    container.querySelector('input[aria-label="Your HTTPS address"]')!,
    "https://studio.example.com",
  );
  await act(async () => button("Turn on").click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "That address isn’t this computer’s.",
  );
  expect(container.querySelector('input[aria-label="Your HTTPS address"]')).not.toBeNull();
  expect(container.querySelector(".setup-scan__svg")).toBeNull();
});

it.each(["Skip for now", "Back", "choice", "generation"])(
  "discards a pending tailnet share after %s",
  async (change) => {
    const origin = "https://studio.tail2f9.ts.net";
    let resolve!: (value: { ok: true; origin: string }) => void;
    const pending = new Promise<{ ok: true; origin: string }>((done) => {
      resolve = done;
    });
    const { access, bridge } = desktopBridge({
      tailscaleShare: vi.fn(() => pending),
      tailscaleStatus: vi.fn(async () => ({
        dnsName: "studio.tail2f9.ts.net",
        sharedOrigin: null,
        state: "ready",
      })),
    });
    onThisMac(bridge, access);
    localStorage.setItem(`opensteer.setup.v1:${shell.snapshot.deploymentId}`, "phone");
    await mount();
    await act(async () => radio("Tailscale").click());
    await act(async () => button("Turn on").click());
    expect(bridge.tailscaleShare).toHaveBeenCalledTimes(1);
    if (change === "choice") await act(async () => radio("Your own address").click());
    else if (change === "generation")
      await remoteChanged({
        ...remoteStatus,
        revision: 2,
        access: { ...(remoteStatus.access as object), generation: 2 },
      });
    else await act(async () => button(change).click());
    await act(async () => {
      resolve({ ok: true, origin });
      await pending;
    });
    expect(shell.hostClient.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "personal.remoteAccess.request" }),
    );
  },
);

it.each(["fails", "succeeds"])(
  "follows a switch from Connect through Connect turning off until it %s",
  async (outcome) => {
    const origin = "https://mac.example.com";
    const operationId = "8f0b6c6e-2a4b-4f6d-9e1a-666666666666";
    const { access, bridge } = desktopBridge();
    onThisMac(bridge, access);
    remoteStatus = {
      ...remoteStatus,
      access: {
        ...(remoteStatus.access as object),
        accountLink: { state: "active" },
        mode: "connect",
        route: { document: { route: { origin: "https://studio.connect.test" } } },
      },
    };
    localStorage.setItem(`opensteer.setup.v1:${shell.snapshot.deploymentId}`, "phone");
    shell.hostClient.dispatch.mockImplementation(async (command: { type: string }) =>
      command.type === "personal.remoteAccess.request"
        ? { operation: { id: operationId, state: "pending" }, type: command.type }
        : pairingCreated(),
    );
    Object.defineProperty(window, "confirm", { configurable: true, value: vi.fn(() => true) });
    await mount();
    await act(async () => radio("Your own address").click());
    type(container.querySelector('input[aria-label="Your HTTPS address"]')!, origin);
    await act(async () => button("Turn on").click());
    // The desktop turns Connect off first; that step is this request's own.
    await remoteChanged({
      ...remoteStatus,
      access: { ...(remoteStatus.access as object), generation: 2, mode: "off", route: null },
      operation: {
        intent: { action: "configure", mode: "private", privateOrigin: origin },
        detail: null,
        id: operationId,
        state: "running",
      },
      revision: 2,
    });
    expect(button("Turning on…").disabled).toBe(true);
    if (outcome === "fails") {
      await remoteChanged({
        ...remoteStatus,
        operation: {
          intent: { action: "configure", mode: "private", privateOrigin: origin },
          detail: "The address didn’t answer.",
          id: operationId,
          state: "failed",
        },
        revision: 3,
      });
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "The address didn’t answer.",
      );
      return;
    }
    await remoteChanged({
      ...remoteStatus,
      access: {
        ...(remoteStatus.access as object),
        generation: 3,
        mode: "private",
        route: { document: { route: { origin } } },
      },
      operation: {
        intent: { action: "configure", mode: "private", privateOrigin: origin },
        detail: null,
        id: operationId,
        state: "succeeded",
      },
      revision: 3,
    });
    expect(container.querySelector(".setup-manual")?.textContent).toContain(origin);
  },
);
