// @vitest-environment happy-dom

import { RunnerIdSchema, createId, emptyExecutionPreferences, type Request } from "@opensteer/core";
import {
  DesktopDeploymentSummarySchema,
  type OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
import { fullAccessRequestBody } from "@opensteer/client/host";
import type { ShellContext } from "./app-shell.js";
import { ThreadFullDiskAccessAction } from "./thread-full-disk-access-action.js";

const noOp = () => undefined;
const mountedRoots: Root[] = [];
const machineId = RunnerIdSchema.parse("rnr_33333333-3333-4333-8333-333333333333");
/** The mock's Personal main computer: Deployment-owned, hosting it. */
const hostingMacId = RunnerIdSchema.parse("rnr_11111111-1111-4111-8111-111111111111");
const otherMachineId = RunnerIdSchema.parse("rnr_44444444-4444-4444-8444-444444444444");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  for (const root of mountedRoots.splice(0)) act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("ThreadFullDiskAccessAction", () => {
  it("names the Mac to open, and offers the grant only on that Mac", async () => {
    const requestFullDiskAccess = vi.fn(async () => ({ opened: true }) as const);
    const bridge = { requestFullDiskAccess } as unknown as OpensteerDesktopBridge;

    // In a browser, or on a phone: nothing here can open a macOS pane.
    const away = await mount({});
    expect(away.container.textContent).toContain(fullAccessRequestBody("Alex's MacBook Pro"));
    expect(buttonTexts(away.container)).toEqual(["Not now"]);

    // The desktop app, but running on a different computer.
    const elsewhere = await mount({ desktopBridge: bridge, localRunnerId: otherMachineId });
    expect(buttonTexts(elsewhere.container)).toEqual(["Not now"]);

    const here = await mount({ desktopBridge: bridge, localRunnerId: machineId });
    expect(buttonTexts(here.container)).toEqual(["Not now", "Review macOS permission"]);

    await click(button(here.container, "Review macOS permission"));
    expect(requestFullDiskAccess).not.toHaveBeenCalled();
    await click(button(here.container, "Open System Settings"));
    expect(requestFullDiskAccess).toHaveBeenCalledOnce();
  });

  it("offers the grant on the Mac that hosts a Personal Deployment, from that Mac", async () => {
    const requestFullDiskAccess = vi.fn(async () => ({ opened: true }) as const);
    const bridge = { requestFullDiskAccess } as unknown as OpensteerDesktopBridge;

    // The hosting Mac is no lent Runner slot, so nothing in the local Runner
    // status names it; the desktop supervising the Deployment here is what does.
    const elsewhere = await mount({ desktopBridge: bridge, machineId: hostingMacId });
    expect(buttonTexts(elsewhere.container)).toEqual(["Not now"]);

    const here = await mount({
      desktopBridge: bridge,
      hostsDeploymentHere: true,
      machineId: hostingMacId,
    });
    expect(buttonTexts(here.container)).toEqual(["Not now", "Review macOS permission"]);
    await click(button(here.container, "Review macOS permission"));
    expect(requestFullDiskAccess).not.toHaveBeenCalled();
    await click(button(here.container, "Open System Settings"));
    expect(requestFullDiskAccess).toHaveBeenCalledOnce();
  });

  it("keeps the card usable when the decline fails", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    vi.spyOn(client, "dispatch").mockRejectedValue(new Error("The deployment refused that."));
    const page = await mount({ client });

    await click(button(page.container, "Not now"));

    expect(page.container.textContent).toContain("The deployment refused that.");
    expect(button(page.container, "Not now").disabled).toBe(false);
  });
});

function fullDiskAccessRequest(machineId: ReturnType<typeof RunnerIdSchema.parse>): Request {
  return {
    callId: crypto.randomUUID(),
    cancellationReason: null,
    createdAt: "2026-09-15T00:00:00.000Z",
    id: createId("request"),
    kind: "machine.full-disk-access",
    mode: "durable",
    originatingOccurrenceId: null,
    originatingRunId: createId("run"),
    originatingThreadId: createId("thread"),
    originatingWorkspaceId: createId("workspace"),
    payload: {
      kind: "machine.full-disk-access",
      machineId,
      machineName: "Alex's MacBook Pro",
      reason: "Reading Messages to summarise the thread",
    },
    presentation: {
      detail: "Reading Messages to summarise the thread",
      kind: "external",
      subject: { id: machineId, kind: "machine" },
      title: "Allow full access on Alex's MacBook Pro",
    },
    requestedBy: createId("user"),
    requiredActor: "requester",
    resolvedAt: null,
    resolvedBy: null,
    response: null,
    status: "pending",
    targetWorkspaceId: createId("workspace"),
  };
}

async function mount(input: {
  readonly client?: MockHostClient;
  readonly desktopBridge?: OpensteerDesktopBridge;
  readonly hostsDeploymentHere?: boolean;
  readonly localRunnerId?: string;
  readonly machineId?: string;
}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  const client = input.client ?? new MockHostClient({ latencyMs: 0 });
  const context = shellContext({
    client,
    desktopBridge: input.desktopBridge ?? null,
    hostsDeploymentHere: input.hostsDeploymentHere ?? false,
    localRunnerId: input.localRunnerId ?? null,
  });
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route element={<Outlet context={context} />}>
            <Route
              element={
                <ThreadFullDiskAccessAction
                  request={fullDiskAccessRequest(
                    RunnerIdSchema.parse(input.machineId ?? machineId),
                  )}
                />
              }
              index
            />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
  });
  return { container };
}

function shellContext(input: {
  readonly client: MockHostClient;
  readonly desktopBridge: OpensteerDesktopBridge | null;
  readonly hostsDeploymentHere: boolean;
  readonly localRunnerId: string | null;
}): ShellContext {
  const snapshot = input.client.getSnapshot();
  const desktopDeployment = input.hostsDeploymentHere
    ? DesktopDeploymentSummarySchema.parse({
        access: "owner",
        activeOrigin: "http://127.0.0.1:60470",
        canonicalOrigin: "http://127.0.0.1:60470",
        id: createId("deployment"),
        kind: "personal",
        lastUsedAt: null,
        name: "Mac mini",
        onThisComputer: true,
        routes: [{ kind: "canonical", origin: "http://127.0.0.1:60470", selected: true }],
      })
    : null;
  return {
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
    desktopBridge: input.desktopBridge,
    desktopDeployment,
    executionPreferences: emptyExecutionPreferences,
    hostClient: input.client,
    localExecutionAction: null,
    localExecutionError: null,
    localExecutionStatus:
      input.localRunnerId === null ? null : localStatus(RunnerIdSchema.parse(input.localRunnerId)),
    openHarnessAuthentication: null,
    refreshHarnessCatalog: async () => undefined,
    leaveSettings: noOp,
    openMobileNavigation: noOp,
    openNewWorkspace: noOp,
    openSharing: noOp,
    performLocalExecutionAction: async () => undefined,
    placements: [],
    rememberExecution: noOp,
    reportActionError: noOp,
    setTaskDone: noOp,
    writeInChat: noOp,
    snapshot,
  };
}

function localStatus(runnerId: string): NonNullable<ShellContext["localExecutionStatus"]> {
  return {
    available: true,
    computerName: "Alex's MacBook Pro",
    deploymentId: createId("deployment"),
    mayRunAgents: true,
    platform: "macos",
    portableFs: {
      binaryPath: null,
      detail: "Not installed",
      installAvailable: true,
      issue: null,
      state: "missing",
      version: null,
    },
    runAgents: false,
    runner: {
      detail: "Ready",
      enrolled: true,
      environmentId: createId("environment"),
      runnerId: RunnerIdSchema.parse(runnerId),
      state: "running",
    },
    schemaVersion: 4,
  };
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

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}
