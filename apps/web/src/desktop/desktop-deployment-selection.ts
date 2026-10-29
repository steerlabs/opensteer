import type {
  DeploymentAccessDeployment,
  DeploymentAccessSnapshot,
  DesktopDeploymentSummary,
  DesktopSelectDeploymentInput,
  OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";
import type { DeploymentStatusInfo } from "@opensteer/protocol/deployment-status";
import { actionErrorMessage } from "../ui-utils.js";

export function acceptDesktopDeploymentSelection(
  current: DeploymentAccessSnapshot | null,
  next: DeploymentAccessSnapshot,
): DeploymentAccessSnapshot {
  return current !== null && next.revision <= current.revision ? current : next;
}

export function deploymentPanelEntries(
  snapshot: DeploymentAccessSnapshot | null,
  fallback: DesktopDeploymentSummary | null,
): readonly DeploymentAccessDeployment[] {
  const deployments = snapshot?.deployments ?? [];
  if (deployments.length > 0) {
    return [...deployments].sort((left, right) => {
      const used = Date.parse(right.lastUsedAt ?? "") - Date.parse(left.lastUsedAt ?? "");
      return Number.isNaN(used) || used === 0 ? left.name.localeCompare(right.name) : used;
    });
  }
  // Before the first snapshot arrives, the attached Deployment is the only
  // entry we can honestly present, and it is still on its way in.
  return fallback
    ? [
        {
          ...fallback,
          // The attached summary carries no Account relation, and a row whose
          // relation is unknown offers no Account-listing action.
          accountAccess: null,
          availableActions: [],
          failure: null,
          source: fallback.onThisComputer ? "this-device" : "manual",
          status: "connecting",
          statusInfo: { reason: null, status: "starting" },
        },
      ]
    : [];
}

export function selectedDeploymentFrom(
  snapshot: DeploymentAccessSnapshot | null,
  fallback: DesktopDeploymentSummary | null,
): DesktopDeploymentSummary | null {
  const selected = snapshot?.deployments.find(({ id }) => id === snapshot.selectedDeploymentId);
  return selected ? desktopSummaryFromAccess(selected) : fallback;
}

export function desktopSummaryFromAccess(
  deployment: DeploymentAccessDeployment,
): DesktopDeploymentSummary {
  return {
    access: deployment.access,
    activeOrigin: deployment.activeOrigin,
    canonicalOrigin: deployment.canonicalOrigin,
    id: deployment.id,
    kind: deployment.kind,
    lastUsedAt: deployment.lastUsedAt,
    name: deployment.name,
    onThisComputer: deployment.onThisComputer,
    routes: deployment.routes,
  };
}

/**
 * What one row says. The Desktop already derived what the owning authority
 * knows about the place; this only adds what *this* app's own attachment is
 * doing on top of it, so a stack that is degraded on this computer still reads
 * as needing attention even while the connection to it is perfectly live.
 */
export function deploymentConnectionStatusInfo(
  deployment: DeploymentAccessDeployment,
): DeploymentStatusInfo {
  if (deployment.failure) return { reason: deployment.failure.detail, status: "attention" };
  if (deployment.status === "connecting") return { reason: null, status: "starting" };
  if (deployment.status === "authorizing") {
    return { reason: "Finish signing in in your browser.", status: "starting" };
  }
  return deployment.statusInfo;
}

/**
 * The outcome of asking the Desktop to attach to another deployment.
 *
 * Selecting can be refused — another operation already holds the machine, the
 * entry went away, the Host would not answer — and the refusal used to be
 * swallowed into `false`, which left the popover open with no explanation and
 * nothing to read. The reason travels back so the caller can show it.
 */
type ChooseDeploymentResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

export async function chooseDeployment(
  bridge: Pick<OpensteerDesktopBridge, "select">,
  deploymentId: DesktopSelectDeploymentInput["deploymentId"],
): Promise<ChooseDeploymentResult> {
  try {
    await bridge.select({ deploymentId });
    return { ok: true };
  } catch (reason) {
    return { ok: false, reason: actionErrorMessage(reason) };
  }
}
