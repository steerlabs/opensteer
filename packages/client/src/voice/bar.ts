import type { VoicePhase, VoiceSnapshot } from "./contract.js";

/** What a screen reader hears; the orb says the same thing to the eye. */
const statusWords: Record<VoicePhase, string> = {
  idle: "",
  connecting: "Connecting",
  listening: "Listening",
  hearing: "Listening",
  thinking: "Working",
  speaking: "Speaking",
};

export interface VoiceBarView {
  /** The call's state in a word, for assistive technology. */
  readonly status: string;
  /** The one line of words the bar shows; null when it shows none. */
  readonly words: string | null;
  /** Live words are someone talking; the rest is the bar saying how it stands. */
  readonly live: boolean;
  readonly tone: "default" | "soft" | "muted";
}

/**
 * Everything the call bar says, worked out once for every client: a client
 * draws this and owns nothing but how it looks.
 */
export function voiceBar(snapshot: VoiceSnapshot): VoiceBarView {
  const { heard, muted, phase, spoken } = snapshot;
  const status = muted ? "Microphone muted" : statusWords[phase];
  const caption =
    phase === "hearing" || phase === "thinking" ? heard : phase === "speaking" ? spoken : null;
  if (caption !== null)
    return {
      live: true,
      status,
      tone: phase === "hearing" ? "default" : phase === "speaking" ? "soft" : "muted",
      words: caption,
    };
  return {
    live: false,
    status,
    tone: "muted",
    words: muted
      ? "Muted"
      : phase === "listening" || phase === "connecting"
        ? statusWords[phase]
        : null,
  };
}
