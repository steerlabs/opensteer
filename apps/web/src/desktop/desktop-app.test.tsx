// @vitest-environment happy-dom

import { createId } from "@opensteer/core";
import {
  DeploymentAccessSnapshotSchema,
  DesktopDeploymentSummarySchema,
  DesktopPersonalDeploymentStatusSchema,
  type DeploymentAccessSnapshot,
  type DesktopPersonalDeploymentStatus,
  type DeploymentAccessDeployment,
  type OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { DesktopApp, desktopAccessPresentationFromSnapshot } from "./desktop-app.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("keeps confirmation fenced while exposing its failure, retry, leave and the chooser", async () => {
  const selected = accessDeployment("needs-sign-in");
  const access = snapshot({ deployments: [selected], selectedDeploymentId: selected.id });
  const retryGate = Promise.withResolvers<void>();
  const retryDeviceConnection = vi.fn(async () => retryGate.promise);
  const leaveDeployment = vi.fn(async () => undefined);
  const setUpDevice = vi.fn();
  const bridge = {
    retryDeviceConnection,
    leaveDeployment,
    setUpDevice,
    checkDeployments: async () => undefined,
    getDeploymentAccessSnapshot: async () => access,
    getLocalExecutionStatus: async () => ({
      deploymentId: selected.id,
      runner: {
        state: "failed",
        detail: "Home is offline; runner route refused the connection.",
        enrolled: true,
        runnerId: createId("runner"),
        environmentId: null,
      },
      membership: {
        state: "active",
        sessionState: "confirming",
        runnerId: createId("runner"),
        generation: 3,
      },
    }),
    onHostWebSocketEvent: () => () => undefined,
    onDeploymentAccessSnapshotChanged: () => () => undefined,
    onNotificationActivated: () => () => undefined,
    onLocalExecutionStatusChanged: () => () => undefined,
  } as unknown as OpensteerDesktopBridge;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<DesktopApp bridge={bridge} />));
    await vi.waitFor(() => expect(container.textContent).toContain("Home is offline"));
    const click = async (label: string) => {
      const button = [...container.querySelectorAll("button")].find(
        (item) => item.textContent?.trim() === label,
      );
      expect(button, label).toBeDefined();
      await act(async () => button!.click());
    };
    await click("Retry");
    expect(retryDeviceConnection).toHaveBeenCalledWith({ deploymentId: selected.id });
    await click("Leave this Opensteer");
    expect(leaveDeployment).toHaveBeenCalledWith({ deploymentId: selected.id });
    await act(async () => retryGate.resolve());
    await click("Choose an Opensteer");
    expect(container.textContent).toContain("Open your Opensteer");
    expect(container.textContent).not.toContain("Checking this Mac’s connection");
    expect(setUpDevice).not.toHaveBeenCalled();
  } finally {
    retryGate.resolve();
    await act(async () => root.unmount());
    container.remove();
  }
});

it("lets a connecting place go back and shows cancellation failures", async () => {
  const cancel = vi.fn(async () => {
    throw new Error("The connection could not be cancelled.");
  });
  const connecting = accessDeployment("connecting");
  const access = snapshot({
    deployments: [connecting],
    selectedDeploymentId: connecting.id,
  });
  const bridge = {
    cancel,
    getDeploymentAccessSnapshot: async () => access,
    onHostWebSocketEvent: () => () => undefined,
    onDeploymentAccessSnapshotChanged: () => () => undefined,
    onNotificationActivated: () => () => undefined,
    getLocalExecutionStatus: async () => {
      throw new Error("No local execution in this test.");
    },
    onLocalExecutionStatusChanged: () => () => undefined,
  } as unknown as OpensteerDesktopBridge;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(<DesktopApp bridge={bridge} />));
  await vi.waitFor(() => {
    expect(container.textContent).toContain("Back");
  });

  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === "Back",
  );
  expect(button).toBeDefined();
  await act(async () => button?.click());

  expect(cancel).toHaveBeenCalledOnce();
  await vi.waitFor(() => {
    expect(container.textContent).toContain("The connection could not be cancelled.");
  });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "The connection could not be cancelled.",
  );

  await act(async () => root.unmount());
  container.remove();
});

it("carries setup from creating this computer straight into the app it opens", async () => {
  let access = snapshot({
    account: { available: false, status: "signed-out" },
    personalSetup: personalStatus({
      canStart: true,
      deploymentId: null,
      name: "Studio Mac",
      state: "stopped",
      step: null,
    }),
  });
  const listeners = new Set<(next: DeploymentAccessSnapshot) => void>();
  const emit = (next: DeploymentAccessSnapshot) => {
    access = next;
    for (const listener of listeners) listener(next);
  };
  const createPersonalDeployment = vi.fn(async () => undefined);
  const bridge = {
    createPersonalDeployment,
    getDeploymentAccessSnapshot: async () => access,
    onHostWebSocketEvent: () => () => undefined,
    onDeploymentAccessSnapshotChanged: (listener: (next: DeploymentAccessSnapshot) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onNotificationActivated: () => () => undefined,
    getLocalExecutionStatus: async () => {
      throw new Error("No local execution in this test.");
    },
    onLocalExecutionStatusChanged: () => () => undefined,
  } as unknown as OpensteerDesktopBridge;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<DesktopApp bridge={bridge} />));
  await vi.waitFor(() => expect(container.textContent).toContain("Welcome to Opensteer"));
  expect(container.textContent).toContain("Studio Mac");

  // The name is chosen before setup creates anything, and setup is created with it.
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.startsWith(label),
    )!;
  await act(async () => button("Rename").click());
  const field = container.querySelector<HTMLInputElement>("#desktop-entry-name")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      field,
      "Workshop",
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => field.form!.requestSubmit());
  expect(container.textContent).toContain("Workshop");
  await act(async () => button("Set up this Mac").click());
  expect(createPersonalDeployment).toHaveBeenCalledExactlyOnceWith({ name: "Workshop" });

  // What the supervisor sends: the Deployment's id from the first step, long
  // before the list has it, and then listed before it attaches. Neither may
  // bring back the screens from before setup began.
  const personalId = createId("deployment");
  const steps = [
    { deployments: [], step: "checking-computer" as const },
    { deployments: [], step: "starting-host" as const },
    {
      deployments: [{ ...accessDeployment("idle"), ...personalSummary(personalId) }],
      step: "preparing-agent-home" as const,
    },
  ];
  for (const [index, { deployments, step }] of steps.entries()) {
    await act(async () =>
      emit(
        snapshot({
          account: { available: false, status: "signed-out" },
          deployments,
          personalSetup: personalStatus({ deploymentId: personalId, name: "Workshop", step }),
          revision: index + 2,
          selectedDeploymentId: deployments.length ? personalId : null,
        }),
      ),
    );
    await vi.waitFor(() => expect(container.textContent).toContain("Setting up this "));
    expect(container.textContent).toContain("Workshop");
    expect(container.textContent).not.toContain("Welcome to Opensteer");
    expect(container.textContent).not.toContain("Open your Opensteer");
  }

  // Ready, and the app is still attaching: setup's own frame stays up rather
  // than a separate loading screen.
  await act(async () =>
    emit(
      snapshot({
        account: { available: false, status: "signed-out" },
        deployments: [{ ...accessDeployment("connecting"), ...personalSummary(personalId) }],
        personalSetup: personalStatus({
          deploymentId: personalId,
          name: "Workshop",
          state: "ready",
          step: "ready",
        }),
        revision: 10,
        selectedDeploymentId: personalId,
      }),
    ),
  );
  await vi.waitFor(() => expect(container.textContent).toContain("Your AI"));
  expect(container.textContent).not.toContain("Opening Opensteer…");

  await act(async () => root.unmount());
  container.remove();
});

function personalSummary(id: string) {
  return DesktopDeploymentSummarySchema.parse({
    ...deployment,
    activeOrigin: "http://127.0.0.1:45000",
    canonicalOrigin: "http://127.0.0.1:45000",
    id,
    kind: "personal",
    name: "Workshop",
    onThisComputer: true,
    routes: [{ kind: "canonical", origin: "http://127.0.0.1:45000", selected: true }],
  });
}

function personalStatus(
  overrides: Partial<DesktopPersonalDeploymentStatus> = {},
): DesktopPersonalDeploymentStatus {
  return DesktopPersonalDeploymentStatusSchema.parse({
    canStart: false,
    components: {
      browser: { state: "stopped", version: null },
      host: { state: "starting", version: null },
      messaging: { state: "stopped", version: null },
      postgresql: { state: "ready", version: "18" },
      runner: { state: "stopped", version: null },
    },
    deploymentId: null,
    environmentId: null,
    issue: null,
    schemaVersion: 1,
    state: "starting",
    step: "checking-computer",
    ...overrides,
  });
}

const deployment = DesktopDeploymentSummarySchema.parse({
  activeOrigin: "https://server.example.test",
  canonicalOrigin: "https://server.example.test",
  id: createId("deployment"),
  kind: "personal",
  lastUsedAt: "2026-08-20T10:00:00.000Z",
  name: "Server",
  onThisComputer: false,
  access: "native",
  routes: [{ kind: "canonical", origin: "https://server.example.test", selected: true }],
});

function snapshot(overrides: Partial<DeploymentAccessSnapshot> = {}): DeploymentAccessSnapshot {
  return DeploymentAccessSnapshotSchema.parse({
    account: { available: true, status: "signed-out" },
    deployments: [],
    personalAccountLink: {
      account: null,
      deploymentId: null,
      displayName: null,
      status: "unavailable",
      unlinkStep: null,
    },
    personalSetup: null,
    revision: 1,
    selectedDeploymentId: null,
    ...overrides,
  });
}

describe("Desktop snapshot presentation", () => {
  it("maps fresh, picker, authorization, blocked, and ready snapshots without orchestration", () => {
    // With nothing open, the list of places (or, when there are none, the
    // welcome that shows in its place) is where a person starts.
    expect(desktopAccessPresentationFromSnapshot(snapshot())).toBe("picker");
    // A setup that failed before its Deployment was listed keeps its own
    // screen, with its reason and Try again; Welcome could not retry it.
    const unlisted = personalStatus({
      canStart: true,
      deploymentId: createId("deployment"),
      issue: {
        code: "database-unavailable",
        component: "postgresql",
        detail: "Another app is using port 5432. Quit it, then try again.",
        repairAction: "restart-opensteer",
      },
      state: "repair-required",
      step: null,
    });
    expect(desktopAccessPresentationFromSnapshot(snapshot({ personalSetup: unlisted }))).toBe(
      "personal",
    );
    // Once listed, the list's own retry and cancel apply, as for any place.
    expect(
      desktopAccessPresentationFromSnapshot(
        snapshot({
          deployments: [{ ...accessDeployment("idle"), id: unlisted.deploymentId! }],
          personalSetup: unlisted,
          selectedDeploymentId: unlisted.deploymentId!,
        }),
      ),
    ).toBe("picker");
    expect(
      desktopAccessPresentationFromSnapshot(
        snapshot({
          account: { available: true, status: "signed-in" },
        }),
      ),
    ).toBe("picker");
    expect(
      desktopAccessPresentationFromSnapshot(
        snapshot({
          deployments: [accessDeployment("connected")],
        }),
      ),
    ).toBe("picker");
    expect(
      desktopAccessPresentationFromSnapshot(
        snapshot({
          deployments: [accessDeployment("needs-sign-in")],
          selectedDeploymentId: deployment.id,
        }),
      ),
    ).toBe("verified");
    // Waiting on this Host's own browser sign-in belongs on the screen that
    // says so and offers a way out, never on the bare connecting spinner.
    expect(
      desktopAccessPresentationFromSnapshot(
        snapshot({
          deployments: [accessDeployment("authorizing")],
          selectedDeploymentId: deployment.id,
        }),
      ),
    ).toBe("verified");
    expect(
      desktopAccessPresentationFromSnapshot(
        snapshot({
          deployments: [accessDeployment("connecting")],
          selectedDeploymentId: deployment.id,
        }),
      ),
    ).toBe("waiting");
    expect(
      desktopAccessPresentationFromSnapshot(
        snapshot({
          deployments: [accessDeployment("offline")],
          selectedDeploymentId: deployment.id,
        }),
      ),
    ).toBe("blocked");
    // A cancelled attachment leaves the selected row idle, and the Directory is
    // where a person picks up again — never a spinner with nothing behind it.
    expect(
      desktopAccessPresentationFromSnapshot(
        snapshot({
          deployments: [accessDeployment("idle")],
          selectedDeploymentId: deployment.id,
        }),
      ),
    ).toBe("picker");
    expect(
      desktopAccessPresentationFromSnapshot(
        snapshot({
          deployments: [accessDeployment("needs-remote-access")],
          selectedDeploymentId: deployment.id,
        }),
      ),
    ).toBe("picker");
    expect(
      desktopAccessPresentationFromSnapshot(
        snapshot({
          deployments: [accessDeployment("connected")],
          selectedDeploymentId: deployment.id,
        }),
      ),
    ).toBe("ready");
    // An Account place whose sign-in ended waits in the list for that sign-in,
    // never on a server's own sign-in page it could not satisfy.
    expect(
      desktopAccessPresentationFromSnapshot(
        snapshot({
          account: { available: true, status: "error" },
          deployments: [{ ...accessDeployment("needs-sign-in"), source: "account" }],
          selectedDeploymentId: deployment.id,
        }),
      ),
    ).toBe("picker");
  });
});

/**
 * Only states the real ConnectionSupervisor can publish. A row waiting to sign
 * in always carries the retryable failure the supervisor attaches to it, and a
 * row this Desktop is not attached to is `idle` with nothing wrong.
 */
function accessDeployment(
  status: DeploymentAccessDeployment["status"],
): DeploymentAccessDeployment {
  const summary = deployment;
  const failure =
    status === "needs-sign-in"
      ? {
          code: "host-sign-in-required" as const,
          detail: "Sign in to this server to continue.",
          retryable: true,
        }
      : status === "offline"
        ? {
            code: "host-access-blocked" as const,
            detail: "This connection was refused.",
            retryable: false,
          }
        : null;
  return {
    ...summary,
    accountAccess: null,
    availableActions:
      status === "connecting"
        ? ["cancel"]
        : status === "authorizing"
          ? ["retry", "cancel"]
          : status === "connected" || status === "needs-remote-access"
            ? []
            : ["retry"],
    failure,
    source: "manual" as const,
    status,
    statusInfo:
      status === "needs-remote-access"
        ? { reason: `Turn on remote access on ${summary.name}.`, status: "offline" }
        : { reason: null, status: "ready" },
  };
}
