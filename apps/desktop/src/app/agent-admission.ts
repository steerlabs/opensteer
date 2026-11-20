export const agentsStoppedSentence =
  "Agents are stopped on this Mac. Resume from the Opensteer menu bar first.";

export class AgentsStoppedError extends Error {
  constructor(message = agentsStoppedSentence) {
    super(message);
    this.name = "AgentsStoppedError";
  }
}

/**
 * Whether an agent may act on this Mac right now. Every path that lets one act
 * reads it at the last moment before acting: a ticket from {@link admit} is
 * valid only while admission stays open in the same generation, so work let in
 * before a Stop cannot act after it, even if Resume follows at once. Closed
 * until the person's saved choice is known.
 */
export class AgentAdmission {
  #open = false;
  #generation = 0;
  #closing = new AbortController();
  readonly #listeners = new Set<() => void>();

  get open(): boolean {
    return this.#open;
  }

  get generation(): number {
    return this.#generation;
  }

  /** Aborts when the admission that is open now closes. */
  get closing(): AbortSignal {
    return this.#closing.signal;
  }

  admit(): number {
    if (!this.#open) throw new AgentsStoppedError();
    return this.#generation;
  }

  current(ticket: number): boolean {
    return this.#open && this.#generation === ticket;
  }

  assertCurrent(ticket: number): void {
    if (!this.current(ticket)) throw new AgentsStoppedError();
  }

  close(): void {
    this.#generation += 1;
    this.#open = false;
    this.#closing.abort(new AgentsStoppedError());
    this.#emit();
  }

  reopen(): void {
    if (this.#open) return;
    this.#generation += 1;
    this.#closing = new AbortController();
    this.#open = true;
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

/** An admission that is always open, for code that runs without a menu bar Stop. */
export function openAgentAdmission(): AgentAdmission {
  const admission = new AgentAdmission();
  admission.reopen();
  return admission;
}
