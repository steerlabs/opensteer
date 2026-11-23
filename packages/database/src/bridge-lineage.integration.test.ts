import { expect } from "vitest";
import type { AgentGrant, ThreadId } from "@opensteer/core";
import { AgentConnectionStore } from "./agent-connection-store.js";
import { startPersonalQueuedRunFixture } from "./personal-run-fixture.test-support.js";
import {
  describeStore,
  testContinuationIdentity,
  testModelSelection,
} from "./store.integration.test-support.js";
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

      // A change of engine mid-task makes a new session: without personal context from its first
      // row, read before any Run binds it.
      const [previous] = await f.database
        .selectFrom("providerSessions")
        .select("id")
        .where("threadId", "=", root.id)
        .execute();
      await f.store.updateThreadExecutionSelection({
        continuation: { expectedProviderSessionId: previous!.id },
        continuationIdentity: testContinuationIdentity,
        harnessInstanceId: fixture.harnessInstance.id,
        idempotencyKey: "team-engine-change",
        modelSelection: testModelSelection,
        requestedBy: fixture.userId,
        threadId: root.id,
      });
      expect(await sessions(root.id)).toEqual([
        { personalContext: false },
        { personalContext: false },
      ]);

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

      // No automation on the task, whether its agent or the person makes it: its program would
      // run as the person, in their Agent home.
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
          program: {
            toolContractVersion: 5,
            language: "javascript",
            source: "export default () => {}",
          },
          source: {
            kind: "schedule",
            schedule: { expression: "0 9 * * *", kind: "cron", timezone: "UTC" },
          },
        });
      for (const [key, actor] of [
        ["agent-briefing", anyone.id],
        ["person-briefing", undefined],
      ] as const)
        await expect(automation(key, actor), key).rejects.toMatchObject({
          code: "forbidden",
          message: "A chat that anyone in the conversation can message can't have an automation.",
        });

      // That none of it is read into the person's memory is tested through the memory pass's
      // own tools (memory-pass-service.integration.test.ts).
    });
  },
);
