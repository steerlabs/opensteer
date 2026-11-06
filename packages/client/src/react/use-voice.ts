import { createContext, useContext, useSyncExternalStore } from "react";
import { idleVoiceSnapshot, type VoiceControls, type VoiceSnapshot } from "../voice/contract.js";

export const VoiceContext = createContext<VoiceControls | null>(null);

const noSubscribe = () => () => {};
const idleSnapshot = () => idleVoiceSnapshot;

export function useVoice() {
  const controller = useContext(VoiceContext);
  const snapshot = useSyncExternalStore(
    controller?.subscribe ?? noSubscribe,
    controller?.getSnapshot ?? idleSnapshot,
  );
  return { controller, snapshot };
}

/**
 * One fact of the call. Captions publish a snapshot per token, so a screen
 * selects a primitive and redraws only when that fact changes.
 */
export function useVoiceValue<Value extends boolean | number | string | object | null>(
  select: (snapshot: VoiceSnapshot) => Value,
): Value {
  const controller = useContext(VoiceContext);
  const read = () => select(controller?.getSnapshot() ?? idleVoiceSnapshot);
  return useSyncExternalStore(controller?.subscribe ?? noSubscribe, read, read);
}

const selectOnCall = ({ phase }: VoiceSnapshot) => phase !== "idle";

/** Whether a call is under way, for a screen that must not redraw with its words. */
export function useVoiceOn(): boolean {
  return useVoiceValue(selectOnCall);
}
