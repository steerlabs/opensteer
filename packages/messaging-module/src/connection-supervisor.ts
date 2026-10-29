import { setTimeout as delay } from "node:timers/promises";
import {
  ChannelConnectionError,
  type ChannelAdapter,
  type ChannelConnectionIssueKind,
  type IntegrationConnectionId,
} from "@opensteer/channel-core";
import {
  InspectChannelConnectionResponseSchema,
  RuntimeConnectionDescriptorSchema,
  type HostChannelRequest,
  type RuntimeConnectionDescriptor,
} from "@opensteer/channel-protocol";
import type { ChannelAdapterRegistry } from "./adapter-registry.js";
import type { ChannelHostClient, MessagingStreamContext } from "./host-client.js";

export class ChannelConnectionSupervisor {
  readonly #adapters: ChannelAdapterRegistry;
  readonly #connections = new Map<
    IntegrationConnectionId,
    { readonly descriptor: RuntimeConnectionDescriptor; readonly session: AdapterSession }
  >();
  readonly #host: ChannelHostClient;
  #streamGeneration = 0;

  constructor(host: ChannelHostClient, adapters: ChannelAdapterRegistry) {
    this.#host = host;
    this.#adapters = adapters;
  }

  async opened(generation: number): Promise<void> {
    if (generation <= this.#streamGeneration) {
      throw new Error("Messaging stream generations must increase");
    }
    await this.#closeSessions();
    this.#streamGeneration = generation;
  }

  async disconnected(generation: number): Promise<void> {
    if (generation !== this.#streamGeneration) return;
    await this.#closeSessions();
  }

  async handle(request: HostChannelRequest, context: MessagingStreamContext): Promise<unknown> {
    context.signal.throwIfAborted();
    if (context.generation !== this.#streamGeneration) {
      throw new Error("Messaging request belongs to a superseded stream");
    }
    if (request.operation === "connection.inspect") {
      const adapter = this.#adapters.get(request.payload.provider, request.payload.transportKind);
      if (!adapter)
        throw new Error(`No ${request.payload.provider} adapter supports this transport`);
      return InspectChannelConnectionResponseSchema.parse(
        await adapter.connection.inspect(request.payload),
      );
    }
    await this.#sync(request.payload.connections, context);
    return { synchronized: true };
  }

  async close(): Promise<void> {
    await this.#closeSessions();
  }

  async #closeSessions(): Promise<void> {
    const sessions = [...this.#connections.values()].map(({ session }) => session);
    this.#connections.clear();
    await Promise.all(sessions.map((session) => session.close()));
  }

  async #sync(
    inputs: readonly RuntimeConnectionDescriptor[],
    context: MessagingStreamContext,
  ): Promise<void> {
    this.#assertCurrent(context);
    const desired = new Map(
      inputs.map((input) => {
        const descriptor = RuntimeConnectionDescriptorSchema.parse(input);
        return [descriptor.connectionId, descriptor] as const;
      }),
    );
    const closing: Promise<void>[] = [];
    for (const [connectionId, current] of this.#connections) {
      const next = desired.get(connectionId);
      if (next && sameDescriptor(current.descriptor, next) && !current.session.finished) {
        await current.session.reportSteadyState();
        continue;
      }
      this.#connections.delete(connectionId);
      closing.push(current.session.close());
    }
    await Promise.all(closing);
    this.#assertCurrent(context);
    for (const [connectionId, descriptor] of desired) {
      this.#assertCurrent(context);
      if (this.#connections.has(connectionId)) continue;
      const adapter = this.#adapters.get(descriptor.provider, descriptor.transportKind);
      if (!adapter) continue;
      const session = new AdapterSession({ adapter, descriptor, host: this.#host });
      this.#connections.set(connectionId, { descriptor, session });
      session.start();
    }
  }

  #assertCurrent(context: MessagingStreamContext): void {
    context.signal.throwIfAborted();
    if (context.generation !== this.#streamGeneration) {
      throw new Error("Messaging synchronization belongs to a superseded stream");
    }
  }
}

class AdapterSession {
  readonly #adapter: ChannelAdapter;
  readonly #descriptor: RuntimeConnectionDescriptor;
  readonly #host: ChannelHostClient;
  #closed = false;
  #finished = false;
  #ready = false;
  #run: Promise<void> | undefined;
  readonly #stop = new AbortController();

  constructor(options: {
    readonly adapter: ChannelAdapter;
    readonly descriptor: RuntimeConnectionDescriptor;
    readonly host: ChannelHostClient;
  }) {
    this.#adapter = options.adapter;
    this.#descriptor = options.descriptor;
    this.#host = options.host;
  }

  start(): void {
    this.#run ??= this.#loop().finally(() => {
      this.#finished = true;
    });
  }

  get finished(): boolean {
    return this.#finished;
  }

  /**
   * Re-report the health a proven session already has, so a Host that asks for
   * a sync it does not need still hears the truth about this connection.
   */
  async reportSteadyState(): Promise<void> {
    if (this.#ready) await this.#report("connected", null, null);
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#stop.abort();
    await this.#run;
  }

  async #loop(): Promise<void> {
    let attempt = 0;
    await this.#report("connecting", "Checking messaging provider setup", null);
    while (!this.#closed) {
      try {
        const lease = await this.#host.resolveCredential(
          this.#descriptor.connectionId,
          this.#descriptor.provider,
          "transport",
        );
        await this.#adapter.connection.run({
          accountId: this.#descriptor.accountId,
          credentials: lease.secrets,
          expectedAccountExternalId: this.#descriptor.externalAccountId,
          initialCursor: this.#descriptor.initialCursor,
          onEvent: (event) => this.#host.commitIngress(this.#descriptor.connectionId, event),
          onReady: async () => {
            this.#ready = true;
            // A transport that proved itself owes nothing to the failures
            // before it, so the next disconnect starts from the short delay.
            attempt = 0;
            await this.#report("connected", null, null);
          },
          signal: this.#stop.signal,
          transportKind: this.#descriptor.transportKind,
        });
        attempt = 0;
      } catch (error) {
        if (this.#closed) return;
        this.#ready = false;
        // A refusal only a person can fix needs attention. `retryable` says
        // whether the transport keeps trying meanwhile: it does when the fix
        // needs nothing from Opensteer, such as a grant allowed on a Mac.
        if (
          error instanceof ChannelConnectionError &&
          (!error.retryable || error.issue.kind !== "transport")
        ) {
          await this.#report("needs-attention", error.message, error.issue.kind);
          if (!error.retryable) return;
        } else {
          const detail =
            error instanceof Error ? error.message.slice(0, 500) : "Provider disconnected";
          await this.#report("connecting", detail, "transport");
        }
      }
      if (this.#closed) return;
      const reconnectDelay = reconnectDelayMs(attempt);
      attempt += 1;
      await delay(reconnectDelay, undefined, { signal: this.#stop.signal }).catch(() => undefined);
    }
  }

  async #report(
    status: "connecting" | "connected" | "needs-attention",
    detail: string | null,
    reason: ChannelConnectionIssueKind | null,
  ): Promise<void> {
    await this.#host
      .reportConnectionHealth({
        connectionId: this.#descriptor.connectionId,
        detail,
        reason,
        status,
      })
      .catch(() => undefined);
  }
}

/**
 * Exponential backoff with ±20% jitter, so a provider outage that drops every
 * connection at once does not bring them all back in the same instant.
 */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
  return Math.round(base * (0.8 + random() * 0.4));
}

function sameDescriptor(
  left: RuntimeConnectionDescriptor,
  right: RuntimeConnectionDescriptor,
): boolean {
  return (
    left.accountId === right.accountId &&
    left.connectionId === right.connectionId &&
    left.credentialGeneration === right.credentialGeneration &&
    left.externalAccountId === right.externalAccountId &&
    left.provider === right.provider &&
    left.transportKind === right.transportKind
  );
}
