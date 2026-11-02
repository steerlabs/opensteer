import type { BrowserServerMessage } from "@opensteer/protocol/browser";
export type BrowserCursorHint = Extract<BrowserServerMessage, { type: "browser.cursor" }>;

/** Ephemeral controller-only observations; no cursor survives a subscription. */
export class BrowserCursorStore {
  readonly #listeners = new Map<string, Set<(hint: BrowserCursorHint) => void>>();
  subscribe(
    sessionId: string,
    surfaceId: string,
    listener: (hint: BrowserCursorHint) => void,
  ): () => void {
    const key = JSON.stringify([sessionId, surfaceId]);
    const listeners = this.#listeners.get(key) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.#listeners.delete(key);
    };
  }
  receive(sessionId: string, message: BrowserServerMessage): void {
    if (message.type !== "browser.cursor") return;
    for (const listener of this.#listeners.get(JSON.stringify([sessionId, message.surfaceId])) ??
      [])
      listener(message);
  }
}
