import { createId } from "@opensteer/core";
import {
  DeploymentAccessSnapshotSchema,
  DesktopDeploymentSummarySchema,
  type DeploymentAccessSnapshot,
  type DesktopDeploymentSummary,
} from "@opensteer/protocol/desktop";
import { describe, expect, it, vi } from "vitest";
import {
  acceptDesktopDeploymentSelection,
  chooseDeployment,
  deploymentPanelEntries,
} from "./desktop-deployment-selection.js";

function deployment(overrides: Partial<DesktopDeploymentSummary> = {}): DesktopDeploymentSummary {
  const origin = overrides.canonicalOrigin ?? "https://cloud.example.com";
  return DesktopDeploymentSummarySchema.parse({
    activeOrigin: origin,
    canonicalOrigin: origin,
    id: createId("deployment"),
    kind: "self-hosted",
    lastUsedAt: null,
    name: "Opensteer Cloud",
    access: "native",
    onThisComputer: false,
    routes: [{ kind: "canonical", origin, selected: true }],
    ...overrides,
  });
}

function snapshot(
  deployments: readonly DesktopDeploymentSummary[],
  overrides: Partial<DeploymentAccessSnapshot> = {},
): DeploymentAccessSnapshot {
  return DeploymentAccessSnapshotSchema.parse({
    account: { available: true, status: "signed-in" },
    deployments: deployments.map((item) => ({
      accountAccess: "member",
      availableActions: ["select"],
      failure: null,
      ...item,
      source: "account",
      status: "connected",
      statusInfo: { reason: null, status: "ready" },
    })),
    directoryFailure: null,
    personalAccountLink: {
      account: null,
      deploymentId: null,
      displayName: null,
      status: "unavailable",
      unlinkStep: null,
    },
    personalSetup: null,
    revision: 1,
    selectedDeploymentId: deployments[0]?.id ?? null,
    unavailable: [],
    ...overrides,
  });
}

describe("Desktop deployment snapshot presentation", () => {
  it("keeps the newest revision", () => {
    const current = snapshot([deployment()], { revision: 4 });
    const stale = snapshot([deployment()], { revision: 3 });
    expect(acceptDesktopDeploymentSelection(current, stale)).toBe(current);
    expect(acceptDesktopDeploymentSelection(null, stale)).toBe(stale);
  });

  it("sorts panel entries by recency and uses the attached fallback", () => {
    const recent = deployment({ lastUsedAt: "2026-08-15T10:00:00.000Z", name: "Recent" });
    const older = deployment({ lastUsedAt: "2026-08-01T10:00:00.000Z", name: "Older" });
    expect(deploymentPanelEntries(snapshot([older, recent]), null).map(({ name }) => name)).toEqual(
      ["Recent", "Older"],
    );
    // Before the first snapshot the attached place is still on its way in.
    expect(deploymentPanelEntries(null, recent)).toEqual([
      {
        ...recent,
        // A summary carries no Account relation, so the fallback row offers no
        // Account-listing action.
        accountAccess: null,
        availableActions: [],
        failure: null,
        source: recent.onThisComputer ? "this-device" : "manual",
        status: "connecting",
        statusInfo: { reason: null, status: "starting" },
      },
    ]);
  });

  it("returns the refusal instead of swallowing it into a silent no-op", async () => {
    const select = vi.fn(async () => {
      throw new Error("Deployment access intent is not valid now: select-deployment");
    });

    await expect(chooseDeployment({ select }, createId("deployment"))).resolves.toEqual({
      ok: false,
      reason: "Deployment access intent is not valid now: select-deployment",
    });
  });
});
