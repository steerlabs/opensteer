import type { DeploymentTone } from "../theme.js";
import { deploymentStatusLabel, type DeploymentRow } from "../client/deployment-rows.js";
import { deploymentInitial, deploymentTone } from "../screens/deployment-row.js";

/**
 * Which Deployment this is: the foot of the sidebar, and Settings' current
 * Deployment. Switching to another happens from Settings, on a screen that
 * shows each one's state, never from a shortcut a stray tap can reach.
 *
 * Everything here is derived from rows the client already publishes, so a
 * view can subscribe to this projection alone: a snapshot that changed a
 * thread's title produces an equal identity, and the view does not re-render.
 */

export interface DeploymentMark {
  /** One character: a name's first initial, or a dot when it has none. */
  readonly initial: string;
  readonly tone: DeploymentTone;
}

export interface DeploymentIdentity {
  readonly mark: DeploymentMark;
  readonly name: string;
  readonly status: string;
}

export function deploymentMark(row: {
  readonly deploymentId: string;
  readonly name: string;
}): DeploymentMark {
  return { initial: deploymentInitial(row.name), tone: deploymentTone(row.deploymentId) };
}

export function deploymentIdentity(
  rows: readonly DeploymentRow[],
  deploymentId: string,
): DeploymentIdentity {
  const current = rows.find((row) => row.deploymentId === deploymentId) ?? null;
  return {
    mark:
      current === null
        ? { initial: "•", tone: deploymentTone(deploymentId) }
        : deploymentMark(current),
    name: current?.name ?? "Deployment",
    // A Deployment that has left this phone's list is not "offline" and not
    // anything else the status vocabulary covers: it is simply gone.
    status: current === null ? "No longer on this phone" : deploymentStatusLabel(current.status),
  };
}

/**
 * Whether two identities say the same thing. The sidebar's subscription hands
 * back the previous object when they do, so an unrelated snapshot — a streaming
 * token, a thread that moved — cannot re-render it.
 */
export function sameDeploymentIdentity(
  left: DeploymentIdentity,
  right: DeploymentIdentity,
): boolean {
  return (
    left.name === right.name &&
    left.status === right.status &&
    left.mark.initial === right.mark.initial &&
    left.mark.tone === right.mark.tone
  );
}
