import { z } from "zod";
/** Resource authority is intersected with every applicable ceiling. */
export const ResourceAccessLevelSchema = z.enum(["read", "read-write"]);
export type ResourceAccessLevel = z.infer<typeof ResourceAccessLevelSchema>;

export function intersectResourceAccess(
  workspace: ResourceAccessLevel | null,
  ceiling?: ResourceAccessLevel | null,
): ResourceAccessLevel | null {
  if (workspace === null || ceiling === null) return null;
  return workspace === "read" || ceiling === "read" ? "read" : workspace;
}
