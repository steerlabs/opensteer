import { z } from "zod";
/** Resource authority is intersected with every applicable ceiling. */
export const ResourceAccessLevelSchema = z.enum(["read", "read-write"]);
export type ResourceAccessLevel = z.infer<typeof ResourceAccessLevelSchema>;

export function intersectResourceAccess(
  grant: ResourceAccessLevel | null,
  ceiling?: ResourceAccessLevel | null,
): ResourceAccessLevel | null {
  if (grant === null || ceiling === null) return null;
  return grant === "read" || ceiling === "read" ? "read" : grant;
}
