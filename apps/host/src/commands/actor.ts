import type { AuthenticatedSession, UserId } from "@opensteer/core";
import type { DatabaseSchema } from "@opensteer/database";
import type { Kysely } from "kysely";
import type { HostApiServerContext } from "@opensteer/protocol";
import type { AgentCaller } from "../mcp/agent-caller.js";
import { requireSession } from "../server/rpc-context.js";

/** Only `personActor` can make a value carrying it: no other module can name this key. */
declare const heldSession: unique symbol;

/** The command Request an approval answers: which one, at which revision, proposed by whom. */
export interface CommandProposal {
  readonly requestId: string;
  readonly revision: string;
  /** Who proposed it, as the Request recorded it; written to the command's ledger row. */
  readonly proposedBy: Readonly<Record<string, unknown>>;
  /**
   * The proposer's admission, run again in the transaction that makes the change, where the store
   * takes one (a tab group's close, rename or delete): it refuses when the proposer could no
   * longer ask for it, as a tab added to the group meanwhile that it does not hold.
   */
  readonly readmit?: (transaction: Kysely<DatabaseSchema>) => Promise<void>;
}

/**
 * The person, proven by the signed-in session of this request. It is the only way to the owner's
 * authority: a user id alone is not a `PersonActor`, and nothing outside this module can build one,
 * in types (the key above) or at runtime (the set below).
 */
export interface PersonActor {
  readonly kind: "person";
  readonly userId: UserId;
  readonly session: AuthenticatedSession;
  /** Set only when the person approves an agent's command Request. */
  readonly proposal?: CommandProposal;
  readonly [heldSession]: true;
}

/** Who sends a command: the person on their session, or one of the agents the Home authenticated. */
export type Actor = PersonActor | AgentCaller;

/** Every person's actor this module made, and only those: a copy or a cast is not among them. */
const madeHere = new WeakSet<object>();

/** The person behind this request's session; refuses a request without one. Reads nothing. */
export function personActor(
  context: HostApiServerContext,
  proposal?: CommandProposal,
): PersonActor {
  const session = requireSession(context);
  const actor = Object.freeze({
    kind: "person",
    userId: session.user.id,
    session,
    ...(proposal ? { proposal } : {}),
  }) as PersonActor;
  madeHere.add(actor);
  return actor;
}

/** Whether this is a person's actor `personActor` made, not one shaped like it. */
export function isPersonActor(actor: unknown): actor is PersonActor {
  return typeof actor === "object" && actor !== null && madeHere.has(actor);
}
