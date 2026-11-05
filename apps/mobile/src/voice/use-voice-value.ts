import { VoiceContext } from "@opensteer/client/react";
import { idleVoiceSnapshot, type VoiceSnapshot } from "@opensteer/client/voice";
import { useContext, useSyncExternalStore } from "react";

const noSubscribe = () => () => {};

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

const selectOffered = ({ available, phase }: VoiceSnapshot) => available || phase !== "idle";

/** Whether a call can be started or is under way, for a bar choosing its controls. */
export function useVoiceAvailable(): boolean {
  return useVoiceValue(selectOffered);
}

const selectOnCall = (snapshot: VoiceSnapshot) => snapshot.phase !== "idle";

export function useVoiceOn(): boolean {
  return useVoiceValue(selectOnCall);
}

const selectAskedRequest = ({ ask }: VoiceSnapshot) =>
  ask?.kind === "request" ? ask.requestId : null;

/** The Request riding on the call bar, which nothing else on screen may also show. */
export function useVoiceAskedRequest(): string | null {
  return useVoiceValue(selectAskedRequest);
}
