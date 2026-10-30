import {
  AgentEventSchema,
  OpensteerError,
  SequenceSchema,
  createId,
  type AgentEvent,
  type CommandId,
} from "@opensteer/core";
import type { CommandRow, PendingCommandRow } from "@opensteer/database";
import { describe, expect, it, vi } from "vitest";
import {
  CommandDispatchError,
  ExecutionCoordinator,
  type ExecutionCoordinatorStore,
} from "./execution-coordinator.js";

describe("ExecutionCoordinator", () => {
  it.each([
    [
      new OpensteerError({ code: "conflict", message: "The native conversation is missing" }),
      "The native conversation is missing",
    ],
    [new Error("private database failure"), "The AI engine could not be started."],
  ])("retains the dispatch cause and exposes only domain errors (%s)", async (error, message) => {
    const command = pendingCommand();
    const store = fakeStore(command, null);
    const onDispatchError = vi.fn();
    const coordinator = new ExecutionCoordinator({
      dispatcher: {
        isAvailable: () => true,
        dispatch: async () => {
          throw error;
        },
      },
      dispatcherId: "test",
      maxConcurrentRuns: 1,
      maxConcurrentTriggerPrograms: 1,
      maxQueuedBytes: 10_000,
      maxQueuedCommands: 10,
      onDispatchError,
      store: store.value,
    });
    coordinator.start();
    await waitFor(() => store.failCommand.mock.calls.length === 1);
    await coordinator.stop();
    expect(onDispatchError).toHaveBeenCalledWith(error, { ...command, status: "dispatched" });
    expect(store.failCommand).toHaveBeenCalledWith(command.id, message);
  });
  it("publishes the durable failure projection for a non-retryable dispatch", async () => {
    const command = pendingCommand();
    const event = failureEvent(command);
    const store = fakeStore(command, event);
    const onWorkspaceEvent = vi.fn();
    const coordinator = new ExecutionCoordinator({
      dispatcher: {
        isAvailable: () => true,
        dispatch: async () => {
          throw new CommandDispatchError("Harness is unavailable", "failed");
        },
      },
      dispatcherId: "test-dispatcher",
      maxConcurrentRuns: 1,
      maxConcurrentTriggerPrograms: 1,
      maxQueuedBytes: 10_000,
      maxQueuedCommands: 10,
      onWorkspaceEvent,
      pollIntervalMs: 10_000,
      store: store.value,
    });

    coordinator.start();
    await waitFor(() => store.failCommand.mock.calls.length === 1);
    await coordinator.stop();

    expect(store.retryCommand).not.toHaveBeenCalled();
    expect(store.failCommand).toHaveBeenCalledWith(command.id, "Harness is unavailable");
    expect(onWorkspaceEvent).toHaveBeenCalledWith(event);
  });

  it("projects durable starting and retry transitions around dispatch", async () => {
    const command = pendingCommand();
    const starting = statusEvent(command, "starting", "1");
    const queued = statusEvent(command, "queued", "2");
    const idle = {
      ...queued,
      data: { status: "idle" as const, inputQueuePaused: false, pendingRequests: 0 },
      eventId: createId("event"),
      runId: null,
      sequence: SequenceSchema.parse("3"),
      type: "thread.state-changed" as const,
    };
    const dispatched = { ...command, status: "dispatched" as const };
    const onWorkspaceEvent = vi.fn();
    const coordinator = new ExecutionCoordinator({
      dispatcher: {
        isAvailable: () => true,
        dispatch: async () => {
          expect(onWorkspaceEvent).toHaveBeenLastCalledWith(starting);
          throw new CommandDispatchError("Runner is offline", "retry");
        },
      },
      dispatcherId: "test-dispatcher",
      maxConcurrentRuns: 1,
      maxConcurrentTriggerPrograms: 1,
      maxQueuedBytes: 10_000,
      maxQueuedCommands: 10,
      onWorkspaceEvent,
      pollIntervalMs: 10_000,
      store: {
        claimCommand: vi.fn(async () => ({ command: dispatched, events: [starting] })),
        failCommand: vi.fn(async () => []),
        listPendingCommands: vi.fn().mockResolvedValueOnce([command]).mockResolvedValue([]),
        markSteerUnknown: vi.fn(async () => []),
        retryCommand: vi.fn(async () => [queued, idle]),
      },
    });

    coordinator.start();
    await waitFor(() => onWorkspaceEvent.mock.calls.length >= 2);
    await coordinator.stop();

    expect(onWorkspaceEvent.mock.calls.map(([event]) => event)).toEqual([starting, queued, idle]);
  });

  it.each(["authority-cohort", "seed-input"] as const)(
    "terminalizes lost authority with %s scope without dispatching",
    async (scope) => {
      const command = pendingCommand();
      const failure = failureEvent(command);
      const dispatch = vi.fn(async () => undefined);
      const failCommand = vi.fn(async () => [failure]);
      const onWorkspaceEvent = vi.fn();
      const coordinator = new ExecutionCoordinator({
        dispatcher: { dispatch, isAvailable: () => true },
        dispatcherId: "test-dispatcher",
        maxConcurrentRuns: 1,
        maxConcurrentTriggerPrograms: 1,
        maxQueuedBytes: 10_000,
        maxQueuedCommands: 10,
        onWorkspaceEvent,
        pollIntervalMs: 10_000,
        store: {
          claimCommand: vi.fn(async () => ({
            command: { ...command, status: "dispatched" as const },
            events: [],
            terminalFailure: "Execution authority is no longer active.",
            ...(scope === "seed-input" ? { terminalFailureInput: scope } : {}),
          })),
          failCommand,
          listPendingCommands: vi.fn().mockResolvedValueOnce([command]).mockResolvedValue([]),
          markSteerUnknown: vi.fn(async () => []),
          retryCommand: vi.fn(async () => []),
        },
      });

      coordinator.start();
      await waitFor(() => failCommand.mock.calls.length === 1);
      await coordinator.stop();

      expect(dispatch).not.toHaveBeenCalled();
      expect(failCommand).toHaveBeenCalledWith(
        command.id,
        "Execution authority is no longer active.",
        scope,
      );
      expect(onWorkspaceEvent).toHaveBeenCalledWith(failure);
    },
  );

  it("contains a transient claim failure and retries it on the bounded poll", async () => {
    const command = pendingCommand();
    const dispatched = { command: { ...command, status: "dispatched" as const }, events: [] };
    const claimCommand = vi
      .fn<ExecutionCoordinatorStore["claimCommand"]>()
      .mockRejectedValueOnce(new Error("transient database lock failure"))
      .mockResolvedValueOnce(dispatched);
    const failCommand = vi.fn(async () => []);
    const listPendingCommands = vi
      .fn<ExecutionCoordinatorStore["listPendingCommands"]>()
      .mockResolvedValueOnce([command])
      .mockResolvedValueOnce([command])
      .mockResolvedValue([]);
    const retryCommand = vi.fn(async () => []);
    const dispatch = vi.fn(async () => undefined);
    const coordinator = new ExecutionCoordinator({
      dispatcher: { dispatch, isAvailable: () => true },
      dispatcherId: "test-dispatcher",
      maxConcurrentRuns: 1,
      maxConcurrentTriggerPrograms: 1,
      maxQueuedBytes: 10_000,
      maxQueuedCommands: 10,
      pollIntervalMs: 5,
      store: {
        claimCommand,
        failCommand,
        listPendingCommands,
        markSteerUnknown: vi.fn(async () => []),
        retryCommand,
      },
    });

    coordinator.start();
    await waitFor(() => dispatch.mock.calls.length === 1);
    await coordinator.stop();

    expect(claimCommand).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledWith(dispatched.command, expect.any(AbortSignal));
    expect(failCommand).not.toHaveBeenCalled();
    expect(retryCommand).not.toHaveBeenCalled();
  });

  it("dispatches Runs from one Thread serially while using concurrency across Threads", async () => {
    const threadId = createId("thread");
    const first = pendingCommand({ threadId });
    const second = pendingCommand({ threadId });
    let releaseFirst!: () => void;
    const firstFinished = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const dispatch = vi.fn(async (command: CommandRow) => {
      if (command.id === first.id) await firstFinished;
    });
    const claimCommand = vi.fn(async (commandId: CommandRow["id"]) => {
      const command = commandId === first.id ? first : second;
      return { command: { ...command, status: "dispatched" as const }, events: [] };
    });
    const coordinator = new ExecutionCoordinator({
      dispatcher: { dispatch, isAvailable: () => true },
      dispatcherId: "test-dispatcher",
      maxConcurrentRuns: 2,
      maxConcurrentTriggerPrograms: 1,
      maxQueuedBytes: 10_000,
      maxQueuedCommands: 10,
      pollIntervalMs: 10_000,
      store: {
        claimCommand,
        failCommand: vi.fn(async () => []),
        listPendingCommands: vi.fn().mockResolvedValueOnce([first, second]).mockResolvedValue([]),
        markSteerUnknown: vi.fn(async () => []),
        retryCommand: vi.fn(async () => []),
      },
    });

    coordinator.start();
    await waitFor(() => dispatch.mock.calls.length === 1);
    expect(dispatch.mock.calls[0]?.[0].id).toBe(first.id);
    releaseFirst();
    await waitFor(() => dispatch.mock.calls.length === 2);
    await coordinator.stop();

    expect(dispatch.mock.calls.map(([command]) => command.id)).toEqual([first.id, second.id]);
  });

  it("dispatches a Trigger program while the Run pool is fully occupied", async () => {
    const run = pendingCommand();
    const triggerProgram = pendingCommand({ type: "trigger.execute" });
    let releaseRun!: () => void;
    const runFinished = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const dispatch = vi.fn(async (command: CommandRow) => {
      if (command.id === run.id) await runFinished;
    });
    const claimCommand = vi.fn(async (commandId: CommandRow["id"]) => {
      const command = commandId === run.id ? run : triggerProgram;
      return { command: { ...command, status: "dispatched" as const }, events: [] };
    });
    const coordinator = new ExecutionCoordinator({
      dispatcher: { dispatch, isAvailable: () => true },
      dispatcherId: "test-dispatcher",
      maxConcurrentRuns: 1,
      maxConcurrentTriggerPrograms: 1,
      maxQueuedBytes: 10_000,
      maxQueuedCommands: 10,
      pollIntervalMs: 10_000,
      store: {
        claimCommand,
        failCommand: vi.fn(async () => []),
        listPendingCommands: vi
          .fn()
          .mockResolvedValueOnce([run, triggerProgram])
          .mockResolvedValue([]),
        markSteerUnknown: vi.fn(async () => []),
        retryCommand: vi.fn(async () => []),
      },
    });

    coordinator.start();
    // The Run holds the only Run slot for its whole execution; the Trigger
    // program is dispatched from its own pool without waiting for it.
    await waitFor(() => dispatch.mock.calls.length === 2);
    expect(dispatch.mock.calls.map(([command]) => command.id)).toEqual([run.id, triggerProgram.id]);
    releaseRun();
    await coordinator.stop();
  });

  it("dispatches a steer alongside the turn it is meant to join", async () => {
    const threadId = createId("thread");
    const turn = pendingCommand({ threadId });
    const steer = pendingCommand({
      idempotencyKey: "test-steer",
      payload: { type: "run.steer" },
      threadId,
      type: "run.steer",
    });
    let releaseTurn!: () => void;
    const turnFinished = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const dispatch = vi.fn(async (command: CommandRow) => {
      if (command.id === turn.id) await turnFinished;
    });
    const claimCommand = vi.fn(async (commandId: CommandRow["id"]) => {
      const command = commandId === turn.id ? turn : steer;
      return { command: { ...command, status: "dispatched" as const }, events: [] };
    });
    const coordinator = new ExecutionCoordinator({
      dispatcher: { dispatch, isAvailable: () => true },
      dispatcherId: "test-dispatcher",
      maxConcurrentRuns: 2,
      maxConcurrentTriggerPrograms: 1,
      maxQueuedBytes: 10_000,
      maxQueuedCommands: 10,
      pollIntervalMs: 10_000,
      store: {
        claimCommand,
        failCommand: vi.fn(async () => []),
        listPendingCommands: vi.fn().mockResolvedValueOnce([turn, steer]).mockResolvedValue([]),
        markSteerUnknown: vi.fn(async () => []),
        retryCommand: vi.fn(async () => []),
      },
    });

    coordinator.start();
    await waitFor(() => dispatch.mock.calls.length === 2);
    expect(dispatch.mock.calls.map(([command]) => command.id)).toEqual([turn.id, steer.id]);
    releaseTurn();
    await coordinator.stop();
  });

  it("paces a command's retryable rejections instead of redispatching at poll speed", async () => {
    const command = pendingCommand();
    let clock = 1_700_000_000_000;
    const store = backoffStore(() => [command]);
    const dispatch = vi.fn(async () => {
      throw new CommandDispatchError("Runner is offline", "retry");
    });
    const coordinator = new ExecutionCoordinator({
      dispatcher: { isAvailable: () => true, dispatch },
      dispatcherId: "test-dispatcher",
      maxConcurrentRuns: 1,
      maxConcurrentTriggerPrograms: 1,
      maxQueuedBytes: 10_000,
      maxQueuedCommands: 10,
      now: () => clock,
      pollIntervalMs: 1,
      store: store.value,
    });

    coordinator.start();
    await waitFor(() => dispatch.mock.calls.length === 1);
    const polls = store.listPendingCommands.mock.calls.length;
    await waitFor(() => store.listPendingCommands.mock.calls.length >= polls + 5);
    expect(dispatch).toHaveBeenCalledTimes(1);

    clock += 1_000;
    await waitFor(() => dispatch.mock.calls.length === 2);
    await coordinator.stop();
    expect(store.retryCommand).toHaveBeenCalledTimes(2);
  });

  /*
   * A stop or a Request answer can be on the wire when the connection drops,
   * so its delivery is uncertain:
   * - leaving it dispatched loses it while the Run reattaches and goes on;
   * - a steer must never be sent twice, so only it becomes unknown.
   */
  it("sends an interrupt or Request answer again after an uncertain delivery", async () => {
    for (const type of ["run.interrupt", "request.respond"] as const) {
      const command = pendingCommand({ payload: { type }, type });
      const store = backoffStore(() => [command]);
      const dispatch = vi.fn(async () => {
        throw new CommandDispatchError("Runner connection was lost", "uncertain");
      });
      const coordinator = new ExecutionCoordinator({
        dispatcher: { isAvailable: () => true, dispatch },
        dispatcherId: "test-dispatcher",
        maxConcurrentRuns: 1,
        maxConcurrentTriggerPrograms: 1,
        maxQueuedBytes: 10_000,
        maxQueuedCommands: 10,
        pollIntervalMs: 1,
        store: store.value,
      });

      coordinator.start();
      await waitFor(() => store.retryCommand.mock.calls.length === 1);
      await coordinator.stop();
      expect(store.retryCommand).toHaveBeenCalledWith(command.id, expect.anything());
      expect(store.markSteerUnknown).not.toHaveBeenCalled();
    }
  });

  it("keeps pacing a command that polls cannot see while it is being dispatched", async () => {
    const command = pendingCommand();
    let clock = 1_700_000_000_000;
    // Like the database: a claimed command leaves the pending listing until
    // its retry commits, and polls keep running meanwhile.
    let listed = true;
    let releaseRetry = () => {};
    const claimCommand = vi.fn(async () => {
      listed = false;
      return { command: { ...command, status: "dispatched" as const }, events: [] };
    });
    const retryCommand = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        releaseRetry = resolve;
      });
      listed = true;
      return [];
    });
    const listPendingCommands = vi
      .fn<ExecutionCoordinatorStore["listPendingCommands"]>()
      .mockImplementation(async () => (listed ? [command] : []));
    const dispatch = vi.fn(async () => {
      throw new CommandDispatchError("Runner is offline", "retry");
    });
    const coordinator = new ExecutionCoordinator({
      dispatcher: { isAvailable: () => true, dispatch },
      dispatcherId: "test-dispatcher",
      maxConcurrentRuns: 1,
      maxConcurrentTriggerPrograms: 1,
      maxQueuedBytes: 10_000,
      maxQueuedCommands: 10,
      now: () => clock,
      pollIntervalMs: 1,
      store: {
        claimCommand,
        failCommand: vi.fn(async () => []),
        listPendingCommands,
        markSteerUnknown: vi.fn(async () => []),
        retryCommand,
      } as unknown as ExecutionCoordinatorStore,
    });
    const settleWhileUnlisted = async () => {
      await waitFor(() => retryCommand.mock.calls.length === dispatch.mock.calls.length);
      const polls = listPendingCommands.mock.calls.length;
      await waitFor(() => listPendingCommands.mock.calls.length >= polls + 3);
      releaseRetry();
      const settled = listPendingCommands.mock.calls.length;
      await waitFor(() => listPendingCommands.mock.calls.length >= settled + 5);
    };

    coordinator.start();
    await waitFor(() => dispatch.mock.calls.length === 1);
    await settleWhileUnlisted();
    expect(dispatch).toHaveBeenCalledTimes(1);

    clock += 1_000;
    await waitFor(() => dispatch.mock.calls.length === 2);
    await settleWhileUnlisted();
    clock += 1_000;
    const polls = listPendingCommands.mock.calls.length;
    await waitFor(() => listPendingCommands.mock.calls.length >= polls + 5);
    // The second rejection doubled the wait instead of starting over.
    expect(dispatch).toHaveBeenCalledTimes(2);

    clock += 1_000;
    await waitFor(() => dispatch.mock.calls.length === 3);
    await settleWhileUnlisted();
    await coordinator.stop();
  });

  it("keeps the backoff a command records while a listing that missed it is read", async () => {
    const first = pendingCommand();
    const second = pendingCommand();
    const clock = 1_700_000_000_000;
    let secondAvailable = false;
    let releaseFirst = () => {};
    let finishListing = (_commands: readonly PendingCommandRow[]) => {};
    let listings = 0;
    // The second listing's snapshot was taken while both commands were claimed.
    const listPendingCommands = vi
      .fn<ExecutionCoordinatorStore["listPendingCommands"]>()
      .mockImplementation(async () => {
        listings += 1;
        if (listings === 1) return [first, second];
        if (listings === 2) {
          return new Promise((resolve) => {
            finishListing = resolve;
          });
        }
        return [second];
      });
    const dispatch = vi.fn(async (command: CommandRow) => {
      if (command.id === first.id) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        return;
      }
      throw new CommandDispatchError("Runner is offline", "retry");
    });
    const coordinator = new ExecutionCoordinator({
      dispatcher: {
        isAvailable: (command) => command.id === first.id || secondAvailable,
        dispatch,
      },
      dispatcherId: "test-dispatcher",
      maxConcurrentRuns: 2,
      maxConcurrentTriggerPrograms: 1,
      maxQueuedBytes: 10_000,
      maxQueuedCommands: 10,
      now: () => clock,
      pollIntervalMs: 1,
      store: {
        claimCommand: vi.fn(async (id: CommandId) => ({
          command: { ...(id === first.id ? first : second), status: "dispatched" as const },
          events: [],
        })),
        failCommand: vi.fn(async () => []),
        listPendingCommands,
        markSteerUnknown: vi.fn(async () => []),
        retryCommand: vi.fn(async () => []),
      } as unknown as ExecutionCoordinatorStore,
    });

    coordinator.start();
    await waitFor(() => listings === 2 && dispatch.mock.calls.length === 1);
    // The second command is dispatched and rejected entirely within that read.
    secondAvailable = true;
    releaseFirst();
    await waitFor(() => dispatch.mock.calls.length === 2);
    finishListing([]);
    await waitFor(() => listings >= 8);
    // The clock never moves, so only a lost backoff could dispatch it again.
    expect(dispatch).toHaveBeenCalledTimes(2);
    await coordinator.stop();
  });

  it("keeps the backoff of a retry that commits while a listing that missed it is read", async () => {
    const command = pendingCommand();
    const clock = 1_700_000_000_000;
    let releaseRetry = () => {};
    let finishListing = (_commands: readonly PendingCommandRow[]) => {};
    let listings = 0;
    // The second listing's snapshot was taken before the retry committed.
    const listPendingCommands = vi
      .fn<ExecutionCoordinatorStore["listPendingCommands"]>()
      .mockImplementation(async () => {
        listings += 1;
        if (listings !== 2) return [command];
        return new Promise((resolve) => {
          finishListing = resolve;
        });
      });
    const retryCommand = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        releaseRetry = resolve;
      });
      return [];
    });
    const dispatch = vi.fn(async () => {
      throw new CommandDispatchError("Runner is offline", "retry");
    });
    const coordinator = new ExecutionCoordinator({
      dispatcher: { isAvailable: () => true, dispatch },
      dispatcherId: "test-dispatcher",
      maxConcurrentRuns: 1,
      maxConcurrentTriggerPrograms: 1,
      maxQueuedBytes: 10_000,
      maxQueuedCommands: 10,
      now: () => clock,
      pollIntervalMs: 1,
      store: {
        claimCommand: vi.fn(async () => ({
          command: { ...command, status: "dispatched" as const },
          events: [],
        })),
        failCommand: vi.fn(async () => []),
        listPendingCommands,
        markSteerUnknown: vi.fn(async () => []),
        retryCommand,
      } as unknown as ExecutionCoordinatorStore,
    });

    coordinator.start();
    await waitFor(() => retryCommand.mock.calls.length === 1 && listings === 2);
    releaseRetry();
    await waitFor(() => !coordinator.dispatchingRunIds().includes(command.runId!));
    finishListing([]);
    await waitFor(() => listings >= 8);
    // The clock never moves, so only a lost backoff could dispatch it again.
    expect(dispatch).toHaveBeenCalledTimes(1);
    await coordinator.stop();
  });

  it("never claims a control command again while its own dispatch is settling", async () => {
    const command = pendingCommand({ payload: { type: "run.interrupt" }, type: "run.interrupt" });
    const clock = 1_700_000_000_000;
    let listed = true;
    let resumeRetry = () => {};
    const claimCommand = vi.fn(async () => {
      listed = false;
      return { command: { ...command, status: "dispatched" as const }, events: [] };
    });
    // The retry has committed, so listings see the command again, before the
    // dispatch that rejected it has resumed.
    const retryCommand = vi.fn(async () => {
      listed = true;
      await new Promise<void>((resolve) => {
        resumeRetry = resolve;
      });
      return [];
    });
    const listPendingCommands = vi
      .fn<ExecutionCoordinatorStore["listPendingCommands"]>()
      .mockImplementation(async () => (listed ? [command] : []));
    const dispatch = vi.fn(async () => {
      throw new CommandDispatchError("Runner is offline", "retry");
    });
    const coordinator = new ExecutionCoordinator({
      dispatcher: { isAvailable: () => true, dispatch },
      dispatcherId: "test-dispatcher",
      maxConcurrentControls: 2,
      maxConcurrentRuns: 1,
      maxConcurrentTriggerPrograms: 1,
      maxQueuedBytes: 10_000,
      maxQueuedCommands: 10,
      now: () => clock,
      pollIntervalMs: 1,
      store: {
        claimCommand,
        failCommand: vi.fn(async () => []),
        listPendingCommands,
        markSteerUnknown: vi.fn(async () => []),
        retryCommand,
      } as unknown as ExecutionCoordinatorStore,
    });

    coordinator.start();
    await waitFor(() => retryCommand.mock.calls.length === 1);
    const polls = listPendingCommands.mock.calls.length;
    await waitFor(() => listPendingCommands.mock.calls.length >= polls + 5);
    expect(claimCommand).toHaveBeenCalledTimes(1);
    resumeRetry();
    const settled = listPendingCommands.mock.calls.length;
    await waitFor(() => listPendingCommands.mock.calls.length >= settled + 5);
    // The clock never moves: the recorded backoff still holds it.
    expect(dispatch).toHaveBeenCalledTimes(1);
    await coordinator.stop();
  });

  it("drops the backoff of a command that has left the pending listing", async () => {
    const command = pendingCommand();
    const clock = 1_700_000_000_000;
    let pending: readonly PendingCommandRow[] = [command];
    const store = backoffStore(() => pending);
    const dispatch = vi.fn(async () => {
      throw new CommandDispatchError("Runner is offline", "retry");
    });
    const coordinator = new ExecutionCoordinator({
      dispatcher: { isAvailable: () => true, dispatch },
      dispatcherId: "test-dispatcher",
      maxConcurrentRuns: 1,
      maxConcurrentTriggerPrograms: 1,
      maxQueuedBytes: 10_000,
      maxQueuedCommands: 10,
      now: () => clock,
      pollIntervalMs: 1,
      store: store.value,
    });

    coordinator.start();
    await waitFor(() => dispatch.mock.calls.length === 1);
    pending = [];
    const polls = store.listPendingCommands.mock.calls.length;
    await waitFor(() => store.listPendingCommands.mock.calls.length >= polls + 3);
    pending = [command];

    // The clock never moves: only pruning can make this command eligible again.
    await waitFor(() => dispatch.mock.calls.length === 2);
    await coordinator.stop();
  });
});

function backoffStore(pending: () => readonly PendingCommandRow[]) {
  const claimCommand = vi.fn(async (id: CommandId) => {
    const command = pending().find((candidate) => candidate.id === id);
    if (!command) return null;
    return { command: { ...command, status: "dispatched" as const }, events: [] };
  });
  const failCommand = vi.fn(async () => []);
  const listPendingCommands = vi
    .fn<ExecutionCoordinatorStore["listPendingCommands"]>()
    .mockImplementation(async () => pending());
  const retryCommand = vi.fn(async () => []);
  const markSteerUnknown = vi.fn(async () => []);
  return {
    listPendingCommands,
    markSteerUnknown,
    retryCommand,
    value: {
      claimCommand,
      failCommand,
      listPendingCommands,
      markSteerUnknown,
      retryCommand,
    } as unknown as ExecutionCoordinatorStore,
  };
}

function fakeStore(command: PendingCommandRow, event: AgentEvent | null) {
  const claimCommand = vi.fn(async () => ({
    command: { ...command, status: "dispatched" as const },
    events: [],
  }));
  const failCommand = vi.fn(async () => (event ? [event] : []));
  const listPendingCommands = vi
    .fn<ExecutionCoordinatorStore["listPendingCommands"]>()
    .mockResolvedValueOnce([command])
    .mockResolvedValue([]);
  const retryCommand = vi.fn(async () => []);
  const markSteerUnknown = vi.fn(async () => []);
  return {
    claimCommand,
    failCommand,
    listPendingCommands,
    retryCommand,
    value: { claimCommand, failCommand, listPendingCommands, markSteerUnknown, retryCommand },
  };
}

function pendingCommand(overrides: Partial<PendingCommandRow> = {}): PendingCommandRow {
  const now = new Date();
  return {
    requestResponseKeyVersion: null,
    actorPrincipalId: "pri_00000000-0000-4000-8000-000000000099" as CommandRow["actorPrincipalId"],
    attempts: 0,
    authoritySource: { kind: "user-session" },
    createdAt: now,
    dispatcherId: null,
    environmentId: createId("environment"),
    encryptedRequestResponse: null,
    id: createId("command"),
    idempotencyKey: "test-turn",
    lastError: null,
    payload: { type: "run.execute" },
    requestedBy: createId("user"),
    runHarnessInstanceId: null,
    runId: createId("run"),
    status: "pending",
    threadId: createId("thread"),
    type: "run.execute",
    updatedAt: now,
    ...overrides,
  };
}

function failureEvent(command: CommandRow): AgentEvent {
  if (!command.environmentId || !command.runId || !command.threadId) {
    throw new Error("Test command is missing durable identities");
  }
  return AgentEventSchema.parse({
    createdAt: new Date().toISOString(),
    data: {
      startedBy: {
        displayName: "Alex",
        kind: "human",
        userId: createId("user"),
        principalId: "test-principal",
      },
      code: "dispatch_failed",
      message: "The Run could not be dispatched",
      retryable: false,
      status: "failed",
    },
    environmentId: command.environmentId,
    eventId: createId("event"),
    runId: command.runId,
    sequence: SequenceSchema.parse("1"),
    threadId: command.threadId,
    type: "run.failed",
    workspaceId: createId("workspace"),
  });
}

function statusEvent(
  command: CommandRow,
  status: "queued" | "starting",
  eventSequence: string,
): AgentEvent {
  if (!command.environmentId || !command.runId || !command.threadId) {
    throw new Error("Test command is missing durable identities");
  }
  return AgentEventSchema.parse({
    createdAt: new Date().toISOString(),
    data: {
      status,
      startedBy: {
        displayName: "Alex",
        kind: "human",
        userId: createId("user"),
        principalId: "test-principal",
      },
    },
    environmentId: command.environmentId,
    eventId: createId("event"),
    runId: command.runId,
    sequence: SequenceSchema.parse(eventSequence),
    threadId: command.threadId,
    type: "run.status",
    workspaceId: createId("workspace"),
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Condition was not reached");
}
