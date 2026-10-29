import type { HostSnapshot } from "./client.js";
import type { RecentSitesScope } from "./recent-sites.js";

/** Who the snapshot is read as: a deployment's signed-in person, or nobody. */
export function viewerScopeOf(
  snapshot: Pick<HostSnapshot, "deploymentId" | "session" | "user">,
): RecentSitesScope | null {
  return snapshot.session === "authenticated" && snapshot.deploymentId && snapshot.user
    ? { deploymentId: snapshot.deploymentId, userId: snapshot.user.id }
    : null;
}

/**
 * The authority an answer was asked under. Its generation moves only when
 * the signed-in person or deployment does, so an answer the Host granted to
 * someone else is never adopted; clearing this device's recent sites is not
 * a change of authority.
 */
export class ViewerScope {
  #key = "";
  #generation = 0;
  get generation(): number {
    return this.#generation;
  }
  /** Whether this is another viewer than the last one. */
  change(scope: RecentSitesScope | null): boolean {
    const key = scope ? JSON.stringify([scope.deploymentId, scope.userId]) : "";
    if (key === this.#key) return false;
    this.#key = key;
    this.#generation += 1;
    return true;
  }
}
