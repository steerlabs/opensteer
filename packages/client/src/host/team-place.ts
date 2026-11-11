import type { HostSnapshot } from "./client.js";

/**
 * Whether this place is a team server: the Host offers team administration,
 * which only a team server does. Every surface reads this one answer to choose
 * its shell; it grants nothing, and each control still follows the Host's `can`.
 */
export function isTeamPlace(snapshot: Pick<HostSnapshot, "teamAdministrationAvailable">): boolean {
  return snapshot.teamAdministrationAvailable === true;
}
