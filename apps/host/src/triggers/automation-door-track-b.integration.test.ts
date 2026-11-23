import { randomUUID } from "node:crypto";
import type {
  AuthenticatedSession,
  RequestId,
  ThreadAccessMode,
  TriggerId,
  UserId,
} from "@opensteer/core";
import {
  AgentConnectionStore,
  CommandRequestStore,
  TriggerStore,
  commandNotFoundMessage,
} from "@opensteer/database";
import { describeStore, type StoreFixture } from "@opensteer/database/test-support/store";
import type { HostApiServerContext } from "@opensteer/protocol";
import { sql } from "kysely";
import { expect, vi } from "vitest";
import { personActor } from "../commands/actor.js";
import { CommandRequestService } from "../commands/requests.js";
import type { AgentCaller } from "../mcp/agent-caller.js";
import { TriggerToolHandlers } from "../mcp/handlers/triggers.js";
import { handleTriggerCommand } from "./trigger-routes.js";
import { TriggerService } from "./trigger-service.js";

const script = {
  interpreter: null,
  text: "console.log('ok')",
} as const;

const scriptInput = {
  text: "console.log('ok')",
} as const;

const scheduleSource = {
  kind: "schedule" as const,
  cron: "0 9 * * *",
  timezone: "UTC",
};

describeStore("Track B: automation commands through the one door (brief section 10)", (it) => {
  async function setup(storeFixture: StoreFixture, mode: ThreadAccessMode = "full-access") {
    const f = await storeFixture.startRunFixture(`track-b-${randomUUID().slice(0, 8)}`);
    const { database, store } = storeFixture;
    await database
      .updateTable("runners")
      .set({
        capabilities: sql`(select jsonb_agg(distinct value) from jsonb_array_elements_text(capabilities || '["automation-script-v1"]'::jsonb))`,
      } as never)
      .where("id", "=", f.runnerId)
      .execute();
    for (const [table, id] of [
      ["threads", f.threadId],
      ["runs", f.run.id],
    ] as const) {
      await database
        .updateTable(table)
        .set({ accessMode: mode })
        .where("id", "=", id as never)
        .execute();
    }
    const triggerStore = new TriggerStore(database);
    const triggers = new TriggerService({
      onOccurrenceQueued: vi.fn(),
      publicUrl: new URL("https://track-b.opensteer.test"),
      runnerStore: store,
      store: triggerStore,
      threads: store,
    });
    const commandRequests = new CommandRequestService({
      store: new CommandRequestStore(database, store.requests),
      database,
      requests: store.requests,
    });
    const handlers = new TriggerToolHandlers(triggers, store, {
      requests: () => commandRequests,
    });
    const sessionId = `ses_${randomUUID()}`;
    await database
      .insertInto("authSessions")
      .values({
        id: sessionId as never,
        userId: f.userId,
        token: randomUUID(),
        expiresAt: new Date(Date.now() + 60 * 60_000),
        absoluteExpiresAt: new Date(Date.now() + 60 * 60_000),
        createdAt: new Date(),
        updatedAt: new Date(),
        lastSeenAt: new Date(),
        deviceLabel: "Owner phone",
        ipAddress: null,
        userAgent: null,
      })
      .execute();
    const session = { id: sessionId, user: { id: f.userId } } as unknown as AuthenticatedSession;
    const context = { session } as unknown as HostApiServerContext;
    const runCaller = {
      kind: "run",
      key: `run:${f.run.id}`,
      userId: f.userId as UserId,
      accessMode: mode,
      claims: { runId: f.run.id, threadId: f.threadId },
      thread: { id: f.threadId, accessMode: mode },
    } as unknown as AgentCaller;
    const approveRequest = async (requestId: RequestId) => {
      const req = await store.requests.get(requestId);
      if (!req?.command) throw new Error(`Missing command Request ${requestId}`);
      const row = await database
        .selectFrom("requests")
        .select("revision")
        .where("id", "=", requestId)
        .executeTakeFirstOrThrow();
      const approved = await commandRequests.approve(
        personActor(context),
        {
          requestId,
          expectedRevision: String(row.revision),
          command: req.command.command,
          idempotencyKey: `approve-${requestId}`,
        },
        async (approver, command) =>
          handleTriggerCommand(triggers, command as never, context, approver),
        (proposal) => personActor(context, proposal),
      );
      return approved;
    };
    return {
      f,
      database,
      store,
      triggerStore,
      triggers,
      commandRequests,
      handlers,
      runCaller,
      context,
      approveRequest,
    };
  }

  it("opens Requests for supervised create/update-script/run, allows pause and cancel now (narrow)", async ({
    storeFixture,
  }) => {
    const { f, database, triggerStore, triggers, handlers, runCaller, approveRequest } =
      await setup(storeFixture, "approval-required");

    // 1. Supervised create -> pending Request, nothing created yet.
    const createResult = await handlers.write({
      caller: runCaller,
      input: {
        taskId: f.threadId,
        name: "Supervised schedule",
        script: scriptInput,
        source: scheduleSource,
      },
      operationKey: "sup-create",
    });
    expect(createResult).toMatchObject({
      status: "pending",
      requestId: expect.any(String),
    });
    expect(
      await database
        .selectFrom("triggers")
        .select("id")
        .where("createdBy", "=", f.userId)
        .execute(),
    ).toEqual([]);

    // Person approves -> automation exists.
    const approvedCreate = await approveRequest(
      (createResult as { requestId: RequestId }).requestId,
    );
    expect(approvedCreate.status).toBe("done");
    const createdTriggers = await database
      .selectFrom("triggers")
      .select(["id", "currentRevisionId", "originConnectionId"])
      .where("createdBy", "=", f.userId)
      .execute();
    expect(createdTriggers).toHaveLength(1);
    const triggerId = createdTriggers[0]!.id as TriggerId;
    const revisionId = createdTriggers[0]!.currentRevisionId!;
    expect(createdTriggers[0]!.originConnectionId).toBeNull();

    // 2. Supervised script update -> pending Request, revision unchanged.
    const updateResult = await handlers.write({
      caller: runCaller,
      input: {
        automationId: triggerId,
        expectedRevisionId: revisionId,
        script: { text: "console.log('changed')" },
      },
      operationKey: "sup-update-script",
    });
    expect(updateResult).toMatchObject({
      status: "pending",
      requestId: expect.any(String),
    });
    const afterUpdateAsk = await database
      .selectFrom("triggers")
      .select("currentRevisionId")
      .where("id", "=", triggerId)
      .executeTakeFirstOrThrow();
    expect(afterUpdateAsk.currentRevisionId).toBe(revisionId);

    // 3. Supervised run_now -> pending Request, no occurrence queued.
    const runResult = await handlers.write({
      caller: runCaller,
      input: {
        automationId: triggerId,
        action: "run_now",
      },
      operationKey: "sup-run-now",
    });
    expect(runResult).toMatchObject({
      status: "pending",
      requestId: expect.any(String),
    });
    expect(
      await database
        .selectFrom("triggerOccurrences")
        .select("id")
        .where("triggerId", "=", triggerId)
        .execute(),
    ).toEqual([]);

    // 4. Queue a firing as the person, then supervised Run cancels it (`narrow` -> now) and pauses (`narrow` -> now).
    const occurrence = await triggers.run(f.userId, triggerId, null, null, "person-run");
    const cancelResult = await handlers.write({
      caller: runCaller,
      input: {
        automationId: triggerId,
        action: "cancel_pending",
        occurrenceId: occurrence.id,
      },
      operationKey: "sup-cancel",
    });
    expect(cancelResult).toMatchObject({ canceledOccurrenceIds: [occurrence.id] });

    const pauseResult = await handlers.write({
      caller: runCaller,
      input: {
        automationId: triggerId,
        action: "pause",
      },
      operationKey: "sup-pause",
    });
    expect(pauseResult).toMatchObject({
      trigger: expect.objectContaining({ id: triggerId, status: "paused" }),
    });
    const pausedRow = await triggerStore.getForOwner(triggerId, f.userId, 5, { kind: "person" });
    expect(pausedRow?.trigger.status).toBe("paused");
  });

  it("returns not_found for invisible anchors, asks outside lineage, and preserves proposing connection lineage on approval", async ({
    storeFixture,
  }) => {
    const { f, database, handlers, approveRequest } = await setup(storeFixture, "full-access");
    const connections = new AgentConnectionStore(database);

    const makeConnection = async (
      label: string,
      grant:
        | { readonly scope: "everything" }
        | { readonly scope: "selected"; readonly tasks: boolean; readonly resources: readonly [] },
    ) => {
      const record = await connections.create({
        userId: f.userId,
        label,
        clientName: label,
        accessMode: "full-access",
        resource: "https://track-b.opensteer.test/mcp",
        expiresAt: new Date(Date.now() + 60 * 60_000),
        grant,
      });
      await connections.activate(record.id, `hash-${label}-${randomUUID()}`);
      return {
        id: record.id,
        caller: {
          kind: "connection",
          key: `connection:${record.id}`,
          connectionId: record.id,
          userId: f.userId as UserId,
          accessMode: "full-access",
          grant,
        } as unknown as AgentCaller,
      };
    };

    const selected = await makeConnection("Selected agent", {
      scope: "selected",
      tasks: true,
      resources: [],
    });
    const everything = await makeConnection("Everything agent", { scope: "everything" });

    // 1. Selected connection cannot see the person's anchor task -> identical not_found (rule 5).
    await expect(
      handlers.write({
        caller: selected.caller,
        input: {
          taskId: f.threadId,
          name: "Hidden anchor",
          script: scriptInput,
          source: scheduleSource,
        },
        operationKey: "sel-invisible",
      }),
    ).rejects.toMatchObject({ code: "not_found", message: commandNotFoundMessage });

    // 2. Selected connection on its OWN lineage task at full-access -> succeeds now with its lineage.
    const ownTask = await storeFixture.startRunFixture("selected-own-task");
    await database
      .updateTable("threads")
      .set({ accessMode: "full-access", originConnectionId: selected.id, createdBy: f.userId })
      .where("id", "=", ownTask.threadId)
      .execute();
    await database
      .updateTable("runners")
      .set({
        capabilities: sql`(select jsonb_agg(distinct value) from jsonb_array_elements_text(capabilities || '["automation-script-v1"]'::jsonb))`,
      } as never)
      .where("id", "=", ownTask.runnerId)
      .execute();
    const ownCreated = await handlers.write({
      caller: selected.caller,
      input: {
        taskId: ownTask.threadId,
        name: "Own lineage schedule",
        script: scriptInput,
        source: scheduleSource,
      },
      operationKey: "sel-own-create",
    });
    expect(ownCreated).toMatchObject({
      trigger: expect.objectContaining({ name: "Own lineage schedule" }),
    });
    const ownRow = await database
      .selectFrom("triggers")
      .select("originConnectionId")
      .where("id", "=", (ownCreated as { trigger: { id: TriggerId } }).trigger.id)
      .executeTakeFirstOrThrow();
    expect(ownRow.originConnectionId).toBe(selected.id);

    // 3. Everything connection targeting the person's task (outside its lineage) -> asks the person!
    const foreignAsk = await handlers.write({
      caller: everything.caller,
      input: {
        taskId: f.threadId,
        name: "Proposed by connected agent",
        script: scriptInput,
        source: scheduleSource,
      },
      operationKey: "ev-foreign-create",
    });
    expect(foreignAsk).toMatchObject({
      status: "pending",
      requestId: expect.any(String),
    });

    // When the person approves, the automation preserves the proposing connection's lineage (T11).
    const approved = await approveRequest((foreignAsk as { requestId: RequestId }).requestId);
    expect(approved.status).toBe("done");
    const createdRow = await database
      .selectFrom("triggers")
      .select(["id", "originConnectionId"])
      .where("name", "=", "Proposed by connected agent")
      .executeTakeFirstOrThrow();
    expect(createdRow.originConnectionId).toBe(everything.id);
  });

  it("admits a firing (trigger:<occurrenceId>) as its anchor task's live authority", async ({
    storeFixture,
  }) => {
    const { f, database, triggers, handlers } = await setup(storeFixture, "approval-required");

    // Person creates an automation anchored on f.threadId (currently approval-required) and starts a firing.
    const created = await triggers.create(
      {
        anchorThreadId: f.threadId,
        idempotencyKey: "anchor-auto",
        name: "Anchor automation",
        ownerId: f.userId,
        script,
        source: {
          kind: "schedule",
          schedule: { kind: "cron", expression: "0 9 * * *", timezone: "UTC" },
        },
      },
      null,
    );
    const occurrence = await triggers.run(f.userId, created.trigger.id, null, null, "firing-1");
    await database
      .updateTable("triggerOccurrences")
      .set({ status: "running", startedAt: new Date() })
      .where("id", "=", occurrence.id)
      .execute();
    const programCaller = {
      kind: "program",
      key: `trigger:${occurrence.id}`,
      userId: f.userId as UserId,
      accessMode: "approval-required",
      program: { kind: "trigger", occurrenceId: occurrence.id, triggerId: created.trigger.id },
      anchor: { id: f.threadId, accessMode: "approval-required" },
    } as unknown as AgentCaller;

    // Anchor is approval-required -> firing calling trigger.create asks the person.
    const askCreate = await handlers.write({
      caller: programCaller,
      input: {
        taskId: f.threadId,
        name: "Child from firing while supervised",
        script: scriptInput,
        source: scheduleSource,
      },
      operationKey: "firing-create-sup",
    });
    expect(askCreate).toMatchObject({
      status: "pending",
      requestId: expect.any(String),
    });

    // Anchor is approval-required -> firing pausing its own automation is narrow -> now!
    const paused = await handlers.write({
      caller: programCaller,
      input: {
        automationId: created.trigger.id,
        action: "pause",
      },
      operationKey: "firing-pause-sup",
    });
    expect(paused).toMatchObject({
      trigger: expect.objectContaining({ id: created.trigger.id, status: "paused" }),
    });

    // Upgrade anchor task to full-access -> the SAME firing now creates immediately without asking!
    await database
      .updateTable("threads")
      .set({ accessMode: "full-access" })
      .where("id", "=", f.threadId)
      .execute();
    const nowCreate = await handlers.write({
      caller: programCaller,
      input: {
        taskId: f.threadId,
        name: "Child from firing at full access",
        script: scriptInput,
        source: scheduleSource,
      },
      operationKey: "firing-create-full",
    });
    expect(nowCreate).toMatchObject({
      trigger: expect.objectContaining({ name: "Child from firing at full access" }),
    });
  });
});
