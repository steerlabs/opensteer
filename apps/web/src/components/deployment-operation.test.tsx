import { createId } from "@opensteer/core";
import {
  DeploymentAccessSnapshotSchema,
  type DeploymentAccessFailure,
  type DeploymentConnectionAction,
  type DeploymentConnectionStatus,
  type DeploymentAccessSnapshot,
  type OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  DeploymentOperationBanner,
  deploymentMutationsBlockedReason,
  deploymentOperationPresentation,
} from "./deployment-operation.js";

describe("the one foreground operation", () => {
  it("shows a failure assertively, with retry and the link repair beside it", () => {
    const failed = snapshot({
      actions: ["retry", "cancel"],
      failure: {
        code: "link-journal-unusable",
        detail: "The Account link records disagree.",
        retryable: true,
      },
      repairLink: true,
      status: "offline",
    });
    const presentation = deploymentOperationPresentation(failed);
    const html = renderToStaticMarkup(
      <DeploymentOperationBanner bridge={bridge()} snapshot={failed} />,
    );

    expect(presentation).toMatchObject({ canRepairLink: true, canRetry: true, failed: true });
    expect(html).toContain('role="alert"');
    expect(html).toContain("The Account link records disagree.");
    expect(html).toContain("Try again");
    expect(html).toContain("Repair account link");
    expect(html).toContain("notice--error");
  });

  it("never offers a control the machine would refuse", () => {
    const noIntents = snapshot({
      actions: [],
      failure: { code: "host-unavailable", detail: "It did not answer.", retryable: false },
      status: "offline",
    });

    expect(deploymentOperationPresentation(noIntents)).toMatchObject({
      canCancel: false,
      canRepairLink: false,
      canRetry: false,
    });
  });

  it("explains the refusal every other mutating control is under", () => {
    expect(
      deploymentMutationsBlockedReason(
        snapshot({
          status: "connecting",
        }),
      ),
    ).toBe("Opening Test deployment. Wait for it to finish.");
    expect(
      deploymentMutationsBlockedReason(
        snapshot({
          failure: { code: "x", detail: "It did not answer.", retryable: true },
          status: "offline",
        }),
      ),
    ).toBe("Opening Test deployment needs attention. Retry or cancel it first.");
  });
});

function bridge(): OpensteerDesktopBridge {
  return {
    cancel: vi.fn(async () => undefined),
    linkPersonal: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
  } as unknown as OpensteerDesktopBridge;
}

function snapshot(input: {
  readonly actions?: readonly DeploymentConnectionAction[];
  readonly failure?: DeploymentAccessFailure | null;
  readonly repairLink?: boolean;
  readonly status?: DeploymentConnectionStatus;
}): DeploymentAccessSnapshot {
  const deploymentId = createId("deployment");
  return DeploymentAccessSnapshotSchema.parse({
    account: { available: true, status: "signed-in" },
    deployments: input.status
      ? [
          {
            access: "native",
            accountAccess: null,
            activeOrigin: "https://test.example.com",
            availableActions: input.actions ?? [],
            canonicalOrigin: "https://test.example.com",
            failure: input.failure ?? null,
            id: deploymentId,
            kind: "self-hosted",
            lastUsedAt: null,
            name: "Test deployment",
            onThisComputer: false,
            routes: [{ kind: "canonical", origin: "https://test.example.com", selected: true }],
            source: "manual",
            status: input.status,
            statusInfo: { reason: null, status: "ready" },
          },
        ]
      : [],
    directoryFailure: null,
    personalAccountLink: {
      account: null,
      deploymentId,
      displayName: null,
      status: input.repairLink ? "needs-repair" : "unlinked",
      unlinkStep: null,
    },
    personalSetup: null,
    revision: 2,
    selectedDeploymentId: input.status ? deploymentId : null,
    unavailable: [],
  });
}
