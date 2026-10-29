// @vitest-environment happy-dom

import { createId } from "@opensteer/core";
import {
  DeploymentAccessSnapshotSchema,
  DesktopDeploymentSummarySchema,
  type DeploymentAccessSnapshot,
  type DeploymentAccessDeployment,
  type OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import {
  DesktopApp,
  cloudDeletionDisappeared,
  cloudResultBelongsToAccount,
  desktopAccessPresentationFromSnapshot,
} from "./desktop-app.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

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

it("fences Cloud responses to the Account session that requested them", () => {
  expect(cloudResultBelongsToAccount("first@example.test", "first@example.test")).toBe(true);
  expect(cloudResultBelongsToAccount("first@example.test", "second@example.test")).toBe(false);
  expect(cloudResultBelongsToAccount("first@example.test", null)).toBe(false);
});

it("detects a completed deletion when the API removes its tombstone from the list", () => {
  const deleting = {
    canonicalOrigin: "https://cloud.example.test",
    deploymentId: createId("deployment"),
    desiredState: "deleted" as const,
    error: null,
    name: "Cloud",
    operationId: crypto.randomUUID(),
    progress: null,
    status: "deleting" as const,
    updatedAt: "2026-09-05T00:00:00.000Z",
  };
  expect(cloudDeletionDisappeared([deleting], [])).toBe(true);
  expect(cloudDeletionDisappeared([deleting], [deleting])).toBe(false);
});

const deployment = DesktopDeploymentSummarySchema.parse({
  activeOrigin: "https://cloud.example.test",
  canonicalOrigin: "https://cloud.example.test",
  id: createId("deployment"),
  kind: "self-hosted",
  lastUsedAt: "2026-08-20T10:00:00.000Z",
  name: "Cloud",
  onThisComputer: false,
  access: "native",
  routes: [{ kind: "canonical", origin: "https://cloud.example.test", selected: true }],
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
