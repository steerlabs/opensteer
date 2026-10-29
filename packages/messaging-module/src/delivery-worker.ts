import { ChannelDeliveryError } from "@opensteer/channel-core";
import type {
  ClaimedChannelDelivery,
  FinishChannelDeliveryAttempt,
} from "@opensteer/channel-protocol";
import type { ChannelAdapterRegistry } from "./adapter-registry.js";
import type { ChannelHostClient } from "./host-client.js";

export class ChannelDeliveryWorker {
  readonly #adapters: ChannelAdapterRegistry;
  readonly #host: ChannelHostClient;
  #closed = false;
  #connected = false;
  #draining: Promise<void> | null = null;
  #streamStop: AbortController | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(host: ChannelHostClient, adapters: ChannelAdapterRegistry) {
    this.#host = host;
    this.#adapters = adapters;
  }

  start(): void {
    if (this.#closed || this.#timer) return;
    this.#timer = setInterval(() => this.wake(), 500);
    this.#timer.unref();
  }

  wake(): void {
    if (this.#closed || !this.#connected || this.#draining) return;
    const operation = this.#drain().finally(() => {
      if (this.#draining === operation) this.#draining = null;
    });
    this.#draining = operation;
  }

  resume(): void {
    if (this.#closed || this.#connected) return;
    this.#connected = true;
    this.#streamStop = new AbortController();
    this.wake();
  }

  async pause(): Promise<void> {
    this.#connected = false;
    this.#streamStop?.abort(new Error("Messaging stream disconnected"));
    this.#streamStop = null;
    await this.#draining;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#connected = false;
    this.#streamStop?.abort(new Error("Messaging delivery worker stopping"));
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#draining;
  }

  async #drain(): Promise<void> {
    for (let processed = 0; processed < 100 && !this.#closed && this.#connected; processed += 1) {
      let claim;
      try {
        claim = await this.#host.claimDelivery();
      } catch {
        return;
      }
      if (!claim) return;
      await this.#deliver(claim).catch(() => undefined);
    }
  }

  async #deliver(claim: ClaimedChannelDelivery): Promise<void> {
    const streamSignal = this.#streamStop?.signal;
    if (!streamSignal) throw new Error("Messaging delivery is paused");
    await this.#host.startDelivery(claim.delivery.id, claim.claimToken);
    try {
      const adapter = this.#adapters.get(claim.provider);
      if (!adapter) {
        await this.#host.finishDelivery({
          claimToken: claim.claimToken,
          deliveryId: claim.delivery.id,
          error: `No ${claim.provider} adapter is installed in this messaging service`,
          outcome: "dead",
        });
        return;
      }
      const input = {
        delivery: claim.delivery,
        destination: claim.destination,
        lease: claim.lease,
        signal: AbortSignal.any([streamSignal, AbortSignal.timeout(15_000)]),
      };
      // An attempt whose outcome was lost may already have reached the
      // provider; ask before sending, or the person reads the reply twice.
      if (claim.mayHaveBeenSent) {
        const reconciled = await adapter.outbound.reconcile(input);
        if (reconciled.kind === "sent") {
          await this.#host.finishDelivery({
            claimToken: claim.claimToken,
            deliveryId: claim.delivery.id,
            outcome: "sent",
            receipt: reconciled.receipt,
          });
          return;
        }
      }
      const result = await adapter.outbound.send(input);
      await this.#host.finishDelivery({
        claimToken: claim.claimToken,
        deliveryId: claim.delivery.id,
        outcome: "sent",
        receipt: result.receipt,
      });
    } catch (error) {
      await this.#host.finishDelivery(deliveryFailure(claim, error));
    }
  }
}

function deliveryFailure(
  claim: ClaimedChannelDelivery,
  error: unknown,
): FinishChannelDeliveryAttempt {
  const message =
    error instanceof Error ? error.message.slice(0, 2_000) : "Channel delivery failed";
  if (error instanceof ChannelDeliveryError && error.kind === "retryable") {
    return {
      claimToken: claim.claimToken,
      deliveryId: claim.delivery.id,
      error: message,
      outcome: "retryable-failed",
      retryAfterSeconds: clampRetryAfterSeconds(error.retryAfterSeconds),
    };
  }
  if (error instanceof ChannelDeliveryError && error.kind === "dead") {
    return {
      claimToken: claim.claimToken,
      deliveryId: claim.delivery.id,
      error: message,
      outcome: "dead",
    };
  }
  return {
    claimToken: claim.claimToken,
    deliveryId: claim.delivery.id,
    error: message,
    outcome: "unknown",
  };
}

/**
 * A provider may name any delay it likes; the wire accepts one day at most, so
 * an unreasonable `Retry-After` becomes a long wait rather than a rejected
 * outcome report that would lose the attempt entirely.
 */
function clampRetryAfterSeconds(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.min(86_400, Math.max(1, Math.ceil(value)));
}
