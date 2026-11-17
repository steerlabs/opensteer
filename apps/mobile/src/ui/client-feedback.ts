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
import { useCallback, useEffect, useMemo, useRef } from "react";
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
 * Known before anything is sent: this session can't reach its computer or
 * team right now, so `done` ("opened") won't happen. Null when it can.
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

/** A reconcile's answer when a check found the action was not done. */
export function notDone(spec: {
  readonly label: string;
  readonly done?: string;
}): ActionOutcome<never> {
  return {
    kind: "not-sent",
    issue: { code: "not-sent", action: spec.label, ...(spec.done ? { done: spec.done } : {}) },
  };
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

/** An action's words and work; the words are fixed per key, the callbacks may change. */
export type ScreenActionSpec<I, O> = Omit<ClientActionSpec<I, O>, "key">;
interface HeldAction {
  readonly action: ClientAction<unknown, unknown>;
  spec: ScreenActionSpec<unknown, unknown>;
}
// Keyed by session and item, so a row's outcome outlives the menu or sheet that asked.
const heldActions = new WeakMap<ClientSession, Map<string, HeldAction>>();

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
    const action = createClientAction<unknown, unknown>(session, {
      key,
      label: spec.label,
      ...(spec.done ? { done: spec.done } : {}),
      ...(spec.happened ? { happened: spec.happened } : {}),
      execute: (input, signal) => holder.current!.spec.execute(input, signal),
      reconcile: (input, signal) =>
        holder.current!.spec.reconcile?.(input, signal) ?? Promise.resolve(null),
    });
    entry = { action, spec: spec as ScreenActionSpec<unknown, unknown> };
    holder.current = entry;
    held.set(key, entry);
  }
  return entry;
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
} {
  const entry = useMemo(
    () => (session === null ? null : heldAction(session, key, spec)),
    // The spec's words are fixed per key; its callbacks are refreshed below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, key],
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
  useEffect(
    () => () => {
      if (!kept.current) action.dismiss();
    },
    [action],
  );
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
  return { line, running: state.running, state, run, dismiss };
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
