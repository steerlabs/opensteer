import {
  sameRunnerConnectionFence,
  type RunnerConnectionFence,
  type RunnerModuleReadinessReport,
} from "@opensteer/protocol";

/**
 * The Runner's copy of the connection fence, and the lease that goes with it.
 *
 * The Host repeats the fence on every frame and refuses one that does not match
 * the connection it considers current. A Runner that stamped frames from
 * memory of an older welcome would be talking past a Host that has already
 * moved on, so the ledger is the single place the current fence lives, and it
 * refuses to answer at all once the lease it was given has run out.
 */
export class RunnerConnectionFenceLedger {
  readonly #now: () => number;
  #fence: RunnerConnectionFence | undefined;
  #leaseExpiresAt = 0;
  #lastHeartbeatSentAt = 0;

  constructor(options: { readonly now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  adopt(fence: RunnerConnectionFence, leaseExpiresAt: string): void {
    this.#fence = fence;
    this.#leaseExpiresAt = Date.parse(leaseExpiresAt);
    this.#lastHeartbeatSentAt = 0;
  }

  renew(leaseExpiresAt: string): void {
    this.#leaseExpiresAt = Math.max(this.#leaseExpiresAt, Date.parse(leaseExpiresAt));
  }

  get fence(): RunnerConnectionFence {
    const fence = this.#fence;
    if (!fence) throw new Error("The Runner connection has no fence yet");
    if (this.#leaseExpiresAt <= this.#now()) {
      throw new Error("The Runner connection lease has expired");
    }
    return fence;
  }

  /** Whether a frame the Host sent belongs to the connection we believe in. */
  accepts(fence: RunnerConnectionFence): boolean {
    return this.#fence !== undefined && sameRunnerConnectionFence(this.#fence, fence);
  }

  /**
   * A heartbeat timestamp the Host will accept. Two heartbeats inside the same
   * millisecond are indistinguishable from a replay, so the ledger advances the
   * clock itself rather than letting the Host refuse the connection.
   */
  heartbeatTimestamp(): string {
    const sentAt = Math.max(this.#now(), this.#lastHeartbeatSentAt + 1);
    this.#lastHeartbeatSentAt = sentAt;
    return new Date(sentAt).toISOString();
  }
}

/** The shape a runtime reports for one of its modules. */
export function moduleReadiness(
  module: RunnerModuleReadinessReport["module"],
  readiness: RunnerModuleReadinessReport["readiness"],
  detail: string | null = null,
): RunnerModuleReadinessReport {
  return { checkedAt: new Date().toISOString(), detail, module, readiness };
}
