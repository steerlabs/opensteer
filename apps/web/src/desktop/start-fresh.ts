import type {
  DesktopPersonalOldDataState,
  OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";
import { useCallback, useEffect, useReducer } from "react";

/**
 * Whether this window offers Start fresh, and where that stands. Only a
 * Personal Host the supervisor reports as needing repair is asked about old
 * data; only data the desktop names is offered; a failed reset offers it again
 * with the reason, and a successful one relaunches the app, so `starting` is
 * the last state this window shows.
 */
export type StartFreshState =
  | { readonly phase: "idle" }
  | { readonly phase: "checking" }
  | { readonly phase: "none" }
  | {
      readonly phase: "offer";
      readonly data: DesktopPersonalOldDataState;
      readonly error: string | null;
    }
  | { readonly phase: "starting"; readonly data: DesktopPersonalOldDataState };

export type StartFreshEvent =
  | { readonly type: "repair-required"; readonly required: boolean }
  | { readonly type: "read"; readonly data: DesktopPersonalOldDataState | null }
  | { readonly type: "start" }
  | { readonly type: "failed"; readonly error: string };

export function startFreshReducer(state: StartFreshState, event: StartFreshEvent): StartFreshState {
  switch (event.type) {
    case "repair-required":
      if (!event.required) return state.phase === "starting" ? state : { phase: "idle" };
      return state.phase === "idle" ? { phase: "checking" } : state;
    case "read":
      if (state.phase !== "checking") return state;
      return event.data ? { phase: "offer", data: event.data, error: null } : { phase: "none" };
    case "start":
      return state.phase === "offer" ? { phase: "starting", data: state.data } : state;
    case "failed":
      return state.phase === "starting"
        ? { phase: "offer", data: state.data, error: event.error }
        : state;
  }
}

type ResetBridge = Pick<OpensteerDesktopBridge, "personalDataReset">;

/** Reads old data while the Personal Host needs repair, and runs Start fresh once asked. */
export function useStartFresh(
  bridge: ResetBridge,
  repairRequired: boolean,
): { readonly state: StartFreshState; readonly startFresh: () => void } {
  const reset = bridge.personalDataReset;
  const [state, dispatch] = useReducer(startFreshReducer, { phase: "idle" });
  const required = repairRequired && reset !== undefined;
  useEffect(() => dispatch({ type: "repair-required", required }), [required]);
  const checking = state.phase === "checking";
  useEffect(() => {
    if (!checking || !reset) return;
    let live = true;
    reset.oldData().then(
      (data) => live && dispatch({ type: "read", data }),
      // Unreadable is not old data: the ordinary repair screen stands.
      () => live && dispatch({ type: "read", data: null }),
    );
    return () => {
      live = false;
    };
  }, [checking, reset]);
  const startFresh = useCallback(() => {
    if (!reset || state.phase !== "offer") return;
    dispatch({ type: "start" });
    reset.startFresh().catch((reason: unknown) =>
      dispatch({
        type: "failed",
        error: reason instanceof Error ? reason.message : "Opensteer couldn’t start fresh.",
      }),
    );
  }, [reset, state.phase]);
  return { state, startFresh };
}
