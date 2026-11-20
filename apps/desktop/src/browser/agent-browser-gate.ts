import { BrowserRuntimeError } from "@opensteer/browser-runtime-core";

export interface GatedAttachment {
  close(): Promise<void>;
}

const stoppedSentence =
  "Agents were stopped on this Mac from the Opensteer menu bar. Resume there to use its tabs again.";

/**
 * Every attachment to this Mac's browsers, which is how an agent (through its
 * Home and this Mac's Runner) reaches a local tab. The window's own tabs are
 * presented natively and never attach, so a Stop leaves them in the person's
 * hands while it ends every attachment and refuses new ones until resumed.
 */
export class AgentBrowserGate {
  #paused = false;
  readonly #live = new Set<GatedAttachment>();
  readonly #listeners = new Set<() => void>();

  get paused(): boolean {
    return this.#paused;
  }

  get inUse(): number {
    return this.#live.size;
  }

  assertOpen(): void {
    if (this.#paused)
      throw new BrowserRuntimeError("conflict", stoppedSentence, { reason: "device-stopped" });
  }

  admit<Attachment extends GatedAttachment>(attachment: Attachment): Attachment {
    if (this.#paused) {
      void attachment.close().catch(() => undefined);
      this.assertOpen();
    }
    const close = attachment.close.bind(attachment);
    attachment.close = () => {
      if (this.#live.delete(attachment)) this.#emit();
      return close();
    };
    this.#live.add(attachment);
    this.#emit();
    return attachment;
  }

  async pause(): Promise<void> {
    this.#paused = true;
    const live = [...this.#live];
    this.#emit();
    await Promise.allSettled(live.map((attachment) => attachment.close()));
  }

  resume(): void {
    this.#paused = false;
    this.#emit();
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}
