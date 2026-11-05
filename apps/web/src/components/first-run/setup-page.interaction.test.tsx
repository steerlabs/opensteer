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
    sourceId: "default",
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
    ...overrides,
  });

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
    environments: [{ harnessDrivers: [{ driverKind: "claude" }], kind: "main" }] as unknown[],
    homeThreadId: null as string | null,
    voiceThreadId: null,
    identityConfig: {
      deployment: { name: "Studio Mac" },
      portalOrigin: "https://app.opensteer.test",
    },
    threads: [] as unknown[],
  },
}));
vi.mock("../app-shell.js", () => ({ useShell: () => shell }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  state.remoteListeners.clear();
  state.accessListeners.clear();
  shell.placements = [placement({})];
  shell.executionPreferences = { accessMode: "approval-required", history: [] };
  shell.desktopBridge = null;
  shell.desktopDeployment = null;
  shell.deploymentAccess = null;
  shell.snapshot.homeThreadId = null;
  shell.snapshot.environments = [{ harnessDrivers: [{ driverKind: "claude" }], kind: "main" }];
  shell.hostClient.rememberExecution.mockResolvedValue({});
  shell.hostClient.rpc["sessions.list"].mockResolvedValue({ data: { sessions: [] }, ok: true });
  shell.hostClient.subscribePersonalRemoteAccess.mockImplementation((listener: Listener) => {
    state.remoteListeners.add(listener);
    return () => state.remoteListeners.delete(listener);
  });
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

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`No button named ${label}: ${container.textContent ?? ""}`);
  return found;
}

it("fills in a ready AI and starts Chat on it with one press", async () => {
  await mount();
  expect(container.textContent).toContain("Studio Mac");
  expect(container.textContent).toContain("Claude Code");
  expect(container.textContent).toContain("Ready");
  // No phone row off the computer the app runs on.
  expect(container.textContent).not.toContain("Phone");
  await act(async () => button("Start").click());
  expect(shell.hostClient.rememberExecution).toHaveBeenCalledWith({
    selection: {
      environmentId: "env_main",
      harnessInstanceId: "hin_claude",
      modelSelection: expect.objectContaining({ modelId: "model", providerId: "anthropic" }),
    },
  });
  expect(container.textContent).toContain("Chat home");
});

it("offers the first ready AI when several are ready and none was picked", async () => {
  shell.placements = [codex(), placement({})];
  await mount();
  expect(container.textContent).not.toContain("Choose an AI");
  expect(container.textContent).toContain("Codex");
  await act(async () => button("Start").click());
  expect(shell.hostClient.rememberExecution).toHaveBeenCalledWith({
    selection: expect.objectContaining({ harnessInstanceId: "hin_codex" }),
  });
});

it("explains an AI that cannot run when it is the only one", async () => {
  shell.placements = [codex({ available: false, availability: "missing" })];
  await mount();
  expect(container.textContent).toContain("Not installed on this computer");
  expect(container.textContent).toContain("Set up later");
});

it("lets the person switch to another ready AI before starting", async () => {
  shell.placements = [placement({}), codex()];
  shell.executionPreferences = {
    accessMode: "approval-required",
    history: [
      {
        environmentId: "env_main",
        harnessInstanceId: "hin_claude",
        modelSelection: { modelId: "model", options: {}, providerId: "anthropic" },
      },
    ],
  };
  await mount();
  await act(async () => button("Change").click());
  const choice = [...container.querySelectorAll('[role="radio"]')].find((element) =>
    element.textContent?.includes("Codex"),
  ) as HTMLButtonElement;
  await act(async () => choice.click());
  expect(container.textContent).toContain("Codex");
  await act(async () => button("Start").click());
  expect(shell.hostClient.rememberExecution).toHaveBeenCalledWith({
    selection: expect.objectContaining({ harnessInstanceId: "hin_codex" }),
  });
});

it("offers each AI's own fix when none can run yet, and a way to finish later", async () => {
  shell.placements = [
    placement({ available: false, availability: "authentication-required" }),
    codex({ available: false, availability: "missing" }),
  ];
  await mount();
  expect(container.textContent).toContain("Choose an AI");
  expect(container.textContent).toContain("Not signed in");
  // An AI that cannot be used or fixed from here stays out of the way.
  expect(container.textContent).not.toContain("Codex");
  expect(button("Start").disabled).toBe(true);
  await act(async () => button("Sign in").click());
  expect(shell.openHarnessAuthentication).toHaveBeenCalledWith(
    expect.objectContaining({ harnessInstanceId: "hin_claude" }),
  );
  // Coming back to the window re-reads a sign-in done somewhere else.
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(shell.refreshHarnessCatalog).toHaveBeenCalledWith(
    expect.objectContaining({ harnessInstanceId: "hin_claude" }),
  );
  await act(async () => button("Set up later").click());
  expect(container.textContent).toContain("Chat home");
  expect(shell.hostClient.rememberExecution).not.toHaveBeenCalled();
});

it("waits for this computer to report its AIs instead of calling it empty", async () => {
  shell.placements = [];
  shell.snapshot.environments = [{ harnessDrivers: [], kind: "main" }];
  await mount();
  expect(container.textContent).toContain("Looking for AIs on this computer");
  expect(container.textContent).not.toContain("No AI was found");
  shell.snapshot.environments = [{ harnessDrivers: [{ driverKind: "claude" }], kind: "main" }];
  await act(async () =>
    root?.render(
      <MemoryRouter initialEntries={["/get-started"]}>
        <Routes>
          <Route element={<SetupPage />} path="/get-started" />
        </Routes>
      </MemoryRouter>,
    ),
  );
  expect(container.textContent).toContain("No AI was found on this computer");
});

it("keeps setup open with the reason when the choice cannot be saved", async () => {
  shell.hostClient.rememberExecution.mockRejectedValueOnce(new Error("Opensteer is offline."));
  await mount();
  await act(async () => button("Start").click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Opensteer is offline.");
  expect(button("Start").disabled).toBe(false);
});

it("names a remembered AI that can no longer run instead of quietly using another", async () => {
  shell.placements = [
    placement({}),
    codex({ available: false, availability: "authentication-required" }),
  ];
  shell.executionPreferences = {
    accessMode: "approval-required",
    history: [
      {
        environmentId: "env_main",
        harnessInstanceId: "hin_codex",
        modelSelection: { modelId: "gpt", options: {}, providerId: "openai" },
      },
    ],
  };
  await mount();
  expect(container.textContent).toContain("Choose an AI");
  expect(button("Start").disabled).toBe(true);
});

it("adds a phone: links this computer, turns on Connect, shows the code, then names the phone that signed in", async () => {
  vi.useFakeTimers();
  const access = {
    account: { available: true, status: "signed-in" },
    personalAccountLink: { status: "unlinked" },
  };
  const bridge = {
    getDeploymentAccessSnapshot: vi.fn(async () => access),
    linkPersonal: vi.fn(async () => undefined),
    onDeploymentAccessSnapshotChanged: vi.fn((listener: (snapshot: unknown) => void) => {
      state.accessListeners.add(listener);
      return () => state.accessListeners.delete(listener);
    }),
    unlinkPersonal: vi.fn(),
  };
  shell.desktopBridge = bridge;
  shell.desktopDeployment = { kind: "personal", name: "Studio Mac", onThisComputer: true };
  shell.deploymentAccess = access;
  let remoteStatus: Record<string, unknown> = {
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
  const phone = {
    absoluteExpiresAt: "2026-12-01T00:00:00.000Z",
    createdAt: "2026-11-03T10:05:00.000Z",
    current: false,
    deviceLabel: "Opensteer on iPhone",
    expiresAt: "2026-12-01T00:00:00.000Z",
    form: "mobile",
    id: "ses_phone",
    lastSeenAt: "2026-11-03T10:05:00.000Z",
  };

  await mount();
  expect(container.textContent).toContain("Phone");
  await act(async () => button("Add").click());
  expect(bridge.linkPersonal).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("Adding this computer to your account");

  // The Desktop reports the link settled; the Host reports it active.
  const linked = { ...access, personalAccountLink: { status: "linked" } };
  shell.deploymentAccess = linked;
  remoteStatus = {
    ...remoteStatus,
    access: { ...(remoteStatus.access as object), accountLink: { state: "active" } },
    revision: 2,
  };
  await act(async () => {
    for (const listener of state.accessListeners) listener(linked);
    for (const listener of state.remoteListeners) listener();
  });
  await act(async () =>
    root?.render(
      <MemoryRouter initialEntries={["/get-started"]}>
        <Routes>
          <Route element={<SetupPage />} path="/get-started" />
        </Routes>
      </MemoryRouter>,
    ),
  );
  expect(shell.hostClient.dispatch).toHaveBeenCalledWith(
    expect.objectContaining({
      intent: { action: "configure", mode: "connect", privateOrigin: null },
      type: "personal.remoteAccess.request",
    }),
  );
  expect(container.textContent).toContain("Turning on remote access");

  // Connect is on and its route is published: the code appears.
  remoteStatus = {
    ...remoteStatus,
    access: { ...(remoteStatus.access as object), mode: "connect", route: {} },
    operation: { id: operationId, state: "succeeded" },
    revision: 3,
  };
  await act(async () => {
    for (const listener of state.remoteListeners) listener();
  });
  expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toContain(
    "open this computer on your phone",
  );
  expect(container.textContent).toContain("Waiting for your phone");

  // A phone signs in after the code appeared.
  shell.hostClient.rpc["sessions.list"].mockResolvedValue({
    data: { sessions: [phone] },
    ok: true,
  });
  await act(async () => vi.advanceTimersByTimeAsync(4_000));
  expect(container.textContent).toContain("Opensteer on iPhone");
  expect(container.textContent).toContain("Signed in");
  expect(container.querySelector('[role="img"]')).toBeNull();
});

it("shows why remote access failed and lets the person try again", async () => {
  const access = {
    account: { available: true, status: "signed-in" },
    personalAccountLink: { status: "linked" },
  };
  shell.desktopBridge = {
    getDeploymentAccessSnapshot: vi.fn(async () => access),
    linkPersonal: vi.fn(),
    onDeploymentAccessSnapshotChanged: vi.fn(() => () => undefined),
    unlinkPersonal: vi.fn(),
  };
  shell.desktopDeployment = { kind: "personal", name: "Studio Mac", onThisComputer: true };
  shell.deploymentAccess = access;
  const operationId = "8f0b6c6e-2a4b-4f6d-9e1a-333333333333";
  let remoteStatus: Record<string, unknown> = {
    access: {
      accountLink: { state: "active" },
      generation: 1,
      mode: "off",
      route: null,
      schemaVersion: 2,
    },
    accountIssuer: "https://accounts.opensteer.test",
    executorConnected: true,
    operation: null,
    revision: 1,
  };
  shell.hostClient.rpc["personal.remoteAccess.get"].mockImplementation(async () => ({
    data: remoteStatus,
    ok: true,
  }));
  shell.hostClient.dispatch.mockResolvedValue({
    operation: { id: operationId, state: "pending" },
    type: "personal.remoteAccess.request",
  });
  await mount();
  await act(async () => button("Add").click());
  expect(shell.hostClient.dispatch).toHaveBeenCalledTimes(1);
  remoteStatus = {
    ...remoteStatus,
    operation: { detail: "Opensteer Connect is unavailable.", id: operationId, state: "failed" },
    revision: 2,
  };
  await act(async () => {
    for (const listener of state.remoteListeners) listener();
  });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Opensteer Connect is unavailable.",
  );
  await act(async () => button("Try again").click());
  expect(shell.hostClient.dispatch).toHaveBeenCalledTimes(2);
  await act(async () => button("Cancel").click());
  expect(button("Add")).toBeTruthy();
});
