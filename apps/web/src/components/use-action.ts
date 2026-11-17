import {
  createClientAction,
  type ActionOutcome,
  type ClientAction,
} from "@opensteer/client/actions";
import type { ClientConnectionState, ClientSession } from "@opensteer/client/connections";
import {
  clientIssueActions,
  presentClientIssue,
  type ClientIssue,
} from "@opensteer/client/feedback";
import { useClientAction } from "@opensteer/client/react";
import { useEffect, useMemo, useRef } from "react";
import type { ActionLineValue } from "./action-line.js";

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

export interface ActionSpec<I, O> {
  /** What the action is, for "Couldn't {label}." when it is refused without a reason. */
  readonly label: string;
  /** Its past tense, for "Not {done}. You're offline." */
  readonly done?: string;
  /** What it acts on, for "Couldn't confirm {thing} {done}." */
  readonly thing?: string;
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
  const owner = session ?? localSession;
  const action: ClientAction<I, O> = useMemo(
    () =>
      createClientAction<I, O>(owner, {
        key,
        label: spec.label,
        ...(spec.done ? { done: spec.done } : {}),
        ...(spec.thing ? { thing: spec.thing } : {}),
        execute: (input, signal) => current.current.execute(input, signal),
        reconcile: (input, signal) =>
          current.current.reconcile?.(input, signal) ?? Promise.resolve(null),
      }),
    // The copy is fixed per key; the work always runs as last rendered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [owner, key],
  );
  useEffect(() => () => action.dispose(), [action]);
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
        : actionLine(state.issue, spec.reconcile ? () => void action.reconcile() : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [action, state.issue, spec.reconcile === undefined],
  );
  const run = useMemo(
    () => (input: I) => {
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
