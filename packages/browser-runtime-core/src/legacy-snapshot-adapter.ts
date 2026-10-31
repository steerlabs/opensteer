import { createHash } from "node:crypto";
import { browserStateImportRuntimeTimeoutMs } from "@opensteer/protocol";
import type {
  BrowserProfileSnapshot,
  BrowserOriginCaptureFailure,
} from "@opensteer/browser-profile/snapshot";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { AsyncMutex } from "./async.js";
import { BrowserRuntimeError } from "./errors.js";
import type { BrowserHost } from "./runtime.js";
import type {
  BrowserProfileAttachTicketClaims,
  BrowserProfileStateClient,
} from "./profile-state-client.js";
export { isProfileAttachTicketClaims } from "./profile-state-client.js";
export type { BrowserProfileStateClient } from "./profile-state-client.js";
const profileSnapshotTimeoutMs = 15_000;
const profileCloseTimeoutMs = browserStateImportRuntimeTimeoutMs + profileSnapshotTimeoutMs;
type CheckpointStage =
  "quiesce" | "imports" | "checkpoint-lock" | "snapshot" | "host-commit" | "browser-close";
export interface BrowserCheckpointFailure {
  readonly runtimeId: string;
  readonly profileId: string;
  readonly sessionId: string;
  readonly phase: "periodic" | "final";
  readonly stage: CheckpointStage;
  readonly elapsedMs: number;
  readonly error: BrowserRuntimeError;
}
interface LegacyOptions {
  readonly checkpointIntervalMs: number;
  readonly checkpointRetryMs: number;
  readonly idleProfileHostTimeoutMs: number;
  readonly runtimeId: string;
  readonly profileStateClient: BrowserProfileStateClient;
  shuttingDown(): boolean;
  current(): boolean;
  closeHost(): Promise<void>;
  quiesceHost(): Promise<void>;
  disposeHost(): Promise<void>;
  onCheckpointFailure(diagnostic: BrowserCheckpointFailure): void;
}
/** Whole-profile snapshots and their released lease/final-save semantics live only here. */
export class LegacySnapshotAdapter {
  private readonly options: LegacyOptions;
  private readonly checkpoints = new AsyncMutex();
  private checkpointTimer: NodeJS.Timeout | null = null;
  private closeTimer: NodeJS.Timeout | null = null;
  private cleanup: { readonly result: Promise<void> } | null = null;
  private snapshotExport: Promise<BrowserProfileSnapshot> | null = null;
  private finalSnapshotSaved = false;
  private profileDigest: string;
  private profileRevision: number;
  profileStateClaims: BrowserProfileAttachTicketClaims;
  constructor(
    claims: BrowserProfileAttachTicketClaims,
    state: { snapshot: BrowserProfileSnapshot; revision: number },
    options: LegacyOptions,
  ) {
    this.profileStateClaims = claims;
    this.profileDigest = snapshotDigest(state.snapshot);
    this.profileRevision = state.revision;
    this.options = options;
  }
  static load(client: BrowserProfileStateClient, claims: BrowserProfileAttachTicketClaims) {
    return client.load(claims);
  }
  cancelClose(): void {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
  }
  scheduleCheckpoint(host: BrowserHost): void {
    this.checkpointTimer = setTimeout(() => {
      let retryable = true;
      void this.checkpointInUse(host)
        .catch((error: unknown) => {
          retryable = !(error instanceof BrowserRuntimeError) || error.retryable;
        })
        .finally(() => {
          if (this.options.current()) {
            if (host.acceptingSessions && retryable) this.scheduleCheckpoint(host);
          }
        });
    }, this.options.checkpointIntervalMs);
    this.checkpointTimer.unref();
  }

  private checkpointInUse(host: BrowserHost): Promise<void> {
    const started = performance.now();
    let stage: CheckpointStage = "checkpoint-lock";
    return this.checkpoints
      .run(async () => {
        if (!host.acceptingSessions || host.sessions.size === 0) return;
        // Cookie imports rewrite one site's cookies in several steps; a save
        // between them would capture half a sign-in.
        stage = "snapshot";
        const { snapshot, failures } = await this.exportCheckpointSnapshot(host);
        const digest = snapshotDigest(snapshot);
        if (!host.acceptingSessions) return;
        if (digest === this.profileDigest) {
          this.reportOriginFailures("periodic", started, failures);
          return;
        }
        stage = "host-commit";
        this.profileRevision = await this.options.profileStateClient.commit(
          this.profileStateClaims,
          this.profileRevision,
          snapshot,
          true,
        );
        this.profileDigest = digest;
        this.reportOriginFailures("periodic", started, failures);
      })
      .catch((error: unknown) => {
        throw this.checkpointFailure("periodic", stage, started, error);
      });
  }

  scheduleHostClose(host: BrowserHost, delayMs = this.options.idleProfileHostTimeoutMs): void {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => {
      void this.options.closeHost().catch((error: unknown) => {
        const current = this.options.current() ? host : undefined;
        if (
          !this.options.shuttingDown() &&
          (!(error instanceof BrowserRuntimeError) || error.retryable) &&
          current?.generation === host.generation &&
          current.sessions.size === 0
        ) {
          this.scheduleHostClose(current, this.options.checkpointRetryMs);
        }
      });
    }, delayMs);
    this.closeTimer.unref();
  }

  async checkpointAndCloseHost(host: BrowserHost): Promise<void> {
    try {
      await this.cleanupHost(host, true);
    } catch (error) {
      const current = this.options.current() ? host : undefined;
      if (
        !this.options.shuttingDown() &&
        (!(error instanceof BrowserRuntimeError) || error.retryable) &&
        current?.generation === host.generation &&
        current.sessions.size === 0
      ) {
        this.scheduleHostClose(current, this.options.checkpointRetryMs);
      }
      throw error;
    }
  }

  cleanupHost(host: BrowserHost, checkpoint: boolean): Promise<void> {
    if (!this.options.current()) return Promise.resolve();
    // An expired attempt can still own a native operation. Do not overlap it
    // or silently restart its deadline when another caller asks to stop.
    if (this.cleanup) return this.cleanup.result;
    const controller = new AbortController();
    const started = performance.now();
    let stage: CheckpointStage = "quiesce";
    const operation = this.cleanupHostOnce(host, checkpoint, controller.signal, (next) => {
      stage = next;
    });
    const result = withTimeout(operation, profileCloseTimeoutMs, {
      timeoutError: () =>
        new BrowserRuntimeError(
          "conflict",
          `Browser profile close timed out during ${stage}; shutdown did not complete.`,
          {
            retryable: true,
            reason: `profile-checkpoint.${stage}-timeout`,
          },
        ),
    }).catch((error: unknown) => {
      controller.abort(error);
      throw checkpoint ? this.checkpointFailure("final", stage, started, error) : error;
    });
    const pending = { result };
    this.cleanup = pending;
    const release = () => {
      if (this.cleanup === pending) this.cleanup = null;
    };
    void operation.then(release, release);
    return result;
  }

  private async cleanupHostOnce(
    host: BrowserHost,
    checkpoint: boolean,
    signal: AbortSignal,
    stage: (next: CheckpointStage) => void,
  ): Promise<void> {
    const started = performance.now();
    if (!this.options.current()) return;
    host.acceptingSessions = false;
    host.passkeys?.close();
    host.signIns.close();
    if (this.checkpointTimer) clearTimeout(this.checkpointTimer);
    this.checkpointTimer = null;
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    await this.options.quiesceHost();
    signal.throwIfAborted();
    // The final commit is unconditional: it also ends the profile's lease grace.
    if (checkpoint && !this.finalSnapshotSaved) {
      // A periodic checkpoint may already hold checkpoints while waiting for
      // an import, so its lock cannot guard this deadline-aware drain.
      if (host.stateMutations.size > 0) {
        stage("imports");
        try {
          await withTimeout(
            Promise.allSettled(host.stateMutations.keys()),
            browserStateImportRuntimeTimeoutMs,
            {
              signal: AbortSignal.any([signal, ...host.stateMutations.values()]),
              timeoutError: () => new Error("Sign-in import drain timed out."),
            },
          );
        } catch (cause) {
          throw new BrowserRuntimeError(
            "conflict",
            "Could not save this browser profile because a sign-in import is still pending. Unsaved state remains in memory, and " +
              (this.options.shuttingDown()
                ? "shutdown did not complete."
                : "Opensteer will retry saving it automatically."),
            { cause, retryable: true, reason: "profile-checkpoint.import-pending" },
          );
        }
      }
      stage("checkpoint-lock");
      await this.checkpoints.run(async () => {
        signal.throwIfAborted();
        stage("snapshot");
        const { snapshot, failures } = await this.exportCheckpointSnapshot(host, signal);
        signal.throwIfAborted();
        stage("host-commit");
        try {
          this.profileRevision = await this.options.profileStateClient.commit(
            this.profileStateClaims,
            this.profileRevision,
            snapshot,
          );
        } catch (error) {
          if (error instanceof BrowserRuntimeError && error.reason?.startsWith("profile-state.")) {
            // A refused or lost commit cannot be replayed safely. Release the
            // quiesced browser so the next attachment restores durable state.
            // The commit stays the caller's error: it is why state went unsaved.
            await this.cleanupHostOnce(host, false, signal, () => undefined).catch(
              (disposal: unknown) =>
                this.checkpointFailure("final", "browser-close", started, disposal),
            );
          }
          throw error;
        }
        this.profileDigest = snapshotDigest(snapshot);
        // A successful final commit retires this lease. A later close failure
        // must retry disposal without attempting another commit on that lease.
        this.finalSnapshotSaved = true;
        this.reportOriginFailures("final", started, failures);
      });
    }
    signal.throwIfAborted();
    stage("browser-close");
    if (this.closeTimer) clearTimeout(this.closeTimer);
    await this.options.disposeHost();
  }

  private async exportCheckpointSnapshot(
    host: BrowserHost,
    signal?: AbortSignal,
  ): Promise<{ snapshot: BrowserProfileSnapshot; failures: BrowserOriginCaptureFailure[] }> {
    if (this.snapshotExport)
      throw new BrowserRuntimeError(
        "conflict",
        "A previous browser profile snapshot is still pending; unsaved state remains in memory.",
        {
          retryable: true,
          reason: "profile-checkpoint.snapshot-pending",
        },
      );
    const controller = new AbortController();
    const deadline = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const failures: BrowserOriginCaptureFailure[] = [];
    const operation = host.stateImports.run(async () => {
      deadline.throwIfAborted();
      return host.browser.exportSnapshot((failure) => failures.push(failure));
    });
    this.snapshotExport = operation;
    const release = () => {
      if (this.snapshotExport === operation) this.snapshotExport = null;
    };
    void operation.then(release, release);
    try {
      const snapshot = await withTimeout(operation, profileSnapshotTimeoutMs, {
        signal: deadline,
        timeoutError: () =>
          new BrowserRuntimeError(
            "conflict",
            "Browser profile snapshot timed out; unsaved state remains in memory.",
            {
              retryable: true,
              reason: "profile-checkpoint.snapshot-timeout",
            },
          ),
      });
      return { snapshot, failures };
    } catch (error) {
      // Native snapshot export has no cancellation API. It keeps the state
      // lock until it settles; its late result cannot initiate a commit.
      controller.abort(error);
      throw error;
    }
  }

  private reportOriginFailures(
    phase: BrowserCheckpointFailure["phase"],
    started: number,
    failures: readonly BrowserOriginCaptureFailure[],
  ): void {
    if (failures.length === 0) return;
    this.checkpointFailure(
      phase,
      "snapshot",
      started,
      new BrowserRuntimeError(
        "internal",
        `Browser profile saved incompletely: ${failures.length} site(s) could not be captured. Other sites and cookies were saved; the last captured state was retained where available.`,
        { retryable: true, reason: "profile-checkpoint.origins-incomplete" },
      ),
    );
  }

  private checkpointFailure(
    phase: BrowserCheckpointFailure["phase"],
    stage: CheckpointStage,
    started: number,
    cause: unknown,
  ): BrowserRuntimeError {
    const error =
      cause instanceof BrowserRuntimeError
        ? cause
        : new BrowserRuntimeError(
            "internal",
            `Browser profile checkpoint failed during ${stage}.`,
            {
              cause,
              retryable: true,
              reason: `profile-checkpoint.${stage}-failed`,
            },
          );

    try {
      this.options.onCheckpointFailure({
        runtimeId: this.options.runtimeId,
        profileId: this.profileStateClaims.identity.profileId,
        sessionId: this.profileStateClaims.sessionId,
        phase,
        stage,
        elapsedMs: performance.now() - started,
        error,
      });
    } catch {
      /* Reporting cannot change checkpoint ownership. */
    }
    return error;
  }
}
/**
 * Browsers list cookies and origins in no promised order, so the digest reads
 * them sorted: the same state never looks changed.
 */
function snapshotDigest(snapshot: BrowserProfileSnapshot): string {
  const cookies = snapshot.cookies
    .map((cookie) => JSON.stringify(cookie))
    .sort((left, right) => left.localeCompare(right));
  const origins = snapshot.origins
    .map((origin) => JSON.stringify(origin))
    .sort((left, right) => left.localeCompare(right));
  return createHash("sha256").update(JSON.stringify({ cookies, origins })).digest("hex");
}
