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
  readonly startedAt: number;
  /** Taken before opening the microphone, so start-up replies are still new. */
  readonly baseline: HostSnapshot;
  readonly onReplySpoken?: (runId: string | null) => void;
  readonly onSettled?: () => void;
  readonly onError?: () => void;
}

/** A held Chat observation never navigates or acknowledges its messages. */
export class VoiceSpeaker {
  readonly #input: VoiceSpeakerInput;
  readonly #timers;
  readonly #messages = new Set<string>();
  readonly #requests = new Set<string>();
  #queue: Speech[] = [];
  #current: Speech | null = null;
  #timer: VoiceTimer | null = null;
  #threadId: string | null = null;
  #release: (() => void) | null = null;
  #unsubscribe: () => void;
  #disposed = false;

  constructor(input: VoiceSpeakerInput) {
    this.#input = input;
    this.#timers = voiceTimers(input);
    for (const entry of input.baseline.transcripts[input.baseline.homeThreadId ?? ""] ?? []) {
      if (durableReply(entry)) this.#messages.add(entry.id);
    }
    for (const { request } of input.baseline.waitingRequests) this.#requests.add(request.id);
    this.#unsubscribe = input.hostClient.subscribe(() => this.#read());
    this.#read();
  }

  spoke(): void {
    const current = this.#current;
    if (!current || this.#disposed) return;
    this.#timers.clear(this.#timer);
    this.#timer = null;
    this.#current = null;
    if (current.kind === "reply") this.#input.onReplySpoken?.(current.runId);
    this.#input.onSettled?.();
    this.#drain();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe();
    this.#release?.();
    this.#release = null;
    this.#timers.clear(this.#timer);
    this.#queue = [];
    this.#current = null;
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
      if (Date.parse(entry.createdAt) <= this.#input.startedAt) continue;
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
    if (this.#disposed || this.#current) return;
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
    this.#current = next;
    // A missing voice turn-end must not hold the queue forever (at most four minutes).
    this.#timer = this.#timers.set(
      () => this.spoke(),
      Math.min(240_000, 15_000 + text.length * 80),
    );
    void this.#input.say(text).catch(() => {
      if (!this.#disposed && this.#current === next) this.#input.onError?.();
    });
  }
}
