import { OpensteerError } from "@opensteer/core";
import type {
  AgentEvent,
  Sequence,
  EnvironmentId,
  HarnessInstanceId,
  ModelSelection,
  ThreadAccessMode,
  Thread,
  ThreadId,
  UserId,
  WorkspaceId,
  Workspace,
} from "@opensteer/core";
import {
  OpensteerStore,
  type CommandRow,
  type AdmittedThreadDelegationRequest,
  type AdmittedThreadInputRequest,
  type CancelledThreadInput,
  type CancelThreadInputRequest,
  type DelegatedThreadResult,
  type DelegateThreadRequest,
  type EnqueuedThreadInput,
  type EnqueueThreadInputRequest,
  type MovedThreadInput,
  type MoveThreadInputRequest,
  type SteerThreadInputRequest,
  type RunnerControlInput,
} from "@opensteer/database";
import { KeyedAdmissionQueue } from "./admission-queue.js";

/** How many times stopping a task re-fences a tree that grew meanwhile. */
const maxCancelRounds = 8;

interface CommandServiceOptions {
  readonly store: OpensteerStore;
  readonly admission: KeyedAdmissionQueue;
  /** A durable execution was accepted, so dispatch can resume immediately. */
  readonly onExecutionQueued: (environmentId: EnvironmentId) => void;
  readonly onWorkspaceActivity?: (workspaceId: WorkspaceId) => void;
  readonly onWorkspaceEvent: (event: AgentEvent) => void;
}

export class CommandService {
  readonly #store: OpensteerStore;
  readonly #admission: KeyedAdmissionQueue;
  readonly #onExecutionQueued: (environmentId: EnvironmentId) => void;
  readonly #onWorkspaceActivity: ((workspaceId: WorkspaceId) => void) | undefined;
  readonly #onWorkspaceEvent: (event: AgentEvent) => void;

  constructor(options: CommandServiceOptions) {
    this.#store = options.store;
    this.#admission = options.admission;
    this.#onExecutionQueued = options.onExecutionQueued;
    this.#onWorkspaceActivity = options.onWorkspaceActivity;
    this.#onWorkspaceEvent = options.onWorkspaceEvent;
  }

  readonly #inputAdmissions = new Map<string, Promise<void>>();

  /** One Host owns a deployment. Coordinate external preflight with commit per input key,
   * without occupying the command queue or a database transaction while a producer answers.
   * Followers share a refusal; after success they use the store's exact replay validation.
   */
  async withInputAdmission<T>(
    requestedBy: UserId,
    idempotencyKey: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = JSON.stringify([requestedBy, idempotencyKey]);
    const pending = this.#inputAdmissions.get(key);
    if (pending) {
      await pending;
      return operation();
    }
    const result = Promise.resolve().then(operation);
    const settled = result.then(() => undefined);
    this.#inputAdmissions.set(key, settled);
    try {
      return await result;
    } finally {
      this.#inputAdmissions.delete(key);
      // The caller observes result's rejection; followers observe settled's rejection.
      void settled.catch(() => undefined);
    }
  }

  createThread(input: {
    readonly accessMode: ThreadAccessMode;
    readonly createdBy: UserId;
    readonly environmentId: EnvironmentId;
    readonly harnessInstanceId: HarnessInstanceId;
    readonly idempotencyKey: string;
    readonly modelSelection: ModelSelection;
    readonly parentThreadId?: ThreadId;
    readonly home?: boolean;
    readonly generateTitle?: true;
    readonly title: string;
    readonly workspaceId: WorkspaceId;
  }): Promise<{
    readonly asOfSequence: Sequence;
    readonly thread: Thread;
    readonly wasDuplicate: boolean;
  }> {
    return this.#admission.execute(
      [`workspace:${input.workspaceId}`],
      byteSize(input),
      async () => {
        const result = await this.#store.createThread(input);
        if (result.event) this.#onWorkspaceEvent(result.event);
        return result;
      },
    );
  }

  renameThread(
    input: Parameters<OpensteerStore["renameThread"]>[0],
  ): Promise<{ readonly asOfSequence: Sequence; readonly thread: Thread }> {
    return this.#admission.execute([threadKey(input.threadId)], byteSize(input), async () => {
      const result = await this.#store.renameThread(input);
      for (const event of result.events ?? []) this.#onWorkspaceEvent(event);
      return { asOfSequence: result.asOfSequence, thread: result.thread };
    });
  }

  setThreadIcon(
    input: Parameters<OpensteerStore["setThreadIcon"]>[0],
  ): Promise<{ readonly asOfSequence: Sequence; readonly thread: Thread }> {
    return this.#admission.execute([threadKey(input.threadId)], byteSize(input), async () => {
      const result = await this.#store.setThreadIcon(input);
      for (const event of result.events ?? []) this.#onWorkspaceEvent(event);
      return { asOfSequence: result.asOfSequence, thread: result.thread };
    });
  }

  setWorkspaceColor(input: Parameters<OpensteerStore["setWorkspaceColor"]>[0]): Promise<Workspace> {
    return this.#admission.execute([`workspace:${input.workspaceId}`], byteSize(input), () =>
      this.#store.setWorkspaceColor(input),
    );
  }

  updateThreadAccessMode(input: {
    readonly accessMode: ThreadAccessMode;
    readonly requestedBy: UserId;
    readonly threadId: ThreadId;
  }): Promise<{ readonly asOfSequence: Sequence; readonly thread: Thread }> {
    return this.#admission.execute([threadKey(input.threadId)], byteSize(input), async () => {
      const result = await this.#store.updateThreadAccessMode(input);
      if (result.event) this.#onWorkspaceEvent(result.event);
      return { asOfSequence: result.asOfSequence, thread: result.thread };
    });
  }

  updateThreadExecutionSelection(
    input: Parameters<OpensteerStore["updateThreadExecutionSelection"]>[0],
  ): Promise<{ readonly asOfSequence: Sequence; readonly thread: Thread }> {
    return this.#admission.execute([threadKey(input.threadId)], byteSize(input), async () => {
      const result = await this.#store.updateThreadExecutionSelection(input);
      if (result.event) this.#onWorkspaceEvent(result.event);
      return { asOfSequence: result.asOfSequence, thread: result.thread };
    });
  }

  enqueueThreadInput(input: EnqueueThreadInputRequest): Promise<EnqueuedThreadInput> {
    return this.#admission.execute([threadKey(input.threadId)], byteSize(input), async () => {
      const result = await this.#store.enqueueThreadInput(input);
      for (const event of result.events) this.#onWorkspaceEvent(event);
      const workspaceId = result.events[0]?.workspaceId;
      if (workspaceId && input.policy !== "report") this.#onWorkspaceActivity?.(workspaceId);
      if (!result.wasDuplicate && result.command?.environmentId) {
        this.#onExecutionQueued(result.command.environmentId);
      }
      return result;
    });
  }

  steerThreadInput(input: SteerThreadInputRequest): Promise<EnqueuedThreadInput> {
    return this.#admission.execute([threadKey(input.threadId)], byteSize(input), async () => {
      const result = await this.#store.steerThreadInput(input);
      for (const event of result.events) this.#onWorkspaceEvent(event);
      if (!result.wasDuplicate && result.command?.environmentId) {
        this.#onExecutionQueued(result.command.environmentId);
      }
      return result;
    });
  }

  cancelThreadInput(input: CancelThreadInputRequest): Promise<CancelledThreadInput> {
    return this.#admission.execute([threadKey(input.threadId)], byteSize(input), async () => {
      const result = await this.#store.cancelThreadInput(input);
      for (const event of result.events) this.#onWorkspaceEvent(event);
      return result;
    });
  }

  moveThreadInput(input: MoveThreadInputRequest): Promise<MovedThreadInput> {
    return this.#admission.execute([threadKey(input.threadId)], byteSize(input), async () => {
      const result = await this.#store.moveThreadInput(input);
      for (const event of result.events) this.#onWorkspaceEvent(event);
      return result;
    });
  }

  enqueueAdmittedThreadInput(input: AdmittedThreadInputRequest): Promise<EnqueuedThreadInput> {
    return this.#admission.execute([threadKey(input.input.threadId)], byteSize(input), async () => {
      const result = await this.#store.enqueueAdmittedThreadInput(input);
      for (const event of result.events) this.#onWorkspaceEvent(event);
      const workspaceId = result.events[0]?.workspaceId;
      if (workspaceId && input.input.policy !== "report") this.#onWorkspaceActivity?.(workspaceId);
      if (!result.wasDuplicate && result.command?.environmentId) {
        this.#onExecutionQueued(result.command.environmentId);
      }
      return result;
    });
  }

  resumeThreadInputQueue(input: {
    readonly idempotencyKey: string;
    readonly requestedBy: UserId;
    readonly threadId: ThreadId;
  }): Promise<{
    readonly asOfSequence: Sequence;
    readonly thread: Thread;
    readonly events: readonly AgentEvent[];
  }> {
    return this.#admission.execute([threadKey(input.threadId)], byteSize(input), async () => {
      const result = await this.#store.resumeThreadInputQueue(input);
      for (const event of result.events) this.#onWorkspaceEvent(event);
      const workspaceId = result.events[0]?.workspaceId;
      if (workspaceId) this.#onWorkspaceActivity?.(workspaceId);
      if (result.events.length > 0) this.#onExecutionQueued(result.thread.environmentId);
      return result;
    });
  }

  delegateThread(input: DelegateThreadRequest): Promise<DelegatedThreadResult> {
    return this.#admission.execute(delegationKeys(input), byteSize(input), async () => {
      const result = await this.#store.delegateThread(input);
      for (const event of result.events) this.#onWorkspaceEvent(event);
      const workspaceId = result.events[0]?.workspaceId;
      if (workspaceId) this.#onWorkspaceActivity?.(workspaceId);
      if (!result.wasDuplicate) this.#onExecutionQueued(result.run.environmentId);
      return result;
    });
  }

  delegateAdmittedThread(input: AdmittedThreadDelegationRequest): Promise<DelegatedThreadResult> {
    return this.#admission.execute(delegationKeys(input.input), byteSize(input), async () => {
      const result = await this.#store.delegateAdmittedThread(input);
      for (const event of result.events) this.#onWorkspaceEvent(event);
      const workspaceId = result.events[0]?.workspaceId;
      if (workspaceId) this.#onWorkspaceActivity?.(workspaceId);
      if (!result.wasDuplicate) this.#onExecutionQueued(result.run.environmentId);
      return result;
    });
  }

  async cancelAssignment(
    input: Parameters<OpensteerStore["cancelAssignment"]>[0],
  ): ReturnType<OpensteerStore["cancelAssignment"]> {
    const threadIds = new Set(await this.#store.assignmentTreeThreadIds(input.assignmentId));
    // A tree that keeps growing faster than it can be fenced is refused rather
    // than chased forever; the caller may try again.
    for (let round = 0; round < maxCancelRounds; round += 1) {
      const result = await this.#admission.execute(
        [`assignment:${input.assignmentId}`, ...[...threadIds].map(threadKey)],
        byteSize(input),
        async () => {
          const current = await this.#store.assignmentTreeThreadIds(input.assignmentId);
          if (current.some((threadId) => !threadIds.has(threadId))) {
            // A delegation admitted before us may have added descendants while
            // we waited. Release our keys before acquiring the enlarged set.
            for (const threadId of current) threadIds.add(threadId);
            return null;
          }
          const cancelled = await this.#store.cancelAssignment(input);
          for (const event of cancelled.events) this.#onWorkspaceEvent(event);
          for (const command of cancelled.interruptCommands) {
            if (command.environmentId) this.#onExecutionQueued(command.environmentId);
          }
          return cancelled;
        },
      );
      if (result) return result;
    }
    throw new OpensteerError({
      code: "conflict",
      message: "The task kept gaining work while it was being stopped; try again",
      retryable: true,
    });
  }

  /**
   * Done stops the task and its subtasks, so like a cancel it is admitted
   * under every Thread it stops, re-fencing a set that grew while it waited.
   */
  async setThreadDone(
    input: Parameters<OpensteerStore["setThreadDone"]>[0],
  ): ReturnType<OpensteerStore["setThreadDone"]> {
    const scope = () =>
      input.done ? this.#store.doneScopeThreadIds(input.threadId) : [input.threadId];
    const threadIds = new Set(await scope());
    for (let round = 0; round < maxCancelRounds; round += 1) {
      const result = await this.#admission.execute(
        [...threadIds].map(threadKey),
        byteSize(input),
        async () => {
          const current = await scope();
          if (current.some((threadId) => !threadIds.has(threadId))) {
            for (const threadId of current) threadIds.add(threadId);
            return null;
          }
          const done = await this.#store.setThreadDone(input);
          for (const event of done.events) this.#onWorkspaceEvent(event);
          for (const command of done.interruptCommands) {
            if (command.environmentId) this.#onExecutionQueued(command.environmentId);
          }
          return done;
        },
      );
      if (result) return result;
    }
    throw new OpensteerError({
      code: "conflict",
      message: "The task kept gaining work while it was being marked Done; try again",
      retryable: true,
    });
  }

  sendControl(
    input: RunnerControlInput,
  ): Promise<{ readonly command: CommandRow; readonly wasDuplicate: boolean }> {
    return this.#admission.execute([threadKey(input.threadId)], byteSize(input), async () => {
      const result = await this.#store.enqueueRunnerControl(input);
      for (const event of result.events) this.#onWorkspaceEvent(event);
      // Control commands are dispatched to a Runner, so the schema refuses to
      // enqueue one without an environment. The null branch is unreachable and
      // is left as a silence rather than a guess: nothing is nudged awake for a
      // Command nobody can claim anyway.
      const environmentId = result.command.environmentId;
      if (!result.wasDuplicate && result.command.status === "pending" && environmentId) {
        this.#onExecutionQueued(environmentId);
      }
      return result;
    });
  }
}

/** Commands for one Thread are admitted in the order they were sent. */
function threadKey(threadId: ThreadId): string {
  return `thread:${threadId}`;
}

/**
 * A delegation changes the Thread it comes from and the Thread it delegates
 * to, or creates that Thread in its Workspace.
 */
function delegationKeys(input: DelegateThreadRequest): readonly string[] {
  return [
    threadKey(input.origin.parentThreadId),
    input.threadId ? threadKey(input.threadId) : `workspace:${input.workspaceId}`,
  ];
}

function byteSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
