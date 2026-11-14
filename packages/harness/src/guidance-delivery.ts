/** What one turn carries of an engine's stable guidance, and when it was prepared. */
export interface GuidanceTicket {
  /** The guidance this turn sends, or undefined when the conversation already holds it. */
  readonly send: string | undefined;
  readonly epoch: number;
}

/**
 * Which stable guidance a native conversation already holds, for engines with
 * no system channel that survives a resume: the guidance rides on a turn once
 * and again only when its text changes or a compaction drops it. Process-local
 * on purpose, as in T3 Code: a new engine process starts empty and resends
 * once, so a missed compaction can never strand the conversation without it.
 */
export class GuidanceDelivery {
  #delivered: string | undefined;
  #epoch = 0;
  readonly #compactions = new Set<string>();

  prepare(guidance: string): GuidanceTicket {
    return { send: guidance === this.#delivered ? undefined : guidance, epoch: this.#epoch };
  }

  /** Records the ticket's guidance once its turn completed; a compaction since then voids it. */
  acknowledge(ticket: GuidanceTicket): void {
    if (ticket.send !== undefined && ticket.epoch === this.#epoch) this.#delivered = ticket.send;
  }

  /** A completed compaction of the root conversation; a repeated id is the same compaction. */
  compacted(id?: string): void {
    if (id !== undefined) {
      if (this.#compactions.has(id)) return;
      this.#compactions.add(id);
    }
    this.#epoch += 1;
    this.#delivered = undefined;
  }
}
