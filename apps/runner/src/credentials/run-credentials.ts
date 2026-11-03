import type { RefreshedRunCredentials } from "../runtime/runtime.js";

/**
 * A Run's current Host credentials. Everything that calls the Host for the Run
 * reads them at the moment of the call, so a refresh takes effect everywhere
 * at once. One tool credential serves its MCP tools, browser control and shell
 * relay.
 */
export class RunCredentials {
  #agentTools: string;
  #attachments: string | undefined;

  constructor(context: {
    readonly agentTools: { readonly token: string };
    readonly attachments?: { readonly token: string } | undefined;
  }) {
    this.#agentTools = context.agentTools.token;
    this.#attachments = context.attachments?.token;
  }

  get agentTools(): string {
    return this.#agentTools;
  }

  get attachments(): string | undefined {
    return this.#attachments;
  }

  replace(fresh: NonNullable<RefreshedRunCredentials>): void {
    this.#agentTools = fresh.agentTools;
    // A Run without attachment authority is never handed any.
    if (this.#attachments !== undefined && fresh.attachments) this.#attachments = fresh.attachments;
  }
}
