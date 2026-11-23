import {
  AgentConnectionStore,
  TriggerStore,
  type BlockedCommandClaim,
  type ClaimedCommand,
} from "@opensteer/database";
import { describeStore } from "@opensteer/database/test-support/store";
import { ExecutionCoordinator, type ExecutionCoordinatorStore } from "@opensteer/orchestration";
import type { CommandId } from "@opensteer/core";
import { expect, vi } from "vitest";
import { connection, serveMcp } from "../mcp/connection-caller.test-support.js";

const script = {
  interpreter: null,
  text: "console.log('ok')",
} as const;

describeStore(
  "an automation change takes the connection as it is inside the store's fence",
  (it) => {
    const cases = [
      ["the connection's mode was lowered", { accessMode: "approval-required" as const }],
      [
        "the connection was narrowed to selected",
        { grant: { scope: "selected" as const, tasks: true, resources: [] } },
      ],
    ] as const;
    for (const [name, change] of cases)
      it(`refuses to define an automation on the person's task once ${name} after the MCP check`, async ({
        storeFixture,
      }) => {
        const f = await storeFixture.startRunFixture("automation-fence");
        const { database, store } = storeFixture;
        const url = await serveMcp(storeFixture);
        const agent = await connection(store, url, {
          userId: f.userId,
          accessMode: "full-access",
          grant: { scope: "everything" },
        });
        await database
          .updateTable("threads")
          .set({ accessMode: "full-access" })
          .where("id", "=", f.threadId)
          .execute();
        const create = (key: string) =>
          new TriggerStore(database).create({
            actorThreadId: null,
            // What the MCP layer admitted the caller under, before the change committed.
            actorAccessMode: "full-access",
            actorConnectionId: agent.id,
            anchorThreadId: f.threadId,
            createdBy: f.userId,
            idempotencyKey: key,
            name: `Automation ${key}`,
            script,
            source: {
              kind: "schedule",
              schedule: { expression: "0 9 * * *", kind: "cron", timezone: "UTC" },
            },
          });
        // Before the change the same call defines it.
        expect((await create("before")).trigger.id).toBeTruthy();
        await new AgentConnectionStore(database).update(f.userId, {
          connectionId: agent.id,
          expectedRevision: 1,
          ...change,
        });
        await expect(create("after")).rejects.toMatchObject({ code: "forbidden" });
        await expect(create("before")).rejects.toMatchObject({ code: "forbidden" });
        expect(
          await database
            .selectFrom("triggers")
            .select("name")
            .where("originConnectionId", "=", agent.id)
            .execute(),
        ).toEqual([{ name: "Automation before" }]);
      });

    it("runs zero statements while waiting firings sit behind a running firing and wakes on every ending (AB1)", async ({
      storeFixture,
    }) => {
      const f = await storeFixture.startRunFixture("ab1-zero-poll");
      const { database, store } = storeFixture;
      const triggers = new TriggerStore(database);
      const routeKey = "whk_ab1_zero_poll_123456789012345678901234";
      const created = await triggers.create({
        actorThreadId: null,
        anchorThreadId: f.threadId,
        createdBy: f.userId,
        idempotencyKey: "ab1-webhook",
        name: "AB1 zero-poll webhook",
        script,
        source: { kind: "webhook" },
        webhookRouteKey: routeKey,
      });

      const enqueueOne = async (tag: string) =>
        (
          await triggers.enqueueWebhook({
            headers: {},
            method: "POST",
            rawBody: Buffer.from(tag, "utf8"),
            routeKey,
          })
        ).occurrence;

      const o1 = await enqueueOne("f1");
      const o2 = await enqueueOne("f2");
      const o3 = await enqueueOne("f3");
      const o4 = await enqueueOne("f4");
      const o5 = await enqueueOne("f5");
      const o6 = await enqueueOne("f6");

      let boot = "boot-ab1-1";
      const started: { commandId: CommandId; executionGeneration: number; occurrenceId: string }[] =
        [];
      let listCalls = 0;
      let claimCalls = 0;
      const observedStore: ExecutionCoordinatorStore = {
        listPendingCommands: async (limit) => {
          listCalls += 1;
          return store.listPendingCommands(limit);
        },
        claimCommand: async (
          commandId,
          dispatcherId,
          options,
        ): Promise<ClaimedCommand | BlockedCommandClaim | null> => {
          claimCalls += 1;
          return options
            ? store.claimCommand(commandId, dispatcherId, options)
            : store.claimCommand(commandId, dispatcherId);
        },
        failCommand: (...args) => store.failCommand(...args),
        markSteerUnknown: (...args) => store.markSteerUnknown(...args),
        retryCommand: (...args) => store.retryCommand(...args),
      };

      let now = 1_700_000_000_000;
      const scheduled = new Set<{ readonly at: number; readonly run: () => void }>();
      const coordinator = new ExecutionCoordinator({
        clock: {
          now: () => now,
          schedule(run, ms) {
            const timer = { at: now + ms, run };
            scheduled.add(timer);
            return () => scheduled.delete(timer);
          },
        },
        dispatcher: {
          isAvailable: () => true,
          dispatch: async (command) => {
            const began = await triggers.startExecution({
              commandId: command.id,
              runnerBootId: boot,
              runnerId: f.runnerId,
            });
            await store.markCommandFrameSent(command.id);
            started.push({
              commandId: command.id,
              executionGeneration: began.executionGeneration,
              occurrenceId: began.context.occurrence.id,
            });
          },
        },
        dispatcherId: "ab1-coordinator",
        maxConcurrentRuns: 1,
        maxConcurrentTriggerPrograms: 4,
        maxQueuedBytes: 100_000,
        maxQueuedCommands: 100,
        pollIntervalMs: 500,
        store: observedStore,
      });

      const executionWakes: string[] = [];
      const unhook = storeFixture.observePersonalReactions({
        notice: () => undefined,
        reaction: (reaction) => {
          if (reaction.type === "executionCommandsChanged") {
            executionWakes.push(reaction.type);
            coordinator.wake();
          }
        },
      });

      try {
        coordinator.start();
        // O1 starts immediately, and O2 hits blocked once (at most 1 claim for O2..O6).
        await vi.waitFor(() => {
          expect(started).toHaveLength(1);
          expect(claimCalls).toBe(2);
        });
        expect(started[0]?.occurrenceId).toBe(o1.id);
        expect(scheduled.size).toBe(0);

        const listsWhenBlocked = listCalls;
        const claimsWhenBlocked = claimCalls;
        // Advance 2.5 seconds (5 poll intervals): zero DB statements!
        now += 2_500;
        for (const timer of scheduled) {
          if (timer.at <= now) {
            scheduled.delete(timer);
            timer.run();
          }
        }
        await Promise.resolve();
        expect(listCalls).toBe(listsWhenBlocked);
        expect(claimCalls).toBe(claimsWhenBlocked);

        // Ending 1: Runner report (completeExecution) wakes O2.
        await triggers.completeExecution({
          executionGeneration: started[0]!.executionGeneration,
          output: {
            completedAt: new Date().toISOString(),
            error: null,
            exitCode: 0,
            occurrenceId: o1.id,
            result: null,
            status: "succeeded",
            stderr: "",
            stdout: "",
          },
          runnerBootId: boot,
          runnerId: f.runnerId,
        });
        await vi.waitFor(() => expect(started).toHaveLength(2));
        expect(started[1]?.occurrenceId).toBe(o2.id);

        // Ending 2: Unknown at attach (attachRunnerFirings on new boot) wakes O3.
        boot = "boot-ab1-2";
        await triggers.attachRunnerFirings({
          dispatchingOccurrenceIds: [],
          firings: [],
          runnerBootId: boot,
          runnerId: f.runnerId,
        });
        await vi.waitFor(() => expect(started).toHaveLength(3));
        expect(started[2]?.occurrenceId).toBe(o3.id);

        // Ending 3: Person settles contact-lost running firing to unknown (AA12) wakes O4.
        await database
          .updateTable("triggerOccurrences")
          .set({ contactLostAt: new Date() })
          .where("id", "=", o3.id)
          .execute();
        await triggers.cancelPendingOccurrences(f.userId, {
          actorThreadId: null,
          occurrenceId: o3.id,
          triggerId: created.trigger.id,
        });
        await vi.waitFor(() => expect(started).toHaveLength(4));
        expect(started[3]?.occurrenceId).toBe(o4.id);

        // Ending 4: Canceling O5 while O4 runs lets O6 start right after O4 completes.
        const wakesBeforeCancel = executionWakes.length;
        await triggers.cancelPendingOccurrences(f.userId, {
          actorThreadId: null,
          occurrenceId: o5.id,
          triggerId: created.trigger.id,
        });
        expect(executionWakes.length).toBeGreaterThan(wakesBeforeCancel);
        await triggers.completeExecution({
          executionGeneration: started[3]!.executionGeneration,
          output: {
            completedAt: new Date().toISOString(),
            error: null,
            exitCode: 0,
            occurrenceId: o4.id,
            result: null,
            status: "succeeded",
            stderr: "",
            stdout: "",
          },
          runnerBootId: boot,
          runnerId: f.runnerId,
        });
        await vi.waitFor(() => expect(started).toHaveLength(5));
        expect(started[4]?.occurrenceId).toBe(o6.id);

        // Ending 5: Pause cancels/settles and wakes; computer removal wakes.
        const wakesBeforePause = executionWakes.length;
        await database
          .updateTable("triggerOccurrences")
          .set({ contactLostAt: new Date() })
          .where("id", "=", o6.id)
          .execute();
        await triggers.setStatus({
          actorThreadId: null,
          ownerId: f.userId,
          status: "paused",
          triggerId: created.trigger.id,
        });
        expect(executionWakes.length).toBeGreaterThan(wakesBeforePause);

        // Re-activate, queue one firing, fail it pre-send (failCommand), verify wake fires.
        await triggers.setStatus({
          actorThreadId: null,
          ownerId: f.userId,
          status: "active",
          triggerId: created.trigger.id,
        });
        const wakesBeforeRemove = executionWakes.length;
        await enqueueOne("f7");
        await vi.waitFor(() => expect(started).toHaveLength(6));
        await database
          .updateTable("runners")
          .set({ kind: "local", ownerKind: "user", ownerUserId: f.userId })
          .where("id", "=", f.runnerId)
          .execute();
        await store.revokeRunner(f.runnerId, f.userId);
        expect(executionWakes.length).toBeGreaterThan(wakesBeforeRemove);
      } finally {
        unhook();
        await coordinator.stop();
      }
    });
  },
);
