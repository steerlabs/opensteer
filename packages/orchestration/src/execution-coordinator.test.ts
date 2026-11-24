import { OpensteerError, createId, type CommandId } from "@opensteer/core";
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
      new OpensteerError({
        code: "conflict",
        message: "The native conversation is missing",
      }),
      "The native conversation is missing",
    ],
    [new Error("private database failure"), "The AI engine could not be started."],
  ])("retains the dispatch cause and exposes only domain errors (%s)", async (error, message) => {
    const command = pendingCommand();
    const store = fakeStore(command);
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
    expect(onDispatchError).toHaveBeenCalledWith(error, {
      ...command,
      status: "dispatched",
    });
    expect(store.failCommand).toHaveBeenCalledWith(command.id, message);
  });
  it.each(["authority-cohort", "seed-input"] as const)(
    "terminalizes lost authority with %s scope without dispatching",
    async (scope) => {
      const command = pendingCommand();
      const dispatch = vi.fn(async () => undefined);
      const failCommand = vi.fn(async () => undefined);
      const coordinator = new ExecutionCoordinator({
        dispatcher: {
          dispatch,
          isAvailable: () => true,
        },
        dispatcherId: "test-dispatcher",
        maxConcurrentRuns: 1,
        maxConcurrentTriggerPrograms: 1,
        maxQueuedBytes: 10_000,
        maxQueuedCommands: 10,
        pollIntervalMs: 10_000,
        store: {
          claimCommand: vi.fn(async () => ({
            command: {
              ...command,
              status: "dispatched" as const,
            },
            events: [],
            terminalFailure: "Execution authority is no longer active.",
            ...(scope === "seed-input"
              ? {
                  terminalFailureInput: scope,
                }
              : {}),
          })),
          failCommand,
          listPendingCommands: vi.fn().mockResolvedValueOnce([command]).mockResolvedValue([]),
          markSteerUnknown: vi.fn(async () => undefined),
          retryCommand: vi.fn(async () => undefined),
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
    },
  );
  it("reads again at once for a command queued while a read was running", async () => {
    const command = pendingCommand();
    let finishFirstRead: (commands: PendingCommandRow[]) => void = () => undefined;
    const listPendingCommands = vi
      .fn<ExecutionCoordinatorStore["listPendingCommands"]>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirstRead = resolve;
          }),
      )
      .mockResolvedValueOnce([command])
      .mockResolvedValue([]);
    const dispatch = vi.fn(async () => undefined);
    const coordinator = new ExecutionCoordinator({
      dispatcher: {
        dispatch,
        isAvailable: () => true,
      },
      dispatcherId: "test",
      maxConcurrentRuns: 1,
      maxConcurrentTriggerPrograms: 1,
      maxQueuedBytes: 10_000,
      maxQueuedCommands: 10,
      // The fallback poll must not be what finds it.
      pollIntervalMs: 3_600_000,
      store: {
        ...fakeStore(command).value,
        claimCommand: vi.fn(async () => ({
          command: {
            ...command,
            status: "dispatched" as const,
          },
          events: [],
        })),
        listPendingCommands,
      },
    });
    coordinator.start();
    await waitFor(() => listPendingCommands.mock.calls.length === 1);
    coordinator.wake();
    finishFirstRead([]);
    await waitFor(() => dispatch.mock.calls.length === 1);
    await coordinator.stop();
  });
  it("starts again after stopping, and stops again", async () => {
    const listPendingCommands = vi
      .fn<ExecutionCoordinatorStore["listPendingCommands"]>()
      .mockResolvedValue([]);
    const coordinator = new ExecutionCoordinator({
      dispatcher: {
        dispatch: vi.fn(async () => undefined),
        isAvailable: () => true,
      },
      dispatcherId: "test",
      maxConcurrentRuns: 1,
      maxConcurrentTriggerPrograms: 1,
      maxQueuedBytes: 10_000,
      maxQueuedCommands: 10,
      pollIntervalMs: 1,
      store: {
        ...fakeStore(pendingCommand()).value,
        listPendingCommands,
      },
    });
    coordinator.start();
    await waitFor(() => listPendingCommands.mock.calls.length === 1);
    await coordinator.stop();
    const stoppedAt = listPendingCommands.mock.calls.length;
    coordinator.start();
    await waitFor(() => listPendingCommands.mock.calls.length === stoppedAt + 1);
    await coordinator.stop();

    // Only a stop that really ran lets it start a third time.
    coordinator.start();
    await coordinator.stop();
  });
  it("contains a transient claim failure and retries it on the bounded poll", async () => {
    const command = pendingCommand();
    const dispatched = {
      command: {
        ...command,
        status: "dispatched" as const,
      },
      events: [],
    };
    const claimCommand = vi
      .fn<ExecutionCoordinatorStore["claimCommand"]>()
      .mockRejectedValueOnce(new Error("transient database lock failure"))
      .mockResolvedValueOnce(dispatched);
    const failCommand = vi.fn(async () => undefined);
    const listPendingCommands = vi
      .fn<ExecutionCoordinatorStore["listPendingCommands"]>()
      .mockResolvedValueOnce([command])
      .mockResolvedValueOnce([command])
      .mockResolvedValue([]);
    const retryCommand = vi.fn(async () => undefined);
    const dispatch = vi.fn(async () => undefined);
    const coordinator = new ExecutionCoordinator({
      dispatcher: {
        dispatch,
        isAvailable: () => true,
      },
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
        markSteerUnknown: vi.fn(async () => undefined),
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
    const first = pendingCommand({
      threadId,
    });
    const second = pendingCommand({
      threadId,
    });
    let releaseFirst!: () => void;
    const firstFinished = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const dispatch = vi.fn(async (command: CommandRow) => {
      if (command.id === first.id) await firstFinished;
    });
    const claimCommand = vi.fn(async (commandId: CommandRow["id"]) => {
      const command = commandId === first.id ? first : second;
      return {
        command: {
          ...command,
          status: "dispatched" as const,
        },
        events: [],
      };
    });
    const coordinator = new ExecutionCoordinator({
      dispatcher: {
        dispatch,
        isAvailable: () => true,
      },
      dispatcherId: "test-dispatcher",
      maxConcurrentRuns: 2,
      maxConcurrentTriggerPrograms: 1,
      maxQueuedBytes: 10_000,
      maxQueuedCommands: 10,
      pollIntervalMs: 10_000,
      store: {
        claimCommand,
        failCommand: vi.fn(async () => undefined),
        listPendingCommands: vi.fn().mockResolvedValueOnce([first, second]).mockResolvedValue([]),
        markSteerUnknown: vi.fn(async () => undefined),
        retryCommand: vi.fn(async () => undefined),
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
    const triggerProgram = pendingCommand({
      type: "trigger.execute",
    });
    let releaseRun!: () => void;
    const runFinished = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const dispatch = vi.fn(async (command: CommandRow) => {
      if (command.id === run.id) await runFinished;
    });
    const claimCommand = vi.fn(async (commandId: CommandRow["id"]) => {
      const command = commandId === run.id ? run : triggerProgram;
      return {
        command: {
          ...command,
          status: "dispatched" as const,
        },
        events: [],
      };
    });
    const coordinator = new ExecutionCoordinator({
      dispatcher: {
        dispatch,
        isAvailable: () => true,
      },
      dispatcherId: "test-dispatcher",
      maxConcurrentRuns: 1,
      maxConcurrentTriggerPrograms: 1,
      maxQueuedBytes: 10_000,
      maxQueuedCommands: 10,
      pollIntervalMs: 10_000,
      store: {
        claimCommand,
        failCommand: vi.fn(async () => undefined),
        listPendingCommands: vi
          .fn()
          .mockResolvedValueOnce([run, triggerProgram])
          .mockResolvedValue([]),
        markSteerUnknown: vi.fn(async () => undefined),
        retryCommand: vi.fn(async () => undefined),
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
    const turn = pendingCommand({
      threadId,
    });
    const steer = pendingCommand({
      idempotencyKey: "test-steer",
      payload: {
        type: "run.steer",
      },
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
      return {
        command: {
          ...command,
          status: "dispatched" as const,
        },
        events: [],
      };
    });
    const coordinator = new ExecutionCoordinator({
      dispatcher: {
        dispatch,
        isAvailable: () => true,
      },
      dispatcherId: "test-dispatcher",
      maxConcurrentRuns: 2,
      maxConcurrentTriggerPrograms: 1,
      maxQueuedBytes: 10_000,
      maxQueuedCommands: 10,
      pollIntervalMs: 10_000,
      store: {
        claimCommand,
        failCommand: vi.fn(async () => undefined),
        listPendingCommands: vi.fn().mockResolvedValueOnce([turn, steer]).mockResolvedValue([]),
        markSteerUnknown: vi.fn(async () => undefined),
        retryCommand: vi.fn(async () => undefined),
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
    const time = manualClock();
    const store = backoffStore(() => [command]);
    const dispatch = vi.fn(async () => {
      throw new CommandDispatchError("Runner is offline", "retry");
    });
    const coordinator = new ExecutionCoordinator({
      dispatcher: {
        isAvailable: () => true,
        dispatch,
      },
      dispatcherId: "test-dispatcher",
      maxConcurrentRuns: 1,
      maxConcurrentTriggerPrograms: 1,
      maxQueuedBytes: 10_000,
      maxQueuedCommands: 10,
      clock: time.clock,
      pollIntervalMs: 1,
      store: store.value,
    });
    coordinator.start();
    await waitFor(() => dispatch.mock.calls.length === 1);
    await wakeRepeatedly(coordinator, () => store.listPendingCommands.mock.calls.length);
    expect(dispatch).toHaveBeenCalledTimes(1);
    // Backoff arms one timer for when the command is eligible; it never polls.
    await waitFor(() => time.timers().length > 0);
    expect(time.timers()).toEqual([1_000]);
    time.advance(1_000);
    await waitFor(() => dispatch.mock.calls.length === 2);
    await coordinator.stop();
    expect(store.retryCommand).toHaveBeenCalledTimes(2);
  });

  it("retries what a Runner refused at once when that Runner's computer resumes agents", async () => {
    const command = pendingCommand();
    const other = pendingCommand();
    const time = manualClock();
    let pending = [command, other];
    const store = backoffStore(() => pending);
    let refusing = true;
    const dispatch = vi.fn(async (sent: { id: string }) => {
      if (refusing) throw new CommandDispatchError("Agents are stopped on this computer", "retry");
      pending = pending.filter((candidate) => candidate.id !== sent.id);
    });
    const coordinator = new ExecutionCoordinator({
      dispatcher: { isAvailable: () => true, dispatch },
      dispatcherId: "test-dispatcher",
      maxConcurrentRuns: 2,
      maxConcurrentTriggerPrograms: 1,
      maxQueuedBytes: 10_000,
      maxQueuedCommands: 10,
      clock: time.clock,
      pollIntervalMs: 1,
      store: store.value,
    });
    coordinator.start();
    await waitFor(() => dispatch.mock.calls.length === 2);
    await waitFor(() => time.timers().length > 0);
    refusing = false;
    const dispatched = (id: string) =>
      dispatch.mock.calls.filter(([candidate]) => (candidate as { id: string }).id === id).length;
    // Only the resumed computer's work goes again, and without waiting out its backoff.
    coordinator.wakeEnvironment(command.environmentId!);
    await waitFor(() => dispatched(command.id) === 2);
    await wakeRepeatedly(coordinator, () => store.listPendingCommands.mock.calls.length);
    expect(dispatched(other.id)).toBe(1);
    await coordinator.stop();
  });

  /*
   * A stop or a Request answer can be on the wire when the connection drops,
   * so its delivery is uncertain:
   * - leaving it dispatched loses it while the Run reattaches and goes on;
   * - a steer must never be sent twice, so only it becomes unknown.
   */
  it("sends an interrupt or Request answer again after an uncertain delivery", async () => {
    for (const type of ["run.interrupt", "request.respond"] as const) {
      const command = pendingCommand({
        payload: {
          type,
        },
        type,
      });
      const store = backoffStore(() => [command]);
      const dispatch = vi.fn(async () => {
        throw new CommandDispatchError("Runner connection was lost", "uncertain");
      });
      const coordinator = new ExecutionCoordinator({
        dispatcher: {
          isAvailable: () => true,
          dispatch,
        },
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
    const time = manualClock();
    // A claimed command leaves the pending listing until its retry commits.
    // Other admissions may wake a read during that time.
    let listed = true;
    let releaseRetry = () => {};
    const claimCommand = vi.fn(async () => {
      listed = false;
      return {
        command: {
          ...command,
          status: "dispatched" as const,
        },
        events: [],
      };
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
      dispatcher: {
        isAvailable: () => true,
        dispatch,
      },
      dispatcherId: "test-dispatcher",
      maxConcurrentRuns: 1,
      maxConcurrentTriggerPrograms: 1,
      maxQueuedBytes: 10_000,
      maxQueuedCommands: 10,
      clock: time.clock,
      pollIntervalMs: 1,
      store: {
        claimCommand,
        failCommand: vi.fn(async () => undefined),
        listPendingCommands,
        markSteerUnknown: vi.fn(async () => undefined),
        retryCommand,
      } as unknown as ExecutionCoordinatorStore,
    });
    const settleWhileUnlisted = async () => {
      await waitFor(() => retryCommand.mock.calls.length === dispatch.mock.calls.length);
      const reads = listPendingCommands.mock.calls.length;
      coordinator.wake();
      await waitFor(() => listPendingCommands.mock.calls.length > reads);
      releaseRetry();
      await wakeRepeatedly(coordinator, () => listPendingCommands.mock.calls.length);
    };
    coordinator.start();
    await waitFor(() => dispatch.mock.calls.length === 1);
    await settleWhileUnlisted();
    expect(dispatch).toHaveBeenCalledTimes(1);
    await waitFor(() => time.timers().length > 0);
    time.advance(1_000);
    await waitFor(() => dispatch.mock.calls.length === 2);
    await settleWhileUnlisted();
    await waitFor(() => time.timers().length > 0);
    time.advance(1_000);
    await wakeRepeatedly(coordinator, () => listPendingCommands.mock.calls.length);
    // The second rejection doubled the wait instead of starting over.
    expect(dispatch).toHaveBeenCalledTimes(2);
    await waitFor(() => time.timers().length > 0);
    time.advance(1_000);
    await waitFor(() => dispatch.mock.calls.length === 3);
    await settleWhileUnlisted();
    await coordinator.stop();
  });
  it("keeps the backoff a command records while a listing that missed it is read", async () => {
    const first = pendingCommand();
    const second = pendingCommand();
    const time = manualClock();
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
      clock: time.clock,
      pollIntervalMs: 1,
      store: {
        claimCommand: vi.fn(async (id: CommandId) => ({
          command: {
            ...(id === first.id ? first : second),
            status: "dispatched" as const,
          },
          events: [],
        })),
        failCommand: vi.fn(async () => undefined),
        listPendingCommands,
        markSteerUnknown: vi.fn(async () => undefined),
        retryCommand: vi.fn(async () => undefined),
      } as unknown as ExecutionCoordinatorStore,
    });
    coordinator.start();
    await waitFor(() => dispatch.mock.calls.length === 1);
    coordinator.wake();
    await waitFor(() => listings === 2);
    // The second command is dispatched and rejected entirely within that read.
    secondAvailable = true;
    releaseFirst();
    await waitFor(() => dispatch.mock.calls.length === 2);
    finishListing([]);
    await wakeRepeatedly(coordinator, () => listings);
    // The clock never moves, so only a lost backoff could dispatch it again.
    expect(dispatch).toHaveBeenCalledTimes(2);
    await coordinator.stop();
  });
  it("keeps the backoff of a retry that commits while a listing that missed it is read", async () => {
    const command = pendingCommand();
    const time = manualClock();
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
      dispatcher: {
        isAvailable: () => true,
        dispatch,
      },
      dispatcherId: "test-dispatcher",
      maxConcurrentRuns: 1,
      maxConcurrentTriggerPrograms: 1,
      maxQueuedBytes: 10_000,
      maxQueuedCommands: 10,
      clock: time.clock,
      pollIntervalMs: 1,
      store: {
        claimCommand: vi.fn(async () => ({
          command: {
            ...command,
            status: "dispatched" as const,
          },
          events: [],
        })),
        failCommand: vi.fn(async () => undefined),
        listPendingCommands,
        markSteerUnknown: vi.fn(async () => undefined),
        retryCommand,
      } as unknown as ExecutionCoordinatorStore,
    });
    coordinator.start();
    await waitFor(() => retryCommand.mock.calls.length === 1);
    coordinator.wake();
    await waitFor(() => listings === 2);
    releaseRetry();
    await waitFor(() => !coordinator.dispatchingRunIds().includes(command.runId!));
    finishListing([]);
    await wakeRepeatedly(coordinator, () => listings);
    // The clock never moves, so only a lost backoff could dispatch it again.
    expect(dispatch).toHaveBeenCalledTimes(1);
    await coordinator.stop();
  });
  it("never claims a control command again while its own dispatch is settling", async () => {
    const command = pendingCommand({
      payload: {
        type: "run.interrupt",
      },
      type: "run.interrupt",
    });
    const time = manualClock();
    let listed = true;
    let resumeRetry = () => {};
    const claimCommand = vi.fn(async () => {
      listed = false;
      return {
        command: {
          ...command,
          status: "dispatched" as const,
        },
        events: [],
      };
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
      dispatcher: {
        isAvailable: () => true,
        dispatch,
      },
      dispatcherId: "test-dispatcher",
      maxConcurrentControls: 2,
      maxConcurrentRuns: 1,
      maxConcurrentTriggerPrograms: 1,
      maxQueuedBytes: 10_000,
      maxQueuedCommands: 10,
      clock: time.clock,
      pollIntervalMs: 1,
      store: {
        claimCommand,
        failCommand: vi.fn(async () => undefined),
        listPendingCommands,
        markSteerUnknown: vi.fn(async () => undefined),
        retryCommand,
      } as unknown as ExecutionCoordinatorStore,
    });
    coordinator.start();
    await waitFor(() => retryCommand.mock.calls.length === 1);
    const reads = listPendingCommands.mock.calls.length;
    coordinator.wake();
    await waitFor(() => listPendingCommands.mock.calls.length > reads);
    expect(claimCommand).toHaveBeenCalledTimes(1);
    resumeRetry();
    await wakeRepeatedly(coordinator, () => listPendingCommands.mock.calls.length);
    // The clock never moves: the recorded backoff still holds it.
    expect(dispatch).toHaveBeenCalledTimes(1);
    await coordinator.stop();
  });
  it("retries a failed write after a claim instead of stranding the dispatched command", async () => {
    const command = pendingCommand({ payload: { type: "run.interrupt" }, type: "run.interrupt" });
    const time = manualClock();
    let listed = true;
    const store = backoffStore(() => (listed ? [command] : []));
    store.value.claimCommand = vi.fn(async () => {
      listed = false;
      return { command: { ...command, status: "dispatched" as const }, events: [] };
    }) as never;
    store.retryCommand
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockResolvedValue(undefined);
    const coordinator = new ExecutionCoordinator({
      dispatcher: {
        isAvailable: () => true,
        dispatch: vi.fn(async () => {
          throw new CommandDispatchError("Runner connection was lost", "uncertain");
        }),
      },
      dispatcherId: "test-dispatcher",
      maxConcurrentRuns: 1,
      maxConcurrentTriggerPrograms: 1,
      maxQueuedBytes: 10_000,
      maxQueuedCommands: 10,
      clock: time.clock,
      pollIntervalMs: 500,
      store: store.value,
    });
    coordinator.start();
    await waitFor(() => store.retryCommand.mock.calls.length === 1);
    // The command left the pending listing; only the owed write can settle it.
    await waitFor(() => time.timers().length > 0);
    time.advance(500);
    await waitFor(() => store.retryCommand.mock.calls.length === 2);
    await coordinator.stop();
  });
  it("drops the backoff of a command that has left the pending listing", async () => {
    const command = pendingCommand();
    const time = manualClock();
    let pending: readonly PendingCommandRow[] = [command];
    const store = backoffStore(() => pending);
    const dispatch = vi.fn(async () => {
      throw new CommandDispatchError("Runner is offline", "retry");
    });
    const coordinator = new ExecutionCoordinator({
      dispatcher: {
        isAvailable: () => true,
        dispatch,
      },
      dispatcherId: "test-dispatcher",
      maxConcurrentRuns: 1,
      maxConcurrentTriggerPrograms: 1,
      maxQueuedBytes: 10_000,
      maxQueuedCommands: 10,
      clock: time.clock,
      pollIntervalMs: 1,
      store: store.value,
    });
    coordinator.start();
    await waitFor(() => dispatch.mock.calls.length === 1);
    pending = [];
    const reads = store.listPendingCommands.mock.calls.length;
    coordinator.wake();
    await waitFor(() => store.listPendingCommands.mock.calls.length > reads);
    pending = [command];
    coordinator.wake();

    // The clock never moves: only pruning can make this command eligible again.
    await waitFor(() => dispatch.mock.calls.length === 2);
    await coordinator.stop();
  });

  it("retries an unsent firing when coordinator.stop() aborts pre-send setup and preserves uncertain dispatches (Z8)", async () => {
    const command = pendingCommand({
      payload: { type: "trigger.execute" },
      runId: null,
      type: "trigger.execute",
    });
    const store = fakeStore(command);
    let dispatchEntered = false;
    const coordinator = new ExecutionCoordinator({
      dispatcher: {
        isAvailable: () => true,
        dispatch: async (_command, signal) => {
          dispatchEntered = true;
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
          signal.throwIfAborted();
        },
      },
      dispatcherId: "test-dispatcher",
      maxConcurrentRuns: 1,
      maxConcurrentTriggerPrograms: 1,
      maxQueuedBytes: 10_000,
      maxQueuedCommands: 10,
      pollIntervalMs: 10_000,
      store: store.value,
    });
    coordinator.start();
    await waitFor(() => dispatchEntered);
    await coordinator.stop();
    expect(store.retryCommand).toHaveBeenCalledWith(
      command.id,
      expect.objectContaining({ disposition: "retry", provenNotStarted: true }),
      { provenNotStarted: true },
    );
    expect(store.failCommand).not.toHaveBeenCalled();

    // If bytes may already have left (uncertain), coordinator shutdown must NEVER retry it.
    const sentCommand = pendingCommand({
      payload: { type: "trigger.execute" },
      runId: null,
      type: "trigger.execute",
    });
    const sentStore = fakeStore(sentCommand);
    let sentEntered = false;
    const sentCoordinator = new ExecutionCoordinator({
      dispatcher: {
        isAvailable: () => true,
        dispatch: async (_command, signal) => {
          sentEntered = true;
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
          throw new CommandDispatchError("Lost connection after frame left", "uncertain");
        },
      },
      dispatcherId: "test-dispatcher",
      maxConcurrentRuns: 1,
      maxConcurrentTriggerPrograms: 1,
      maxQueuedBytes: 10_000,
      maxQueuedCommands: 10,
      pollIntervalMs: 10_000,
      store: sentStore.value,
    });
    sentCoordinator.start();
    await waitFor(() => sentEntered);
    await sentCoordinator.stop();
    expect(sentStore.retryCommand).not.toHaveBeenCalled();
    expect(sentStore.failCommand).not.toHaveBeenCalled();
  });

  it("attempts at most one claim per automation and schedules no poll while a firing is ahead (AB1)", async () => {
    const triggerId = createId("trigger");
    const waiting = Array.from({ length: 5 }, (_, index) =>
      pendingCommand({
        authoritySource: { kind: "trigger", triggerId },
        createdAt: new Date(1_700_000_000_000 + index * 1_000),
        payload: { occurrenceId: createId("triggerOccurrence"), type: "trigger.execute" },
        runId: null,
        type: "trigger.execute",
      }),
    );
    let firingAhead = true;
    const dispatched: CommandId[] = [];
    const listPendingCommands = vi.fn<ExecutionCoordinatorStore["listPendingCommands"]>(async () =>
      waiting.filter((cmd) => !dispatched.includes(cmd.id)),
    );
    const claimCommand = vi.fn(
      async (
        id: CommandId,
        _dispatcherId: string,
        options?: { readonly includeBlocked?: boolean },
      ) => {
        const found = waiting.find((cmd) => cmd.id === id);
        if (!found) return null;
        if (firingAhead) {
          return options?.includeBlocked ? { blocked: "firing-ahead" as const, triggerId } : null;
        }
        return {
          command: { ...found, status: "dispatched" as const },
        };
      },
    );
    const clock = manualClock();
    const coordinator = new ExecutionCoordinator({
      clock: clock.clock,
      dispatcher: {
        isAvailable: () => true,
        dispatch: async (command) => {
          dispatched.push(command.id);
          firingAhead = true;
        },
      },
      dispatcherId: "ab1-test",
      maxConcurrentRuns: 1,
      maxConcurrentTriggerPrograms: 4,
      maxQueuedBytes: 100_000,
      maxQueuedCommands: 100,
      pollIntervalMs: 500,
      store: {
        claimCommand: claimCommand as unknown as ExecutionCoordinatorStore["claimCommand"],
        failCommand: vi.fn(async () => undefined),
        listPendingCommands,
        markSteerUnknown: vi.fn(async () => undefined),
        retryCommand: vi.fn(async () => undefined),
      },
    });
    coordinator.start();
    await waitFor(() => claimCommand.mock.calls.length >= 1);
    // Let any microtasks settle.
    await new Promise<void>((resolve) => setImmediate(resolve));
    // At most one claim attempt for all 5 waiting firings of the same automation, and NO poll timer!
    expect(claimCommand).toHaveBeenCalledTimes(1);
    expect(clock.timers()).toEqual([]);
    const listsAfterBlocked = listPendingCommands.mock.calls.length;
    const claimsAfterBlocked = claimCommand.mock.calls.length;
    // Advance 2.5 seconds (5 poll intervals): zero statements!
    clock.advance(2_500);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(listPendingCommands).toHaveBeenCalledTimes(listsAfterBlocked);
    expect(claimCommand).toHaveBeenCalledTimes(claimsAfterBlocked);
    // When the firing ahead ends and wakes the coordinator, the earliest waiting firing runs at once.
    firingAhead = false;
    coordinator.wake();
    await waitFor(() => dispatched.length === 1);
    expect(dispatched).toEqual([waiting[0]!.id]);
    await coordinator.stop();
  });
  it("V1 (A1): a held firing the Runner refused after its frame left is retried as proven not started", async () => {
    const command = pendingCommand({
      payload: { type: "trigger.execute" },
      runId: null,
      type: "trigger.execute",
    });
    const store = fakeStore(command);
    const coordinator = new ExecutionCoordinator({
      dispatcher: {
        isAvailable: () => true,
        dispatch: async () => {
          throw new CommandDispatchError("Automation is held", "held", { provenNotStarted: true });
        },
      },
      dispatcherId: "test-dispatcher",
      maxConcurrentRuns: 1,
      maxConcurrentTriggerPrograms: 1,
      maxQueuedBytes: 10_000,
      maxQueuedCommands: 10,
      pollIntervalMs: 10_000,
      store: store.value,
    });
    coordinator.start();
    await waitFor(() => store.retryCommand.mock.calls.length === 1);
    await coordinator.stop();
    expect(store.retryCommand).toHaveBeenCalledWith(
      command.id,
      expect.objectContaining({ disposition: "held", provenNotStarted: true }),
      { provenNotStarted: true },
    );
  });
});
function backoffStore(pending: () => readonly PendingCommandRow[]) {
  const claimCommand = vi.fn(async (id: CommandId) => {
    const command = pending().find((candidate) => candidate.id === id);
    if (!command) return null;
    return {
      command: {
        ...command,
        status: "dispatched" as const,
      },
      events: [],
    };
  });
  const failCommand = vi.fn(async () => undefined);
  const listPendingCommands = vi
    .fn<ExecutionCoordinatorStore["listPendingCommands"]>()
    .mockImplementation(async () => pending());
  const retryCommand = vi.fn(async () => undefined);
  const markSteerUnknown = vi.fn(async () => undefined);
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
function fakeStore(command: PendingCommandRow) {
  const claimCommand = vi.fn(async () => ({
    command: {
      ...command,
      status: "dispatched" as const,
    },
    events: [],
  }));
  const failCommand = vi.fn(async () => undefined);
  const listPendingCommands = vi
    .fn<ExecutionCoordinatorStore["listPendingCommands"]>()
    .mockResolvedValueOnce([command])
    .mockResolvedValue([]);
  const retryCommand = vi.fn(async () => undefined);
  const markSteerUnknown = vi.fn(async () => undefined);
  return {
    claimCommand,
    failCommand,
    listPendingCommands,
    retryCommand,
    value: {
      claimCommand,
      failCommand,
      listPendingCommands,
      markSteerUnknown,
      retryCommand,
    },
  };
}
function pendingCommand(overrides: Partial<PendingCommandRow> = {}): PendingCommandRow {
  const now = new Date();
  return {
    requestResponseKeyVersion: null,
    actorPrincipalId: "pri_00000000-0000-4000-8000-000000000099" as CommandRow["actorPrincipalId"],
    attempts: 0,
    authoritySource: {
      kind: "user-session",
    },
    createdAt: now,
    dispatcherId: null,
    environmentId: createId("environment"),
    encryptedRequestResponse: null,
    id: createId("command"),
    idempotencyKey: "test-turn",
    lastError: null,
    payload: {
      type: "run.execute",
    },
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

/** Time that moves only when the test says so, with the timers it armed. */
function manualClock(start = 1_700_000_000_000) {
  let now = start;
  const scheduled = new Set<{ readonly at: number; readonly run: () => void }>();
  return {
    clock: {
      now: () => now,
      schedule(run: () => void, milliseconds: number) {
        const timer = { at: now + milliseconds, run };
        scheduled.add(timer);
        return () => scheduled.delete(timer);
      },
    },
    advance(milliseconds: number) {
      now += milliseconds;
      for (const timer of [...scheduled].sort((left, right) => left.at - right.at)) {
        if (timer.at > now) continue;
        scheduled.delete(timer);
        timer.run();
      }
    },
    timers: () => [...scheduled].map((timer) => timer.at - now),
  };
}

/** Other commits wake the queue meanwhile; a held backoff must survive each read. */
async function wakeRepeatedly(
  coordinator: ExecutionCoordinator,
  reads: () => number,
  times = 5,
): Promise<void> {
  for (let wake = 0; wake < times; wake += 1) {
    const before = reads();
    coordinator.wake();
    await waitFor(() => reads() > before);
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Condition was not reached");
}
