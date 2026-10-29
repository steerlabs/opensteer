import type { DesktopDeploymentSummary } from "@opensteer/protocol/desktop";
import type { HostSnapshot } from "@opensteer/client/host";
import { useShell } from "./app-shell.js";

/** The name a person gave this Deployment, or null while nothing has said it. */
export function deploymentNameFrom(
  deployment: DesktopDeploymentSummary | null,
  snapshot: Pick<HostSnapshot, "identityConfig">,
): string | null {
  return deployment?.name ?? snapshot.identityConfig?.deployment.name ?? null;
}

/** The name a person gave this Deployment, as every page that names it says it. */
export function useDeploymentName(): string {
  const { desktopDeployment, snapshot } = useShell();
  return deploymentNameFrom(desktopDeployment, snapshot) ?? "this Opensteer";
}
