import {
  createClientAction,
  type ActionOutcome,
  type ClientAction,
} from "@opensteer/client/actions";
import type { ClientConnectionState, ClientSession } from "@opensteer/client/connections";
import {
  clientIssue,
  clientIssueActions,
  presentClientIssue,
  type ClientIssue,
} from "@opensteer/client/feedback";
import { useClientAction } from "@opensteer/client/react";
import { useEffect, useMemo, useRef } from "react";

/**
 * Work that never leaves this device or the Desktop app beside it (a local
 * bridge call, a file read), so there is no connection to be unready.
 */
const localState: ClientConnectionState = {
  phase: "ready",
  network: "unknown",
  visibility: "foreground",
  scope: { authorityKey: "local", deploymentId: "local", viewerId: "local", loginId: "local" },
  epoch: 0,
  readyRevision: 1,
  showInterruption: false,
  issue: null,
  trying: false,
  pathRevision: 0,
  lastConnectedAt: null,
  name: null,
  target: "computer",
  route: null,
};
export const localSession: ClientSession = {
  connection: {
    getSnapshot: () => localState,
    subscribe: () => () => {},
    retry: () => {},
  },
};

/** One action's outcome, said beside the control that asked for it. */
export interface ActionLineValue {
  /** Changes for each new outcome: it is announced once per key. */
  readonly key: string;
  readonly text: string;
  readonly tone: "muted" | "danger";
  readonly link?: {
    readonly label: string;
    readonly accessibilityLabel?: string;
    readonly onPress: () => void;
  } | null;
}

export interface ActionSpec<I, O> {
  /** The whole verb phrase, for "Couldn't {label}." when refused without a reason: "close this tab". */
  readonly label: string;
  /** Its past tense, for "Not {done}. You're offline." */
  readonly done?: string;
  /** The full clause for "Couldn't confirm {happened}." after a lost answer: "this tab closed". */
  readonly happened?: string;
  readonly execute: (input: I, signal: AbortSignal) => Promise<O>;
  readonly reconcile?: (input: I, signal: AbortSignal) => Promise<ActionOutcome<O> | null>;
}

/** How long a "Not sent" line stays when nothing else clears it. */
const notSentMs = 6_000;

/**
 * One action a screen offers, run through the shared action owner so its
 * outcome is honest (not sent, refused, or unconfirmed), and said in one line
 * beside the control that asked for it. Leaving the screen clears the line.
 */
export function useAction<I = void, O = unknown>(
  session: ClientSession | null,
  spec: ActionSpec<I, O>,
  key = spec.label,
): {
  readonly run: (input: I) => Promise<ActionOutcome<O>>;
  readonly running: boolean;
  readonly outcome: ActionOutcome<O> | null;
  readonly line: ActionLineValue | null;
  readonly dismiss: () => void;
} {
  const current = useRef(spec);
  current.current = spec;
  // A `Refusal` the work threw is said in its own words, beside the control.
  const refused = useRef<Refusal | null>(null);
  const owner = session ?? localSession;
  const action: ClientAction<I, O> = useMemo(
    () =>
      createClientAction<I, O>(owner, {
        key,
        label: spec.label,
        ...(spec.done ? { done: spec.done } : {}),
        ...(spec.happened ? { happened: spec.happened } : {}),
        execute: async (input, signal) => {
          try {
            return await current.current.execute(input, signal);
          } catch (error) {
            if (error instanceof Refusal) refused.current = error;
            throw error;
          }
        },
        reconcile: (input, signal) =>
          current.current.reconcile?.(input, signal) ?? Promise.resolve(null),
      }),
    // The copy is fixed per key; the work always runs as last rendered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [owner, key],
  );
  useDisposedWithView(action);
  const state = useClientAction(action);
  const notSent = state.outcome?.kind === "not-sent" && state.issue !== null;
  useEffect(() => {
    if (!notSent) return;
    const timer = setTimeout(action.dismiss, notSentMs);
    return () => clearTimeout(timer);
  }, [action, notSent, state.outcome]);
  const line = useMemo(
    () =>
      state.issue === null
        ? null
        : refused.current
          ? {
              ...actionLine(state.issue, null),
              text: refused.current.words,
              tone: "danger" as const,
            }
          : actionLine(state.issue, spec.reconcile ? () => void action.reconcile() : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [action, state.issue, spec.reconcile === undefined],
  );
  const run = useMemo(
    () => (input: I) => {
      refused.current = null;
      action.dismiss();
      return action.run(input);
    },
    [action],
  );
  return {
    run,
    running: state.running,
    outcome: state.outcome,
    line,
    dismiss: action.dismiss,
  };
}

let lineKey = 0;
const lineKeys = new WeakMap<ClientIssue, string>();

/** One outcome as the line beside its control: refusals in danger, everything else muted. */
export function actionLine(issue: ClientIssue, check: (() => void) | null): ActionLineValue {
  let key = lineKeys.get(issue);
  if (key === undefined) lineKeys.set(issue, (key = String(++lineKey)));
  const said = presentClientIssue(issue);
  return {
    key,
    text: said.title,
    tone: issue.code === "rejected" ? "danger" : "muted",
    link:
      said.action === "check" && check !== null
        ? { label: clientIssueActions.check, onPress: check }
        : null,
  };
}

/**
 * Runs one action through the shared action owner, for a flow whose own
 * state shows the result: known-unready is not sent at all, a refusal keeps
 * the Host's reason, and a lost answer is never called a failure.
 */
export async function runAction<O>(
  session: ClientSession | null,
  spec: Omit<ActionSpec<void, O>, "execute" | "reconcile"> & {
    readonly execute: (signal: AbortSignal) => Promise<O>;
  },
): Promise<ActionOutcome<O>> {
  const caught: { refusal: Refusal | null } = { refusal: null };
  const action = createClientAction<void, O>(session ?? localSession, {
    key: spec.label,
    label: spec.label,
    ...(spec.done ? { done: spec.done } : {}),
    ...(spec.happened ? { happened: spec.happened } : {}),
    execute: async (_input, signal) => {
      try {
        return await spec.execute(signal);
      } catch (error) {
        if (error instanceof Refusal) caught.refusal = error;
        throw error;
      }
    },
  });
  try {
    const outcome = await action.run(undefined);
    if (caught.refusal && outcome.kind !== "confirmed") refusals.set(outcome, caught.refusal.words);
    return outcome;
  } finally {
    action.dispose();
  }
}

/** The app's own words for an outcome its work refused with a `Refusal`. */
const refusals = new WeakMap<ActionOutcome<unknown>, string>();

/** The words for an outcome that wasn't confirmed; null when it was, or there is nothing to say. */
export function outcomeWords(outcome: ActionOutcome<unknown>): string | null {
  if (outcome.kind === "confirmed") return null;
  const refused = refusals.get(outcome);
  if (refused !== undefined) return refused;
  return outcome.issue === null ? null : presentClientIssue(outcome.issue).title;
}

/** A read's own failure, in its own words: never the connection's. */
export function readWords(issue: ClientIssue | null | undefined): string | null {
  return issue ? presentClientIssue(issue).title : null;
}

/** For an action whose control is gone by the time it answers: only then a toast. */
export function toastOutcome(toast: { readonly error: (message: string) => void }) {
  return (outcome: ActionOutcome<unknown>): void => {
    const words = outcomeWords(outcome);
    if (words) toast.error(words);
  };
}

/**
 * One read a screen makes for itself. Its failure is said only when the
 * connection is fine ("Couldn't load {resource}."); while the connection is
 * the cause, the pill says so and the read says nothing.
 */
export async function runRead<T>(
  session: ClientSession | null,
  spec: { readonly resource: string; readonly read: () => Promise<T> },
): Promise<
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly words: string | null }
> {
  try {
    return { ok: true, value: await spec.read() };
  } catch (error) {
    const state = session?.connection.getSnapshot();
    if (state && (state.phase !== "ready" || state.network === "offline"))
      return { ok: false, words: null };
    const issue = clientIssue(error, { operation: "read", label: spec.resource });
    return { ok: false, words: issue ? presentClientIssue(issue).title : null };
  }
}

/**
 * A refusal this app decides and words itself ("This conversation changed while
 * you were choosing. Choose again."). Only these words reach the screen; an
 * arbitrary exception's text never does.
 */
export class Refusal extends Error {
  readonly words: string;
  constructor(words: string) {
    super(words);
    this.name = "Refusal";
    this.words = words;
  }
}

/** An action the shared owner did not confirm, carried through a promise chain. */
export class ActionNotDone extends Error {
  readonly outcome: ActionOutcome<unknown>;
  constructor(outcome: ActionOutcome<unknown>) {
    super("The action was not confirmed.");
    this.name = "ActionNotDone";
    this.outcome = outcome;
  }
}

/**
 * `runAction` for a promise chain: resolves with the confirmed value, or
 * rejects with `ActionNotDone`, whose words `failureWords` gives.
 */
export async function act<O>(
  session: ClientSession | null,
  spec: Omit<ActionSpec<void, O>, "execute" | "reconcile">,
  execute: (signal: AbortSignal) => Promise<O>,
): Promise<O> {
  const outcome = await runAction(session, { ...spec, execute });
  if (outcome.kind === "confirmed") return outcome.value;
  throw new ActionNotDone(outcome);
}

/**
 * What to say for a rejection from `act`. Anything else, such as a refresh
 * failing after the action was confirmed, says nothing: it never turns a
 * confirmed action into a failure, and never shows an exception's text.
 */
export function failureWords(reason: unknown): string | null {
  if (reason instanceof Refusal) return reason.words;
  return reason instanceof ActionNotDone ? outcomeWords(reason.outcome) : null;
}

/** `failureWords` as a toast, for an action whose control is gone by its answer. */
export function toastFailure(toast: { readonly error: (message: string) => void }) {
  return (reason: unknown): void => {
    const words = failureWords(reason);
    if (words) toast.error(words);
  };
}

/** The Host's own reason code for refusing an `act`, for a screen that words its refusals itself. */
export function refusalReason(reason: unknown): string | null {
  return reason instanceof ActionNotDone &&
    reason.outcome.kind === "rejected" &&
    reason.outcome.issue?.reason &&
    reason.outcome.issue.reason !== "unexpected"
    ? reason.outcome.issue.reason
    : null;
}

/**
 * A toast for a failure whose control is gone, from work that did not run
 * through `act`: classified once by the shared presenter, never its own text.
 */
export function toastError(
  toast: { readonly error: (message: string) => void },
  label = "do this",
) {
  return (reason: unknown): void => {
    if (reason instanceof ActionNotDone || reason instanceof Refusal) {
      toastFailure(toast)(reason);
      return;
    }
    const issue = clientIssue(reason, { operation: "action", label });
    if (issue) toast.error(presentClientIssue(issue).title);
  };
}

const pendingDisposals = new WeakMap<object, ReturnType<typeof setTimeout>>();

/**
 * Disposes a memoized owner when its view really leaves. React's development
 * double mount runs the cleanup and mounts again at once, so disposal waits a
 * task and a remount in between keeps the owner alive.
 */
export function useDisposedWithView(owner: { dispose(): void }): void {
  useEffect(() => {
    clearTimeout(pendingDisposals.get(owner));
    pendingDisposals.delete(owner);
    return () => {
      pendingDisposals.set(
        owner,
        setTimeout(() => {
          pendingDisposals.delete(owner);
          owner.dispose();
        }, 0),
      );
    };
  }, [owner]);
}

/** Answering a Request: "Not sent. You're offline." before it goes, the Host's reason after. */
export const requestAnswer = {
  label: "send your answer",
  done: "sent",
  happened: "your answer was sent",
} as const;

/**
 * A failure that didn't run through `act`, said by the shared presenter:
 * a refusal with the Host's safe reason where it has one, otherwise an honest
 * "couldn't". Never the exception's own text.
 */
export function presentFailure(reason: unknown, label = "do this", done?: string): string {
  if (reason instanceof Refusal) return reason.words;
  if (reason instanceof ActionNotDone) return outcomeWords(reason.outcome) ?? "";
  const issue = clientIssue(reason, { operation: "action", label });
  return issue ? presentClientIssue({ ...issue, ...(done ? { done } : {}) }).title : "";
}
