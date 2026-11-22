import type { AuthenticatedSession, UserId } from "@opensteer/core";
import type { HostApiServerContext } from "@opensteer/protocol";
import type { AgentCaller } from "../mcp/agent-caller.js";
import { requireSession } from "../server/rpc-context.js";

/** Only `personActor` can make a value carrying it: no other module can name this key. */
declare const heldSession: unique symbol;

/**
 * The person, proven by the signed-in session of this request. It is the only way to the owner's
 * authority: a user id alone is not a `PersonActor`, and nothing outside this module can build one.
 */
export interface PersonActor {
  readonly kind: "person";
  readonly userId: UserId;
  readonly session: AuthenticatedSession;
  readonly [heldSession]: true;
}

/** Who sends a command: the person on their session, or one of the agents the Home authenticated. */
export type Actor = PersonActor | AgentCaller;

/** The person behind this request's session; refuses a request without one. Reads nothing. */
export function personActor(context: HostApiServerContext): PersonActor {
  const session = requireSession(context);
  return { kind: "person", userId: session.user.id, session } as PersonActor;
}
