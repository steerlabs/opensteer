import type { VoicePhase, VoiceSnapshot } from "./contract.js";

/** What a screen reader hears; the mark and the mic say the same thing to the eye. */
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
  /** Who is talking this moment. Words stay up while the agent works on them; this does not. */
  readonly speaker: "person" | "opensteer" | null;
  /** Nothing to read, so the bar takes only the room its controls need. */
  readonly compact: boolean;
}

/**
 * Everything the call bar says, worked out once for every client: a client
 * draws this and owns nothing but how it looks.
 */
export function voiceBar(snapshot: VoiceSnapshot): VoiceBarView {
  const { heard, muted, phase, spoken } = snapshot;
  const status = muted ? "Microphone muted" : statusWords[phase];
  const speaker =
    phase === "speaking" ? "opensteer" : phase === "hearing" && !muted ? "person" : null;
  const caption =
    phase === "hearing" || phase === "thinking" ? heard : phase === "speaking" ? spoken : null;
  if (caption !== null)
    return {
      compact: false,
      live: true,
      speaker,
      status,
      tone: phase === "hearing" ? "default" : phase === "speaking" ? "soft" : "muted",
      words: caption,
    };
  const connecting = phase === "connecting";
  return {
    compact: !connecting,
    live: false,
    speaker,
    status,
    tone: "muted",
    words: connecting ? statusWords.connecting : null,
  };
}

/**
 * How wide the pill holds its words: as wide as they have been this turn, so
 * words that get rewritten never make it twitch, and shut once none are left.
 */
export function heldWords(measured: number, held: number, newTurn: boolean): number {
  return newTurn || measured === 0 ? measured : Math.max(held, measured);
}

/** The cursor's arrow on a 16 x 18 box: the one shape Voice wears, in the pill and on the move. */
export const voiceCursorPath = "M2 2 2 15.2 5.6 11.9 8.1 17.3 10.4 16.3 8 11 13 10.7Z";

/** A call's length the way a phone shows it: 0:07, 12:40, 1:02:09. */
export function callClock(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const seconds = String(total % 60).padStart(2, "0");
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}
