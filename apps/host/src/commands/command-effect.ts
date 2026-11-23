import { isRaisedBeforeEffect, OpensteerError } from "@opensteer/core";
import {
  beginCommandAttempt,
  settleCommandAttempt,
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
  ): Promise<string>;
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
 * at the last admission records nothing and is thrown as it is.
 */
export async function runCommandEffect<T>(input: {
  readonly row: CommandRow;
  readonly attempts: CommandAttempts | undefined;
  readonly attempt: CommandAttemptInput;
  readonly readmit?: ((transaction: Kysely<DatabaseSchema>) => Promise<void>) | undefined;
  readonly act: () => Promise<T>;
}): Promise<CommandEffectOutcome<T>> {
  const outside = commandEffect(input.row) === "outside";
  const id =
    outside && input.attempts ? await input.attempts.begin(input.attempt, input.readmit) : null;
  const settle = async (state: "done" | "failed" | "unknown") => {
    if (id && input.attempts) await input.attempts.settle(id, state);
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
