import { isResendableControlCommand } from "@opensteer/database/command-delivery";
import type { CommandId, EnvironmentId, RunId, ThreadId, TriggerId } from "@opensteer/core";
import { OpensteerError } from "@opensteer/core";
import type {
  BlockedCommandClaim,
  ClaimedCommand,
  CommandRow,
  OpensteerStore,
  PendingCommandRow,
} from "@opensteer/database";
import { CoalescedWake } from "@opensteer/shared/coalescedWake";
import { systemClock, type Clock } from "@opensteer/shared/clock";
/**
 * `held`: the command's work waits for something that wakes it (a paused chat that is back), not
 * for time. It goes back to pending with no backoff timer and no error, and is not listed while
 * it waits.
 */
export type DispatchDisposition = "retry" | "held" | "uncertain" | "failed";
export class CommandDispatchError extends Error {
  readonly disposition: DispatchDisposition;
  readonly provenNotStarted: boolean;
  constructor(
    message: string,
    disposition: DispatchDisposition,
    options?: {
      readonly cause?: unknown;
      readonly provenNotStarted?: boolean | undefined;
    },
  ) {
    super(message, options);
    this.name = "CommandDispatchError";
    this.disposition = disposition;
    this.provenNotStarted = options?.provenNotStarted === true;
  }
}
export interface DurableCommandDispatcher {
  /**
   * Whether the command can be dispatched now. `dispatchingRuns` counts the
   * Runs already being dispatched to the same environment, which its Runner
   * has not yet accepted and so cannot count against its own capacity.
   */
  isAvailable(command: PendingCommandRow, dispatchingRuns: number): boolean;
  dispatch(command: CommandRow, signal: AbortSignal): Promise<void>;
}
export interface ExecutionCoordinatorStore extends Pick<
  OpensteerStore,
  "failCommand" | "listPendingCommands" | "markSteerUnknown" | "retryCommand"
> {
  claimCommand(
    commandId: CommandId,
    dispatcherId: string,
    options?: { readonly includeBlocked?: boolean },
  ): Promise<ClaimedCommand | BlockedCommandClaim | null>;
}
interface ExecutionCoordinatorOptions {
  readonly dispatcher: DurableCommandDispatcher;
  readonly dispatcherId: string;
  readonly maxConcurrentRuns: number;
  /** Independent bounded lane for short control RPCs targeting live Runs. */
  readonly maxConcurrentControls?: number;
  readonly maxConcurrentTriggerPrograms: number;
  readonly maxQueuedBytes: number;
  readonly maxQueuedCommands: number;
  /** Time and timers for dispatch backoff; defaults to the system clock. */
  readonly clock?: Clock;
  readonly onDispatchError?: (error: unknown, command: CommandRow) => void;
  /** The retry delay after a failed read or claim. */
  readonly pollIntervalMs?: number;
  readonly store: ExecutionCoordinatorStore;
}
interface QueueEntry {
  readonly bytes: number;
  readonly command: PendingCommandRow;
}
interface DispatchBackoff {
  attempts: number;
  nextEligibleAt: number;
  /** When it was last recorded, on the coordinator's own count of rejections. */
  recorded: number;
  /** The environment the command was refused by, when it names one. */
  environmentId: EnvironmentId | null;
}
const dispatchBackoffBaseMs = 1_000;
const dispatchBackoffMaxMs = 30_000;
export class ExecutionCoordinator {
  readonly #dispatcher: DurableCommandDispatcher;
  readonly #dispatcherId: string;
  readonly #maxConcurrentRuns: number;
  readonly #maxConcurrentControls: number;
  readonly #maxConcurrentTriggerPrograms: number;
  readonly #maxQueuedBytes: number;
  readonly #maxQueuedCommands: number;
  readonly #clock: Clock;
  readonly #now: () => number;
  readonly #onDispatchError: ExecutionCoordinatorOptions["onDispatchError"];
  readonly #pollIntervalMs: number;
  readonly #store: ExecutionCoordinatorStore;
  readonly #dispatchBackoff = new Map<CommandId, DispatchBackoff>();
  #backoffRecords = 0;
  readonly #dispatchingIds = new Set<CommandId>();
  readonly #queuedIds = new Set<CommandId>();
  readonly #activeThreads = new Set<ThreadId>();
  readonly #activeTriggerIds = new Set<TriggerId>();
  readonly #blockedTriggerIds = new Set<TriggerId>();
  #wakeGeneration = 0;
  readonly #dispatchingRuns = new Map<EnvironmentId, number>();
  readonly #dispatchingRunIds = new Set<RunId>();
  readonly #queue: QueueEntry[] = [];
  #queuedBytes = 0;
  #activeRuns = 0;
  #activeControls = 0;
  #activeTriggerPrograms = 0;
  #controller: AbortController | undefined;
  #cancelPoll: (() => void) | undefined;
  #pollAt = 0;
  #readFailed = false;
  readonly #owedSettlements = new Map<CommandId, () => Promise<unknown>>();
  #claimFailed = false;
  readonly #reads = new CoalescedWake({
    run: () => this.#poll(),
    onSettled: () => this.#schedulePoll(),
    onError: () => {
      this.#readFailed = true;
    },
  });
  #stopping: Promise<void> | undefined;
  constructor(options: ExecutionCoordinatorOptions) {
    this.#dispatcher = options.dispatcher;
    this.#dispatcherId = options.dispatcherId;
    this.#maxConcurrentRuns = positiveInteger(options.maxConcurrentRuns, "maxConcurrentRuns");
    this.#maxConcurrentControls = positiveInteger(
      options.maxConcurrentControls ?? options.maxConcurrentRuns,
      "maxConcurrentControls",
    );
    this.#maxConcurrentTriggerPrograms = positiveInteger(
      options.maxConcurrentTriggerPrograms,
      "maxConcurrentTriggerPrograms",
    );
    this.#maxQueuedBytes = positiveInteger(options.maxQueuedBytes, "maxQueuedBytes");
    this.#maxQueuedCommands = positiveInteger(options.maxQueuedCommands, "maxQueuedCommands");
    this.#clock = options.clock ?? systemClock;
    this.#now = this.#clock.now;
    this.#onDispatchError = options.onDispatchError;
    this.#pollIntervalMs = positiveInteger(options.pollIntervalMs ?? 500, "pollIntervalMs");
    this.#store = options.store;
  }
  start(): void {
    if (this.#controller)
      throw new OpensteerError({
        code: "conflict",
        message: "Coordinator already started",
      });
    this.#controller = new AbortController();
    this.wake();
  }
  /**
   * The environment's Runner says it can take work again (its person resumed
   * agents): what it refused meanwhile is retried now, not at its backoff.
   */
  wakeEnvironment(environmentId: EnvironmentId): void {
    for (const [commandId, backoff] of this.#dispatchBackoff)
      if (backoff.environmentId === environmentId) this.#dispatchBackoff.delete(commandId);
    this.wake();
  }

  wake(): void {
    if (!this.#controller || this.#controller.signal.aborted) return;
    this.#wakeGeneration += 1;
    this.#blockedTriggerIds.clear();
    this.#cancelPoll?.();
    this.#cancelPoll = undefined;
    this.#reads.wake();
  }
  async stop(): Promise<void> {
    if (this.#stopping) return this.#stopping;
    this.#stopping = this.#stop();
    return this.#stopping;
  }
  async #stop(): Promise<void> {
    this.#controller?.abort(new CoordinatorStoppedError());
    this.#cancelPoll?.();
    this.#cancelPoll = undefined;
    await this.#reads.stop();
    while (this.#activeRuns > 0 || this.#activeControls > 0 || this.#activeTriggerPrograms > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    this.#queue.length = 0;
    this.#queuedIds.clear();
    this.#activeTriggerIds.clear();
    this.#blockedTriggerIds.clear();
    this.#dispatchBackoff.clear();
    // Startup recovery returns dispatched resendable controls to pending.
    this.#owedSettlements.clear();
    this.#queuedBytes = 0;
    this.#controller = undefined;
    this.#stopping = undefined;
  }
  async #poll(): Promise<void> {
    this.#claimFailed = false;
    for (const [commandId, write] of this.#owedSettlements) {
      try {
        await write();
        this.#owedSettlements.delete(commandId);
      } catch {
        this.#claimFailed = true;
      }
    }
    const recordedBefore = this.#backoffRecords;
    const commands = await this.#store.listPendingCommands(this.#maxQueuedCommands);
    this.#readFailed = false;
    // Backoff is dispatch pacing for commands that are still pending. A command
    // that has left the listing can never be dispatched again, so its entry is
    // dropped and the map stays bounded by the queue it paces. A command being
    // dispatched is missing from a listing read meanwhile, and so is one
    // rejected since the read began, which its retry lists again.
    const pending = new Set(commands.map(({ id }) => id));
    for (const [id, backoff] of this.#dispatchBackoff) {
      if (!pending.has(id) && !this.#dispatchingIds.has(id) && backoff.recorded <= recordedBefore) {
        this.#dispatchBackoff.delete(id);
      }
    }
    for (const command of commands) {
      if (this.#queuedIds.has(command.id)) continue;
      const bytes = Buffer.byteLength(JSON.stringify(command.payload), "utf8");
      if (
        this.#queue.length >= this.#maxQueuedCommands ||
        this.#queuedBytes + bytes > this.#maxQueuedBytes
      ) {
        break;
      }
      this.#queue.push({
        bytes,
        command,
      });
      this.#queuedIds.add(command.id);
      this.#queuedBytes += bytes;
    }
    this.#pump();
  }
  #pump(): void {
    const signal = this.#controller?.signal;
    if (!signal || signal.aborted) return;
    const now = this.#now();
    // A Run's dispatch slot is held until its Runner accepts it; a Trigger
    // program's until its result. They draw from separate pools, so a Trigger
    // program that is waiting on a manual Occurrence never keeps a Run queued.
    while (
      this.#activeRuns < this.#maxConcurrentRuns ||
      this.#activeControls < this.#maxConcurrentControls ||
      this.#activeTriggerPrograms < this.#maxConcurrentTriggerPrograms
    ) {
      const index = this.#queue.findIndex(({ command }) => {
        if (command.threadId === null) return false;
        if (!this.#poolHasRoom(command)) return false;
        // A retry lists its command again before its own dispatch settles.
        if (this.#dispatchingIds.has(command.id)) return false;
        if (command.type === "run.execute" && this.#activeThreads.has(command.threadId)) {
          return false;
        }
        const triggerId = commandTriggerId(command);
        if (
          triggerId !== null &&
          (this.#activeTriggerIds.has(triggerId) || this.#blockedTriggerIds.has(triggerId))
        ) {
          return false;
        }
        if ((this.#dispatchBackoff.get(command.id)?.nextEligibleAt ?? 0) > now) return false;
        return this.#dispatcher.isAvailable(
          command,
          command.environmentId ? (this.#dispatchingRuns.get(command.environmentId) ?? 0) : 0,
        );
      });
      if (index < 0) return;
      const [entry] = this.#queue.splice(index, 1);
      if (!entry || !entry.command.threadId) return;
      this.#queuedIds.delete(entry.command.id);
      this.#queuedBytes -= entry.bytes;
      const isTriggerProgram = entry.command.type === "trigger.execute";
      const isRun = entry.command.type === "run.execute";
      const environmentId = entry.command.environmentId;
      if (isTriggerProgram) this.#activeTriggerPrograms += 1;
      else if (isRun) this.#activeRuns += 1;
      else this.#activeControls += 1;
      if (isRun && environmentId) {
        this.#dispatchingRuns.set(
          environmentId,
          (this.#dispatchingRuns.get(environmentId) ?? 0) + 1,
        );
      }
      const dispatchingRunId = isRun ? entry.command.runId : null;
      if (dispatchingRunId) this.#dispatchingRunIds.add(dispatchingRunId);
      const locksThread = isRun;
      if (locksThread) this.#activeThreads.add(entry.command.threadId);
      const triggerId = commandTriggerId(entry.command);
      if (triggerId !== null) this.#activeTriggerIds.add(triggerId);
      this.#dispatchingIds.add(entry.command.id);
      const startedAtWake = this.#wakeGeneration;
      let outcome: ExecuteOutcome = { kind: "done" };
      void this.#execute(entry.command, signal)
        .then(
          (result) => {
            outcome = result;
          },
          () => {
            // A Store failure after claim is still contained here: detached
            // coordinator work must never become an unhandled rejection.
            outcome = { kind: "claim-failed" };
          },
        )
        .finally(() => {
          if (isTriggerProgram) this.#activeTriggerPrograms -= 1;
          else if (isRun) this.#activeRuns -= 1;
          else this.#activeControls -= 1;
          if (isRun && environmentId) {
            const dispatching = (this.#dispatchingRuns.get(environmentId) ?? 1) - 1;
            if (dispatching > 0) this.#dispatchingRuns.set(environmentId, dispatching);
            else this.#dispatchingRuns.delete(environmentId);
          }
          if (dispatchingRunId) this.#dispatchingRunIds.delete(dispatchingRunId);
          if (locksThread && entry.command.threadId)
            this.#activeThreads.delete(entry.command.threadId);
          if (triggerId !== null) this.#activeTriggerIds.delete(triggerId);
          this.#dispatchingIds.delete(entry.command.id);
          if (outcome.kind === "blocked") {
            const blockedId = outcome.triggerId ?? triggerId;
            if (this.#wakeGeneration === startedAtWake) {
              if (blockedId !== null) {
                this.#blockedTriggerIds.add(blockedId);
                this.#evictQueuedTrigger(blockedId);
              }
              this.#pump();
            } else {
              // A wake arrived while the claim was in flight: the firing ahead may have just ended.
              this.wake();
            }
          } else if (outcome.kind === "done") {
            this.wake();
            this.#pump();
          } else {
            this.#pump();
            this.#claimFailed = true;
            this.#schedulePoll();
          }
        })
        .catch(() => undefined);
    }
  }

  #evictQueuedTrigger(triggerId: TriggerId): void {
    for (let index = this.#queue.length - 1; index >= 0; index -= 1) {
      const queued = this.#queue[index];
      if (!queued || commandTriggerId(queued.command) !== triggerId) continue;
      this.#queue.splice(index, 1);
      this.#queuedIds.delete(queued.command.id);
      this.#queuedBytes -= queued.bytes;
    }
  }

  /**
   * The Runs whose execute command this Host is dispatching right now. A
   * Runner that attaches meanwhile cannot hold them yet, and they are not lost:
   * their own dispatch settles them.
   */
  dispatchingRunIds(): readonly RunId[] {
    return [...this.#dispatchingRunIds];
  }
  #poolHasRoom(command: CommandRow): boolean {
    if (command.type === "trigger.execute") {
      return this.#activeTriggerPrograms < this.#maxConcurrentTriggerPrograms;
    }
    if (command.type === "run.execute") return this.#activeRuns < this.#maxConcurrentRuns;
    return this.#activeControls < this.#maxConcurrentControls;
  }
  async #execute(command: CommandRow, signal: AbortSignal): Promise<ExecuteOutcome> {
    let claimed: Awaited<ReturnType<ExecutionCoordinatorStore["claimCommand"]>>;
    try {
      claimed = await this.#store.claimCommand(command.id, this.#dispatcherId, {
        includeBlocked: true,
      });
    } catch {
      // The atomic claim rolled back. Leave the durable pending command for a
      // bounded poll retry rather than failing the Run or rejecting detached.
      return { kind: "claim-failed" };
    }
    if (!claimed) return { kind: "claim-failed" };
    if (claimed.blocked) {
      return { kind: "blocked", triggerId: claimed.triggerId };
    }

    if (claimed.terminalFailure) {
      const failure = claimed.terminalFailure;
      const input = claimed.terminalFailureInput ?? "authority-cohort";
      await this.#settle(command.id, () => this.#store.failCommand(command.id, failure, input));
      return { kind: "done" };
    }
    try {
      await this.#dispatcher.dispatch(claimed.command, signal);
      this.#dispatchBackoff.delete(command.id);
    } catch (error) {
      const dispatchError = normalizeDispatchError(error);
      if (dispatchError.disposition === "held") {
        // Waiting is not an error: nothing is logged, and no timer is set. It is listed again
        // only once what it waits for is back, and that wakes the coordinator.
        this.#dispatchBackoff.delete(command.id);
        await this.#settle(command.id, () =>
          dispatchError.provenNotStarted
            ? this.#store.retryCommand(command.id, dispatchError, { provenNotStarted: true })
            : this.#store.retryCommand(command.id, dispatchError),
        );
        return { kind: "done" };
      }
      this.#onDispatchError?.(error, claimed.command);
      // A Run outlives the connection that lost its control command, and so
      // must the command: one a Runner records once by ID is sent again.
      const resendable =
        dispatchError.disposition === "uncertain" && isResendableControlCommand(command.type);
      if (dispatchError.disposition === "retry" || resendable) {
        await this.#settle(command.id, async () => {
          if (dispatchError.provenNotStarted) {
            await this.#store.retryCommand(command.id, dispatchError, { provenNotStarted: true });
          } else {
            await this.#store.retryCommand(command.id, dispatchError);
          }
          // Recorded once the retry has committed: a listing read before then
          // misses the command, and must not take it for one that left.
          this.#backOff(command.id, command.environmentId ?? null);
        });
      } else if (dispatchError.disposition === "failed") {
        await this.#settle(command.id, () =>
          dispatchError.provenNotStarted
            ? this.#store.failCommand(command.id, dispatchError.message, undefined, undefined, {
                provenNotStarted: true,
              })
            : this.#store.failCommand(command.id, dispatchError.message),
        );
      } else if (command.type === "run.steer") {
        await this.#settle(command.id, () =>
          this.#store.markSteerUnknown(command.id, dispatchError.message),
        );
      }
    }
    return { kind: "done" };
  }

  /**
   * The write that settles a claimed command. A claimed command is no longer
   * pending, so no listing will find it again: if this write fails it is owed,
   * kept here and retried on the poll interval until it commits.
   */
  async #settle(commandId: CommandId, write: () => Promise<unknown>): Promise<void> {
    try {
      await write();
      this.#owedSettlements.delete(commandId);
    } catch (error) {
      this.#owedSettlements.set(commandId, write);
      throw error;
    }
  }

  /**
   * A retryable rejection means the destination is not ready, not that the
   * command is wrong. Pacing each command's own retries keeps one unreachable
   * Runner from spinning the whole queue at poll speed.
   */
  #backOff(commandId: CommandId, environmentId: EnvironmentId | null): void {
    const entry = this.#dispatchBackoff.get(commandId) ?? {
      attempts: 0,
      nextEligibleAt: 0,
      recorded: 0,
      environmentId,
    };
    entry.nextEligibleAt =
      this.#now() + Math.min(dispatchBackoffBaseMs * 2 ** entry.attempts, dispatchBackoffMaxMs);
    entry.attempts += 1;
    entry.recorded = ++this.#backoffRecords;
    this.#dispatchBackoff.set(commandId, entry);
  }
  /**
   * Idle means no timer. A failed read or claim retries after the poll
   * interval; a command in backoff wakes the queue when it next becomes
   * eligible. Everything else is woken by the commit or Runner that changed it.
   */
  #schedulePoll(): void {
    const signal = this.#controller?.signal;
    if (!signal || signal.aborted) return;
    const now = this.#now();
    let at = this.#readFailed || this.#claimFailed ? now + this.#pollIntervalMs : Infinity;
    for (const { nextEligibleAt } of this.#dispatchBackoff.values())
      if (nextEligibleAt > now) at = Math.min(at, nextEligibleAt);
    if (at === Infinity || (this.#cancelPoll && this.#pollAt <= at)) return;
    this.#cancelPoll?.();
    this.#pollAt = at;
    this.#cancelPoll = this.#clock.schedule(() => {
      this.#cancelPoll = undefined;
      this.wake();
    }, at - now);
  }
}
class CoordinatorStoppedError extends Error {
  override readonly name = "CoordinatorStoppedError";

  constructor() {
    super("Coordinator stopped");
  }
}

type ExecuteOutcome =
  | { readonly kind: "done" }
  | { readonly kind: "claim-failed" }
  | { readonly kind: "blocked"; readonly triggerId: TriggerId };

function commandTriggerId(command: Pick<CommandRow, "authoritySource" | "type">): TriggerId | null {
  if (command.type !== "trigger.execute") return null;
  const source = command.authoritySource;
  if (
    source &&
    typeof source === "object" &&
    "kind" in source &&
    source.kind === "trigger" &&
    "triggerId" in source &&
    typeof source.triggerId === "string"
  ) {
    return source.triggerId as TriggerId;
  }
  return null;
}

function normalizeDispatchError(error: unknown): CommandDispatchError {
  if (error instanceof CommandDispatchError) return error;
  if (
    error instanceof CoordinatorStoppedError ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    return new CommandDispatchError("Dispatch was aborted before sending.", "retry", {
      cause: error,
      provenNotStarted: true,
    });
  }
  if (error instanceof OpensteerError && error.code !== "internal") {
    return new CommandDispatchError(error.message, error.retryable ? "retry" : "failed", {
      cause: error,
    });
  }
  return new CommandDispatchError("The AI engine could not be started.", "failed", {
    cause: error,
  });
}
function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1)
    throw new TypeError(`${name} must be a positive integer`);
  return value;
}
