import {
  parseAgentConnectionDeepLink,
  type AgentConnectionAuthorizationTarget,
} from "@opensteer/protocol";

/** Navigation only. The selected Host still requires an owner session and an explicit decision. */
export class McpAuthorizationLinks {
  readonly #applicationId: string;
  readonly #now: () => number;
  #pending: { target: AgentConnectionAuthorizationTarget; receivedAt: number } | null = null;
  #consumer: ((target: AgentConnectionAuthorizationTarget) => void) | null = null;
  constructor(applicationId: string, now: () => number = Date.now) {
    this.#applicationId = applicationId;
    this.#now = now;
  }
  get pending() {
    return this.#pending !== null && this.#pending.receivedAt + 10 * 60_000 > this.#now();
  }
  accept(value: string): boolean {
    const target = parseAgentConnectionDeepLink(value, this.#applicationId);
    if (!target) return false;
    this.#pending = { target, receivedAt: this.#now() };
    this.#consumer?.(target);
    return true;
  }
  clear(requestId: string): void {
    if (this.#pending?.target.requestId === requestId) this.#pending = null;
  }
  attach(consumer: (target: AgentConnectionAuthorizationTarget) => void): () => void {
    this.#consumer = consumer;
    if (this.pending && this.#pending) consumer(this.#pending.target);
    return () => {
      if (this.#consumer === consumer) this.#consumer = null;
    };
  }
}
