// @vitest-environment happy-dom
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { AuthSessionIdSchema } from "@opensteer/core";
import { MockHostClient } from "@opensteer/client/mock";
import { useHostSnapshot } from "@opensteer/client/react";
import type { DesktopLocalExecutionStatus } from "@opensteer/protocol/desktop";
import { desktopPreviewBridge } from "../../desktop/desktop-preview-bridge.js";
import { desktopSummaryFromAccess } from "../../desktop/desktop-deployment-selection.js";
import { observeLocalExecutionStatus } from "../../desktop/local-execution-status.js";
import { turnOnDeviceAccess } from "../thread-device-access-action.js";
import { accessConflictNotice, useAccessSwitch } from "./device-access-switches.js";
import { DeviceRemovedScreen } from "./device-removed.js";
import { SetUpThisMac } from "./set-up-this-mac.js";
import { useThisDeviceLifecycle } from "./this-device.js";

const deploymentId = "dep_00000000-0000-4000-8000-000000000001";
const laptopId = "rnr_33333333-3333-4333-8333-333333333333";
let root: Root | null = null;
let client: MockHostClient | null = null;
const container = () => document.body.querySelector("#root")!;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  client?.dispose();
  client = null;
  localStorage.clear();
  document.body.innerHTML = "";
});

function unboundSession() {
  const at = "2026-11-12T12:00:00.000Z";
  return {
    absoluteExpiresAt: at,
    createdAt: at,
    current: true,
    deviceId: null,
    deviceLabel: "Opensteer for Mac",
    expiresAt: at,
    form: "computer" as const,
    id: AuthSessionIdSchema.parse("ses_00000000-0000-4000-8000-000000000001"),
    lastSeenAt: at,
  };
}

async function attach(input: {
  readonly remote: "off" | "connect";
  readonly runnerId: string | null;
}) {
  const host = new MockHostClient({
    latencyMs: 0,
    ...(input.runnerId ? {} : { sessions: [unboundSession()] }),
  });
  client = host;
  if (input.remote === "connect")
    host.setPersonalRemoteAccessStatus({
      accountLink: null,
      generation: 1,
      mode: "connect",
      route: null,
      schemaVersion: 2,
    });
  const bridge = desktopPreviewBridge("?desktop-preview=first-run", true, {
    attached: {
      id: deploymentId,
      name: "Alex’s Opensteer",
      origin: "https://alex.connect.opensteer.invalid",
      hosting: null,
      runnerId: input.runnerId,
    },
    connectRunner: (token) => host.connectLocalRunner(token),
    transitionDelayMs: 0,
  })!;
  const access = await bridge.getDeploymentAccessSnapshot();
  const deployment = desktopSummaryFromAccess(access.deployments[0]!);
  vi.spyOn(bridge, "leaveDeployment");
  return { access, bridge, deployment, host };
}

/** The shell's own wiring of the lifecycle, without the rest of the workspace. */
function Shell({ setup }: { readonly setup: Awaited<ReturnType<typeof attach>> }) {
  const { snapshot } = useHostSnapshot(setup.host, () => false);
  const [status, setStatus] = useState<DesktopLocalExecutionStatus | null>(null);
  useEffect(
    () =>
      observeLocalExecutionStatus(setup.bridge, setup.deployment.id, setStatus, () => undefined),
    [setup],
  );
  const device = useThisDeviceLifecycle({
    bridge: setup.bridge,
    deployment: setup.deployment,
    deploymentAccess: setup.access,
    hostClient: setup.host,
    hostingRunnerId: null,
    localStatus: status,
    onLocalStatus: setStatus,
    snapshot,
  });
  if (!device) return <p>Not a device</p>;
  if (device.membership.state === "removed")
    return (
      <DeviceRemovedScreen
        bridge={setup.bridge}
        deploymentId={device.deploymentId}
        name={device.opensteerName}
        onSetUpAgain={device.openSetup}
        unconfirmed={status?.membership?.leaveUnconfirmed === true}
      />
    );
  if (device.step) return <SetUpThisMac bridge={setup.bridge} device={device} />;
  return (
    <div>
      <p data-testid="membership">{device.membership.state}</p>
      <p data-testid="cause">{device.cause?.kind ?? "none"}</p>
      <button onClick={() => void device.leave()} type="button">
        Sign out and remove this Mac
      </button>
    </div>
  );
}

async function render(setup: Awaited<ReturnType<typeof attach>>) {
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(container());
  await act(async () => {
    root!.render(
      <MemoryRouter>
        <Shell setup={setup} />
      </MemoryRouter>,
    );
  });
}

async function waitForText(text: string | RegExp, what: string) {
  await vi.waitFor(
    () => {
      const content = container().textContent ?? "";
      if (typeof text === "string" ? !content.includes(text) : !text.test(content))
        throw new Error(`Never showed ${what}`);
    },
    { timeout: 3_000 },
  );
}

function button(name: string): HTMLButtonElement {
  const found = [...container().querySelectorAll("button, a")].find(
    (element) => element.textContent?.trim() === name,
  );
  if (!found) throw new Error(`No ${name} control`);
  return found as HTMLButtonElement;
}

it("sets up a new Mac with its switches, binds this session, then walks macOS and Ready", async () => {
  const setup = await attach({ remote: "connect", runnerId: null });
  await render(setup);
  await waitForText("Set up this Mac", "the setup step");
  const switches = [...container().querySelectorAll<HTMLInputElement>('input[role="switch"]')];
  await act(async () => switches[1]!.click());
  await act(async () => button("Continue").click());
  await waitForText("Let macOS allow it", "the macOS step");

  const joined = setup.host
    .getSnapshot()
    .machines.find((machine) => machine.status === "online" && machine.name === "Preview MacBook");
  expect(joined?.access?.policy).toMatchObject({ browser: true, apps: false, reach: "owner" });
  const sessions = await setup.host.rpc["sessions.list"]({});
  if (!sessions.ok) throw new Error(sessions.error.message);
  expect(sessions.data.sessions.find((session) => session.current)?.deviceId).toBe(joined?.id);

  await act(async () => button("Finish").click());
  await waitForText("Preview MacBook is ready", "Ready");
  expect(container().textContent).toContain("On · needs macOS permission");
});

it("opens the workspace with the fix when Home's Use from anywhere is off, minting nothing", async () => {
  const setup = await attach({ remote: "off", runnerId: null });
  const before = setup.host.getSnapshot().machines.length;
  await render(setup);
  await waitForText("Set up this Mac", "the setup step");
  await act(async () => button("Continue").click());
  await waitForText("use-from-anywhere", "the finish-setup cause");
  expect(setup.host.getSnapshot().machines).toHaveLength(before);
  // A reload keeps the workspace and its bar rather than asking again.
  act(() => root?.unmount());
  await render(setup);
  await waitForText("use-from-anywhere", "the remembered cause");
});

it("leaves through desktop main and shows the removed screen, which never signs back in by itself", async () => {
  const setup = await attach({ remote: "connect", runnerId: laptopId });
  await render(setup);
  await waitForText("ready", "a ready device");
  await act(async () => button("Sign out and remove this Mac").click());
  expect(setup.bridge.leaveDeployment).toHaveBeenCalledWith({ deploymentId });
  await waitForText("This Mac was removed from", "the removed screen");
  // "Set up again" is the person's choice, and it opens setup rather than rejoining.
  await act(async () => button("Set up again").click());
  await waitForText("Set up this Mac", "setup after Set up again");
});

it("writes a switch against the revision on screen, and shows a newer one instead of overwriting it", async () => {
  const host = new MockHostClient({ latencyMs: 0 });
  client = host;
  const machine = () => host.getSnapshot().machines.find((entry) => entry.id === laptopId)!;
  const stale = machine();
  // Another device turns Files and commands off first.
  await host.updateMachineAccess({
    expectedRevision: stale.access!.revision,
    policy: { ...stale.access!.policy, reach: "nobody" },
    runnerId: laptopId,
  });
  let api: ReturnType<typeof useAccessSwitch> | null = null;
  function Probe() {
    api = useAccessSwitch(host, stale);
    return <p>{api.notice?.text ?? ""}</p>;
  }
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(container());
  await act(async () => root!.render(<Probe />));
  await act(async () => void (await api!.set("browser", false)));
  expect(container().textContent).toBe(accessConflictNotice);
  expect(machine().access!.policy).toMatchObject({ reach: "nobody" });
  expect(machine().access!.policy.browser).not.toBe(false);

  // Turning it on from a request reads the newer revision and asks once more.
  await turnOnDeviceAccess(host, laptopId, "files");
  expect(machine().access!.policy).toMatchObject({
    reach: "owner",
    commands: stale.access!.policy.commands,
    forwarding: stale.access!.policy.forwarding,
    shares: stale.access!.policy.shares,
  });
});
