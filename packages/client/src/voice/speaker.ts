import { voiceSayMaxLength } from "@opensteer/protocol/voice";
import type { HostClient, HostSnapshot, MessageEntry, TranscriptEntry } from "../host/client.js";
import { requesterLink } from "../host/task-list.js";
import { voiceTimers, type VoiceTimer, type VoiceTimers } from "./timers.js";

export function voiceSpeakableText(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n[\s\S]*?(?:```|$)/gu, " (code omitted) ")
    .replace(/~~~[^\n]*\n[\s\S]*?(?:~~~|$)/gu, " (code omitted) ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gmu, "")
    .replace(/[`*_~]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, voiceSayMaxLength)
    .trim();
}

function durableReply(entry: TranscriptEntry): entry is MessageEntry {
  // Run completion also clears streaming on unfinished synthetic stream entries.
  return (
    entry.kind === "message" &&
    entry.messageKind === "assistant" &&
    entry.streaming !== true &&
    !!entry.id &&
    !entry.id.startsWith("stream:")
  );
}

type Speech =
  | { readonly kind: "reply"; readonly text: string; readonly runId: string | null }
  | { readonly kind: "request"; readonly requestId: string };

export interface VoiceSpeakerInput extends VoiceTimers {
  readonly hostClient: HostClient;
  readonly say: (text: string) => Promise<void>;
  /** Taken before opening the microphone, so start-up replies are still new. */
  readonly baseline: HostSnapshot;
  readonly onReplySpoken?: (runId: string | null) => void;
  readonly onSettled?: () => void;
  readonly onError?: () => void;
}

/**
 * Says Chat's new replies and "needs you" Requests one at a time. A held Chat
 * observation never navigates or acknowledges its messages.
 *
 * The voice also speaks on its own (acknowledgements), so a relay counts as
 * spoken only when the voice turn that began after it was sent ends, and the
 * next relay waits until the voice is quiet.
 */
export class VoiceSpeaker {
  readonly #input: VoiceSpeakerInput;
  readonly #timers;
  readonly #messages = new Set<string>();
  readonly #requests = new Set<string>();
  /**
   * The newest Chat message the person already had, in the Host's own clock:
   * replies at or before it are history, whatever this device's clock says.
   */
  readonly #since: number | null;
  #queue: Speech[] = [];
  #current: { readonly speech: Speech; started: boolean } | null = null;
  #talking = false;
  #timer: VoiceTimer | null = null;
  #quiet: VoiceTimer | null = null;
  #threadId: string | null = null;
  #release: (() => void) | null = null;
  #unsubscribe: () => void;
  #disposed = false;

  constructor(input: VoiceSpeakerInput) {
    this.#input = input;
    this.#timers = voiceTimers(input);
    let since: number | null = null;
    for (const entry of input.baseline.transcripts[input.baseline.homeThreadId ?? ""] ?? []) {
      if (durableReply(entry)) this.#messages.add(entry.id);
      const at = entry.kind === "message" ? Date.parse(entry.createdAt) : Number.NaN;
      if (Number.isFinite(at)) since = Math.max(since ?? at, at);
    }
    this.#since = since;
    for (const { request } of input.baseline.waitingRequests) this.#requests.add(request.id);
    this.#unsubscribe = input.hostClient.subscribe(() => this.#read());
    this.#read();
  }

  /** The voice began a turn of speech. */
  speaking(): void {
    this.#talking = true;
    if (this.#current) this.#current.started = true;
  }

  /** The voice finished a turn of speech. */
  spoke(): void {
    this.#talking = false;
    if (this.#current?.started) this.#finish();
    else this.#drain();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe();
    this.#release?.();
    this.#release = null;
    this.#timers.clear(this.#timer);
    this.#timers.clear(this.#quiet);
    this.#queue = [];
    this.#current = null;
  }

  #finish(): void {
    const current = this.#current;
    if (!current || this.#disposed) return;
    this.#timers.clear(this.#timer);
    this.#timer = null;
    this.#current = null;
    if (current.speech.kind === "reply") this.#input.onReplySpoken?.(current.speech.runId);
    this.#input.onSettled?.();
    this.#drain();
  }

  #read(): void {
    if (this.#disposed) return;
    const snapshot = this.#input.hostClient.getSnapshot();
    if (snapshot.homeThreadId !== this.#threadId) {
      this.#release?.();
      this.#threadId = snapshot.homeThreadId;
      // Set identity before observeThread: it may synchronously publish history.
      this.#release = this.#threadId ? this.#input.hostClient.observeThread(this.#threadId) : null;
    }
    for (const entry of snapshot.transcripts[snapshot.homeThreadId ?? ""] ?? []) {
      if (!durableReply(entry) || this.#messages.has(entry.id)) continue;
      this.#messages.add(entry.id);
      if (this.#since !== null && !(Date.parse(entry.createdAt) > this.#since)) continue;
      const text = voiceSpeakableText(entry.body);
      if (text) this.#enqueue({ kind: "reply", text, runId: entry.runId });
    }
    for (const { request } of snapshot.waitingRequests) {
      if (this.#requests.has(request.id)) continue;
      this.#requests.add(request.id);
      this.#enqueue({ kind: "request", requestId: request.id });
    }
    this.#drain();
  }

  #enqueue(speech: Speech): void {
    this.#queue = [...this.#queue, speech].slice(-2);
  }

  #drain(): void {
    if (this.#disposed || this.#current || this.#queue.length === 0) return;
    if (this.#talking) {
      // A missed turn end must not hold the queue: assume quiet after a while.
      this.#quiet ??= this.#timers.set(() => {
        this.#quiet = null;
        this.#talking = false;
        this.#drain();
      }, 20_000);
      return;
    }
    this.#timers.clear(this.#quiet);
    this.#quiet = null;
    const next = this.#queue.shift();
    if (!next) return;
    let text: string;
    if (next.kind === "request") {
      const snapshot = this.#input.hostClient.getSnapshot();
      const waiting = snapshot.waitingRequests.find(({ request }) => request.id === next.requestId);
      if (!waiting || waiting.request.status !== "pending") {
        this.#drain();
        return;
      }
      const title = requesterLink(snapshot, waiting.request.originatingThreadId)?.title ?? "A task";
      text = `${title.slice(0, voiceSayMaxLength - 12)} needs you.`;
    } else text = next.text;
    const current = { speech: next, started: false };
    this.#current = current;
    // A missing voice turn-end must not hold the queue forever (at most four minutes).
    this.#timer = this.#timers.set(
      () => this.#finish(),
      Math.min(240_000, 15_000 + text.length * 80),
    );
    void this.#input.say(text).catch(() => {
      if (!this.#disposed && this.#current === current) this.#input.onError?.();
    });
  }
}
