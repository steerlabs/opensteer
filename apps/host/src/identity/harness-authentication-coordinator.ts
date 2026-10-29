import {
  OpensteerError,
  type EnvironmentId,
  type ExecutionEnvironmentKind,
  type HarnessId,
  type HarnessInstanceId,
} from "@opensteer/core";
import type { HarnessAuthenticationState, HostToRunnerMessage } from "@opensteer/protocol";

const defaultMaximumLifetimeMs = 15 * 60_000;
const runnerNudgeTimeoutMs = 30_000;

type HarnessAuthenticationRequest = Extract<
  HostToRunnerMessage,
  { readonly type: "host.harness-authentication" }
>["request"];
type HarnessAuthenticationStartRequest = Extract<HarnessAuthenticationRequest, { action: "start" }>;

/**
 * One person's open request to sign an AI engine in on one managed Runner.
 *
 * An attempt records no progress of its own. Runner start is idempotent and
 * every registration replays every live attempt, so a stage marker here could
 * only ever be a second, staler copy of what the Runner already knows — and the
 * envelope's environmentStatus, not this record, is what tells a waiting browser
 * whether the Runner is reachable.
 */
interface HarnessAuthenticationAttempt {
  readonly connectionSlot?: string;
  readonly createdAt: number;
  readonly driverKind: HarnessId;
  readonly environmentId: EnvironmentId;
  readonly hardExpiresAt: number;
  readonly harnessInstanceId: HarnessInstanceId;
  readonly methodId: string;
}

export interface HarnessAuthenticationTarget {
  readonly environment: {
    readonly id: EnvironmentId;
    readonly kind: ExecutionEnvironmentKind;
  };
  readonly harness: HarnessAuthenticationStartRequest["harness"];
}

export interface HarnessAuthenticationEnvelope {
  readonly authentication: HarnessAuthenticationState;
  readonly environmentStatus: "connected" | "disconnected";
}

export interface HarnessAuthenticationHarnessSource {
  getHarnessInstance(harnessInstanceId: HarnessInstanceId): Promise<{
    readonly config: unknown;
    readonly driverKind: HarnessId;
    readonly enabled: boolean;
    readonly id: HarnessInstanceId;
    readonly name: string;
    readonly runtimeRevision: number;
    readonly sourceId: string;
    readonly stateKind: "ambient" | "isolated";
  } | null>;
}

export interface HarnessAuthenticationRunnerRegistry {
  isAvailable(environmentId: EnvironmentId): boolean;
  manageHarnessAuthentication(
    environmentId: EnvironmentId,
    request: HarnessAuthenticationRequest,
    signal: AbortSignal,
  ): Promise<HarnessAuthenticationState>;
}

/**
 * Owns the process-lifetime intent behind managed AI-engine authentication.
 *
 * Attempts are demand, not a cache of Runner state, and they carry no stage of
 * their own: every attempt is replayed on every Runner registration, and Runner
 * start is idempotent, so an attempt is either live or gone. What a waiting
 * browser needs to know while it waits comes from the envelope's environmentStatus.
 *
 * Their deadline is fixed at creation and polling can never move it: otherwise
 * a browser left open would become unbounded process-lifetime demand. Ready and
 * failed observations are deleted rather than retained because the Runner's
 * private home is the durable outcome; keeping terminal copies here would only
 * let stale process memory disagree with it.
 */
export class HarnessAuthenticationCoordinator {
  readonly #attempts = new Map<string, HarnessAuthenticationAttempt>();
  readonly #harnesses: HarnessAuthenticationHarnessSource;
  readonly #maximumLifetimeMs: number;
  readonly #now: () => number;
  readonly #runners: HarnessAuthenticationRunnerRegistry;

  constructor(options: {
    readonly harnesses: HarnessAuthenticationHarnessSource;
    readonly maximumLifetimeMs?: number;
    readonly now?: () => number;
    readonly runners: HarnessAuthenticationRunnerRegistry;
  }) {
    this.#harnesses = options.harnesses;
    this.#maximumLifetimeMs = options.maximumLifetimeMs ?? defaultMaximumLifetimeMs;
    this.#now = options.now ?? Date.now;
    this.#runners = options.runners;
  }

  /** Ensures one bounded attempt exists and starts it immediately when possible. */
  async ensure(
    target: HarnessAuthenticationTarget,
    signal: AbortSignal,
    // No default. Every caller names a method the profile's catalog actually
    // advertises; a "default" placeholder was a method no driver defines and
    // would have reached the Runner as an unsatisfiable request.
    selection: { readonly connectionSlot?: string; readonly methodId: string },
  ): Promise<HarnessAuthenticationEnvelope> {
    const attempt = this.#ensureAttempt(target, selection);
    if (!this.#runners.isAvailable(target.environment.id)) {
      return this.#envelope(target, false, { status: "not-started" });
    }

    const authentication = await this.#manage(
      target.environment.id,
      {
        action: "start",
        ...(selection.connectionSlot ? { connectionSlot: selection.connectionSlot } : {}),
        harness: target.harness,
        methodId: selection.methodId,
      },
      signal,
    );
    if (!authentication) return this.#envelope(target, false, { status: "not-started" });
    this.#deleteIfTerminal(attempt, authentication);
    return this.#envelope(target, true, authentication);
  }

  /**
   * Reads the Runner when attached. It deliberately creates no attempt, sends
   * no wake signal, and never updates the hard deadline of an existing attempt.
   */
  async read(
    target: HarnessAuthenticationTarget,
    signal: AbortSignal,
  ): Promise<HarnessAuthenticationEnvelope> {
    const attempt = this.#liveAttempt(target.environment.id, target.harness.id);
    const connected = this.#runners.isAvailable(target.environment.id);
    if (!connected) return this.#envelope(target, false, { status: "not-started" });

    const authentication = await this.#manage(
      target.environment.id,
      {
        action: "read",
        driverKind: target.harness.driverKind,
        harnessInstanceId: target.harness.id,
      },
      signal,
    );
    if (!authentication) return this.#envelope(target, false, { status: "not-started" });
    if (attempt) this.#deleteIfTerminal(attempt, authentication);
    return this.#envelope(target, true, authentication);
  }

  /** Removes demand first, then best-effort forwards cancellation when attached. */
  async cancel(
    target: HarnessAuthenticationTarget,
    signal: AbortSignal,
  ): Promise<HarnessAuthenticationEnvelope> {
    const attempt = this.#liveAttempt(target.environment.id, target.harness.id);
    if (attempt) this.#deleteAttempt(attempt);
    const connected = this.#runners.isAvailable(target.environment.id);
    if (!connected) return this.#envelope(target, false, { status: "not-started" });

    const authentication = await this.#manage(
      target.environment.id,
      {
        action: "cancel",
        driverKind: target.harness.driverKind,
        harnessInstanceId: target.harness.id,
      },
      signal,
    );
    if (!authentication) return this.#envelope(target, false, { status: "not-started" });
    return this.#envelope(target, true, authentication);
  }

  async submit(
    target: HarnessAuthenticationTarget,
    value: string,
    signal: AbortSignal,
  ): Promise<HarnessAuthenticationEnvelope> {
    if (value.length === 0) {
      throw new OpensteerError({ code: "bad_request", message: "Sign-in code is required" });
    }
    if (!this.#runners.isAvailable(target.environment.id)) {
      return this.#envelope(target, false, { status: "not-started" });
    }
    const authentication = await this.#manage(
      target.environment.id,
      {
        action: "submit",
        driverKind: target.harness.driverKind,
        harnessInstanceId: target.harness.id,
        value,
      },
      signal,
    );
    return authentication
      ? this.#envelope(target, true, authentication)
      : this.#envelope(target, false, { status: "not-started" });
  }

  async logout(
    target: HarnessAuthenticationTarget,
    signal: AbortSignal,
    connectionSlot?: string,
  ): Promise<HarnessAuthenticationEnvelope> {
    if (!this.#runners.isAvailable(target.environment.id)) {
      return this.#envelope(target, false, { status: "not-started" });
    }
    const authentication = await this.#manage(
      target.environment.id,
      {
        action: "logout",
        ...(connectionSlot ? { connectionSlot } : {}),
        harness: target.harness,
      },
      signal,
    );
    return authentication
      ? this.#envelope(target, true, authentication)
      : this.#envelope(target, false, { status: "not-started" });
  }

  async remove(target: HarnessAuthenticationTarget, signal: AbortSignal): Promise<void> {
    if (!this.#runners.isAvailable(target.environment.id)) {
      throw new OpensteerError({
        code: "conflict",
        message: "Reconnect this work location before removing the AI engine",
        retryable: true,
      });
    }
    const authentication = await this.#manage(
      target.environment.id,
      { action: "remove", harness: target.harness },
      signal,
    );
    if (!authentication) {
      throw new OpensteerError({
        code: "conflict",
        message: "The work location disconnected while removing the AI engine",
        retryable: true,
      });
    }
  }

  /**
   * Replays every still-live attempt whenever a managed Runner registers,
   * including one a Runner already accepted: a replacement sandbox has lost the
   * old device flow, and Runner start is idempotent on the same sandbox. That
   * is why an attempt needs no record of how far it got.
   */
  async onRunnerConnected(environmentId: EnvironmentId): Promise<void> {
    const attempts = this.#liveAttempts(environmentId);
    await Promise.all(attempts.map((attempt) => this.#startAfterRegistration(attempt)));
  }

  /** The lifecycle's synchronous, lazily-pruned interactive-demand predicate. */
  hasPendingAttempt(environmentId: EnvironmentId): boolean {
    return this.#liveAttempts(environmentId).length > 0;
  }

  #deleteAttempt(attempt: HarnessAuthenticationAttempt): void {
    const key = this.#key(attempt.environmentId, attempt.harnessInstanceId);
    if (this.#attempts.get(key) === attempt) this.#attempts.delete(key);
  }

  #deleteIfTerminal(
    attempt: HarnessAuthenticationAttempt,
    authentication: HarnessAuthenticationState,
  ): void {
    if (authentication.status === "ready" || authentication.status === "failed") {
      this.#deleteAttempt(attempt);
    }
  }

  #ensureAttempt(
    target: HarnessAuthenticationTarget,
    selection: { readonly connectionSlot?: string; readonly methodId: string },
  ): HarnessAuthenticationAttempt {
    const existing = this.#liveAttempt(target.environment.id, target.harness.id);
    if (
      existing &&
      existing.methodId === selection.methodId &&
      existing.connectionSlot === selection.connectionSlot
    ) {
      return existing;
    }
    if (existing) this.#deleteAttempt(existing);
    const createdAt = this.#now();
    const attempt: HarnessAuthenticationAttempt = {
      createdAt,
      ...(selection.connectionSlot ? { connectionSlot: selection.connectionSlot } : {}),
      driverKind: target.harness.driverKind,
      environmentId: target.environment.id,
      hardExpiresAt: createdAt + this.#maximumLifetimeMs,
      harnessInstanceId: target.harness.id,
      methodId: selection.methodId,
    };
    this.#attempts.set(this.#key(attempt.environmentId, attempt.harnessInstanceId), attempt);
    return attempt;
  }

  #envelope(
    _target: HarnessAuthenticationTarget,
    connected: boolean,
    authentication: HarnessAuthenticationState,
  ): HarnessAuthenticationEnvelope {
    return {
      authentication,
      environmentStatus: connected ? "connected" : "disconnected",
    };
  }

  #key(environmentId: EnvironmentId, harnessInstanceId: HarnessInstanceId): string {
    return `${environmentId}:${harnessInstanceId}`;
  }

  #liveAttempt(
    environmentId: EnvironmentId,
    harnessInstanceId: HarnessInstanceId,
  ): HarnessAuthenticationAttempt | undefined {
    const key = this.#key(environmentId, harnessInstanceId);
    const attempt = this.#attempts.get(key);
    if (attempt && attempt.hardExpiresAt <= this.#now()) {
      this.#attempts.delete(key);
      return undefined;
    }
    return attempt;
  }

  /**
   * Forwards one request to the Runner, reporting a Runner that left between
   * the connectivity check and the send as absent rather than as a conflict.
   *
   * That gap is unavoidable — connectedness is observed, not held — and the
   * browser asked about a Runner, not about a socket. Returning nothing lets the
   * caller report the Runner as disconnected instead of showing a 409 for a race
   * the person cannot act on.
   */
  async #manage(
    environmentId: EnvironmentId,
    request: HarnessAuthenticationRequest,
    signal: AbortSignal,
  ): Promise<HarnessAuthenticationState | undefined> {
    try {
      return await this.#runners.manageHarnessAuthentication(environmentId, request, signal);
    } catch (error) {
      if (isRunnerDetached(error)) return undefined;
      throw error;
    }
  }

  #liveAttempts(environmentId: EnvironmentId): HarnessAuthenticationAttempt[] {
    const now = this.#now();
    const live: HarnessAuthenticationAttempt[] = [];
    for (const [key, attempt] of this.#attempts) {
      if (attempt.hardExpiresAt <= now) {
        this.#attempts.delete(key);
      } else if (attempt.environmentId === environmentId) {
        live.push(attempt);
      }
    }
    return live;
  }

  async #startAfterRegistration(attempt: HarnessAuthenticationAttempt): Promise<void> {
    const harness = await this.#harnesses.getHarnessInstance(attempt.harnessInstanceId);
    if (!harness?.enabled || harness.driverKind !== attempt.driverKind) {
      // The attempt can never be started again, and nothing else would remove
      // it: DELETE resolves its target through the AI engine that just vanished
      // and so cannot reach this coordinator at all. Leaving it would hold the
      // managed Runner active for the rest of its lifetime with no way to stop,
      // so demand is dropped before the failure is reported.
      this.#deleteAttempt(attempt);
      throw new Error(`AI engine ${attempt.harnessInstanceId} is no longer available`);
    }
    // Resolving the current definition is asynchronous. Re-check identity and
    // expiry so an old nudge cannot revive or delete a replacement attempt.
    if (this.#liveAttempt(attempt.environmentId, attempt.harnessInstanceId) !== attempt) {
      return;
    }
    const authentication = await this.#manage(
      attempt.environmentId,
      {
        action: "start",
        ...(attempt.connectionSlot ? { connectionSlot: attempt.connectionSlot } : {}),
        harness: {
          config: harness.config,
          driverKind: harness.driverKind,
          id: harness.id,
          name: harness.name,
          runtimeRevision: harness.runtimeRevision,
          sourceId: harness.sourceId,
          stateKind: harness.stateKind,
        },
        methodId: attempt.methodId,
      },
      AbortSignal.timeout(runnerNudgeTimeoutMs),
    );
    if (authentication) this.#deleteIfTerminal(attempt, authentication);
  }
}

/**
 * The registry's one retryable conflict: the environment had no attached Runner
 * when the request was about to be sent.
 */
function isRunnerDetached(error: unknown): boolean {
  return error instanceof OpensteerError && error.code === "conflict" && error.retryable;
}
