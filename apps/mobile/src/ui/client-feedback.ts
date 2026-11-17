import {
  createClientAction,
  type ActionOutcome,
  type ClientAction,
  type ClientActionSpec,
  type ClientActionState,
} from "@opensteer/client/actions";
import type { ClientSession } from "@opensteer/client/connections";
import { clientIssueActions, presentClientIssue } from "@opensteer/client/feedback";
import { useClientAction, useClientRead } from "@opensteer/client/react";
import {
  createClientRead,
  type ClientReadSpec,
  type ClientReadState,
} from "@opensteer/client/reads";
import { useEffect, useMemo, useRef } from "react";
import type { NativeSettingsFooter } from "../screens/native-settings-page.types.js";
import type { ActionLineValue } from "./action-line.js";

/**
 * What a screen says about its own read: nothing while waiting or once
 * anything arrived, unless the person asked for a refresh that failed; one
 * line with Try again only when nothing ever loaded. Never the connection.
 */
export function readLine(
  state: ClientReadState<unknown>,
  retry: () => void,
): ActionLineValue | null {
  if (state.issue === null) return null;
  if (state.status === "ready" && state.issue.code !== "refresh-failed") return null;
  const copy = presentClientIssue(state.issue);
  return {
    key: `${state.status}:${state.issue.code}`,
    text: copy.title,
    tone: "muted",
    link: copy.action === "retry" ? { label: clientIssueActions.tryAgain, onPress: retry } : null,
  };
}

/**
 * One action's outcome as a line beside its control: not done because it was
 * never sent, couldn't confirm (with Check), or refused (danger, dismissed by a
 * tap). A check that found it undone offers Try again.
 */
export function actionLine(
  state: ClientActionState<unknown>,
  links: { readonly check?: (() => void) | undefined; readonly retry?: (() => void) | undefined },
): ActionLineValue | null {
  const { outcome, issue } = state;
  if (outcome === null || outcome.kind === "confirmed" || issue === null) return null;
  const copy = presentClientIssue(issue);
  const link =
    copy.action === "check" && links.check
      ? { label: clientIssueActions.check, onPress: links.check }
      : copy.action === "retry" && links.retry
        ? { label: clientIssueActions.tryAgain, onPress: links.retry }
        : null;
  return {
    key: `${outcome.kind}:${issue.code}:${issue.reason ?? ""}`,
    text: copy.title,
    tone: outcome.kind === "rejected" ? "danger" : "muted",
    link,
    haptic: outcome.kind === "rejected" ? "error" : "warning",
  };
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

type ScreenActionSpec<I, O> = Omit<ClientActionSpec<I, O>, "key">;
interface HeldAction {
  readonly action: ClientAction<unknown, unknown>;
  spec: ScreenActionSpec<unknown, unknown>;
}
// Keyed by session and entity, so a row's outcome outlives the menu or sheet that asked.
const heldActions = new WeakMap<ClientSession, Map<string, HeldAction>>();
const noSession = {
  key: "",
  running: false,
  outcome: null,
  issue: null,
} satisfies ClientActionState<never>;
const notSentOutcome = { kind: "not-sent", issue: null } as const;

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
      ...(spec.thing ? { thing: spec.thing } : {}),
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
 * One action on one thing (`key` names it: "archive:<taskId>"), with its
 * outcome as a line. Not-sent goes after 6 s or when the screen goes; a lost
 * answer stays until Check (`reconcile`) settles it.
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
  const state = useClientAction(entry?.action ?? idleAction) as ClientActionState<O> &
    ReturnType<typeof useClientAction>;
  const kind = state.outcome?.kind ?? null;
  const dismiss = state.dismiss;
  useEffect(() => {
    if (kind !== "not-sent" || state.issue === null) return;
    const timer = setTimeout(dismiss, 6_000);
    return () => clearTimeout(timer);
  }, [dismiss, kind, state.issue]);
  const latest = useRef(kind);
  latest.current = kind;
  useEffect(
    () => () => {
      if (latest.current !== "unconfirmed") entry?.action.dismiss();
    },
    [entry],
  );
  const retry = spec.retry;
  const line = useMemo(
    () => actionLine(state, { check: () => void state.reconcile(), retry }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.outcome, state.issue, state.reconcile, retry],
  );
  return {
    line,
    running: state.running,
    state,
    run: (input: I) =>
      entry === null
        ? Promise.resolve(notSentOutcome)
        : (entry.action.run(input) as Promise<ActionOutcome<O>>),
    dismiss,
  };
}

const noop = () => {};
const idleAction: ClientAction<unknown, unknown> = {
  getSnapshot: () => noSession,
  subscribe: () => noop,
  preflight: () => null,
  run: () => Promise.resolve(notSentOutcome),
  reconcile: () => Promise.resolve(),
  dismiss: noop,
  dispose: noop,
};
