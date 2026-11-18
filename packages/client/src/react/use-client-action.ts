import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { ClientAction, ClientActionState } from "../actions/client-action.js";

export function useClientAction<I, O>(
  action: ClientAction<I, O>,
): ClientActionState<O> & {
  readonly run: ClientAction<I, O>["run"];
  readonly dismiss: () => void;
  readonly reconcile: () => Promise<void>;
} {
  const state = useSyncExternalStore(action.subscribe, action.getSnapshot, action.getSnapshot);
  return { ...state, run: action.run, dismiss: action.dismiss, reconcile: action.reconcile };
}

import { createClientActionFamily } from "../actions/client-action.js";
import type { ClientSession } from "../connections/connection-controller.js";
import { presentClientIssue } from "../feedback/client-issue.js";

const operations = new WeakMap<ClientSession, ReturnType<typeof operationFamily>>();
function operationFamily(session: ClientSession) {
  return createClientActionFamily<(signal: AbortSignal) => Promise<void>, void>(session, {
    label: "complete this action",
    execute: (work, signal) => work(signal),
  });
}
export function useClientOperation(session: ClientSession, key: string) {
  const action = useMemo(() => {
    let family = operations.get(session);
    if (!family) operations.set(session, (family = operationFamily(session)));
    return family.for(key);
  }, [session, key]);
  const state = useClientAction(action);
  const run = useCallback(
    async <T>(
      work: (signal: AbortSignal) => Promise<T>,
      _label: string,
      done?: (value: T) => void,
    ) => {
      let result: { value: T } | null = null;
      const outcome = await action.run(async (signal) => {
        result = { value: await work(signal) };
      });
      if (outcome.kind === "confirmed" && action.getSnapshot().outcome === outcome && result)
        done?.((result as { value: T }).value);
    },
    [action],
  );
  return {
    busy: state.running,
    failure: state.issue ? presentClientIssue(state.issue).title : null,
    dismiss: state.dismiss,
    run,
  };
}
