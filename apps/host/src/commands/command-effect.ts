import { isRaisedBeforeEffect, OpensteerError } from "@opensteer/core";
import {
  beginCommandAttempt,
  settleCommandAttempt,
  type CommandAttemptBegin,
  type CommandAttemptInput,
  type DatabaseSchema,
} from "@opensteer/database";
import { commandEffect, type CommandRow } from "@opensteer/protocol/command-table";
import type { Kysely } from "kysely";

/** Where a command's attempt is recorded and settled. */
export interface CommandAttempts {
  begin(
    input: CommandAttemptInput,
    readmit?: (transaction: Kysely<DatabaseSchema>) => Promise<void>,
  ): Promise<CommandAttemptBegin>;
  settle(id: string, state: "done" | "failed" | "unknown"): Promise<void>;
}

export function commandAttempts(database: Kysely<DatabaseSchema>): CommandAttempts {
  return {
    begin: (input, readmit) => beginCommandAttempt(database, input, readmit),
    settle: (id, state) => settleCommandAttempt(database, id, state),
  };
}

export type CommandEffectOutcome<T> =
  | { readonly status: "done"; readonly output: T }
  /** Nothing happened: refused where it was raised, before anything was sent. */
  | { readonly status: "failed"; readonly error: unknown }
  /** It may have happened: never failed, never completed, never retried by the Home. */
  | { readonly status: "unknown"; readonly error: unknown };

/**
 * The one way a command acts, whoever asked and whether it runs now or after the person approved
 * it (G4). One with an effect outside the database is recorded first, in the same transaction as
 * its last admission (G3, `readmit`), and in the asking connection's Disconnect set; then it acts;
 * then it settles: done, failed only when the error was raised before the effect (or the Home's
 * own refusal inside a database-only command's one transaction), and otherwise unknown. A refusal
 * at the last admission records nothing and is thrown as it is. The same key again (K1) is
 * unknown without acting while its attempt runs or once it may have happened; done, the handler's
 * own lookup replays it.
 */
/**
 * Runs one piece of work later, once, its failure handled by the work itself: a timer in the
 * Home, a hand the test turns, so no test races the clock.
 */
export type LaterWork = (work: () => Promise<unknown>) => void;

/** A Home's own later: once, after `ms`, never holding the process open. */
export function laterBy(ms: number): LaterWork {
  return (work) => {
    const timer = setTimeout(() => void work(), ms);
    timer.unref?.();
  };
}

export async function runCommandEffect<T>(input: {
  readonly row: CommandRow;
  readonly attempts: CommandAttempts | undefined;
  readonly attempt: CommandAttemptInput;
  readonly readmit?: ((transaction: Kysely<DatabaseSchema>) => Promise<void>) | undefined;
  readonly act: () => Promise<T>;
  /** Runs a lost attempt receipt's one later write (default: after 30 seconds). */
  readonly later?: LaterWork;
}): Promise<CommandEffectOutcome<T>> {
  const outside = commandEffect(input.row) === "outside";
  const begun =
    outside && input.attempts ? await input.attempts.begin(input.attempt, input.readmit) : null;
  // One key, one attempt (K1): one that is running or may have happened is not sent again.
  if (begun?.kind === "prior" && begun.state !== "done")
    return { status: "unknown", error: new Error(`An attempt with this key is ${begun.state}`) };
  // One that is done is replayed by the handler's own lookup, with no second attempt.
  const id = begun?.kind === "begun" ? begun.id : null;
  // The attempt's receipt of what is already known: if it cannot be written, the caller is still
  // told what happened (rule 4), never an error for an effect that ran. Until it is written the
  // attempt reads as "may have happened" to anything that asks it, so nothing runs twice; it is
  // written once more a little later, so the row reaches its known outcome without a restart
  // (and a Disconnect waiting on it is not held until then). If that one later write fails too,
  // the row stays `running` until the Home's startup recovery settles it `unknown`: still true to
  // rule 4 (it may have happened, and nothing runs it again), and to rule 3 (a Disconnect waiting
  // on it shows no end until there is evidence). No retry loop.
  const settle = async (state: "done" | "failed" | "unknown") => {
    if (!id || !input.attempts) return;
    const attempts = input.attempts;
    const warn = (error: unknown) =>
      console.warn("A command's attempt receipt could not be written", {
        type: input.attempt.type,
        state,
        error: error instanceof Error ? error.message : String(error),
      });
    try {
      await attempts.settle(id, state);
    } catch (error) {
      warn(error);
      (input.later ?? laterBy(30_000))(() => attempts.settle(id, state).catch(warn));
    }
  };
  let output: T;
  try {
    output = await input.act();
  } catch (error) {
    const failed = isRaisedBeforeEffect(error) || (!outside && error instanceof OpensteerError);
    await settle(failed ? "failed" : "unknown");
    return failed ? { status: "failed", error } : { status: "unknown", error };
  }
  await settle("done");
  return { status: "done", output };
}
