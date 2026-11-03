/** Resource authority is intersected with every applicable ceiling. */
export type ResourceAccessLevel = "read" | "read-write";

export function intersectResourceAccess(
  workspace: ResourceAccessLevel | null,
  ceiling?: ResourceAccessLevel | null,
): ResourceAccessLevel | null {
  if (workspace === null || ceiling === null) return null;
  return workspace === "read" || ceiling === "read" ? "read" : workspace;
}
