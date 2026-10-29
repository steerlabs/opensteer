// @vitest-environment happy-dom

import {
  createId,
  emptyExecutionPreferences,
  RunnerIdSchema,
  type DeploymentId,
} from "@opensteer/core";
import type { MachineSummary } from "@opensteer/protocol";
import {
  DesktopDeploymentSummarySchema,
  type OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
import { fullAccessElsewhere } from "@opensteer/client/host";
import type { ShellContext } from "./app-shell.js";
import {
  computerAppIdFromHash,
  computerAppRoute,
  ComputerDetailPage,
  ComputersPage,
  currentDeviceMachineId,
  machineRemovalPrompt,
} from "./computers-page.js";

const noOp = () => undefined;
const mountedRoots: Root[] = [];
const macMiniId = "rnr_11111111-1111-4111-8111-111111111111";
const laptopId = "rnr_33333333-3333-4333-8333-333333333333";
/** The approval key the preview's Host already holds for the Mac mini. */
const macMiniApprovalKeyId = `sha256:${"A".repeat(43)}`;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  for (const root of mountedRoots.splice(0)) act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("computerAppRoute", () => {
  /**
   * The Apps settings and a computer's page reach one editor, so the link is
   * one route: the computer, and the app named in its fragment.
   */
  it("names one app on one computer, and reads the name back", () => {
    const route = computerAppRoute({ definitionId: "apple-messages", runnerId: laptopId });

    expect(route).toBe(`/settings/computers/${laptopId}#computer-app-apple-messages`);
    expect(computerAppIdFromHash(new URL(route, "https://x.test").hash)).toBe("apple-messages");
  });

  it("reads nothing out of a fragment that names no app", () => {
    expect(computerAppIdFromHash("")).toBeNull();
    expect(computerAppIdFromHash("#computer-app-")).toBeNull();
    expect(computerAppIdFromHash("#something-else")).toBeNull();
  });
});

describe("currentDeviceMachineId", () => {
  it("uses the hosting desktop's positive fact for a Personal Main with no local Runner slot", () => {
    const machines = [
      machineFixture({ id: laptopId, ownership: "mine" }),
      machineFixture({ id: macMiniId, ownership: "deployment" }),
    ];

    expect(
      currentDeviceMachineId({
        deploymentKind: "personal",
        hostsDeploymentOnThisComputer: true,
        localRunnerId: null,
        machines,
      }),
    ).toBe(macMiniId);
    expect(
      currentDeviceMachineId({
        deploymentKind: "personal",
        hostsDeploymentOnThisComputer: false,
        localRunnerId: null,
        machines,
      }),
    ).toBeNull();
  });
});

describe("machineRemovalPrompt", () => {
  it("names what is lost before anyone confirms", () => {
    expect(
      machineRemovalPrompt(
        machineFixture({ localWorkspaces: 2, name: "Mac mini", pinnedThreads: 1 }),
      ),
    ).toBe(
      "Remove Mac mini? Agents will no longer be able to use it. 1 Thread runs here and 2 Workspaces keep their files on its disk, and will have nowhere to run until you move them.",
    );
  });
});

describe("ComputersPage", () => {
  it("offers the Mac in front of the reader by name, and adds it", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    const performLocalExecutionAction = vi.fn(async () => undefined);
    const page = await interactivePage({
      client,
      desktopBridge: {} as OpensteerDesktopBridge,
      localExecutionStatus: localStatus({ enrolled: false }),
      performLocalExecutionAction,
      snapshot: client.getSnapshot(),
    });

    expect(page.container.textContent).toContain("You’re on Alex's MacBook Pro");
    expect(page.container.textContent).toContain("Add a different computer");
    await click(button(page.container, "Add Alex's MacBook Pro"));

    expect(performLocalExecutionAction).toHaveBeenCalledWith({
      kind: "add",
      name: "Alex's MacBook Pro",
      runAgents: false,
    });
  });

  it("reviews Full Disk Access before opening settings for a Mac that just joined", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    const checkFullDiskAccess = vi.fn(async () => ({ granted: false }) as const);
    const requestFullDiskAccess = vi.fn(async () => ({ opened: true }) as const);
    const page = await interactivePage({
      client,
      desktopBridge: {
        checkFullDiskAccess,
        requestFullDiskAccess,
      } as unknown as OpensteerDesktopBridge,
      localExecutionStatus: localStatus({ enrolled: false }),
      snapshot: client.getSnapshot(),
    });

    await click(button(page.container, "Add Alex's MacBook Pro"));
    await vi.waitFor(() => expect(checkFullDiskAccess).toHaveBeenCalledOnce());

    expect(page.container.textContent).toContain("Review macOS Full Disk Access");
    expect(page.container.textContent).toContain(
      "Full Disk Access lets Opensteer access protected files on this Mac, beyond any one app integration.",
    );
    expect(requestFullDiskAccess).not.toHaveBeenCalled();

    await click(button(page.container, "Open System Settings"));

    expect(requestFullDiskAccess).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(page.container.textContent).not.toContain("Review macOS Full Disk Access"),
    );
  });

  it("adds a Windows computer to a server running agents, and never asks it about macOS", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    const checkFullDiskAccess = vi.fn(async () => ({ granted: false }) as const);
    const performLocalExecutionAction = vi.fn(async () => undefined);
    const page = await interactivePage({
      client,
      desktopBridge: { checkFullDiskAccess } as unknown as OpensteerDesktopBridge,
      localExecutionStatus: localStatus({ enrolled: false, platform: "windows" }),
      performLocalExecutionAction,
      snapshot: serverSnapshot(client),
    });

    expect(page.container.textContent).toContain("Add it and agents can work right on it");
    await click(button(page.container, "Add Alex's MacBook Pro"));

    expect(performLocalExecutionAction).toHaveBeenCalledWith({
      kind: "add",
      name: "Alex's MacBook Pro",
      runAgents: true,
    });
    expect(checkFullDiskAccess).not.toHaveBeenCalled();
  });

  it("grants a headless computer agents and reach, and labels both setup commands", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    const dispatch = vi.spyOn(client, "dispatch");
    const page = await interactivePage({ client, snapshot: serverSnapshot(client) });

    await click(button(page.container, "Add a computer"));
    await change(labelledInput(page.container, "Computer name"), "Office computer");
    await click(button(page.container, "Create connection code"));
    await vi.waitFor(() => expect(page.container.textContent).toContain("Runs in a container"));

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedModules: ["agents", "shell"],
        name: "Office computer",
        type: "runner.enrollment.createLocal",
      }),
    );
    const text = page.container.textContent ?? "";
    expect(text).toContain("Runs in a container: agents get only what you mount");
    expect(text).toContain("Needs Docker on that computer.");
    expect(text).toContain("no published runner download");
  });

  it("offers a new code after the current addition expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T20:00:00.000Z"));
    const client = new MockHostClient({ latencyMs: 0, now: () => new Date(Date.now()) });
    const page = await interactivePage({ client, snapshot: serverSnapshot(client) });

    await click(button(page.container, "Add a computer"));
    await click(button(page.container, "Create connection code"));
    await act(async () => vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000));

    expect(button(page.container, "Create a new code")).toBeTruthy();
  });

  /**
   * A Personal Opensteer admits no second computer until other computers can
   * reach it, so that is the first step while — and only while — it is off,
   * and the Mac hosting it links straight to the switch.
   */
  it("asks the hosting Mac to let other computers connect only while it cannot", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    const bridge = (phase: string) =>
      ({
        getPersonalRemoteAccessStatus: async () => ({ phase }),
        onPersonalRemoteAccessStatusChanged: () => () => undefined,
      }) as unknown as OpensteerDesktopBridge;
    const off = await interactivePage({
      client,
      desktopBridge: bridge("off"),
      desktopDeploymentKind: "personal",
      onThisComputer: true,
      snapshot: client.getSnapshot(),
    });
    const on = await interactivePage({
      client,
      desktopBridge: bridge("ready"),
      desktopDeploymentKind: "personal",
      onThisComputer: true,
      snapshot: client.getSnapshot(),
    });

    await click(button(off.container, "Add a computer"));
    await click(button(on.container, "Add a computer"));
    const steps = (container: HTMLElement) =>
      [...container.querySelectorAll(".add-computer__steps li")].map((step) => step.textContent);

    await vi.waitFor(() =>
      expect(steps(off.container)[0]).toContain("Turn on remote access for Mac mini"),
    );
    expect(
      off.container.querySelector('.add-computer__steps a[href="/settings/devices"]'),
    ).not.toBeNull();
    await vi.waitFor(() => expect(steps(on.container)).toHaveLength(2));
    expect(steps(on.container)[0]).toContain(
      "sign in with your Opensteer account. Then open Mac mini.",
    );
    expect(steps(on.container)[1]).toContain("choose Add");
  });
});

describe("ComputerDetailPage", () => {
  it("finishes a same-access request through the live Host and this Mac's answer", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    const input = {
      access: "read-write" as const,
      app: null,
      definitionId: "apple-messages",
      kind: "app" as const,
      runnerId: laptopId,
    };
    const first = await client.dispatch({
      idempotencyKey: "existing-write-setup",
      input,
      type: "integration.computer.setup.request",
    });
    if (first.type !== "integration.computer.setup.request") throw new Error("Setup mismatch.");
    await client.answerComputerAppApprovalOnMac({
      ...input,
      approval: {
        expiresAt: "2026-09-20T00:00:00.000Z",
        requestId: first.request.id,
        signature: "a".repeat(86),
      },
    });
    const pending = await client.dispatch({
      idempotencyKey: "pending-write-setup",
      input,
      type: "integration.computer.setup.request",
    });
    if (pending.type !== "integration.computer.setup.request") throw new Error("Setup mismatch.");
    // The Host pushes the request to this Mac, and the Mac answers on its own
    // stream; the page only waits for that answer.
    const reviewComputerAppSetup = vi.fn(async ({ setupRequestId }: { setupRequestId: string }) => {
      await client.answerComputerAppApprovalOnMac({
        ...input,
        approval: {
          expiresAt: "2026-09-20T00:00:00.000Z",
          requestId: setupRequestId,
          signature: "b".repeat(86),
        },
      });
      return { allowed: true };
    });
    const dispatch = vi.spyOn(client, "dispatch");
    const page = await interactivePage({
      client,
      desktopBridge: Object.assign({} as OpensteerDesktopBridge, { reviewComputerAppSetup }),
      localExecutionStatus: localStatus({ enrolled: true, runnerId: laptopId }),
      path: `/settings/computers/${laptopId}`,
      snapshot: client.getSnapshot(),
    });

    await vi.waitFor(() => expect(buttonTexts(page.container)).toContain("Finish setup"));
    await click(button(page.container, "Finish setup"));
    await click(button(page.container, "Allow and continue"));

    expect(reviewComputerAppSetup).toHaveBeenCalledWith({ setupRequestId: pending.request.id });
    // No client command carries a signature.
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "integration.computer.setup.set" }),
    );
    const remaining = await client.rpc["integration.computer.setup.list"]({});
    expect(
      remaining.ok &&
        remaining.data.requests.filter(({ definitionId }) => definitionId === "apple-messages"),
    ).toEqual([]);
    const connections = await client.rpc["integrations.get"]({});
    expect(
      connections.ok &&
        connections.data.connections.some(
          (connection) =>
            connection.definitionId === input.definitionId &&
            connection.computer?.runnerId === laptopId &&
            connection.computer.access === "read-write",
        ),
    ).toBe(true);
    expect(page.container.textContent).not.toContain("Sending setup requested");
    expect(page.container.textContent).not.toContain("Setup requested");
    expect(page.container.textContent).toContain("Setup unfinished");
  });

  it("refreshes a stale setup intent before its target computer is asked", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    const stale = await client.dispatch({
      idempotencyKey: "stale-setup-fixture",
      input: {
        access: "read",
        app: null,
        definitionId: "apple-messages",
        kind: "app",
        runnerId: laptopId,
      },
      type: "integration.computer.setup.request",
    });
    if (stale.type !== "integration.computer.setup.request") throw new Error("Setup mismatch.");
    const fresh = { ...stale.request, id: crypto.randomUUID(), definitionDigest: "new-digest" };
    const dispatch = vi.spyOn(client, "dispatch");
    dispatch.mockImplementation(async (command) => {
      if (command.type === "integration.computer.setup.request") {
        return { type: command.type, request: fresh } as Awaited<
          ReturnType<typeof client.dispatch>
        >;
      }
      return MockHostClient.prototype.dispatch.call(client, command);
    });
    const reviewComputerAppSetup = vi.fn(async () => ({ allowed: false }));
    const page = await interactivePage({
      client,
      desktopBridge: Object.assign({} as OpensteerDesktopBridge, { reviewComputerAppSetup }),
      localExecutionStatus: localStatus({ enrolled: true, runnerId: laptopId }),
      path: `/settings/computers/${laptopId}`,
      snapshot: client.getSnapshot(),
    });

    await vi.waitFor(() => expect(buttonTexts(page.container)).toContain("Review request"));
    await click(button(page.container, "Review request"));
    await click(button(page.container, "Allow and continue"));

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          access: "read",
          app: null,
          definitionId: "apple-messages",
          kind: "app",
          runnerId: laptopId,
        },
        type: "integration.computer.setup.request",
      }),
    );
    expect(reviewComputerAppSetup).toHaveBeenCalledWith({ setupRequestId: fresh.id });
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "integration.computer.setup.set",
      }),
    );
  });

  it("keeps setup unfinished when the Host refuses this Mac's answer", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    const reviewComputerAppSetup = vi.fn(async () => {
      throw new Error("The setup request was replaced.");
    });
    const page = await interactivePage({
      client,
      desktopBridge: Object.assign({} as OpensteerDesktopBridge, { reviewComputerAppSetup }),
      localExecutionStatus: localStatus({ enrolled: true, runnerId: laptopId }),
      path: `/settings/computers/${laptopId}`,
      snapshot: client.getSnapshot(),
    });

    await vi.waitFor(() => expect(buttonTexts(page.container)).toContain("Set up"));
    await click(button(page.container, "Set up"));
    await click(button(page.container, "Allow and continue"));

    expect(reviewComputerAppSetup).toHaveBeenCalledWith({ setupRequestId: expect.any(String) });
    expect(page.container.textContent).toContain("The setup request was replaced.");
    expect(page.container.textContent).not.toContain("is ready");
  });

  it("keeps the Reachable block and Remove off the Mac a Personal Opensteer runs on", () => {
    const client = new MockHostClient({ latencyMs: 0 });
    const html = renderPage({
      client,
      desktopBridge: {} as OpensteerDesktopBridge,
      desktopDeploymentKind: "personal",
      onThisComputer: true,
      path: `/settings/computers/${macMiniId}`,
      snapshot: client.getSnapshot(),
    });

    expect(html).toContain("You’re here");
    expect(html).toContain("Your Opensteer runs here.");
    expect(html).not.toContain("Reachable by agents");
    expect(html).not.toContain("Remove Mac mini");
    expect(html).toContain("can’t be removed, because your Opensteer runs on it");
  });

  /**
   * A Personal Deployment's added computer was granted `integrations` and
   * `shell` when it joined, and nothing on this page can change that. Offering
   * a switch would be offering a change the Host refuses, so the page says
   * where agents do run instead.
   */
  it("offers no agents switch on a Personal computer that was never granted it", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    const page = await interactivePage({
      client,
      desktopBridge: {} as OpensteerDesktopBridge,
      desktopDeploymentKind: "personal",
      localExecutionStatus: localStatus({ enrolled: true, runnerId: laptopId }),
      path: `/settings/computers/${laptopId}`,
      snapshot: client.getSnapshot(),
    });

    expect(page.container.textContent).toContain(
      "Agents work on Mac mini. Choose what they can use on Alex's MacBook Pro.",
    );
    expect(page.container.textContent).not.toContain("Agents work here");
    expect(
      page.container.querySelector('[aria-label="Agents work on Alex\'s MacBook Pro"]'),
    ).toBeNull();
  });

  it("switches agent work on this device, and states it as a fact elsewhere", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    const performLocalExecutionAction = vi.fn(async () => undefined);
    const snapshot = serverSnapshot(client);
    const here = await interactivePage({
      client,
      desktopBridge: {} as OpensteerDesktopBridge,
      localExecutionStatus: localStatus({ enrolled: true, runAgents: false, runnerId: macMiniId }),
      path: `/settings/computers/${macMiniId}`,
      performLocalExecutionAction,
      snapshot,
    });

    await click(labelledInput(here.container, "Agents work on Mac mini"));
    expect(performLocalExecutionAction).toHaveBeenCalledWith({
      kind: "set-run-agents",
      runAgents: true,
    });
    expect(here.container.textContent).toContain(
      "New threads can run on Mac mini, using its own files, apps and sign-ins.",
    );

    // The same computer read from another device: a fact, not a control.
    const elsewhere = renderPage({ client, path: `/settings/computers/${macMiniId}`, snapshot });
    expect(elsewhere).toContain("Agents work here");
    expect(elsewhere).not.toContain("Agents work on Mac mini");
  });

  it("states Full Disk Access and opens settings only after local review", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    const requestFullDiskAccess = vi.fn(async () => ({ opened: true }) as const);
    const denied = withFullDiskAccess(client, laptopId, false);

    // Read from anywhere else, the block says where the switch lives.
    const elsewhere = renderPage({
      client,
      path: `/settings/computers/${laptopId}`,
      snapshot: denied,
    });
    expect(elsewhere).toContain("Mac permissions");
    expect(elsewhere).toContain("macOS Full Disk Access");
    expect(elsewhere).toContain(
      "macOS Full Disk Access has not been granted. Some protected data may be unavailable.",
    );
    expect(elsewhere).toContain(
      fullAccessElsewhere("Alex's MacBook Pro").replaceAll("'", "&#x27;"),
    );
    expect(elsewhere).not.toContain("Review macOS permission");

    const here = await interactivePage({
      client,
      desktopBridge: { requestFullDiskAccess } as unknown as OpensteerDesktopBridge,
      localExecutionStatus: localStatus({ enrolled: true, runnerId: laptopId }),
      path: `/settings/computers/${laptopId}`,
      snapshot: denied,
    });
    expect(here.container.textContent).toContain(
      "macOS Full Disk Access has not been granted. Some protected data may be unavailable.",
    );
    expect(here.container.textContent).not.toContain("Complete setup in Opensteer on");

    await click(button(here.container, "Review macOS permission"));
    expect(requestFullDiskAccess).not.toHaveBeenCalled();
    expect(here.container.textContent).toContain("Review macOS Full Disk Access");
    await click(button(here.container, "Open System Settings"));
    expect(requestFullDiskAccess).toHaveBeenCalledOnce();
    // Opening Settings does not manufacture a grant; the Host's next machine
    // report remains the only source of the observed state.
    expect(buttonTexts(here.container)).toContain("Review macOS permission");

    // Once the Mac reports the grant, the page the revision refreshed says so
    // and stops offering anything.
    await here.render(withFullDiskAccess(client, laptopId, true));
    expect(here.container.textContent).toContain(
      "Opensteer has macOS permission to access protected files. Agent access still follows your app and computer settings.",
    );
    expect(buttonTexts(here.container)).not.toContain("Review macOS permission");
  });

  it("offers full access on the Mac that hosts a Personal Deployment, from that Mac", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    const requestFullDiskAccess = vi.fn(async () => ({ opened: true }) as const);
    const denied = withFullDiskAccess(client, macMiniId, false);
    const bridge = { requestFullDiskAccess } as unknown as OpensteerDesktopBridge;

    // The hosting Mac is no lent slot, so the local Runner status never names
    // it; the desktop's own supervision of the Deployment is what places the
    // reader at its keyboard.
    const elsewhere = renderPage({
      client,
      desktopBridge: bridge,
      desktopDeploymentKind: "personal",
      path: `/settings/computers/${macMiniId}`,
      snapshot: denied,
    });
    expect(elsewhere).toContain(fullAccessElsewhere("Mac mini"));
    expect(elsewhere).not.toContain("Review macOS permission");

    const here = await interactivePage({
      client,
      desktopBridge: bridge,
      desktopDeploymentKind: "personal",
      onThisComputer: true,
      path: `/settings/computers/${macMiniId}`,
      snapshot: denied,
    });
    expect(here.container.textContent).not.toContain("Complete setup in Opensteer on");
    await click(button(here.container, "Review macOS permission"));
    expect(requestFullDiskAccess).not.toHaveBeenCalled();
    await click(button(here.container, "Open System Settings"));
    expect(requestFullDiskAccess).toHaveBeenCalledOnce();
  });

  // Failure: the Mac hosting a Personal Deployment has no lent Runner slot, so
  // its own page treats it as elsewhere and offers an access request where
  // only that Mac's macOS step can finish setup.
  // Failure: registering the approval key and setting up an app decide "this
  // Mac" separately, so one sees the hosting Mac while the other does not.
  // Failure: a browser on that Mac claims to be at it, though only the desktop
  // app there can open the grant.
  it("finishes an app's macOS setup on the Mac that hosts a Personal Deployment, from that Mac", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    const snapshot = withMessagesNeedingFullDiskAccess(client, macMiniId);
    const path = `/settings/computers/${macMiniId}`;
    const computerUseApprovalKey = vi.fn(async () => ({
      keyId: macMiniApprovalKeyId,
      publicKey: "public-key",
    }));
    const openComputerAppSetup = vi.fn(async () => ({ opened: true }));
    const bridge = {
      computerUseApprovalKey,
      openComputerAppSetup,
    } as unknown as OpensteerDesktopBridge;

    const browser = await interactivePage({ client, path, snapshot });
    await vi.waitFor(() =>
      expect(browser.container.textContent).toContain("Complete setup on Mac mini."),
    );
    expect(buttonTexts(browser.container)).not.toContain("Finish setup");
    expect(buttonTexts(browser.container)).not.toContain("Send setup request");

    const here = await interactivePage({
      client,
      desktopBridge: bridge,
      desktopDeploymentKind: "personal",
      onThisComputer: true,
      path,
      snapshot,
    });
    await vi.waitFor(() => expect(buttonTexts(here.container)).toContain("Finish setup"));
    expect(buttonTexts(here.container)).not.toContain("Send setup request");
    expect(here.container.textContent).not.toContain("Complete setup on Mac mini.");
    expect(computerUseApprovalKey).toHaveBeenCalled();

    await click(button(here.container, "Finish setup"));
    expect(here.container.textContent).toContain("Allow Apple Messages on this Mac");
    await click(button(here.container, "Set up"));
    expect(openComputerAppSetup).toHaveBeenCalledWith({
      access: "read",
      definitionId: "apple-messages",
    });
  });

  // Failure: turning an app on at the hosting Mac goes out as a request for
  // some other device to approve, rather than this Mac's own approval.
  it("turns an app on at the Mac that hosts a Personal Deployment through that Mac's approval", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    const dashboard = await client.rpc["integrations.get"]({});
    const messages = dashboard.ok
      ? dashboard.data.connections.find(
          ({ computer, definitionId }) =>
            definitionId === "apple-messages" && computer?.runnerId === macMiniId,
        )
      : undefined;
    if (!messages) throw new Error("The preview has Messages on the Mac mini.");
    await client.dispatch({
      connectionId: messages.id,
      idempotencyKey: "messages-off-on-mac-mini",
      type: "integration.disconnect",
    });
    const reviewComputerAppSetup = vi.fn(async ({ setupRequestId }: { setupRequestId: string }) => {
      await client.answerComputerAppApprovalOnMac({
        access: "read",
        app: null,
        approval: {
          expiresAt: "2026-09-20T00:00:00.000Z",
          requestId: setupRequestId,
          signature: "c".repeat(86),
        },
        definitionId: "apple-messages",
        kind: "app",
        runnerId: macMiniId,
      });
      return { allowed: true };
    });
    const bridge = {
      computerUseApprovalKey: async () => ({
        keyId: macMiniApprovalKeyId,
        publicKey: "public-key",
      }),
      reviewComputerAppSetup,
    } as unknown as OpensteerDesktopBridge;
    const page = await interactivePage({
      client,
      desktopBridge: bridge,
      desktopDeploymentKind: "personal",
      onThisComputer: true,
      path: `/settings/computers/${macMiniId}`,
      snapshot: client.getSnapshot(),
    });

    await vi.waitFor(() => expect(buttonTexts(page.container)).toContain("Set up"));
    expect(buttonTexts(page.container)).not.toContain("Send setup request");
    await click(button(page.container, "Set up"));
    await click(button(page.container, "Allow and continue"));

    expect(reviewComputerAppSetup).toHaveBeenCalledOnce();
    expect(page.container.textContent).not.toContain("Open Opensteer on Mac mini to continue.");
  });

  it("removes another computer with the Host command, after saying what it costs", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    const dispatch = vi.spyOn(client, "dispatch");
    const confirm = vi.fn(() => true);
    Object.defineProperty(window, "confirm", { configurable: true, value: confirm });
    const page = await interactivePage({
      client,
      path: `/settings/computers/${laptopId}`,
      snapshot: client.getSnapshot(),
    });

    expect(page.container.textContent).toContain("Remove Alex's MacBook Pro");
    await click(dangerButton(page.container));

    expect(confirm).toHaveBeenCalledWith(
      "Remove Alex's MacBook Pro? Agents will no longer be able to use it.",
    );
    await vi.waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ machineId: laptopId, type: "machine.revoke" }),
      ),
    );
  });

  it("removes this device through the desktop, which revokes before it stops", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    const dispatch = vi.spyOn(client, "dispatch");
    const performLocalExecutionAction = vi.fn(async () => undefined);
    Object.defineProperty(window, "confirm", { configurable: true, value: vi.fn(() => true) });
    const page = await interactivePage({
      client,
      desktopBridge: {} as OpensteerDesktopBridge,
      localExecutionStatus: localStatus({ enrolled: true, runnerId: laptopId }),
      path: `/settings/computers/${laptopId}`,
      performLocalExecutionAction,
      snapshot: client.getSnapshot(),
    });

    await click(dangerButton(page.container));

    expect(performLocalExecutionAction).toHaveBeenCalledWith({ kind: "remove" });
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "machine.revoke" }));
  });

  it("stays on the computer, and says why, when removing it fails", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    const performLocalExecutionAction = vi.fn(async () => {
      throw new Error("This computer could not be removed.");
    });
    Object.defineProperty(window, "confirm", { configurable: true, value: vi.fn(() => true) });
    const page = await interactivePage({
      client,
      desktopBridge: {} as OpensteerDesktopBridge,
      localExecutionStatus: localStatus({ enrolled: true, runnerId: laptopId }),
      path: `/settings/computers/${laptopId}`,
      performLocalExecutionAction,
      snapshot: client.getSnapshot(),
    });

    await click(dangerButton(page.container));

    expect(page.container.textContent).toContain("This computer could not be removed.");
    // Still the computer's own page: nothing said it left.
    expect(page.container.textContent).toContain("Remove Alex's MacBook Pro");
  });

  it("stays put when the Host refuses to revoke another computer", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    vi.spyOn(client, "dispatch").mockRejectedValue(new Error("The deployment refused that."));
    Object.defineProperty(window, "confirm", { configurable: true, value: vi.fn(() => true) });
    const page = await interactivePage({
      client,
      path: `/settings/computers/${laptopId}`,
      snapshot: client.getSnapshot(),
    });

    await click(dangerButton(page.container));

    expect(page.container.textContent).toContain("The deployment refused that.");
    expect(page.container.textContent).toContain("Remove Alex's MacBook Pro");
  });
});

/*
 * An iPhone a newer Host lists, read on a server Deployment from another
 * device. Its page must not:
 * - offer or explain agents working on it, or folders it was "added only to lend";
 * - describe it as a computer, or say nothing on "the computer" is deleted;
 * - read as broken while it is away, which it is whenever Opensteer is closed.
 */
describe("ComputerDetailPage for an iPhone", () => {
  const iphoneId = "rnr_77777777-7777-4777-8777-777777777777";
  const iphone = machineFixture({
    allowedModules: ["integrations"],
    device: { form: "phone", platform: "ios" },
    id: iphoneId,
    lastSeenAt: "2026-09-19T00:00:00.000Z",
    modules: { integrations: { checkedAt: null, detail: null, readiness: "ready" } },
    name: "Alex's iPhone",
    ownerName: "Alex",
    status: "offline",
  });

  it("shows only what an iPhone lends, in an iPhone's words", () => {
    const client = new MockHostClient({ latencyMs: 0 });
    const snapshot = serverSnapshot(client);
    const html = renderPage({
      client,
      path: `/settings/computers/${iphoneId}`,
      snapshot: { ...snapshot, machines: [...snapshot.machines, iphone] },
    });
    const text = html.replace(/<[^>]+>/g, " ");

    expect(text).toContain("Offline · Available while Opensteer is open on Alex&#x27;s iPhone");
    expect(text).toContain("Alex’s phone");
    expect(text).toContain(
      "Agents can use only the apps turned on for Alex&#x27;s iPhone, and only while Opensteer is open on it.",
    );
    expect(text).toContain("Agents stop using its apps. Nothing on the iPhone is deleted.");
    expect(text).not.toContain("Agents don’t work here");
    expect(text).not.toContain("folders");
    expect(text).not.toContain("Mac permissions");
    expect(text).not.toContain("Files and commands");
    expect(text).not.toContain("on the computer");
  });

  it("waits for a new iPhone in its own words", () => {
    const client = new MockHostClient({ latencyMs: 0 });
    const snapshot = serverSnapshot(client);
    const pending = { ...iphone, lastSeenAt: null, status: "pending" as const };
    const text = renderPage({
      client,
      path: `/settings/computers/${iphoneId}`,
      snapshot: { ...snapshot, machines: [...snapshot.machines, pending] },
    });

    expect(text).toContain(
      "Waiting for Alex&#x27;s iPhone to connect. Open Opensteer on it to finish adding it.",
    );
    expect(text).not.toContain("on that computer");
  });
});

function machineFixture(overrides: Partial<MachineSummary> = {}): MachineSummary {
  return {
    access: null,
    apps: null,
    allowedModules: ["agents", "shell"],
    computerUse: null,
    detail: null,
    device: null,
    enrollmentId: "ren_fixture",
    expiresAt: null,
    fullDiskAccess: null,
    id: "rnr_55555555-5555-4555-8555-555555555555",
    lastSeenAt: null,
    localWorkspaces: 0,
    modules: { agents: { checkedAt: null, detail: null, readiness: "ready" } },
    name: "Fixture",
    ownership: "mine",
    ownerName: null,
    pinnedThreads: 0,
    revocable: true,
    status: "online",
    runtimeVersion: null,
    unlinkedLocalFolders: 0,
    ...overrides,
  };
}

/** One computer's snapshot with the macOS grant the Host projected for it. */
function withFullDiskAccess(
  client: MockHostClient,
  machineId: string,
  fullDiskAccess: boolean | null,
): ShellContext["snapshot"] {
  const snapshot = client.getSnapshot();
  return {
    ...snapshot,
    machines: snapshot.machines.map((machine) =>
      machine.id === machineId ? { ...machine, fullDiskAccess } : machine,
    ),
  };
}

/** One computer's snapshot where reading Messages still waits for Full Disk Access. */
function withMessagesNeedingFullDiskAccess(
  client: MockHostClient,
  machineId: string,
): ShellContext["snapshot"] {
  const snapshot = client.getSnapshot();
  const blocked = {
    detail: "Reading Messages needs macOS Full Disk Access.",
    remedy: "full-disk-access" as const,
    state: "permission-required" as const,
  };
  return {
    ...snapshot,
    machines: snapshot.machines.map((machine) =>
      machine.id === machineId
        ? {
            ...machine,
            apps: (machine.apps ?? []).map((app) =>
              app.definitionId === "apple-messages"
                ? {
                    ...app,
                    operations: app.operations.map((status) => ({ ...status, ...blocked })),
                  }
                : app,
            ),
          }
        : machine,
    ),
  };
}

function serverSnapshot(client: MockHostClient): ShellContext["snapshot"] {
  return {
    ...client.getSnapshot(),
    deploymentShape: { defaultWorkspaceBacking: "portablefs", kind: "server" },
  };
}

function localStatus(input: {
  readonly deploymentId?: DeploymentId;
  readonly enrolled: boolean;
  readonly platform?: NonNullable<ShellContext["localExecutionStatus"]>["platform"];
  readonly runAgents?: boolean;
  readonly runnerId?: string;
}): NonNullable<ShellContext["localExecutionStatus"]> {
  return {
    available: true,
    computerName: "Alex's MacBook Pro",
    deploymentId: input.deploymentId ?? createId("deployment"),
    mayRunAgents: true,
    platform: input.platform ?? "macos",
    portableFs: {
      binaryPath: null,
      detail: "Not installed",
      installAvailable: true,
      issue: null,
      state: "missing",
      version: null,
    },
    runAgents: input.runAgents ?? false,
    runner: {
      detail: input.enrolled ? "Ready" : "Off",
      enrolled: input.enrolled,
      environmentId: input.enrolled ? createId("environment") : null,
      runnerId: input.runnerId === undefined ? null : RunnerIdSchema.parse(input.runnerId),
      state: input.enrolled ? "running" : "disabled",
    },
    schemaVersion: 4,
  };
}

interface PageInput {
  /** How the desktop reached the Deployment on screen. */
  readonly desktopAccess?: "connect" | "native" | "owner";
  readonly client: MockHostClient;
  readonly desktopBridge?: OpensteerDesktopBridge | null;
  readonly desktopDeploymentKind?: "personal" | "self-hosted";
  readonly desktopDeploymentName?: string;
  readonly localExecutionStatus?: ShellContext["localExecutionStatus"];
  /** Whether the desktop app supervises the Deployment on the computer it runs on. */
  readonly onThisComputer?: boolean;
  readonly path?: string;
  readonly performLocalExecutionAction?: ShellContext["performLocalExecutionAction"];
  readonly snapshot: ShellContext["snapshot"];
}

async function interactivePage(input: PageInput) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  const render = async (
    nextSnapshot: ShellContext["snapshot"],
    nextStatus = input.localExecutionStatus ?? null,
  ) => {
    await act(async () => {
      root.render(
        pageElement({ ...input, localExecutionStatus: nextStatus, snapshot: nextSnapshot }),
      );
    });
  };
  await render(input.snapshot);
  return { container, render };
}

function renderPage(input: PageInput): string {
  return renderToStaticMarkup(pageElement(input));
}

function pageElement(input: PageInput) {
  const desktopDeployment = input.desktopBridge
    ? DesktopDeploymentSummarySchema.parse({
        access: input.desktopAccess ?? "native",
        activeOrigin: "https://opensteer.example.test",
        canonicalOrigin: "https://opensteer.example.test",
        id: input.localExecutionStatus?.deploymentId ?? createId("deployment"),
        kind: input.desktopDeploymentKind ?? "self-hosted",
        lastUsedAt: null,
        name: input.desktopDeploymentName ?? "Mac mini",
        onThisComputer: input.onThisComputer ?? false,
        routes: [{ kind: "canonical", origin: "https://opensteer.example.test", selected: true }],
      })
    : null;
  const context: ShellContext = {
    actionError: null,
    clearActionError: noOp,
    askOpensteerAbout: noOp,
    clearHomeHandoff: noOp,
    homeDraft: "",
    homeHandoff: null,
    homeThreadId: null,
    setHomeDraft: noOp,
    createThreadAndSend: async () => null,
    defaultPlacement: undefined,
    deploymentAccess: null,
    desktopBridge: input.desktopBridge ?? null,
    desktopDeployment,
    executionPreferences: emptyExecutionPreferences,
    hostClient: input.client,
    localExecutionAction: null,
    localExecutionError: null,
    localExecutionStatus: input.localExecutionStatus ?? null,
    openHarnessAuthentication: null,
    refreshHarnessCatalog: async () => undefined,
    leaveSettings: noOp,
    openMobileNavigation: noOp,
    openNewWorkspace: noOp,
    openSharing: noOp,
    performLocalExecutionAction: input.performLocalExecutionAction ?? (async () => undefined),
    placements: [],
    rememberExecution: noOp,
    reportActionError: noOp,
    setTaskDone: noOp,
    writeInChat: noOp,
    snapshot: input.snapshot,
  };
  return (
    <MemoryRouter initialEntries={[input.path ?? "/settings/computers"]}>
      <Routes>
        <Route element={<Outlet context={context} />}>
          <Route element={<ComputersPage />} path="settings/computers" />
          <Route element={<ComputerDetailPage />} path="settings/computers/:computerId" />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

function buttonTexts(container: HTMLElement): readonly (string | null)[] {
  return [...container.querySelectorAll("button")].map((candidate) => candidate.textContent);
}

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === text,
  );
  if (!match) throw new Error(`Missing button: ${text}`);
  return match;
}

/** The one destructive control a computer's page carries. */
function dangerButton(container: HTMLElement): HTMLButtonElement {
  const match = container.querySelector<HTMLButtonElement>(".btn--danger");
  if (!match) throw new Error("Missing the Remove button.");
  return match;
}

function labelledInput(container: HTMLElement, label: string): HTMLInputElement {
  const input = [...container.querySelectorAll("input")].find(
    (candidate) =>
      candidate.getAttribute("aria-label") === label ||
      candidate.labels?.[0]?.textContent?.includes(label),
  );
  if (!input) throw new Error(`Missing input: ${label}`);
  return input;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}

async function change(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setValue) throw new Error("The test DOM has no input value setter.");
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
