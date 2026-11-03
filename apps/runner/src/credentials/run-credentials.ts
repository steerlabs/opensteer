import type { RefreshedRunCredentials } from "../runtime/runtime.js";

/**
 * A Run's current Host tokens. Everything that calls the Host for the Run reads
 * them at the moment of the call, so a refresh takes effect everywhere at once.
 * A refresh issues one agent-control token, which agent tools and browser
 * control accept as well.
 */
export class RunCredentials {
  #agentControl: string;
  #agentTools: string;
  #attachments: string | undefined;
  #browserCdp: string;

  constructor(context: {
    readonly agentControl: { readonly token: string };
    readonly agentTools: { readonly token: string };
    readonly browserCdp: { readonly token: string };
    readonly attachments?: { readonly token: string } | undefined;
  }) {
    this.#agentControl = context.agentControl.token;
    this.#agentTools = context.agentTools.token;
    this.#attachments = context.attachments?.token;
    this.#browserCdp = context.browserCdp.token;
  }

  get agentControl(): string {
    return this.#agentControl;
  }

  get agentTools(): string {
    return this.#agentTools;
  }

  get attachments(): string | undefined {
    return this.#attachments;
  }

  get browserCdp(): string {
    return this.#browserCdp;
  }

  replace(fresh: NonNullable<RefreshedRunCredentials>): void {
    this.#agentControl = fresh.agentControl;
    this.#agentTools = fresh.agentControl;
    this.#browserCdp = fresh.agentControl;
    // A Run without attachment authority is never handed any.
    if (this.#attachments !== undefined && fresh.attachments) this.#attachments = fresh.attachments;
  }
}
