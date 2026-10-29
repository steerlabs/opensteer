import type { AgentEvent, CommandId, EnvironmentId, RunId, ThreadId } from "@opensteer/core";
import { OpensteerError } from "@opensteer/core";
import {
  isResendableControlCommand,
  type CommandRow,
  type OpensteerStore,
  type PendingCommandRow,
} from "@opensteer/database";

export type DispatchDisposition = "retry" | "uncertain" | "failed";

export class CommandDispatchError extends Error {
  readonly disposition: DispatchDisposition;

  constructor(
    message: string,
    disposition: DispatchDisposition,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "CommandDispatchError";
    this.disposition = disposition;
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

export type ExecutionCoordinatorStore = Pick<
  OpensteerStore,
  "claimCommand" | "failCommand" | "listPendingCommands" | "markSteerUnknown" | "retryCommand"
>;

interface ExecutionCoordinatorOptions {
  readonly dispatcher: DurableCommandDispatcher;
  readonly dispatcherId: string;
  readonly maxConcurrentRuns: number;
  /** Independent bounded lane for short control RPCs targeting live Runs. */
  readonly maxConcurrentControls?: number;
  readonly maxConcurrentTriggerPrograms: number;
  readonly maxQueuedBytes: number;
  readonly maxQueuedCommands: number;
  readonly now?: () => number;
  readonly onWorkspaceEvent?: (event: AgentEvent) => void;
  readonly onDispatchError?: (error: unknown, command: CommandRow) => void;
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
  readonly #now: () => number;
  readonly #onWorkspaceEvent: ((event: AgentEvent) => void) | undefined;
  readonly #onDispatchError: ExecutionCoordinatorOptions["onDispatchError"];
  readonly #pollIntervalMs: number;
  readonly #store: ExecutionCoordinatorStore;
  readonly #dispatchBackoff = new Map<CommandId, DispatchBackoff>();
  #backoffRecords = 0;
  readonly #dispatchingIds = new Set<CommandId>();
  readonly #queuedIds = new Set<CommandId>();
  readonly #activeThreads = new Set<ThreadId>();
  readonly #dispatchingRuns = new Map<EnvironmentId, number>();
  readonly #dispatchingRunIds = new Set<RunId>();
  readonly #queue: QueueEntry[] = [];
  #queuedBytes = 0;
  #activeRuns = 0;
  #activeControls = 0;
  #activeTriggerPrograms = 0;
  #controller: AbortController | undefined;
  #pollTimer: NodeJS.Timeout | undefined;
  #polling: Promise<void> | undefined;
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
    this.#now = options.now ?? Date.now;
    this.#onWorkspaceEvent = options.onWorkspaceEvent;
    this.#onDispatchError = options.onDispatchError;
    this.#pollIntervalMs = positiveInteger(options.pollIntervalMs ?? 500, "pollIntervalMs");
    this.#store = options.store;
  }

  start(): void {
    if (this.#controller)
      throw new OpensteerError({ code: "conflict", message: "Coordinator already started" });
    this.#controller = new AbortController();
    this.wake();
  }

  wake(): void {
    if (!this.#controller || this.#controller.signal.aborted || this.#polling) return;
    this.#polling = this.#poll()
      .catch(() => undefined)
      .finally(() => {
        this.#polling = undefined;
        this.#schedulePoll();
      });
  }

  async stop(): Promise<void> {
    if (this.#stopping) return this.#stopping;
    this.#stopping = this.#stop();
    return this.#stopping;
  }

  async #stop(): Promise<void> {
    this.#controller?.abort(new Error("Coordinator stopped"));
    if (this.#pollTimer) clearTimeout(this.#pollTimer);
    await this.#polling;
    while (this.#activeRuns > 0 || this.#activeControls > 0 || this.#activeTriggerPrograms > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    this.#queue.length = 0;
    this.#queuedIds.clear();
    this.#dispatchBackoff.clear();
    this.#queuedBytes = 0;
    this.#controller = undefined;
  }

  async #poll(): Promise<void> {
    const recordedBefore = this.#backoffRecords;
    const commands = await this.#store.listPendingCommands(this.#maxQueuedCommands);
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
      this.#queue.push({ bytes, command });
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
      const index = this.#queue.findIndex(
        ({ command }) =>
          command.threadId !== null &&
          this.#poolHasRoom(command) &&
          // A retry lists its command again before its own dispatch settles.
          !this.#dispatchingIds.has(command.id) &&
          (command.type !== "run.execute" || !this.#activeThreads.has(command.threadId)) &&
          (this.#dispatchBackoff.get(command.id)?.nextEligibleAt ?? 0) <= now &&
          this.#dispatcher.isAvailable(
            command,
            command.environmentId ? (this.#dispatchingRuns.get(command.environmentId) ?? 0) : 0,
          ),
      );
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
      this.#dispatchingIds.add(entry.command.id);
      let wakeImmediately = true;
      void this.#execute(entry.command, signal)
        .then(
          (result) => {
            wakeImmediately = result;
          },
          () => {
            // A Store failure after claim is still contained here: detached
            // coordinator work must never become an unhandled rejection.
            wakeImmediately = false;
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
          this.#dispatchingIds.delete(entry.command.id);
          this.#pump();
          if (wakeImmediately) this.wake();
          else this.#schedulePoll();
        })
        .catch(() => undefined);
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

  async #execute(command: CommandRow, signal: AbortSignal): Promise<boolean> {
    let claimed: Awaited<ReturnType<ExecutionCoordinatorStore["claimCommand"]>>;
    try {
      claimed = await this.#store.claimCommand(command.id, this.#dispatcherId);
    } catch {
      // The atomic claim rolled back. Leave the durable pending command for a
      // bounded poll retry rather than failing the Run or rejecting detached.
      return false;
    }
    if (!claimed) return true;
    for (const event of claimed.events) this.#onWorkspaceEvent?.(event);
    if (claimed.terminalFailure) {
      for (const event of await this.#store.failCommand(
        command.id,
        claimed.terminalFailure,
        claimed.terminalFailureInput ?? "authority-cohort",
      )) {
        this.#onWorkspaceEvent?.(event);
      }
      return true;
    }
    try {
      await this.#dispatcher.dispatch(claimed.command, signal);
      this.#dispatchBackoff.delete(command.id);
    } catch (error) {
      this.#onDispatchError?.(error, claimed.command);
      const dispatchError = normalizeDispatchError(error);
      // A Run outlives the connection that lost its control command, and so
      // must the command: one a Runner records once by ID is sent again.
      const resendable =
        dispatchError.disposition === "uncertain" && isResendableControlCommand(command.type);
      if (dispatchError.disposition === "retry" || resendable) {
        const events = await this.#store.retryCommand(command.id, dispatchError);
        // Recorded once the retry has committed: a listing read before then
        // misses the command, and must not take it for one that left.
        this.#backOff(command.id);
        for (const event of events) this.#onWorkspaceEvent?.(event);
      } else if (dispatchError.disposition === "failed") {
        for (const event of await this.#store.failCommand(command.id, dispatchError.message)) {
          this.#onWorkspaceEvent?.(event);
        }
      } else if (command.type === "run.steer") {
        for (const event of await this.#store.markSteerUnknown(command.id, dispatchError.message)) {
          this.#onWorkspaceEvent?.(event);
        }
      }
    }
    return true;
  }

  /**
   * A retryable rejection means the destination is not ready, not that the
   * command is wrong. Pacing each command's own retries keeps one unreachable
   * Runner from spinning the whole queue at poll speed.
   */
  #backOff(commandId: CommandId): void {
    const entry = this.#dispatchBackoff.get(commandId) ?? {
      attempts: 0,
      nextEligibleAt: 0,
      recorded: 0,
    };
    entry.nextEligibleAt =
      this.#now() + Math.min(dispatchBackoffBaseMs * 2 ** entry.attempts, dispatchBackoffMaxMs);
    entry.attempts += 1;
    entry.recorded = ++this.#backoffRecords;
    this.#dispatchBackoff.set(commandId, entry);
  }

  #schedulePoll(): void {
    const signal = this.#controller?.signal;
    if (!signal || signal.aborted || this.#pollTimer) return;
    this.#pollTimer = setTimeout(() => {
      this.#pollTimer = undefined;
      this.wake();
    }, this.#pollIntervalMs);
    this.#pollTimer.unref();
  }
}

function normalizeDispatchError(error: unknown): CommandDispatchError {
  if (error instanceof CommandDispatchError) return error;
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
