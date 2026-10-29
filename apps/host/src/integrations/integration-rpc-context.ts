import { OpensteerError } from "@opensteer/core";
import type { HostApiServerContext } from "@opensteer/protocol";

/**
 * The three guards every integration rpc handler opens with.
 *
 * The rpc scope map already refuses an unauthenticated caller before a handler
 * runs, so these read a context the router has populated; they exist to turn
 * "the type is nullable" into one refusal with one wording rather than a
 * per-handler `if`. Both integration surfaces — provider connections and the
 * MCP platform — share them so a permission is never tightened on one and left
 * loose on the other.
 */
export function requireSession(context: HostApiServerContext) {
  if (!context.session) {
    throw new OpensteerError({ code: "unauthorized", message: "Authentication required" });
  }
  return context.session;
}

export function requireAdministrator(context: HostApiServerContext): void {
  if (requireSession(context).user.instanceRole !== "administrator") {
    throw new OpensteerError({ code: "forbidden", message: "Administrator access required" });
  }
}

export function requireSurface(
  context: HostApiServerContext,
): Exclude<HostApiServerContext["surface"], null> {
  if (!context.surface) {
    throw new OpensteerError({ code: "unauthorized", message: "Request surface is unavailable" });
  }
  return context.surface;
}
