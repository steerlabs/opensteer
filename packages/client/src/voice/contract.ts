import type { VoiceView } from "@opensteer/protocol/voice";
import type { ActivityIcon } from "../host/agent-activity-model.js";
import type { WorkspaceSurfaceDestination } from "../host/surfaces.js";

/**
 * A voice call is the person's microphone and speaker for their Voice Thread,
 * an agent on their computer that manages their work. The client carries audio
 * and says which screen is showing; the agent acts through its own tools. The
 * vendor sits behind `VoiceProvider`; the platform behind `VoiceMediaPort`.
 */

/** The platform's microphone and WebRTC; null where it has none. */
export interface VoiceMediaPort {
  /** Asks for the microphone on first use; rejects with a `NotAllowedError` when refused. */
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  /** Ends a stream `getUserMedia` returned, freeing the microphone and any native handles. */
  releaseStream(stream: MediaStream): void;
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
  "stopped" | "connection-lost" | "replaced" | "expired" | "refused" | "failed";

/** The Voice Thread and this call's Run, as the Host admitted them. */
export interface VoiceCallIdentity {
  readonly threadId: string;
  readonly runId: string;
  readonly workspaceId: string;
}

export interface VoiceCall {
  readonly identity: VoiceCallIdentity;
  /**
   * Has the voice tell the person this once, by `id`. Resolves when accepted,
   * not when spoken; rejects with `VoiceStartError` when the call refused it.
   */
  say(id: string, text: string): Promise<void>;
  /** Replaces what the call's agent knows the person is looking at. */
  view(view: VoiceView): Promise<void>;
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

/** Where an agent's `person_show` takes the person. The app maps it to its own navigation. */
export type VoiceTarget =
  | { readonly kind: "chat" }
  | { readonly kind: "thread"; readonly threadId: string }
  | { readonly kind: "place"; readonly destination: WorkspaceSurfaceDestination };

export type VoicePhase =
  | "idle"
  | "connecting"
  /** On and waiting for the person. */
  | "listening"
  /** The person is talking. */
  | "hearing"
  /** The call's agent is working on what the person asked. */
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
  /** What the agent's running tool is, drawn as a glyph; null while none runs. */
  readonly activity: ActivityIcon | null;
  /** Tasks the Voice Thread started that are still working. */
  readonly tasks: number;
  /** The first thing that needs the person during this call; null when nothing does. */
  readonly ask: VoiceAsk | null;
  readonly notice: VoiceNotice | null;
}

/** What rides on the call bar, wherever the person is. Each kind is its client's existing card. */
export type VoiceAsk =
  | { readonly kind: "request"; readonly requestId: string; readonly others: number }
  | { readonly kind: "passwords"; readonly site: string; readonly card: boolean };

export const idleVoiceSnapshot: VoiceSnapshot = {
  available: false,
  phase: "idle",
  muted: false,
  heard: null,
  spoken: null,
  since: null,
  activity: null,
  tasks: 0,
  ask: null,
  notice: null,
};

/** What a client's voice UI drives: the runtime's one `VoiceController`. */
export interface VoiceControls {
  subscribe(listener: () => void): () => void;
  getSnapshot(): VoiceSnapshot;
  subscribeLevel(listener: (levels: VoiceLevels) => void): () => void;
  /** Fires when the call's agent changed the screen. */
  subscribeShown?(listener: () => void): () => void;
  start(): Promise<void>;
  stop(): unknown;
  /** The person's Voice Thread, created on first need; null when it cannot be opened. */
  openThread(): Promise<string | null>;
  setMuted(muted: boolean): void;
  dismissNotice(): void;
  openMicrophoneSettings?(): void;
}

export interface VoiceLevels {
  readonly input: number;
  readonly output: number;
}
