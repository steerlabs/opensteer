import {
  createClientAction,
  type ActionOutcome,
  type ClientAction,
} from "@opensteer/client/actions";
import type { ClientSession } from "@opensteer/client/connections";
import { ClientOperationError } from "@opensteer/client/connections";
import { useClientAction } from "@opensteer/client/react";
import { useCallback, useEffect, useMemo } from "react";
import { issueLine, type ActionLineValue } from "./action-line-value.js";

type Work = () => Promise<unknown>;

/** The words an action's outcome is said in: "Not closed", "Couldn't close this tab". */
export interface ItemActionWords {
  /** The verb, as "Couldn't {label} {thing}" says it. */
  readonly label: string;
  /** Its past tense, as "Not {done}" and "Couldn't confirm {thing} {done}" say it. */
  readonly done: string;
  readonly thing: string;
}

const actions = new WeakMap<ClientSession, Map<string, ClientAction<Work, unknown>>>();

/**
 * One action on one item (a tab, a group), shared by the menu that runs it
 * and the row that says how it went: its outcome outlives the menu. The same
 * key always carries the same words.
 */
export function itemAction(
  session: ClientSession,
  key: string,
  words: ItemActionWords,
): ClientAction<Work, unknown> {
  let held = actions.get(session);
  if (held === undefined) actions.set(session, (held = new Map()));
  let action = held.get(key);
  if (action === undefined) {
    action = createClientAction<Work, unknown>(session, {
      ...words,
      execute: (work) => work(),
      key,
    });
    held.set(key, action);
  }
  return action;
}

const serials = new WeakMap<object, number>();
let serial = 0;
function outcomeSerial(outcome: ActionOutcome<unknown> | null): number {
  if (outcome === null) return 0;
  let value = serials.get(outcome);
  if (value === undefined) serials.set(outcome, (value = ++serial));
  return value;
}

/** How long a line saying an action never went out stays, unless tapped again first. */
const notSentMs = 6_000;

/**
 * An item action as a control and its line beside it. A line that it never
 * went out clears after a moment; any line clears when the place showing it
 * goes. A refusal stays until dismissed or tried again.
 */
export function useItemAction(
  session: ClientSession,
  key: string,
  words: ItemActionWords,
): {
  readonly run: (work: Work) => Promise<ActionOutcome<unknown>>;
  readonly running: boolean;
  readonly line: ActionLineValue | null;
  readonly dismiss: () => void;
} {
  // Words are constants per key, so the action is found again, never remade.
  const action = useMemo(() => itemAction(session, key, words), [key, session, words]);
  const state = useClientAction(action);
  const notSent = state.outcome?.kind === "not-sent" && state.issue !== null;
  useEffect(() => {
    if (!notSent) return;
    const timer = setTimeout(action.dismiss, notSentMs);
    return () => clearTimeout(timer);
  }, [action, notSent, state.outcome]);
  useEffect(() => () => action.dismiss(), [action]);
  const run = useCallback((work: Work) => action.run(work), [action]);
  const line = useMemo(
    () =>
      state.issue === null
        ? null
        : issueLine(state.issue, `${key}:${outcomeSerial(state.outcome)}`),
    [key, state.issue, state.outcome],
  );
  return { dismiss: action.dismiss, line, run, running: state.running };
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
