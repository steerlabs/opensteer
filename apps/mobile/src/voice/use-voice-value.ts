import { useVoiceOn, useVoiceValue } from "@opensteer/client/react";
import type { VoiceSnapshot } from "@opensteer/client/voice";

export { useVoiceOn, useVoiceValue };

const selectOffered = ({ available, phase }: VoiceSnapshot) => available || phase !== "idle";

/** Whether a call can be started or is under way, for a bar choosing its controls. */
export function useVoiceAvailable(): boolean {
  return useVoiceValue(selectOffered);
}

const selectAskedRequest = ({ ask }: VoiceSnapshot) =>
  ask?.kind === "request" ? ask.requestId : null;

/** The Request riding on the call bar, which nothing else on screen may also show. */
export function useVoiceAskedRequest(): string | null {
  return useVoiceValue(selectAskedRequest);
}
