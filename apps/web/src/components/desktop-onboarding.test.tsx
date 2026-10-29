import { renderToStaticMarkup } from "react-dom/server";
import {
  DesktopDeploymentSummarySchema,
  DesktopPersonalDeploymentStatusSchema,
  type DesktopDeploymentSummary,
  type DesktopPersonalDeploymentStatus,
} from "@opensteer/protocol/desktop";
import { createId } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import {
  DesktopPersonalSetup,
  DesktopPersonalLoadFailure,
  DesktopVerifiedDeployment,
} from "./desktop-onboarding.js";

describe("Desktop Personal load failure", () => {
  it("explains the existing setup failure, keeps sign-in visible, and offers no create action", () => {
    const markup = renderToStaticMarkup(
      <DesktopPersonalLoadFailure
        accountAvailable
        detail="Personal deployment manifest is incompatible or corrupt."
        onAccount={vi.fn()}
        onAddDeployment={vi.fn()}
      />,
    );
    expect(markup).toContain("Opensteer on this computer couldn’t be loaded.");
    expect(markup).toContain("Personal deployment manifest is incompatible or corrupt.");
    expect(markup).toContain("Sign in to see your other computers");
    expect(markup).not.toContain("Use this computer");
  });
});

describe("Desktop setup state surfaces", () => {
  it("presents the verified authority before starting Host sign-in", () => {
    const verified = deployment({ name: "studio.opensteer.test" });
    const markup = renderToStaticMarkup(
      <DesktopVerifiedDeployment
        authorizing={false}
        deployment={verified}
        error={null}
        onBack={vi.fn()}
        onContinue={vi.fn()}
      />,
    );

    expect(markup).toContain("Opensteer verified this server’s identity.");
    expect(markup).toContain("Verified address");
    expect(markup).toContain(verified.canonicalOrigin);
    expect(markup).toContain("Identifier");
    expect(markup).toContain(verified.id);
    expect(markup).toContain("Continue to sign in");
  });

  it("renders a retry only when the supervisor says starting is safe", () => {
    const retryable = renderToStaticMarkup(
      <DesktopPersonalSetup
        actionError={null}
        onBack={vi.fn()}
        onRetry={vi.fn()}
        status={personalStatus({
          canStart: true,
          issue: {
            code: "database-unavailable",
            component: "postgresql",
            detail: "The private database did not become ready.",
            repairAction: "restart-opensteer",
          },
          state: "repair-required",
          step: null,
        })}
      />,
    );
    const updateRequired = renderToStaticMarkup(
      <DesktopPersonalSetup
        actionError={null}
        onBack={vi.fn()}
        onRetry={vi.fn()}
        status={personalStatus({
          canStart: false,
          issue: {
            code: "update-incompatible",
            component: "desktop",
            detail: "This deployment requires a compatible signed release.",
            repairAction: "update-opensteer",
          },
          state: "update-required",
          step: null,
        })}
      />,
    );

    expect(retryable).toContain('role="alert"');
    expect(retryable).toContain("The private database did not become ready.");
    expect(retryable).toContain("Try again");
    expect(updateRequired).toContain("Opensteer needs an update");
    expect(updateRequired).not.toContain("Try again");
    expect(updateRequired).toContain("Update or repair Opensteer");
  });
});

function personalStatus(
  overrides: Partial<DesktopPersonalDeploymentStatus> = {},
): DesktopPersonalDeploymentStatus {
  return DesktopPersonalDeploymentStatusSchema.parse({
    canStart: false,
    components: {
      browser: { state: "stopped", version: null },
      host: { state: "starting", version: "1.0.0" },
      messaging: { state: "stopped", version: null },
      postgresql: { state: "ready", version: "17.2" },
      runner: { state: "stopped", version: "1.0.0" },
    },
    deploymentId: createId("deployment"),
    environmentId: createId("environment"),
    issue: null,
    schemaVersion: 1,
    state: "starting",
    step: "starting-host",
    ...overrides,
  });
}

function deployment(
  overrides: Partial<
    Pick<DesktopDeploymentSummary, "kind" | "lastUsedAt" | "name" | "onThisComputer">
  > = {},
): DesktopDeploymentSummary {
  const id = createId("deployment");
  return DesktopDeploymentSummarySchema.parse({
    activeOrigin: `https://${id}.opensteer.test`,
    canonicalOrigin: `https://${id}.opensteer.test`,
    id,
    kind: "self-hosted",
    lastUsedAt: null,
    name: "Opensteer",
    onThisComputer: false,
    access: "connect",
    routes: [{ kind: "canonical", origin: `https://${id}.opensteer.test`, selected: true }],
    ...overrides,
  });
}
