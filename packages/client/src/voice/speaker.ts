import { voiceSayMaxLength } from "@opensteer/protocol/voice";
import type { HostClient, HostSnapshot, MessageEntry, TranscriptEntry } from "../host/client.js";
import { requesterLink } from "../host/task-list.js";
import { VoiceStartError } from "./contract.js";
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

/**
 * When the Host says this entry happened, or null when only this device does.
 * A live stream's reply, reasoning or tool call keeps the moment this device
 * first drew it even once settled; a settled step's completion is the Host's.
 */
function hostTime(entry: TranscriptEntry): string | null {
  if (entry.kind === "reasoning" || entry.kind === "tool") return entry.completedAt ?? null;
  if (entry.kind === "message" && (entry.streaming === true || entry.id.startsWith("stream:")))
    return null;
  return entry.createdAt;
}

export interface VoiceSpeakerInput extends VoiceTimers {
  readonly hostClient: HostClient;
  /** Rejects with `VoiceStartError` when the call refused it, anything else when unknown. */
  readonly say: (id: string, text: string) => Promise<void>;
  /** Taken before opening the microphone, so start-up replies are still new. */
  readonly baseline: HostSnapshot;
  /** The call's own Thread: its Requests are the agent asking, not a task. */
  readonly callThreadId: string;
  readonly onError?: () => void;
}

/**
 * Forwards Chat's new replies and new "needs you" Requests to the call, each
 * once by id and in the order they arrived. The Runner owns speech: it orders
 * what it accepted, drops repeats by id and waits for the voice to be quiet,
 * so nothing here paces, merges or skips. A held Chat observation never
 * navigates or acknowledges its messages.
 */
export class VoiceSpeaker {
  readonly #input: VoiceSpeakerInput;
  readonly #timers;
  readonly #messages = new Set<string>();
  readonly #requests = new Set<string>();
  /**
   * The newest Chat activity the person already had, in the Host's own clock:
   * replies at or before it are history, whatever this device's clock says.
   * Undefined until Chat's history has loaded; null when Chat has none.
   */
  #since: number | null | undefined;
  #queue: { readonly id: string; readonly text: () => string | null }[] = [];
  #sending = false;
  #retry: VoiceTimer | null = null;
  #failures = 0;
  #threadId: string | null = null;
  #release: (() => void) | null = null;
  #unsubscribe: () => void;
  #disposed = false;

  constructor(input: VoiceSpeakerInput) {
    this.#input = input;
    this.#timers = voiceTimers(input);
    const home = input.baseline.homeThreadId;
    if (!home) this.#since = null;
    else if (input.baseline.transcriptWindows[home]) this.#takeHistory(input.baseline, home);
    for (const { request } of input.baseline.waitingRequests) this.#requests.add(request.id);
    this.#unsubscribe = input.hostClient.subscribe(() => this.#read());
    this.#read();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe();
    this.#release?.();
    this.#release = null;
    this.#timers.clear(this.#retry);
    this.#queue = [];
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
    // Chat's history arriving after the call began is history, not news.
    if (this.#since === undefined && this.#threadId && snapshot.transcriptWindows[this.#threadId])
      this.#takeHistory(snapshot, this.#threadId);
    const since = this.#since;
    const replies =
      since === undefined ? [] : (snapshot.transcripts[snapshot.homeThreadId ?? ""] ?? []);
    for (const entry of replies) {
      if (!durableReply(entry) || this.#messages.has(entry.id)) continue;
      this.#messages.add(entry.id);
      if (since !== null && since !== undefined && !(Date.parse(entry.createdAt) > since)) continue;
      const text = voiceSpeakableText(entry.body);
      if (text) this.#queue.push({ id: `message:${entry.id}`, text: () => text });
    }
    for (const { request } of snapshot.waitingRequests) {
      if (this.#requests.has(request.id)) continue;
      this.#requests.add(request.id);
      this.#queue.push({ id: `request:${request.id}`, text: () => this.#requestText(request.id) });
    }
    this.#drain();
  }

  /** A Request is announced by its task's title alone; its contents stay on screen. */
  #requestText(requestId: string): string | null {
    const snapshot = this.#input.hostClient.getSnapshot();
    const waiting = snapshot.waitingRequests.find(({ request }) => request.id === requestId);
    // One answered before its turn came is no longer news.
    if (!waiting || waiting.request.status !== "pending") return null;
    if (waiting.request.originatingThreadId === this.#input.callThreadId)
      return "Check your screen, I need your OK.";
    const title = requesterLink(snapshot, waiting.request.originatingThreadId)?.title ?? "A task";
    return `${title.slice(0, voiceSayMaxLength - 12)} needs you.`;
  }

  #takeHistory(snapshot: HostSnapshot, threadId: string): void {
    let since: number | null = null;
    for (const entry of snapshot.transcripts[threadId] ?? []) {
      if (durableReply(entry)) this.#messages.add(entry.id);
      const at = Date.parse(hostTime(entry) ?? "");
      if (Number.isFinite(at)) since = Math.max(since ?? at, at);
    }
    this.#since = since;
  }

  #drain(): void {
    if (this.#disposed || this.#sending || this.#retry !== null) return;
    const next = this.#queue[0];
    if (!next) return;
    const text = next.text();
    if (text === null) {
      this.#queue.shift();
      this.#drain();
      return;
    }
    this.#sending = true;
    this.#input.say(next.id, text).then(
      () => {
        this.#sending = false;
        this.#failures = 0;
        if (this.#queue[0] === next) this.#queue.shift();
        this.#drain();
      },
      (error: unknown) => {
        this.#sending = false;
        if (this.#disposed) return;
        if (error instanceof VoiceStartError) {
          this.#input.onError?.();
          return;
        }
        // An unknown outcome is sent again with the same id; the Runner says it once.
        this.#retry = this.#timers.set(
          () => {
            this.#retry = null;
            this.#drain();
          },
          Math.min(4_000, 250 * 2 ** Math.min(this.#failures++, 4)),
        );
      },
    );
  }
}
