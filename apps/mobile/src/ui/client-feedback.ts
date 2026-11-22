import {
  createClientAction,
  type ActionOutcome,
  type ClientAction,
  type ClientActionSpec,
  type ClientActionState,
} from "@opensteer/client/actions";
import {
  classifyClientFailure,
  ClientOperationError,
  type ClientSession,
} from "@opensteer/client/connections";
import {
  clientIssue,
  clientIssueActions,
  presentClientIssue,
  type ClientIssue,
} from "@opensteer/client/feedback";
import { useClientAction, useClientRead } from "@opensteer/client/react";
import {
  createClientRead,
  type ClientReadSpec,
  type ClientReadState,
} from "@opensteer/client/reads";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NativeSettingsFooter } from "../screens/native-settings-page.types.js";
import type { ActionLineValue } from "./action-line.js";

/**
 * How a screen says what its own reads and actions came to, beside them:
 * never the connection, which the shell says.
 */

/**
 * An outcome as its line: muted and felt as a warning when it never went out
 * or can't be confirmed, danger and felt as an error when refused.
 */
export function issueLine(
  issue: ClientIssue,
  key: string,
  link?: ActionLineValue["link"],
): ActionLineValue {
  const refused = issue.code === "rejected" || issue.code === "storage-unavailable";
  return {
    haptic: refused ? "error" : "warning",
    key,
    link: link ?? null,
    text: presentClientIssue(issue).title,
    tone: refused ? "danger" : "muted",
  };
}

/**
 * What a screen says about its own read: nothing while waiting or once
 * anything arrived, unless the person asked for a refresh that failed; one
 * line with Try again only when nothing ever loaded.
 */
export function readLine(
  state: ClientReadState<unknown>,
  retry: () => void,
): ActionLineValue | null {
  if (state.issue === null) return null;
  if (state.status === "ready" && state.issue.code !== "refresh-failed") return null;
  const link =
    presentClientIssue(state.issue).action === "retry"
      ? { label: clientIssueActions.tryAgain, onPress: retry }
      : null;
  // A read's line is said, never felt: nobody tapped for it.
  return { ...issueLine(state.issue, `${state.status}:${state.issue.code}`, link), haptic: null };
}

/**
 * One action's outcome as a line beside its control: not done because it was
 * never sent, couldn't confirm (with Check, when something can check), or
 * refused. A check that found it undone offers Try again.
 */
export function actionLine(
  state: Pick<ClientActionState<unknown>, "outcome" | "issue">,
  links: { readonly check?: (() => void) | undefined; readonly retry?: (() => void) | undefined },
  key = "",
): ActionLineValue | null {
  const { outcome, issue } = state;
  if (outcome === null || outcome.kind === "confirmed" || issue === null) return null;
  const action = presentClientIssue(issue).action;
  const link =
    action === "check" && links.check
      ? { label: clientIssueActions.check, onPress: links.check }
      : action === "retry" && links.retry
        ? { label: clientIssueActions.tryAgain, onPress: links.retry }
        : null;
  const line = issueLine(issue, `${key}:${outcome.kind}:${issue.code}:${issue.reason ?? ""}`, link);
  // Any refusal is said as one, whatever the Host's reason.
  return outcome.kind === "rejected" ? { ...line, haptic: "error", tone: "danger" } : line;
}

/**
 * One tap's work, run once with an honest outcome: not sent when known out
 * of reach before anything went out, refused with its reason, or couldn't
 * confirm when the answer was lost.
 */
export async function actOnce<T>(
  session: ClientSession,
  words: ActionWords,
  work: () => Promise<T>,
): Promise<ActionOutcome<T>> {
  const action = createClientAction<undefined, T>(session, {
    key: `once:${words.label}`,
    ...words,
    execute: () => work(),
  });
  try {
    return await action.run(undefined);
  } finally {
    action.dispose();
  }
}

/** An outcome as the line beside the control that asked; null once it worked. */
export function outcomeLine(outcome: ActionOutcome<unknown>): ActionLineValue | null {
  if (outcome.kind === "confirmed") return null;
  const line = actionLine({ outcome, issue: outcome.issue }, {});
  // Each outcome is said once, even when it repeats the last one's words.
  return line && { ...line, key: `${line.key}:${++serial}` };
}

/** The same line as a native settings section's footer. */
export function settingsFooter(line: ActionLineValue | null): NativeSettingsFooter | undefined {
  if (line === null) return undefined;
  return {
    text: line.text,
    ...(line.tone === "danger" ? { tone: "danger" as const } : {}),
    link: line.link ? { label: line.link.label, onPress: line.link.onPress } : null,
  };
}

/**
 * Known before anything is sent: this session can't reach its Home right
 * now, so `done` ("opened") won't happen. Null when it can.
 */
export function unreadyIssue(session: ClientSession, done: string): ClientIssue | null {
  const state = session.connection.getSnapshot();
  if (state.phase === "ready" && state.network !== "offline") return null;
  return {
    code: "not-sent",
    done,
    reason: state.network === "offline" ? "offline" : "unreachable",
    target: state.target,
    ...(state.name ? { name: state.name } : {}),
  };
}

/** A reconcile's answer when a check found the action was not done: "Not {done}." */
export function notDone(done?: string): ActionOutcome<never> {
  return { kind: "not-sent", issue: { code: "not-sent", ...(done ? { done } : {}) } };
}

/** A refusal an answer carried inside a success, such as one tab of several not closing. */
export function refusal(reason: string, message: string): ClientOperationError {
  return new ClientOperationError(message, "blocked", {
    kind: "rejection",
    provenance: "host",
    reason,
    retryable: false,
  });
}

/** An action as the presenter says it: "close this tab", "closed", "this tab closed". */
export interface ActionWords {
  readonly label: string;
  readonly done?: string;
  readonly happened?: string;
}

/**
 * What work a screen ran itself came to, in the presenter's words for that
 * action; null when it was cancelled. A refusal or a failure on this device
 * says the screen's own sentence, `own`, where it has one; a lost answer or
 * the connection's state is always the presenter's.
 */
export function failureWords(error: unknown, words: ActionWords, own?: string): string | null {
  const issue = clientIssue(error, { operation: "action", label: words.label });
  if (issue === null) return null;
  if (own !== undefined && ownsFailure(error)) return own;
  return presentClientIssue({
    ...issue,
    ...(words.done ? { done: words.done } : {}),
    ...(words.happened ? { happened: words.happened } : {}),
  }).title;
}

const ownsFailure = (error: unknown): boolean =>
  ["rejection", "local", "unexpected"].includes(classifyClientFailure(error).kind);

/** The same, as a line beside the control: danger when refused or failed here. */
export function failureLine(
  error: unknown,
  words: ActionWords,
  key: string,
  own?: string,
): ActionLineValue | null {
  const text = failureWords(error, words, own);
  if (text === null) return null;
  const danger = ownsFailure(error) && classifyClientFailure(error).kind !== "unexpected";
  return {
    haptic: danger ? "error" : "warning",
    key: `${key}:${++serial}`,
    text,
    tone: danger ? "danger" : "muted",
  };
}

/**
 * One screen read through the shared read owner: retained through outages,
 * reloaded on recovery, failed only when nothing ever arrived. `read` may
 * change every render; `key` names what is read.
 */
export function useScreenRead<T>(
  session: ClientSession | null,
  spec: Omit<ClientReadSpec<T>, "read"> & {
    readonly read: ((signal: AbortSignal) => Promise<T>) | null;
  },
): ClientReadState<T> & { readonly refresh: () => void } {
  const read = useRef(spec.read);
  read.current = spec.read;
  const invalidation = useRef(spec.subscribeInvalidation);
  invalidation.current = spec.subscribeInvalidation;
  const enabled = spec.read !== null;
  const watches = spec.subscribeInvalidation !== undefined;
  const resource = useMemo(
    () =>
      session && enabled
        ? createClientRead<T>(session, {
            key: spec.key,
            label: spec.label,
            ...(spec.remember === undefined ? {} : { remember: spec.remember }),
            read: (signal) => read.current!(signal),
            ...(watches
              ? { subscribeInvalidation: (listener) => invalidation.current?.(listener) ?? noop }
              : {}),
          })
        : null,
    [session, enabled, spec.key, spec.label, spec.remember, watches],
  );
  return useClientRead(resource);
}

/** An action's words and work; both may change, and a run uses the latest. */
export type ScreenActionSpec<I, O> = Omit<ClientActionSpec<I, O>, "key">;
interface HeldAction {
  readonly action: ClientAction<unknown, unknown>;
  spec: ScreenActionSpec<unknown, unknown>;
  observers: number;
  sweep: ReturnType<typeof setTimeout> | null;
  disposed: boolean;
}
// Keyed by session and item, so a row's outcome outlives the menu or sheet that asked.
const heldActions = new WeakMap<ClientSession, Map<string, HeldAction>>();
/** Unwatched outcomes awaiting a Check that a session keeps; the oldest go first. */
const keptUnwatched = 32;

function heldAction<I, O>(
  session: ClientSession,
  key: string,
  spec: ScreenActionSpec<I, O>,
): HeldAction {
  let held = heldActions.get(session);
  if (!held) heldActions.set(session, (held = new Map()));
  let entry = held.get(key);
  if (!entry) {
    const holder: { current: HeldAction | null } = { current: null };
    // Words are read from the latest spec, never frozen at the key's first use.
    const action = createClientAction<unknown, unknown>(session, {
      key,
      get label() {
        return holder.current!.spec.label;
      },
      // Empty is unsaid: the action adds only the words it has.
      get done() {
        return holder.current!.spec.done ?? "";
      },
      get happened() {
        return holder.current!.spec.happened ?? "";
      },
      execute: (input, signal) => holder.current!.spec.execute(input, signal),
      reconcile: (input, signal) =>
        holder.current!.spec.reconcile?.(input, signal) ?? Promise.resolve(null),
    });
    const created: HeldAction = {
      action,
      spec: spec as ScreenActionSpec<unknown, unknown>,
      observers: 0,
      sweep: null,
      disposed: false,
    };
    holder.current = entry = created;
    held.set(key, created);
    action.subscribe(() => scheduleSweep(session, key, created));
    // Nothing may ever watch or run it; a later task lets the caller do either first.
    scheduleSweep(session, key, created);
  }
  return entry;
}

/** A place showing the entry's outcome: while any is mounted, the entry stays. */
function observe(session: ClientSession, key: string, entry: HeldAction): () => void {
  entry.observers += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.observers -= 1;
    scheduleSweep(session, key, entry);
  };
}

// A task later, so React's development remount and a run started right after
// `screenAction` both land before the entry is judged unwatched.
function scheduleSweep(session: ClientSession, key: string, entry: HeldAction): void {
  if (entry.disposed || entry.sweep !== null) return;
  entry.sweep = setTimeout(() => {
    entry.sweep = null;
    sweep(session, key, entry);
  }, 0);
}

function awaitsCheck(entry: HeldAction): boolean {
  const state = entry.action.getSnapshot();
  return (
    state.outcome?.kind === "unconfirmed" &&
    state.issue !== null &&
    entry.spec.reconcile !== undefined
  );
}

function sweep(session: ClientSession, key: string, entry: HeldAction): void {
  const held = heldActions.get(session);
  if (entry.disposed || held?.get(key) !== entry) return;
  if (entry.observers > 0 || entry.action.getSnapshot().running) return;
  if (!awaitsCheck(entry)) {
    release(held, key, entry);
    return;
  }
  // Newest last, so the bound drops the oldest unwatched outcome.
  held.delete(key);
  held.set(key, entry);
  const unwatched = [...held].filter(
    ([, other]) => other.observers === 0 && !other.action.getSnapshot().running,
  );
  for (const [oldKey, old] of unwatched.slice(0, Math.max(0, unwatched.length - keptUnwatched)))
    release(held, oldKey, old);
}

function release(held: Map<string, HeldAction>, key: string, entry: HeldAction): void {
  entry.disposed = true;
  if (entry.sweep !== null) clearTimeout(entry.sweep);
  entry.sweep = null;
  held.delete(key);
  entry.action.dispose();
}

/**
 * The action on one item (`key` names it: "tab-action:close:<tabId>"), for a
 * menu that runs it while the item's row says how it went.
 */
export function screenAction<I, O>(
  session: ClientSession,
  key: string,
  spec: ScreenActionSpec<I, O>,
): ClientAction<I, O> {
  const entry = heldAction(session, key, spec);
  entry.spec = spec as ScreenActionSpec<unknown, unknown>;
  return entry.action as ClientAction<I, O>;
}

/**
 * A place showing one item's outcome outside React, as `useScreenAction`
 * holds it: the action stays while watched, running, or awaiting a Check.
 */
export function observeScreenAction<I, O>(
  session: ClientSession,
  key: string,
  spec: ScreenActionSpec<I, O>,
): { readonly action: ClientAction<I, O>; readonly release: () => void } {
  const entry = heldAction(session, key, spec);
  entry.spec = spec as ScreenActionSpec<unknown, unknown>;
  return { action: entry.action as ClientAction<I, O>, release: observe(session, key, entry) };
}

/** How long a line saying an action never went out stays, unless tapped again first. */
const notSentMs = 6_000;

/**
 * One action on one item, with its outcome as a line. Not-sent goes after
 * 6 s or when the place showing it goes; a lost answer stays until a check
 * (`reconcile`, by Check or on recovery) settles it, or, when nothing can
 * check it, until the place goes. A refusal stays until dismissed or retried.
 */
export function useScreenAction<I, O>(
  session: ClientSession | null,
  key: string,
  spec: ScreenActionSpec<I, O> & { readonly retry?: () => void },
): {
  readonly line: ActionLineValue | null;
  readonly running: boolean;
  readonly state: ClientActionState<O>;
  readonly run: (input: I) => Promise<ActionOutcome<O>>;
  readonly dismiss: () => void;
  /** Settles an unconfirmed outcome from what the client now holds, as Check does. */
  readonly reconcile: () => Promise<void>;
} {
  const [generation, renew] = useState(0);
  const entry = useMemo(
    () => (session === null ? null : heldAction(session, key, spec)),
    // The spec's words and callbacks are refreshed below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, key, generation],
  );
  if (entry !== null) entry.spec = spec as ScreenActionSpec<unknown, unknown>;
  const action = (entry?.action ?? idleAction) as ClientAction<I, O>;
  const state = useClientAction(action);
  const checkable = spec.reconcile !== undefined;
  const kind = state.outcome?.kind ?? null;
  const { dismiss } = action;
  useEffect(() => {
    if (kind !== "not-sent" || state.issue === null) return;
    const timer = setTimeout(dismiss, notSentMs);
    return () => clearTimeout(timer);
  }, [dismiss, kind, state.issue]);
  const kept = useRef(false);
  kept.current = kind === "unconfirmed" && checkable;
  useEffect(() => {
    if (session === null || entry === null) return;
    // Released while this render waited to commit: hold a fresh one.
    if (entry.disposed) {
      renew((value) => value + 1);
      return;
    }
    const unobserve = observe(session, key, entry);
    return () => {
      if (!kept.current) entry.action.dismiss();
      unobserve();
    };
  }, [session, key, entry]);
  const retry = spec.retry;
  const { reconcile } = action;
  const line = useMemo(
    () =>
      actionLine(
        state,
        { check: checkable ? () => void reconcile() : undefined, retry },
        `${key}:${outcomeSerial(state.outcome)}`,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.outcome, state.issue, checkable, reconcile, retry, key],
  );
  const run = useCallback((input: I) => action.run(input), [action]);
  return { line, running: state.running, state, run, dismiss, reconcile };
}

// Each outcome is said and felt once, even when its words repeat the last one's.
const serials = new WeakMap<object, number>();
let serial = 0;
function outcomeSerial(outcome: ActionOutcome<unknown> | null): number {
  if (outcome === null) return 0;
  let value = serials.get(outcome);
  if (value === undefined) serials.set(outcome, (value = ++serial));
  return value;
}

const noop = () => {};
const notSentOutcome = { kind: "not-sent", issue: null } as const;
const noSession = {
  key: "",
  running: false,
  outcome: null,
  issue: null,
} satisfies ClientActionState<never>;
const idleAction: ClientAction<unknown, unknown> = {
  getSnapshot: () => noSession,
  subscribe: () => noop,
  preflight: () => null,
  run: () => Promise.resolve(notSentOutcome),
  reconcile: () => Promise.resolve(),
  dismiss: noop,
  dispose: noop,
};
