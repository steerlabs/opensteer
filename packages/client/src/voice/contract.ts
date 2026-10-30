import type { WorkspaceSurfaceDestination } from "../host/surfaces.js";

/**
 * Voice is an input and output mode of the person's client, like dictation.
 * A call can only do what this client already does: send the person's words
 * to Chat, change what the screen shows, and tell the person things. The
 * vendor sits behind `VoiceProvider`; the platform behind `VoiceMediaPort`.
 */

/** The platform's microphone and WebRTC; null where it has none. */
export interface VoiceMediaPort {
  /** Asks for the microphone on first use; rejects with a `NotAllowedError` when refused. */
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  createPeerConnection(configuration?: RTCConfiguration): RTCPeerConnection;
  /** Plays the far end's audio until the returned function is called. */
  playRemote(stream: MediaStream): () => void;
  /** Why voice cannot run here at all, such as an insecure page; null when it can. */
  unavailableReason(): VoiceUnavailableReason | null;
  openMicrophoneSettings?(): void;
  /** Keeps the screen on while a call runs, where the platform would sleep it. */
  keepAwake?(on: boolean): void;
}

export type VoiceUnavailableReason = "insecure-context" | "unsupported";

/** What happens on a call, in vendor-neutral terms. */
export type VoiceCallEvent =
  /** The person is talking; `text` is what has been recognized so far. */
  | { readonly type: "hearing"; readonly text: string }
  /** The person finished an utterance. `turnId` is unique within the call. */
  | { readonly type: "heard"; readonly turnId: string; readonly text: string }
  /** The voice is talking; `text` is what it has said so far this turn. */
  | { readonly type: "speaking"; readonly text: string }
  /** The voice finished talking. */
  | { readonly type: "spoke" }
  /** Microphone and voice loudness, 0 to 1, for meters. */
  | { readonly type: "level"; readonly input: number; readonly output: number }
  /** The call is over and can do nothing further. */
  | { readonly type: "closed"; readonly reason: VoiceEndReason };

export type VoiceEndReason =
  | "stopped"
  | "connection-lost"
  | "replaced"
  | "expired"
  | "refused"
  | "failed";

export interface VoiceCall {
  /** Has the voice tell the person this. Resolves when accepted, not when spoken. */
  say(text: string): Promise<void>;
  setMuted(muted: boolean): void;
  /** Ends the call and releases the microphone. Idempotent. */
  close(): Promise<void>;
}

export interface VoiceProvider {
  /** Opens a call. Rejects with `VoiceStartError` when it cannot start. */
  open(input: {
    readonly signal: AbortSignal;
    readonly onEvent: (event: VoiceCallEvent) => void;
  }): Promise<VoiceCall>;
}

/** Why a call could not start, in terms the person can act on. */
export type VoiceStartFailure =
  | "permission-denied"
  | "microphone-unavailable"
  | "insecure-context"
  | "no-account"
  | "update-computer"
  | "update-codex"
  | "refused"
  | "connection-failed";

export class VoiceStartError extends Error {
  readonly failure: VoiceStartFailure;
  constructor(failure: VoiceStartFailure, options?: { cause?: unknown }) {
    super(`Voice could not start: ${failure}`, options);
    this.name = "VoiceStartError";
    this.failure = failure;
  }
}

/** Where a spoken "show me …" takes the person. The app maps it to its own navigation. */
export type VoiceTarget =
  | { readonly kind: "chat" }
  | { readonly kind: "back" }
  | { readonly kind: "thread"; readonly threadId: string }
  | { readonly kind: "place"; readonly destination: WorkspaceSurfaceDestination };

export type VoicePhase =
  | "idle"
  | "connecting"
  /** On and waiting for the person. */
  | "listening"
  /** The person is talking. */
  | "hearing"
  /** Chat is working on what the person asked. */
  | "thinking"
  /** The voice is talking. */
  | "speaking";

export type VoiceNoticeKind = VoiceStartFailure | "ended" | "idle" | "connection-lost";

export interface VoiceNotice {
  readonly kind: VoiceNoticeKind;
  readonly message: string;
  readonly action: "open-settings" | null;
}

export interface VoiceSnapshot {
  /** Show the voice button: the Host serves voice and this person has an account for it. */
  readonly available: boolean;
  readonly phase: VoicePhase;
  readonly muted: boolean;
  /** The person's live or most recent utterance, for captions. */
  readonly heard: string | null;
  /** What the voice is saying now, or said last, for captions. */
  readonly spoken: string | null;
  /** When the current call started, for its timer; null when idle. */
  readonly since: number | null;
  readonly notice: VoiceNotice | null;
}

export interface VoiceLevels {
  readonly input: number;
  readonly output: number;
}
