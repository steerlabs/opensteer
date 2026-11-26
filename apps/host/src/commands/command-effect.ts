import { isRaisedBeforeEffect, OpensteerError, type CommandRequestOutcome } from "@opensteer/core";
import {
  beginCommandAttempt,
  settleCommandAttempt,
  type CommandAttemptBegin,
  type CommandAttemptInput,
  type DatabaseSchema,
} from "@opensteer/database";
import {
  commandEffect,
  type CommandRow,
  type CommandType,
} from "@opensteer/protocol/command-table";
import { outsideProse } from "@opensteer/protocol/command-review";
import { PluginCommandResultSchema } from "@opensteer/protocol";
import { BrowserSignInOutcomeSchema } from "@opensteer/protocol/browser-sources";
import { isRecord } from "@opensteer/shared/isRecord";
import type { Kysely } from "kysely";

/** Where a command's attempt is recorded and settled. */
export interface CommandAttempts {
  begin(
    input: CommandAttemptInput,
    readmit?: (transaction: Kysely<DatabaseSchema>) => Promise<void>,
  ): Promise<CommandAttemptBegin>;
  settle(
    id: string,
    state: "done" | "failed" | "unknown",
    outcome?: CommandRequestOutcome,
  ): Promise<void>;
}

export function commandAttempts(database: Kysely<DatabaseSchema>): CommandAttempts {
  return {
    begin: (input, readmit) => beginCommandAttempt(database, input, readmit),
    settle: (id, state, outcome) => settleCommandAttempt(database, id, state, outcome),
  };
}

export type CommandEffectOutcome<T> =
  | { readonly status: "done"; readonly output: T; readonly receipt?: DoneReceipt }
  /** The handler confirmed it did not take effect, or it refused before effect. */
  | { readonly status: "failed"; readonly error: unknown; readonly receipt?: FailedReceipt }
  /** It may have happened: never failed, never completed, never retried by the Home. */
  | { readonly status: "unknown"; readonly error: unknown; readonly receipt?: IncompleteReceipt };

type DoneReceipt = Extract<CommandRequestOutcome, { status: "done" }>;
type FailedReceipt = Extract<CommandRequestOutcome, { status: "failed" }> & {
  readonly code: OpensteerError["code"];
};

type UnknownReceipt = Extract<CommandRequestOutcome, { status: "unknown" }>;
type IncompleteReceipt = UnknownReceipt & {
  readonly progress: NonNullable<UnknownReceipt["progress"]>;
};

type Receipt = DoneReceipt | FailedReceipt | IncompleteReceipt;
type ResultRecord = Record<string, unknown> & { readonly type: string };

function failed(
  message: string,
  result: NonNullable<FailedReceipt["result"]>,
  code: FailedReceipt["code"] = "conflict",
): FailedReceipt {
  return { status: "failed", code, message, result };
}

function incomplete(
  kind: IncompleteReceipt["progress"]["kind"],
  message: string,
): IncompleteReceipt {
  return { status: "unknown", progress: { kind, message } };
}

function chromeSignInReceipt({ type, outcome }: ResultRecord) {
  const answer = BrowserSignInOutcomeSchema.safeParse(outcome).data;
  // The delivery path throws on an uncertain cookie write. Omit the source name from the receipt.
  if (answer?.status !== "problem") return;
  return failed("The Chrome sign-in was not copied.", {
    type,
    outcome: { status: answer.status, problem: answer.problem },
  });
}

function tabCloseReceipt({ type, closed, failed: failures, groupClosed }: ResultRecord) {
  if (!Array.isArray(closed) || !Array.isArray(failures)) return;
  const closedCount = closed.length;
  const failedCount = failures.length;
  const groupRemains = type === "tab.group.close" && groupClosed === false;
  if (!failedCount && !groupRemains) return;
  const result = { type, closedCount, failedCount };
  if (!closedCount)
    return failed(
      groupRemains ? "The tab group stayed open." : "None of the requested tabs could be closed.",
      result,
    );
  const count = closedCount === 1 ? "1 tab closed." : `${closedCount} tabs closed.`;
  const remaining =
    failedCount === 0
      ? ""
      : failedCount === 1
        ? " 1 tab could not be closed."
        : ` ${failedCount} tabs could not be closed.`;
  return incomplete(
    "partial",
    `${count}${remaining}${groupRemains ? " The tab group stayed open." : ""}`,
  );
}

/**
 * The handler's explicit evidence. Arbitrary outputs may hold secrets, and a resource's nested
 * status is not necessarily evidence about the command. The schema coverage test checks this table.
 */
export const commandResultReceipts: Partial<
  Record<CommandType, (output: ResultRecord) => Receipt | undefined>
> = {
  "machine.access.update": ({ type, outcome }) =>
    outcome === "conflict"
      ? failed("The device's access settings changed before this command ran.", { type, outcome })
      : undefined,
  "browser.session.sign-in": chromeSignInReceipt,
  "browser.sign-in.respond": chromeSignInReceipt,
  "browser.password-sign-in.respond": ({ type, status }) => {
    switch (status) {
      case "declined":
        return failed("The sign-in was declined.", { type, status });
      case "pending":
        return incomplete(
          "pending",
          "The sign-in Request is still pending. Check it before trying again.",
        );
      case "cancelled":
      case "withdrawn":
        return incomplete(
          "unconfirmed",
          `The sign-in Request was ${status}. Check whether the sign-in took effect.`,
        );
      // Fulfilled is the only status that confirms completion.
      default:
        return undefined;
    }
  },
  "tab.close": tabCloseReceipt,
  "tab.group.close": tabCloseReceipt,
  "plugins.install": (output) => {
    const command = PluginCommandResultSchema.safeParse(output).data;
    if (command?.type !== "plugins.install") return undefined;
    const { type, result } = command;
    if (result.status === "build-error") {
      const message =
        outsideProse(result.message).toWellFormed() || "No build diagnostic was available.";
      return failed(
        `The plugin did not build: ${message}`.slice(0, 2_000).toWellFormed(),
        { type, result: { status: result.status, message } },
        "bad_request",
      );
    }
    const { status, pluginId, versionId } = result;
    // These are import diagnostics about omitted operations, with no account credentials.
    const warnings = result.warnings
      ?.slice(0, 16)
      .map((warning) => outsideProse(warning).slice(0, 200).toWellFormed());
    return {
      status: "done",
      result: { type, result: { status, pluginId, versionId, ...(warnings ? { warnings } : {}) } },
    };
  },
};

function commandResultReceipt(type: string, output: unknown): Receipt | undefined {
  if (!isRecord(output) || output.type !== type || !Object.hasOwn(commandResultReceipts, type))
    return undefined;
  return commandResultReceipts[type as CommandType]?.({ ...output, type });
}

/**
 * The one way a command acts, whoever asked and whether it runs now or after the person approved
 * it (G4). One with an effect outside the database is recorded first, in the same transaction as
 * its last admission (G3, `readmit`), and in the asking connection's Disconnect set; then it acts;
 * then it settles. A failed command has either the handler's explicit evidence, a refusal raised
 * before the effect, or the Home's refusal in a database-only command's transaction. A refusal
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
  const settle = async (state: "done" | "failed" | "unknown", receipt?: Receipt) => {
    if (!id || !input.attempts) return;
    const attempts = input.attempts;
    const warn = (error: unknown) =>
      console.warn("A command's attempt receipt could not be written", {
        type: input.attempt.type,
        state,
        error: error instanceof Error ? error.message : String(error),
      });
    try {
      await attempts.settle(id, state, receipt);
    } catch (error) {
      warn(error);
      (input.later ?? laterBy(30_000))(() => attempts.settle(id, state, receipt).catch(warn));
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
  const receipt = commandResultReceipt(input.attempt.type, output);
  if (receipt?.status === "failed") {
    await settle("failed", receipt);
    return {
      status: "failed",
      error: new OpensteerError({ code: receipt.code, message: receipt.message }),
      receipt,
    };
  }
  if (receipt?.status === "unknown") {
    await settle("unknown", receipt);
    return { status: "unknown", receipt, error: new Error(receipt.progress.message) };
  }
  await settle("done", receipt);
  return { status: "done", output, ...(receipt ? { receipt } : {}) };
}
