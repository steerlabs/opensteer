import {
  RunnerAuxiliaryChallengeSchema,
  sameRunnerAuxiliaryFence,
  type RunnerAuxiliaryFrameFence,
  type RunnerAuxiliaryModule,
  type RunnerAuxiliaryWelcome,
  type RunnerBootId,
} from "@opensteer/protocol";
import { createRunnerAuxiliarySignature } from "@opensteer/runner-auth";
import type { KeyObject } from "node:crypto";
import type { RunnerId } from "@opensteer/core";

export interface RunnerAuxiliaryHandshakeInput {
  readonly bootId: RunnerBootId;
  readonly module: RunnerAuxiliaryModule;
  readonly privateKey: KeyObject;
  readonly runnerId: RunnerId;
  /** The one-use credential the primary connection asked the Host for. */
  readonly ticket: string;
}

/**
 * Answers the Host's challenge on a freshly opened auxiliary socket.
 *
 * The ticket alone would be a bearer credential, so this signs the challenge
 * together with the ticket's digest using the Runner's own key. Whoever
 * intercepted the ticket still cannot open the stream.
 */
export function answerAuxiliaryChallenge(
  input: RunnerAuxiliaryHandshakeInput,
  challenge: unknown,
): {
  readonly bootId: RunnerBootId;
  readonly challengeId: string;
  readonly module: RunnerAuxiliaryModule;
  readonly runnerId: RunnerId;
  readonly signature: string;
  readonly ticket: string;
  readonly type: "runner.auxiliary.authenticate";
} {
  const parsed = RunnerAuxiliaryChallengeSchema.parse(challenge);
  if (parsed.module !== input.module) {
    throw new Error("The Host challenged a different Runner module");
  }
  if (Date.parse(parsed.expiresAt) <= Date.now()) {
    throw new Error("The Host auxiliary challenge is expired");
  }
  return {
    bootId: input.bootId,
    challengeId: parsed.challengeId,
    module: input.module,
    runnerId: input.runnerId,
    signature: createRunnerAuxiliarySignature(input.privateKey, {
      bootId: input.bootId,
      challenge: parsed,
      module: input.module,
      runnerId: input.runnerId,
      ticket: input.ticket,
    }),
    ticket: input.ticket,
    type: "runner.auxiliary.authenticate",
  };
}

/**
 * The fence every auxiliary frame repeats, held in one place so a runtime
 * cannot stamp a frame for a stream the Host has already replaced.
 *
 * The ledger also owns the stream lease, because the lease and the fence run
 * out together: a fence stamped after the lease named a stream the Host has
 * already forgotten. Expiry is a state transition, not an exception — the
 * ledger watches its own clock and tells the one owner of the stream to close
 * it, so callers see the ordinary "stream closed" outcome instead of a throw.
 */
export class RunnerAuxiliaryFenceLedger {
  readonly #now: () => number;
  #fence: RunnerAuxiliaryFrameFence | undefined;
  #leaseExpiresAt = 0;
  #lastHeartbeatSentAt = 0;
  #onLeaseExpired: ((reason: Error) => void) | undefined;
  #leaseTimer: NodeJS.Timeout | undefined;

  constructor(options: { readonly now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  adopt(welcome: RunnerAuxiliaryWelcome): RunnerAuxiliaryFrameFence {
    const fence: RunnerAuxiliaryFrameFence = {
      auxiliaryStreamId: welcome.auxiliaryStreamId,
      bootId: welcome.bootId,
      connectionGeneration: welcome.connectionGeneration,
      connectionId: welcome.connectionId,
      connectionLeaseId: welcome.connectionLeaseId,
      module: welcome.module,
      runnerId: welcome.runnerId,
    };
    this.#fence = fence;
    this.#leaseExpiresAt = Date.parse(welcome.streamLeaseExpiresAt);
    this.#lastHeartbeatSentAt = 0;
    this.#scheduleLeaseExpiry();
    return fence;
  }

  renew(streamLeaseExpiresAt: string): void {
    this.#leaseExpiresAt = Math.max(this.#leaseExpiresAt, Date.parse(streamLeaseExpiresAt));
    this.#scheduleLeaseExpiry();
  }

  /**
   * Registers the one owner of the transport, which closes it when the lease
   * runs out. Registering after a lease has already been adopted is how the
   * stream is wired: the ledger does not watch a clock nobody is listening to.
   */
  onLeaseExpired(listener: (reason: Error) => void): void {
    this.#onLeaseExpired = listener;
    this.#scheduleLeaseExpiry();
  }

  /** Stops watching the lease; the stream this ledger fenced is gone. */
  release(): void {
    if (this.#leaseTimer) clearTimeout(this.#leaseTimer);
    this.#leaseTimer = undefined;
    this.#onLeaseExpired = undefined;
  }

  /** True once the lease has run out. An expired stream is a closed stream. */
  get expired(): boolean {
    return this.#fence === undefined || this.#leaseExpiresAt <= this.#now();
  }

  /**
   * The fence to stamp on an outbound frame.
   *
   * This refuses an expired lease, so the failure belongs to the operation
   * that asked for it — a send that rejects. Never read it straight from a
   * timer or a socket event handler: read it inside the promise the operation
   * already returns, so expiry cannot escape as an uncaught exception.
   */
  get fence(): RunnerAuxiliaryFrameFence {
    const fence = this.#fence;
    if (!fence) throw new Error("The auxiliary stream has no fence yet");
    if (this.#leaseExpiresAt <= this.#now()) {
      throw new Error("The auxiliary stream lease has expired");
    }
    return fence;
  }

  accepts(fence: RunnerAuxiliaryFrameFence): boolean {
    return this.#fence !== undefined && sameRunnerAuxiliaryFence(this.#fence, fence);
  }

  heartbeatTimestamp(): string {
    const sentAt = Math.max(this.#now(), this.#lastHeartbeatSentAt + 1);
    this.#lastHeartbeatSentAt = sentAt;
    return new Date(sentAt).toISOString();
  }

  #scheduleLeaseExpiry(): void {
    const listener = this.#onLeaseExpired;
    if (!listener || this.#fence === undefined) return;
    if (this.#leaseTimer) clearTimeout(this.#leaseTimer);
    this.#leaseTimer = setTimeout(
      () => {
        this.#leaseTimer = undefined;
        // A timer can fire a millisecond before the clock reaches the lease's
        // end; the lease has not run out until `expired` says so.
        if (!this.expired) return this.#scheduleLeaseExpiry();
        listener(new Error("The auxiliary stream lease has expired"));
      },
      Math.max(0, this.#leaseExpiresAt - this.#now()),
    );
    this.#leaseTimer.unref();
  }
}
