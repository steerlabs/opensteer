// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SignInInvite } from "./sign-in-invite.js";

type Listener = () => void;

const shell = vi.hoisted(() => ({
  deploymentAccess: null as unknown,
  desktopBridge: null as unknown,
  desktopDeployment: null as unknown,
  hostClient: {
    connection: {
      getSnapshot: () => ({
        phase: "ready",
        network: "online",
        scope: { authorityKey: "host", deploymentId: "d", viewerId: "v", loginId: "l" },
        readyRevision: 1,
        showInterruption: false,
        issue: null,
        trying: false,
      }),
      subscribe: () => () => undefined,
      retry: () => undefined,
    },
    dispatch: vi.fn(),
    rpc: { "personal.remoteAccess.get": vi.fn() },
    subscribePersonalRemoteAccess: vi.fn(),
  },
  snapshot: {
    deploymentId: "dep_6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b",
    identityConfig: {
      deployment: { name: "Studio Mac" },
      exposure: "loopback",
      portalOrigin: "https://app.opensteer.test",
    },
  },
}));
vi.mock("./app-shell.js", () => ({ useShell: () => shell }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let container: HTMLDivElement;
const id = "dep_6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";

function home(account: { available: boolean; status: string }, link = "unlinked") {
  const access = {
    account,
    personalAccountLink: { status: link },
    personalSetup: { deploymentId: id },
  };
  const bridge = {
    getDeploymentAccessSnapshot: vi.fn(async () => access),
    linkPersonal: vi.fn(async () => undefined),
    onDeploymentAccessSnapshotChanged: vi.fn(() => () => undefined),
    signIn: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    unlinkPersonal: vi.fn(async () => undefined),
  };
  shell.desktopBridge = bridge;
  shell.desktopDeployment = { id, kind: "personal", name: "Studio Mac", onThisComputer: true };
  shell.deploymentAccess = access;
  return bridge;
}

beforeEach(() => {
  localStorage.clear();
  shell.hostClient.rpc["personal.remoteAccess.get"].mockResolvedValue({
    data: {
      access: { accountLink: null, generation: 1, mode: "off", route: null, schemaVersion: 2 },
      accountIssuer: "https://accounts.opensteer.test",
      executorConnected: true,
      operation: null,
      revision: 1,
    },
    ok: true,
  });
  shell.hostClient.subscribePersonalRemoteAccess.mockImplementation(
    (_listener: Listener) => () => undefined,
  );
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.clearAllMocks();
});

async function mount() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<SignInInvite />));
  for (let flush = 0; flush < 3; flush += 1) await act(async () => undefined);
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`No ${label} in ${container.textContent ?? ""}`);
  return found;
}

it("invites an Opensteer with no account to sign in, once, and signs in only when asked", async () => {
  const bridge = home({ available: true, status: "signed-out" });
  await mount();
  expect(container.textContent).toContain("Use Opensteer from anywhere");
  expect(container.textContent).toContain(
    "Sign in with your Opensteer account so your phone and connected agents can reach Studio Mac. Nothing else changes.",
  );
  // Showing it calls nothing.
  expect(bridge.signIn).not.toHaveBeenCalled();
  expect(bridge.linkPersonal).not.toHaveBeenCalled();
  await act(async () => button("Sign in").click());
  for (let flush = 0; flush < 5; flush += 1) await act(async () => undefined);
  expect(bridge.signIn).toHaveBeenCalledTimes(1);
});

it("remembers Not now, makes no account call, and the Opensteer goes on as it was", async () => {
  const bridge = home({ available: true, status: "signed-out" });
  await mount();
  await act(async () => button("Not now").click());
  expect(container.textContent).toBe("");
  act(() => root?.unmount());
  await mount();
  expect(container.textContent).toBe("");
  expect(bridge.signIn).not.toHaveBeenCalled();
  expect(bridge.linkPersonal).not.toHaveBeenCalled();
  expect(shell.hostClient.dispatch).not.toHaveBeenCalled();
});

it.each([
  ["signed in", { available: true, status: "signed-in" }, "unlinked"],
  ["already in an account", { available: true, status: "signed-out" }, "linked"],
  ["in a build with no account", { available: false, status: "signed-out" }, "unlinked"],
] as const)("asks nothing of an Opensteer %s", async (_case, account, link) => {
  home(account, link);
  await mount();
  expect(container.textContent).toBe("");
});

it("asks nothing from a Mac that doesn't run this Opensteer", async () => {
  home({ available: true, status: "signed-out" });
  shell.desktopDeployment = { id, kind: "personal", name: "Studio Mac", onThisComputer: false };
  await mount();
  expect(container.textContent).toBe("");
});
