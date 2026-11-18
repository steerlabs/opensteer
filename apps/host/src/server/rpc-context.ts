import { OpensteerError } from "@opensteer/core";
import type { HostApiServerContext } from "@opensteer/protocol";

/**
 * The guards rpc handlers open with. The rpc scope map already refuses an
 * unauthenticated caller before a handler runs; these turn "the type is
 * nullable" into one refusal with one wording rather than a per-handler `if`.
 */
export function requireSession(context: HostApiServerContext) {
  if (!context.session) {
    throw new OpensteerError({ code: "unauthorized", message: "Authentication required" });
  }
  return context.session;
}

export async function requirePersonalSession(
  context: HostApiServerContext,
  store: { assertOwner(ownerId: import("@opensteer/core").UserId): Promise<void> },
) {
  const session = requireSession(context);
  await store.assertOwner(session.user.id);
  return session;
}

export function requireSurface(
  context: HostApiServerContext,
): Exclude<HostApiServerContext["surface"], null> {
  if (!context.surface) {
    throw new OpensteerError({ code: "unauthorized", message: "Request surface is unavailable" });
  }
  return context.surface;
}
