// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { desktopRefusal } from "@opensteer/protocol/desktop";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RemoteAccessCard } from "./remote-access-card.js";

type Listener = () => void;

const state = vi.hoisted(() => ({
  accessListeners: new Set<(snapshot: unknown) => void>(),
  remoteListeners: new Set<() => void>(),
}));

const shell = vi.hoisted(() => ({
  deploymentAccess: null as unknown,
  desktopBridge: null as unknown,
  desktopDeployment: null as unknown,
  hostClient: {
    connection: {
      getSnapshot: () => ({
        phase: "ready",
        network: "online",
        scope: {
          authorityKey: "host",
          deploymentId: "deployment",
          viewerId: "viewer",
          loginId: "login",
        },
        readyRevision: 1,
        showInterruption: false,
        issue: null,
        trying: false,
      }),
      subscribe: () => () => undefined,
      retry: () => undefined,
    },
    dispatch: vi.fn(),
    rpc: {
      "personal.remoteAccess.get": vi.fn(),
      "sessions.list": vi.fn(),
    },
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
vi.mock("../../app-shell.js", () => ({ useShell: () => shell }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let container: HTMLDivElement;
let remoteStatus: Record<string, unknown>;

beforeEach(() => {
  state.remoteListeners.clear();
  state.accessListeners.clear();
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
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.clearAllMocks();
});

function desktopBridge(overrides: Record<string, unknown> = {}) {
  const access = {
    account: { available: true, status: "signed-in" },
    personalAccountLink: { status: "linked" },
    personalSetup: { deploymentId: shell.snapshot.deploymentId },
  };
  const bridge = {
    getDeploymentAccessSnapshot: vi.fn(async () => access),
    linkPersonal: vi.fn(async () => undefined),
    onDeploymentAccessSnapshotChanged: vi.fn((listener: (snapshot: unknown) => void) => {
      state.accessListeners.add(listener);
      return () => state.accessListeners.delete(listener);
    }),
    openExternalUrl: vi.fn(async () => ({ opened: true })),
    signIn: vi.fn(async () => undefined),
    tailscaleShare: vi.fn(),
    tailscaleStatus: vi.fn(async () => ({ state: "not-installed" })),
    unlinkPersonal: vi.fn(),
    ...overrides,
  };
  shell.desktopBridge = bridge;
  shell.desktopDeployment = { kind: "personal", name: "Studio Mac", onThisComputer: true };
  shell.deploymentAccess = access;
  return bridge;
}

async function mount() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<RemoteAccessCard />));
  await act(async () => undefined);
}

async function openAdvanced() {
  const details = container.querySelector<HTMLDetailsElement>("details.settings-advanced");
  if (!details) throw new Error(`No Advanced in ${container.textContent ?? ""}`);
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
  for (let flush = 0; flush < 3; flush += 1) await act(async () => undefined);
}

async function remoteChanged(next: Record<string, unknown>) {
  remoteStatus = next;
  await act(async () => {
    for (const listener of state.remoteListeners) listener();
  });
}

function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** A button of the Private network, not the card's own Remote access action of the same name. */
function privateButton(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll(".private-network button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`No Private network button ${label}: ${container.textContent ?? ""}`);
  return found as HTMLButtonElement;
}

function radio(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('[role="radio"]')].find((element) =>
    element.textContent?.includes(label),
  );
  if (!found) throw new Error(`No choice named ${label}`);
  return found as HTMLButtonElement;
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

it("keeps Tailscale, an own address and phone codes under Advanced, as Private network, closed", async () => {
  desktopBridge();
  await mount();
  // Nothing about a private network shows, or reads Tailscale, until Advanced is opened.
  expect(container.querySelector('[role="radio"]')).toBeNull();
  expect(
    (shell.desktopBridge as { tailscaleStatus: () => void }).tailscaleStatus,
  ).not.toHaveBeenCalled();
  await openAdvanced();
  expect(container.textContent).toContain("Private network");
  expect(radio("Tailscale")).toBeTruthy();
  expect(radio("Your own address")).toBeTruthy();
});

it("offers no private network setup from a Mac that doesn't run this Opensteer", async () => {
  desktopBridge();
  shell.desktopDeployment = { kind: "personal", name: "Studio Mac", onThisComputer: false };
  await mount();
  const details = container.querySelector<HTMLDetailsElement>("details.settings-advanced");
  if (details) await openAdvanced();
  expect(container.querySelector('[role="radio"]')).toBeNull();
});

// Moved from the first run's phone step, whose transports now live here.
it("shares this Mac on the tailnet, then shows a one-time pairing code for the phone", async () => {
  const origin = "https://studio.tail2f9.ts.net";
  const bridge = desktopBridge({
    tailscaleShare: vi.fn(async () => ({ ok: true, origin })),
    tailscaleStatus: vi.fn(async () => ({
      dnsName: "studio.tail2f9.ts.net",
      sharedOrigin: null,
      state: "ready",
    })),
  });
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
  await openAdvanced();
  await act(async () => radio("Tailscale").click());
  expect(container.textContent).toContain("studio.tail2f9.ts.net");
  await act(async () => privateButton("Turn on").click());
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

it("asks before replacing a way phones already connect", async () => {
  const bridge = desktopBridge({
    tailscaleStatus: vi.fn(async () => ({
      dnsName: "studio.tail2f9.ts.net",
      sharedOrigin: null,
      state: "ready",
    })),
  });
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
  const confirm = vi.fn(() => false);
  Object.defineProperty(window, "confirm", { configurable: true, value: confirm });
  await mount();
  await openAdvanced();
  await act(async () => radio("Tailscale").click());
  await act(async () => privateButton("Turn on").click());
  expect(confirm).toHaveBeenCalled();
  expect(bridge.tailscaleShare).not.toHaveBeenCalled();
});

it.each(["fails", "succeeds"])(
  "follows a switch from Connect through Connect turning off until it %s",
  async (outcome) => {
    const origin = "https://mac.example.com";
    const operationId = "8f0b6c6e-2a4b-4f6d-9e1a-666666666666";
    desktopBridge();
    remoteStatus = {
      ...remoteStatus,
      access: {
        ...(remoteStatus.access as object),
        accountLink: { state: "active" },
        mode: "connect",
        route: { document: { route: { origin: "https://studio.connect.test" } } },
      },
    };
    shell.hostClient.dispatch.mockImplementation(async (command: { type: string }) =>
      command.type === "personal.remoteAccess.request"
        ? { operation: { id: operationId, state: "pending" }, type: command.type }
        : pairingCreated(),
    );
    Object.defineProperty(window, "confirm", { configurable: true, value: vi.fn(() => true) });
    await mount();
    await openAdvanced();
    await act(async () => radio("Your own address").click());
    type(container.querySelector('input[aria-label="Your HTTPS address"]')!, origin);
    await act(async () => privateButton("Turn on").click());
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
    expect(privateButton("Turning on…").disabled).toBe(true);
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

/** Turning Remote access on from here, where this Mac's Home isn't in the account yet. */
async function turnOnWhileLinkFails(failure: unknown) {
  const bridge = desktopBridge({ linkPersonal: vi.fn(async () => Promise.reject(failure)) });
  (shell.deploymentAccess as { personalAccountLink: { status: string } }).personalAccountLink = {
    status: "unlinked",
  };
  await mount();
  const turnOn = [...container.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Turn on",
  );
  if (!turnOn) throw new Error(`No Turn on in ${container.textContent ?? ""}`);
  await act(async () => turnOn.click());
  for (let flush = 0; flush < 5; flush += 1) await act(async () => undefined);
  expect(bridge.linkPersonal).toHaveBeenCalled();
}

it("says the Mac's own sentence when its turn to add this Mac never came", async () => {
  await turnOnWhileLinkFails(
    desktopRefusal(
      "Opensteer is still finishing another change on this Mac. Try again in a moment.",
    ),
  );
  expect(container.textContent).toContain(
    "Opensteer is still finishing another change on this Mac. Try again in a moment.",
  );
  expect(container.textContent).not.toContain("Couldn’t add");
});

it("never shows a fault's own text when adding this Mac fails", async () => {
  await turnOnWhileLinkFails(new Error("journal row 7 failed its integrity check"));
  expect(container.textContent).toContain("Couldn’t add Studio Mac to your account. Try again.");
  expect(container.textContent).not.toContain("journal row 7");
});
