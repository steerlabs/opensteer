import { voiceSayMaxLength } from "@opensteer/protocol/voice";
import type { HostClient, HostSnapshot } from "../host/client.js";
import { requesterLink } from "../host/task-list.js";
import { VoiceStartError } from "./contract.js";
import { voiceTimers, type VoiceTimer, type VoiceTimers } from "./timers.js";

export interface VoiceSpeakerInput extends VoiceTimers {
  readonly hostClient: HostClient;
  /** Rejects with `VoiceStartError` when the call refused it, anything else when unknown. */
  readonly say: (id: string, text: string) => Promise<void>;
  /** Taken before opening the microphone, so what already waited isn't news. */
  readonly baseline: HostSnapshot;
  /** The Voice Thread: its own Requests are the agent asking, and it says so itself. */
  readonly callThreadId: string;
  readonly onError?: () => void;
}

/**
 * Tells the call when a task needs the person, once by id and in the order
 * they arrived. The Runner owns speech: it orders what it accepted, drops
 * repeats by id and waits for the voice to be quiet, so nothing here paces,
 * merges or skips.
 */
export class VoiceSpeaker {
  readonly #input: VoiceSpeakerInput;
  readonly #timers;
  readonly #requests = new Set<string>();
  #queue: string[] = [];
  #sending = false;
  #retry: VoiceTimer | null = null;
  #failures = 0;
  #unsubscribe: () => void;
  #disposed = false;

  constructor(input: VoiceSpeakerInput) {
    this.#input = input;
    this.#timers = voiceTimers(input);
    for (const { request } of input.baseline.waitingRequests) this.#requests.add(request.id);
    this.#unsubscribe = input.hostClient.subscribe(() => this.#read());
    this.#read();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe();
    this.#timers.clear(this.#retry);
    this.#queue = [];
  }

  #read(): void {
    if (this.#disposed) return;
    for (const { request } of this.#input.hostClient.getSnapshot().waitingRequests) {
      if (this.#requests.has(request.id)) continue;
      this.#requests.add(request.id);
      if (request.originatingThreadId !== this.#input.callThreadId) this.#queue.push(request.id);
    }
    this.#drain();
  }

  /** A Request is announced by its task's title alone; its contents stay on screen. */
  #requestText(requestId: string): string | null {
    const snapshot = this.#input.hostClient.getSnapshot();
    const waiting = snapshot.waitingRequests.find(({ request }) => request.id === requestId);
    // One answered before its turn came is no longer news.
    if (!waiting || waiting.request.status !== "pending") return null;
    const title = requesterLink(snapshot, waiting.request.originatingThreadId)?.title ?? "A task";
    return `${title.slice(0, voiceSayMaxLength - 12)} needs you.`;
  }

  #drain(): void {
    if (this.#disposed || this.#sending || this.#retry !== null) return;
    const requestId = this.#queue[0];
    if (!requestId) return;
    const text = this.#requestText(requestId);
    if (text === null) {
      this.#queue.shift();
      this.#drain();
      return;
    }
    this.#sending = true;
    this.#input.say(`request:${requestId}`, text).then(
      () => {
        this.#sending = false;
        this.#failures = 0;
        if (this.#queue[0] === requestId) this.#queue.shift();
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
