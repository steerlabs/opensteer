import type { HostSnapshot } from "./client.js";

/**
 * Whether this place is a team server: the Host offers team administration,
 * which only a team server does. Every surface reads this one answer to choose
 * its shell; it grants nothing, and each control still follows the Host's `can`.
 */
export function isTeamPlace(snapshot: Pick<HostSnapshot, "teamAdministrationAvailable">): boolean {
  return snapshot.teamAdministrationAvailable === true;
}

/**
 * Whether the place's Workspaces are still being made. A Personal place always
 * has Main, so none yet means wait; a team place may truly have no Projects
 * once its Host has said who it is.
 */
export function awaitsFirstWorkspace(
  snapshot: Pick<HostSnapshot, "teamAdministrationAvailable" | "workspaces" | "deploymentId">,
): boolean {
  if (snapshot.workspaces.length > 0) return false;
  return !(isTeamPlace(snapshot) && snapshot.deploymentId !== null);
}
