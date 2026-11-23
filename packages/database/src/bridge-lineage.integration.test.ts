import { expect } from "vitest";
import type { AgentGrant, ThreadId } from "@opensteer/core";
import { AgentConnectionStore } from "./agent-connection-store.js";
import { startPersonalQueuedRunFixture } from "./personal-run-fixture.test-support.js";
import { bindingAgentConnectionId, lineagePersonalContext } from "./resource-access.js";
import { describeStore, testModelSelection } from "./store.integration.test-support.js";
import { TriggerStore } from "./trigger-store.js";

const tasksOnly: AgentGrant = { scope: "selected", tasks: true, resources: [] };

describeStore(
  "work in an \"anyone\" bridge's lineage never has the person's personal context",
  (it) => {
    it("reaches its sub-tasks, its delegations and its automations", async ({
      storeFixture: f,
    }) => {
      const { configured, fixture } = await f.createChannelDeliveryFixture("anyone-lineage", {
        bridge: false,
      });
      const anyone = await new AgentConnectionStore(f.database).createBridge({
        userId: fixture.userId,
        accountId: configured.account.id,
        conversation: { id: "C-team", name: "#team" },
        senders: "anyone",
        // Chosen at full access, so its own agent may make an automation with a program.
        accessMode: "full-access",
        grant: tasksOnly,
      });
      const create = (key: string, extra: Record<string, unknown> = {}) =>
        f.store.createThread({
          createdBy: fixture.userId,
          environmentId: fixture.environmentId,
          harnessInstanceId: fixture.harnessInstance.id,
          idempotencyKey: key,
          modelSelection: testModelSelection,
          title: key,
          ...extra,
        });
      const lineageOf = async (threadId: ThreadId) =>
        (
          await f.database
            .selectFrom("threads")
            .select("originConnectionId")
            .where("id", "=", threadId)
            .executeTakeFirstOrThrow()
        ).originConnectionId;
      const runLineage = async (runId: string) =>
        (
          await f.database
            .selectFrom("runs")
            .select("connectionId")
            .where("id", "=", runId as never)
            .executeTakeFirstOrThrow()
        ).connectionId;
      const sessions = (threadId: ThreadId) =>
        f.database
          .selectFrom("providerSessions")
          .select("personalContext")
          .where("threadId", "=", threadId)
          .execute();
      // The task someone in #team started, as the bridge.
      const { thread: root } = await create("from-team", {
        authority: {
          kind: "connection",
          connectionId: anyone.id,
          userId: fixture.userId,
          accessMode: "full-access",
        },
      });
      expect(await lineageOf(root.id)).toBe(anyone.id);
      expect(await sessions(root.id)).toEqual([{ personalContext: false }]);

      // A task made under it inherits its lineage, and so its restriction.
      const { thread: sub } = await create("under-team", { parentThreadId: root.id });
      expect(await lineageOf(sub.id)).toBe(anyone.id);
      expect(await sessions(sub.id)).toEqual([{ personalContext: false }]);

      // A Run of the task delegates: the worker it starts has no personal context either.
      const turn = await f.store.enqueueThreadInput({
        requestedBy: fixture.userId,
        threadId: root.id,
        content: [{ type: "text", text: "Ask a worker" }],
        source: { kind: "human" },
        policy: "queue",
        idempotencyKey: "team-turn",
      });
      if (!turn.run) throw new Error("The task's message reserved no Run");
      expect(await runLineage(turn.run.id)).toBe(anyone.id);
      await startPersonalQueuedRunFixture(f.store, turn.run.id);
      const worker = await f.store.delegateThread({
        accessMode: "approval-required",
        createdBy: fixture.userId,
        environmentId: fixture.environmentId,
        harnessInstanceId: fixture.harnessInstance.id,
        idempotencyKey: "team-worker",
        modelSelection: testModelSelection,
        origin: { kind: "run", parentRunId: turn.run.id, parentThreadId: root.id },
        task: [{ type: "text", text: "Work for #team" }],
        title: "Worker for #team",
      });
      expect(await lineageOf(worker.thread.id)).toBe(anyone.id);
      expect(await runLineage(worker.run.id)).toBe(anyone.id);
      // Its worker never held a personal session, not even its first.
      expect(await sessions(worker.thread.id)).toEqual([{ personalContext: false }]);

      // An automation on the task, whether its agent or the person made it: what its program
      // starts runs in the task's lineage.
      const triggers = new TriggerStore(f.database);
      const automation = (key: string, actorConnectionId?: string) =>
        triggers.create({
          actorThreadId: null,
          ...(actorConnectionId
            ? { actorConnectionId, actorAccessMode: "full-access" as const }
            : {}),
          anchorThreadId: root.id,
          createdBy: fixture.userId,
          idempotencyKey: key,
          name: key,
          script: {
            interpreter: null,
            text: "console.log('ok')",
          },
          source: {
            kind: "schedule",
            schedule: { expression: "0 9 * * *", kind: "cron", timezone: "UTC" },
          },
        });
      for (const [key, actor] of [
        ["agent-briefing", anyone.id],
        ["person-briefing", undefined],
      ] as const) {
        const { trigger } = await automation(key, actor);
        const occurrence = await triggers.enqueueManual({
          actorThreadId: null,
          ownerId: fixture.userId,
          triggerId: trigger.id,
        });
        const lineage = await bindingAgentConnectionId(f.database, `trigger:${occurrence.id}`);
        expect(lineage, key).toBe(anyone.id);
        expect(await lineagePersonalContext(f.database, lineage), key).toBe(false);
      }

      // That none of it is read into the person's memory is tested through the memory pass's
      // own tools (memory-pass-service.integration.test.ts).
    });
  },
);
