import { NotificationStore } from "./notification-store.js";
import { runReply } from "./run-reply.js";
import type { StoreFixture } from "./store.integration.test-support.js";
import { jsonValue } from "./store-primitives.js";
import { createHash, randomUUID } from "node:crypto";
import { createChannelId } from "@opensteer/channel-core";
import { createIntegrationId } from "@opensteer/integration-core";
import {
  HarnessIdSchema,
  WorkspaceIdSchema,
  type WorkspaceId,
  createId,
  type RunId,
  type RunnerId,
} from "@opensteer/core";
import { ShellSessionIdSchema } from "@opensteer/protocol";
import { CamelCasePlugin, Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import type { DatabaseSchema } from "./schema.js";
import { ownTestDatabaseProducer } from "./test-database.test-support.js";
import { describe, expect } from "vitest";
import {
  agentControlActionLimits,
  agentControlMaxDelegationDepth,
  IntegrationPlatformStore,
  OpensteerStore,
} from "./index.js";
import {
  describeStore,
  testModelSelection,
  testContinuationIdentity,
  testWorkspaceProfile,
  enrollTestRunner,
  pendingEvent,
  testOpenApiAdapterContract,
} from "./store.integration.test-support.js";

describeStore("PostgreSQL store", (it) => {
  it("publishes addressed messages atomically with exact replay and no Run completion", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, store, bindAgentControlRun, database } =
      storeFixture;
    const fixture = await createRunFixture("person-notify");
    const source = await enqueueHumanTrigger({
      content: [{ type: "text", text: "Work" }],
      idempotencyKey: "person-notify-seed",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    await store.claimCommand(source.command.id, "notify-dispatcher");
    const binding = await bindAgentControlRun(fixture, source.run.id, "person-notify");
    const admission = {
      ...binding,
      action: "person.notify" as const,
      requestFingerprint: createHash("sha256").update("milestone").digest("hex"),
      requestId: randomUUID(),
      runId: source.run.id,
      sourceThreadId: fixture.thread.id,
    };
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        store.publishPersonNotification({ admission, message: "Milestone passed." }),
      ),
    );
    expect(new Set(results.map((result) => result.message.id)).size).toBe(1);
    expect(results.flatMap((result) => result.events)).toHaveLength(1);
    expect(results.flatMap((result) => result.events)[0]).toMatchObject({
      type: "message.created",
      data: { addressedToUserId: fixture.userId, input: null },
    });
    const row = await database
      .selectFrom("messages")
      .selectAll()
      .where("id", "=", results[0]!.message.id)
      .executeTakeFirstOrThrow();
    expect(row.addressedToUserId).toBe(fixture.userId);
    expect(
      await database
        .transaction()
        .execute((transaction) =>
          runReply(transaction, { id: source.run.id, threadId: fixture.thread.id }),
        ),
    ).toBeNull();
    const notifications = await new NotificationStore(database).decide(
      results.flatMap((result) => result.events)[0]!,
    );
    expect(notifications).toMatchObject([
      {
        userId: fixture.userId,
        view: { kind: "reply-published", messageId: row.id, body: "Milestone passed." },
      },
    ]);
    const history = await store.threadMessagePageForOwner({
      ownerId: fixture.userId,
      threadId: fixture.thread.id,
      aroundMessageId: row.id,
    });
    expect(history?.messages.find((message) => message.id === row.id)).toMatchObject({
      addressedToUserId: fixture.userId,
    });
    expect(results[0]!.message).not.toHaveProperty("addressedToUserId");
    const run = await database
      .selectFrom("runs")
      .select("status")
      .where("id", "=", source.run.id)
      .executeTakeFirstOrThrow();
    expect(["starting", "running", "waiting"]).toContain(run.status);
    await expect(
      store.publishPersonNotification({
        admission: {
          ...admission,
          requestFingerprint: createHash("sha256").update("changed").digest("hex"),
        },
        message: "Changed",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      store.publishPersonNotification({
        admission: { ...admission, requestedBy: createId("user") },
        message: "Milestone passed.",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    for (let index = 1; index < agentControlActionLimits["thread.message"]; index += 1) {
      await store.admitAgentControlRequest({
        ...admission,
        action: "thread.message",
        requestId: randomUUID(),
        requestFingerprint: createHash("sha256").update(`shared-quota-${index}`).digest("hex"),
      });
    }
    await expect(
      store.publishPersonNotification({
        admission: { ...admission, requestId: randomUUID() },
        message: "Milestone passed.",
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      details: { actionClass: "thread.message", limit: 32 },
    });
    await expect(
      store.publishPersonNotification({ admission, message: "Milestone passed." }),
    ).resolves.toMatchObject({ wasDuplicate: true, message: { id: row.id }, events: [] });
    await database
      .updateTable("runs")
      .set({ status: "completed" })
      .where("id", "=", source.run.id)
      .execute();
    await expect(
      store.publishPersonNotification({ admission, message: "Milestone passed." }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("serializes durable per-Run admission and charges an exact retry only once", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, store, bindAgentControlRun, database } =
      storeFixture;
    const fixture = await createRunFixture("agent-admission-run");
    const sourceTurn = await enqueueHumanTrigger({
      content: [{ text: "Start agent-control work", type: "text" }],
      idempotencyKey: "agent-admission-source-turn",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    await store.claimCommand(sourceTurn.command.id, "agent-admission-dispatcher");
    const agentControlBinding = await bindAgentControlRun(
      fixture,
      sourceTurn.run.id,
      "agent-admission-run",
    );
    const requestId = randomUUID();
    const exactInput = {
      ...agentControlBinding,
      action: "thread.message" as const,
      requestFingerprint: createHash("sha256").update("exact-message").digest("hex"),
      requestId,
      runId: sourceTurn.run.id,
      sourceThreadId: fixture.thread.id,
    };

    const exactRetries = await Promise.all(
      Array.from({ length: 8 }, async () => store.admitAgentControlRequest(exactInput)),
    );
    expect(exactRetries.filter(({ wasDuplicate }) => !wasDuplicate)).toHaveLength(1);
    expect(exactRetries.filter(({ wasDuplicate }) => wasDuplicate)).toHaveLength(7);

    const restartedStore = new OpensteerStore(database);
    await expect(restartedStore.admitAgentControlRequest(exactInput)).resolves.toMatchObject({
      actionClass: "thread.message",
      wasDuplicate: true,
    });
    await expect(
      restartedStore.admitAgentControlRequest({
        ...exactInput,
        requestFingerprint: createHash("sha256").update("changed-message").digest("hex"),
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    const remaining = agentControlActionLimits["thread.message"] - 1;
    await Promise.all(
      Array.from({ length: remaining }, async (_, index) =>
        store.admitAgentControlRequest({
          ...agentControlBinding,
          action: "thread.message",
          requestFingerprint: createHash("sha256").update(`message-${index}`).digest("hex"),
          requestId: randomUUID(),
          runId: sourceTurn.run.id,
          sourceThreadId: fixture.thread.id,
        }),
      ),
    );
    await expect(
      restartedStore.admitAgentControlRequest({
        ...agentControlBinding,
        action: "thread.message",
        requestFingerprint: createHash("sha256").update("over-limit").digest("hex"),
        requestId: randomUUID(),
        runId: sourceTurn.run.id,
        sourceThreadId: fixture.thread.id,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      details: {
        actionClass: "thread.message",
        limit: agentControlActionLimits["thread.message"],
      },
    });
    const count = await database
      .selectFrom("agentControlRequests")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("runId", "=", sourceTurn.run.id)
      .where("actionClass", "=", "thread.message")
      .executeTakeFirstOrThrow();
    expect(Number(count.count)).toBe(agentControlActionLimits["thread.message"]);

    expect(agentControlActionLimits["thread.list"]).toBe(64);
    await Promise.all(
      Array.from({ length: agentControlActionLimits["thread.list"] }, async (_, index) =>
        store.admitAgentControlRequest({
          ...agentControlBinding,
          action: "thread.list",
          requestFingerprint: createHash("sha256").update(`list-${index}`).digest("hex"),
          requestId: randomUUID(),
          runId: sourceTurn.run.id,
          sourceThreadId: fixture.thread.id,
        }),
      ),
    );
    await expect(
      store.admitAgentControlRequest({
        ...agentControlBinding,
        action: "thread.list",
        requestFingerprint: createHash("sha256").update("list-over-limit").digest("hex"),
        requestId: randomUUID(),
        runId: sourceTurn.run.id,
        sourceThreadId: fixture.thread.id,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      details: { actionClass: "thread.list", limit: agentControlActionLimits["thread.list"] },
    });
    await expect(
      store.admitAgentControlRequest({
        ...agentControlBinding,
        action: "thread.read",
        requestFingerprint: createHash("sha256").update("read-after-list").digest("hex"),
        requestId: randomUUID(),
        runId: sourceTurn.run.id,
        sourceThreadId: fixture.thread.id,
      }),
    ).resolves.toMatchObject({ actionClass: "thread.read", wasDuplicate: false });
  });

  it("commits thread.message admission and effect atomically and rejects terminal retries", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, database } = storeFixture;
    const source = await startRunFixture("agent-message-atomic-receipt");
    const { thread: target } = await store.createThread({
      createdBy: source.userId,
      environmentId: source.environmentId,
      harnessInstanceId: source.harnessInstance.id,
      idempotencyKey: "agent-message-atomic-receipt-target",
      modelSelection: testModelSelection,
      title: "Atomic message target",
      workspaceId: source.workspace.id,
    });
    const requestId = randomUUID();
    const admissionRequest = {
      action: "thread.message" as const,
      bindingGeneration: source.bindingGeneration,
      environmentId: source.environmentId,
      membershipGeneration: 1,
      requestedBy: source.userId,
      requestFingerprint: createHash("sha256").update("atomic-message").digest("hex"),
      requestId,
      runId: source.run.id,
      runnerBootId: source.runnerBootId,
      runnerId: source.runnerId,
      sourceThreadId: source.thread.id,
      workspaceId: source.workspace.id,
    };
    const idempotencyKey = `agent:${source.run.id}:${requestId}:message`;
    await expect(
      store.enqueueAdmittedThreadInput({
        admission: { kind: "agent", request: admissionRequest },
        input: {
          content: [{ text: "This transaction must roll back", type: "text" }],
          idempotencyKey,
          policy: "queue",
          requestedBy: source.userId,
          source: { kind: "agent", runId: source.run.id },
          threadId: createId("thread"),
        },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      database
        .selectFrom("agentControlRequests")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("runId", "=", source.run.id)
        .where("requestId", "=", requestId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: "0" });

    const committed = await store.enqueueAdmittedThreadInput({
      admission: { kind: "agent", request: admissionRequest },
      input: {
        content: [{ text: "Commit the receipt with its Message", type: "text" }],
        idempotencyKey,
        policy: "queue",
        requestedBy: source.userId,
        source: { kind: "agent", runId: source.run.id },
        threadId: target.id,
      },
    });
    expect(committed.wasDuplicate).toBe(false);
    await database
      .updateTable("runs")
      .set({ completedAt: new Date(), status: "completed" })
      .where("id", "=", source.run.id)
      .executeTakeFirstOrThrow();
    await expect(
      store.enqueueAdmittedThreadInput({
        admission: { kind: "agent", request: admissionRequest },
        input: {
          content: [{ text: "Commit the receipt with its Message", type: "text" }],
          idempotencyKey,
          policy: "queue",
          requestedBy: source.userId,
          source: { kind: "agent", runId: source.run.id },
          threadId: target.id,
        },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      database
        .selectFrom("messages")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("threadId", "=", target.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: "1" });
  });

  it("commits thread.delegate admission and child creation atomically", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, database } = storeFixture;
    const source = await startRunFixture("agent-delegate-atomic-receipt");
    const requestId = randomUUID();
    const admissionRequest = {
      action: "thread.delegate" as const,
      bindingGeneration: source.bindingGeneration,
      environmentId: source.environmentId,
      membershipGeneration: 1,
      requestedBy: source.userId,
      requestFingerprint: createHash("sha256").update("atomic-delegation").digest("hex"),
      requestId,
      runId: source.run.id,
      runnerBootId: source.runnerBootId,
      runnerId: source.runnerId,
      sourceThreadId: source.thread.id,
      workspaceId: source.workspace.id,
    };
    const baseInput = {
      accessMode: "auto" as const,
      createdBy: source.userId,
      environmentId: source.environmentId,
      harnessInstanceId: source.harnessInstance.id,
      idempotencyKey: `agent:${source.run.id}:${requestId}:delegate`,
      modelSelection: testModelSelection,
      origin: {
        kind: "run" as const,
        parentRunId: source.run.id,
        parentThreadId: source.thread.id,
      },
      task: [{ text: "Create the child exactly once", type: "text" as const }],
      title: "Atomic child",
    };
    await expect(
      store.delegateAdmittedThread({
        admission: { kind: "agent", request: admissionRequest },
        input: { ...baseInput, workspaceId: createId("workspace") },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      database
        .selectFrom("agentControlRequests")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("runId", "=", source.run.id)
        .where("requestId", "=", requestId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: "0" });

    const delegated = await store.delegateAdmittedThread({
      admission: { kind: "agent", request: admissionRequest },
      input: { ...baseInput, workspaceId: source.workspace.id },
    });
    expect(delegated.wasDuplicate).toBe(false);
    await database
      .updateTable("runs")
      .set({ completedAt: new Date(), status: "completed" })
      .where("id", "=", source.run.id)
      .executeTakeFirstOrThrow();
    await expect(
      store.delegateAdmittedThread({
        admission: { kind: "agent", request: admissionRequest },
        input: { ...baseInput, workspaceId: source.workspace.id },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      database
        .selectFrom("delegations")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("parentRunId", "=", source.run.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: "1" });
  });

  /*
   * Ways tool authority could outlive what ended it:
   * - Stop and Assignment cancellation only queue an interrupt, so a token keeps
   *   working until the Runner reports the Run terminal;
   * - a Workspace being deleted still authorizes its Runs' tools;
   * - a Runner revoked or a binding replaced leaves the old grant usable;
   * - a Run-originated Request or agent-control call slips in after Stop;
   * - revoking tool authority also refuses the Runner's own reporting, so a
   *   stopped Run could never record how it ended.
   */
  describe("Run grants", () => {
    type Started = Awaited<ReturnType<StoreFixture["startRunFixture"]>>;
    const capability = (started: Started) => ({
      bindingGeneration: started.bindingGeneration,
      environmentId: started.environmentId,
      membershipGeneration: 1,
      requestedBy: started.userId,
      runId: started.run.id,
      runnerBootId: started.runnerBootId,
      runnerId: started.runnerId,
      threadId: started.thread.id,
      workspaceId: started.workspace.id,
    });
    const grantsOf = (storeFixture: StoreFixture, runId: RunId) =>
      storeFixture.database
        .selectFrom("grants")
        .select(["attemptId", "bindingGeneration", "revokedReason", "status"])
        .where("runId", "=", runId)
        .orderBy("createdAt", "asc")
        .execute();

    it("issues attempt 1 and one active grant with the execution binding", async ({
      storeFixture,
    }) => {
      const { startRunFixture, database, store } = storeFixture;
      const started = await startRunFixture("grant-issued");
      const attempts = await database
        .selectFrom("runAttempts")
        .select(["id", "ordinal", "reason", "status"])
        .where("runId", "=", started.run.id)
        .execute();
      expect(attempts).toEqual([
        expect.objectContaining({ ordinal: 1, reason: "initial", status: "current" }),
      ]);
      expect(await grantsOf(storeFixture, started.run.id)).toEqual([
        {
          attemptId: attempts[0]!.id,
          bindingGeneration: started.bindingGeneration,
          revokedReason: null,
          status: "active",
        },
      ]);
      await expect(store.assertActiveGrant(capability(started))).resolves.toBeUndefined();
    });

    it("cuts tool authority on Stop while the Runner can still report the Run's end", async ({
      storeFixture,
    }) => {
      const { startRunFixture, store, database } = storeFixture;
      const started = await startRunFixture("grant-stopped");
      await store.enqueueRunnerControl({
        idempotencyKey: "grant-stopped-interrupt",
        requestedBy: started.userId,
        runId: started.run.id,
        threadId: started.thread.id,
        type: "run.interrupt",
      });
      expect(await grantsOf(storeFixture, started.run.id)).toEqual([
        expect.objectContaining({ revokedReason: "stopped", status: "revoked" }),
      ]);
      await expect(store.assertActiveGrant(capability(started))).rejects.toMatchObject({
        code: "forbidden",
      });
      await expect(
        store.assertActiveExecutionBinding(capability(started)),
      ).resolves.toBeUndefined();
      await store.commitRunnerEvent({
        environmentId: started.environmentId,
        event: pendingEvent({
          bindingGeneration: started.bindingGeneration,
          data: { status: "interrupted" },
          environmentId: started.environmentId,
          ordinal: 1,
          runId: started.run.id,
          threadId: started.thread.id,
          type: "run.interrupted",
          workspaceId: started.workspace.id,
        }),
        runnerBootId: started.runnerBootId,
        runnerId: started.runnerId,
      });
      expect(
        await database
          .selectFrom("runs")
          .select("status")
          .where("id", "=", started.run.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: "interrupted" });
    });

    it("ends tool authority with the Run", async ({ storeFixture }) => {
      const { startRunFixture, store } = storeFixture;
      const completed = await startRunFixture("grant-run-ended");
      await store.commitRunnerEvent({
        environmentId: completed.environmentId,
        event: pendingEvent({
          bindingGeneration: completed.bindingGeneration,
          data: { status: "completed" },
          environmentId: completed.environmentId,
          ordinal: 1,
          runId: completed.run.id,
          threadId: completed.thread.id,
          type: "run.completed",
          workspaceId: completed.workspace.id,
        }),
        runnerBootId: completed.runnerBootId,
        runnerId: completed.runnerId,
      });
      await expect(store.assertActiveGrant(capability(completed))).rejects.toMatchObject({
        code: "forbidden",
      });
    });

    it("ends tool authority with its Runner", async ({ storeFixture }) => {
      const { startRunFixture, store } = storeFixture;
      const revoked = await startRunFixture("grant-runner-revoked");
      await store.revokeRunner(revoked.runnerId, revoked.userId, { allowDeployment: true });
      await expect(store.assertActiveGrant(capability(revoked))).rejects.toMatchObject({
        code: "forbidden",
      });
    });

    it("revokes a worker's grant when its Assignment is cancelled", async ({ storeFixture }) => {
      const { startRunFixture, store } = storeFixture;
      const started = await startRunFixture("grant-assignment");
      const delegated = await store.delegateThread({
        accessMode: "auto",
        createdBy: started.userId,
        environmentId: started.environmentId,
        harnessInstanceId: started.harnessInstance.id,
        idempotencyKey: "grant-assignment-child",
        modelSelection: testModelSelection,
        origin: { kind: "run", parentRunId: started.run.id, parentThreadId: started.thread.id },
        task: [{ text: "Child", type: "text" }],
        title: "Child",
        workspaceId: started.workspace.id,
      });
      await store.claimCommand(delegated.command.id, "grant-assignment-dispatcher");
      await store.acquireExecutionBinding({
        bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
        continuationIdentity: testContinuationIdentity,
        harnessInstanceId: started.harnessInstance.id,
        leaseTokenHash: "grant-assignment-child-lease",
        membershipGeneration: 1,
        runnerBootId: started.runnerBootId,
        runnerId: started.runnerId,
        runId: delegated.run.id,
        threadId: delegated.thread.id,
      });
      await store.cancelAssignment({
        actorRunId: started.run.id,
        assignmentId: delegated.assignment.id,
        idempotencyKey: "grant-assignment-cancel",
        requestedBy: started.userId,
      });
      expect(await grantsOf(storeFixture, delegated.run.id)).toEqual([
        expect.objectContaining({ revokedReason: "assignment-cancelled", status: "revoked" }),
      ]);
    });

    it("refuses tools in a Workspace being deleted", async ({ storeFixture }) => {
      const { startRunFixture, store, database } = storeFixture;
      const started = await startRunFixture("grant-workspace-deleting");
      await expect(store.assertActiveGrant(capability(started))).resolves.toBeUndefined();
      // The state a deletion request leaves, before its Runs are failed.
      await database
        .updateTable("workspaces")
        .set({
          deletionRequestedAt: new Date(),
          deletionRequestedBy: started.userId,
          purgeAfter: new Date(Date.now() + 86_400_000),
          status: "deleting",
        })
        .where("id", "=", started.workspace.id)
        .execute();
      await expect(store.assertActiveGrant(capability(started))).rejects.toMatchObject({
        code: "forbidden",
      });
    });

    it("replaces the grant when a starting Run rebinds", async ({ storeFixture }) => {
      const { createRunFixture, enqueueHumanTrigger, store } = storeFixture;
      const fixture = await createRunFixture("grant-rebind");
      const turn = await enqueueHumanTrigger({
        content: [{ text: "Start", type: "text" }],
        idempotencyKey: "grant-rebind-turn",
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      });
      await store.claimCommand(turn.command.id, "grant-rebind-dispatcher");
      const bind = (boot: string) =>
        store.acquireExecutionBinding({
          bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
          continuationIdentity: testContinuationIdentity,
          harnessInstanceId: fixture.harnessInstance.id,
          leaseTokenHash: `grant-rebind-${boot}`,
          membershipGeneration: 1,
          runnerBootId: boot,
          runnerId: fixture.runnerId,
          runId: turn.run.id,
          threadId: fixture.thread.id,
        });
      const first = await bind("boot-a");
      const second = await bind("boot-b");
      expect(second.grantId).not.toBe(first.grantId);
      const grants = await grantsOf(storeFixture, turn.run.id);
      expect(grants).toEqual([
        expect.objectContaining({ revokedReason: "binding-replaced", status: "revoked" }),
        expect.objectContaining({ revokedReason: null, status: "active" }),
      ]);
      expect(grants[0]!.attemptId).toBe(grants[1]!.attemptId);
    });

    it("refuses a stopped Run's Requests and agent-control calls", async ({ storeFixture }) => {
      const { startRunFixture, store } = storeFixture;
      const started = await startRunFixture("grant-stopped-mutations");
      await store.enqueueRunnerControl({
        idempotencyKey: "grant-stopped-mutations-interrupt",
        requestedBy: started.userId,
        runId: started.run.id,
        threadId: started.thread.id,
        type: "run.interrupt",
      });
      await expect(
        store.admitAgentControlRequest({
          ...capability(started),
          action: "thread.read",
          requestFingerprint: createHash("sha256").update("after-stop").digest("hex"),
          requestId: randomUUID(),
          sourceThreadId: started.thread.id,
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        store.requests.create({
          callId: "after-stop",
          kind: "browser.access",
          mode: "durable",
          originatingRunId: started.run.id,
          originatingThreadId: started.thread.id,
          originatingWorkspaceId: started.workspace.id,
          payload: {
            kind: "browser.access",
            reason: "Choose a profile",
            suggestion: { kind: "user_choice" },
          },
          presentation: {
            kind: "external",
            subject: { id: started.workspace.id, kind: "workspace" },
            title: "Browser",
          },
          requestedBy: started.userId,
          requiredActor: "requester",
          targetWorkspaceId: started.workspace.id,
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
    });
  });

  it("refuses an ended Run's mutation before attempting its work", async ({ storeFixture }) => {
    const { startRunFixture, database, store } = storeFixture;
    const source = await startRunFixture("agent-admission-before-work");
    await database
      .updateTable("runs")
      .set({ completedAt: new Date(), status: "completed" })
      .where("id", "=", source.run.id)
      .executeTakeFirstOrThrow();
    const admission = (action: "thread.delegate" | "thread.message") => ({
      kind: "agent" as const,
      request: {
        action,
        bindingGeneration: source.bindingGeneration,
        environmentId: source.environmentId,
        membershipGeneration: 1,
        requestedBy: source.userId,
        requestFingerprint: createHash("sha256").update(action).digest("hex"),
        requestId: randomUUID(),
        runId: source.run.id,
        runnerBootId: source.runnerBootId,
        runnerId: source.runnerId,
        sourceThreadId: source.thread.id,
        workspaceId: source.workspace.id,
      },
    });
    // The work alone would fail with not_found; the caller's authority is the answer.
    await expect(
      store.delegateAdmittedThread({
        admission: admission("thread.delegate"),
        input: {
          accessMode: "auto",
          createdBy: source.userId,
          environmentId: source.environmentId,
          harnessInstanceId: source.harnessInstance.id,
          idempotencyKey: "agent-admission-before-work-delegate",
          modelSelection: testModelSelection,
          origin: { kind: "run", parentRunId: source.run.id, parentThreadId: source.thread.id },
          task: [{ text: "Never started", type: "text" }],
          title: "Never started",
          workspaceId: createId("workspace"),
        },
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "Agent-control Run is no longer active",
    });
    await expect(
      store.enqueueAdmittedThreadInput({
        admission: admission("thread.message"),
        input: {
          content: [{ text: "Never sent", type: "text" }],
          idempotencyKey: "agent-admission-before-work-message",
          policy: "queue",
          requestedBy: source.userId,
          source: { kind: "agent", runId: source.run.id },
          threadId: createId("thread"),
        },
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "Agent-control Run is no longer active",
    });
  });

  it("rejects every agent-control request after its execution terminates", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, store, bindAgentControlRun, database } =
      storeFixture;
    const fixture = await createRunFixture("agent-admission-authority-fence");
    const turn = await enqueueHumanTrigger({
      content: [{ text: "Exercise agent authority", type: "text" }],
      idempotencyKey: "agent-admission-authority-fence-turn",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    const expectedBinding = {
      bindingGeneration: 1,
      environmentId: fixture.environmentId,
      membershipGeneration: 1,
      requestedBy: fixture.userId,
      runnerBootId: "boot-agent-control-agent-admission-authority-fence",
      runnerId: fixture.runnerId,
      workspaceId: fixture.workspace.id,
    };
    const admitted = {
      ...expectedBinding,
      action: "thread.message" as const,
      requestFingerprint: createHash("sha256").update("admitted-before-terminal").digest("hex"),
      requestId: randomUUID(),
      runId: turn.run.id,
      sourceThreadId: fixture.thread.id,
    };

    await expect(store.admitAgentControlRequest(admitted)).rejects.toMatchObject({
      code: "forbidden",
    });
    await store.claimCommand(turn.command.id, "agent-admission-authority-fence-dispatcher");
    expect(
      await bindAgentControlRun(fixture, turn.run.id, "agent-admission-authority-fence"),
    ).toEqual(expectedBinding);
    await expect(store.admitAgentControlRequest(admitted)).resolves.toMatchObject({
      wasDuplicate: false,
    });
    await database
      .updateTable("runs")
      .set({ completedAt: new Date(), status: "completed" })
      .where("id", "=", turn.run.id)
      .executeTakeFirstOrThrow();

    await expect(store.admitAgentControlRequest(admitted)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      store.admitAgentControlRequest({
        ...admitted,
        requestFingerprint: createHash("sha256").update("new-after-terminal").digest("hex"),
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rejects delegation below the durable maximum lineage depth", async ({ storeFixture }) => {
    const { createRunFixture, store, enqueueHumanTrigger, database } = storeFixture;
    const fixture = await createRunFixture("agent-admission-depth");
    let parent = fixture.thread;
    const lineage = [fixture.thread];
    for (let depth = 1; depth <= agentControlMaxDelegationDepth; depth += 1) {
      const created = await store.createThread({
        createdBy: fixture.userId,
        environmentId: fixture.environmentId,
        harnessInstanceId: fixture.harnessInstance.id,
        idempotencyKey: `agent-depth-thread-${depth}`,
        modelSelection: testModelSelection,
        parentThreadId: parent.id,
        title: `Depth ${depth}`,
        workspaceId: fixture.workspace.id,
      });
      parent = created.thread;
      lineage.push(parent);
    }
    const allowedSource = lineage[agentControlMaxDelegationDepth - 1];
    const blockedSource = lineage[agentControlMaxDelegationDepth];
    if (!allowedSource || !blockedSource) throw new Error("Depth fixture is incomplete");
    const allowedTurn = await enqueueHumanTrigger({
      content: [{ text: "Delegate to depth four", type: "text" }],
      idempotencyKey: "agent-depth-allowed-turn",
      requestedBy: fixture.userId,
      threadId: allowedSource.id,
    });
    await store.claimCommand(allowedTurn.command.id, "agent-depth-allowed-dispatcher");
    await database
      .updateTable("runs")
      .set({ status: "running" })
      .where("id", "=", allowedTurn.run.id)
      .executeTakeFirstOrThrow();
    const allowedInput = {
      accessMode: "auto" as const,
      createdBy: fixture.userId,
      environmentId: fixture.environmentId,
      harnessInstanceId: fixture.harnessInstance.id,
      idempotencyKey: "agent-depth-allowed-delegation",
      modelSelection: testModelSelection,
      origin: {
        kind: "run" as const,
        parentRunId: allowedTurn.run.id,
        parentThreadId: allowedSource.id,
      },
      task: [{ text: "Create the deepest allowed child", type: "text" as const }],
      title: "Depth four child",
      workspaceId: fixture.workspace.id,
    };
    await expect(store.delegateThread(allowedInput)).resolves.toMatchObject({
      thread: { parentThreadId: allowedSource.id },
      wasDuplicate: false,
    });
    await expect(new OpensteerStore(database).delegateThread(allowedInput)).resolves.toMatchObject({
      wasDuplicate: true,
    });

    const blockedTurn = await enqueueHumanTrigger({
      content: [{ text: "Attempt depth five", type: "text" }],
      idempotencyKey: "agent-depth-blocked-turn",
      requestedBy: fixture.userId,
      threadId: blockedSource.id,
    });
    await store.claimCommand(blockedTurn.command.id, "agent-depth-blocked-dispatcher");
    await database
      .updateTable("runs")
      .set({ status: "running" })
      .where("id", "=", blockedTurn.run.id)
      .executeTakeFirstOrThrow();
    await expect(
      store.delegateThread({
        ...allowedInput,
        idempotencyKey: "agent-depth-blocked-delegation",
        origin: {
          kind: "run",
          parentRunId: blockedTurn.run.id,
          parentThreadId: blockedSource.id,
        },
        title: "Depth five child",
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      details: { maxDelegationDepth: agentControlMaxDelegationDepth },
    });
  });

  it("shares one complete Workspace and orders revocation before rejoining", async ({
    storeFixture,
  }) => {
    const { store } = storeFixture;
    await store.ensureDeployment({
      canonicalOrigin: "https://sharing.test",
      hostInstanceId: createId("hostInstance"),
      deploymentShape: testWorkspaceProfile,
    });
    const ownerId = await store.createUser("Workspace owner");
    const clientId = await store.createUser("Client");
    const strangerId = await store.createUser("Stranger");
    const mainRunnerId = createId("runner");
    const mainEnvironmentId = createId("environment");
    await enrollTestRunner(store, {
      createdBy: ownerId,
      environmentId: mainEnvironmentId,
      name: "Shared Main runner",
      runnerId: mainRunnerId,
      tokenSuffix: "workspace-sharing-main",
    });
    const workspace = await store.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: "wsp_workspace_sharing",
      },
      capacityPolicy: {
        blockHardLimitBytes: 10_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota",
      },
      createdBy: ownerId,
      idempotencyKey: "workspace-sharing-workspace",
      name: "Client delivery",
      status: "ready",
    });
    const harness = await store.createHarnessInstance({
      config: { model: "test" },
      driverKind: HarnessIdSchema.parse("native"),
      environmentId: mainEnvironmentId,
      name: "Native",
      stateKind: "isolated",
    });
    const { thread } = await store.createThread({
      createdBy: ownerId,
      environmentId: mainEnvironmentId,
      harnessInstanceId: harness.id,
      idempotencyKey: "workspace-sharing-thread",
      modelSelection: testModelSelection,
      title: "Shared thread",
      workspaceId: workspace.id,
    });

    expect(await store.listWorkspacesForOwner(clientId)).toEqual([]);
    const firstInvitation = await store.createWorkspaceInvitation({
      createdBy: ownerId,
      expiresAt: new Date(Date.now() + 60_000),
      idempotencyKey: "workspace-sharing-invite-1",
      intendedEmail: null,
      requestFingerprint: "sha256:workspace-sharing-invite-1",
      role: "collaborator",
      selector: "workspace-sharing-selector-000001",
      tokenHash: "sha256:workspace-sharing-verifier-1",
      type: "link",
      workspaceId: workspace.id,
    });
    expect(await store.listActiveWorkspaceInvitations(workspace.id, ownerId)).toEqual([
      firstInvitation,
    ]);
    await expect(
      store.listActiveWorkspaceInvitations(workspace.id, clientId),
    ).rejects.toMatchObject({ code: "forbidden" });

    const membership = await store.acceptWorkspaceInvitation({
      selector: firstInvitation.selector,
      tokenHash: "sha256:workspace-sharing-verifier-1",
      userEmail: `${clientId}@test.invalid`,
      userEmailVerified: true,
      userId: clientId,
    });
    expect(membership).toMatchObject({ generation: 1, role: "collaborator", state: "active" });
    expect((await store.listWorkspacesForOwner(clientId)).map((item) => item.id)).toEqual([
      workspace.id,
    ]);
    expect((await store.listThreadsForOwner(clientId)).map((item) => item.id)).toEqual([thread.id]);
    const clientThread = await store.createThread({
      createdBy: clientId,
      environmentId: mainEnvironmentId,
      harnessInstanceId: harness.id,
      idempotencyKey: "workspace-sharing-client-thread",
      modelSelection: testModelSelection,
      title: "Client-created thread",
      workspaceId: workspace.id,
    });
    expect(clientThread.thread).toMatchObject({
      capabilityProfileId: "workspace",
      workspaceId: workspace.id,
    });
    await expect(
      store.createThread({
        createdBy: clientId,
        environmentId: mainEnvironmentId,
        harnessInstanceId: harness.id,
        idempotencyKey: "workspace-sharing-client-thread",
        modelSelection: testModelSelection,
        title: "Client-created thread",
        workspaceId: workspace.id,
      }),
    ).resolves.toMatchObject({
      thread: { capabilityProfileId: "workspace", workspaceId: workspace.id },
    });
    expect(await store.listWorkspacesForOwner(strangerId)).toEqual([]);

    await expect(
      store.changeWorkspaceMembership({
        actorId: ownerId,
        role: "collaborator",
        targetUserId: ownerId,
        workspaceId: workspace.id,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await store.changeWorkspaceMembership({
      actorId: ownerId,
      role: "owner",
      targetUserId: clientId,
      workspaceId: workspace.id,
    });
    await expect(
      store.createThread({
        createdBy: clientId,
        environmentId: mainEnvironmentId,
        harnessInstanceId: harness.id,
        idempotencyKey: "workspace-sharing-client-owner-thread",
        modelSelection: testModelSelection,
        title: "Client owner thread",
        workspaceId: workspace.id,
      }),
    ).resolves.toMatchObject({ thread: { capabilityProfileId: "main" } });
    await store.changeWorkspaceMembership({
      actorId: ownerId,
      role: "collaborator",
      targetUserId: clientId,
      workspaceId: workspace.id,
    });
    const revoked = await store.changeWorkspaceMembership({
      actorId: ownerId,
      state: "revoked",
      targetUserId: clientId,
      workspaceId: workspace.id,
    });
    expect(revoked.membership.state).toBe("revoked");
    expect(await store.listWorkspacesForOwner(clientId)).toEqual([]);

    const secondInvitation = await store.createWorkspaceInvitation({
      createdBy: ownerId,
      expiresAt: new Date(Date.now() + 60_000),
      idempotencyKey: "workspace-sharing-invite-2",
      intendedEmail: null,
      requestFingerprint: "sha256:workspace-sharing-invite-2",
      role: "collaborator",
      selector: "workspace-sharing-selector-000002",
      tokenHash: "sha256:workspace-sharing-verifier-2",
      type: "link",
      workspaceId: workspace.id,
    });
    const reaccept = () =>
      store.acceptWorkspaceInvitation({
        selector: secondInvitation.selector,
        tokenHash: "sha256:workspace-sharing-verifier-2",
        userEmail: `${clientId}@test.invalid`,
        userEmailVerified: true,
        userId: clientId,
      });
    await expect(reaccept()).rejects.toMatchObject({ code: "conflict" });
    const effects = await store.claimSecurityEffects({
      leaseUntil: new Date(Date.now() + 60_000),
      limit: 10,
      now: new Date(),
    });
    expect(effects.map((effect) => effect.kind).sort()).toEqual([
      "close-realtime",
      "revoke-browser",
      "revoke-credentials",
      "revoke-mounts",
      "revoke-triggers",
      "stop-runs",
    ]);
    for (const effect of effects) await store.completeSecurityEffect(effect.id);
    await expect(reaccept()).resolves.toMatchObject({
      generation: revoked.membership.generation + 1,
      state: "active",
    });
  });

  it("stores only coherent adapter definitions, runtime snapshots, and server authority", async ({
    storeFixture,
  }) => {
    const { database } = storeFixture;
    const platform = new IntegrationPlatformStore(database);
    const installationId = createIntegrationId("installation");
    const contract = testOpenApiAdapterContract({
      definitionId: "test-adapter-boundary",
      provider: "example",
    });
    const installation = {
      description: "Adapter boundary",
      id: installationId,
      manifest: contract.manifest,
      name: "test-adapter-boundary",
      provenance: { maintainedBy: "test" },
      sourceKind: "built-in" as const,
      status: "active" as const,
      title: "Adapter boundary",
      trust: "built-in" as const,
      version: "1",
    };
    const activeServer = {
      connectionRequirement: {
        definitionId: "test-adapter-boundary",
        kind: "provider" as const,
        provider: "example",
        providerApplicationRequired: false,
      },
      id: createIntegrationId("server"),
      name: "default",
      status: "active" as const,
      statusDetail: null,
      catalog: { definitions: {}, tools: [] },
      transport: {
        adapter: "openapi" as const,
        definitionId: "test-adapter-boundary",
        type: "adapter" as const,
      },
    };

    await expect(
      platform.install({
        adapterSnapshot: null,
        actorUserId: null,
        installation,
        requestId: "missing-adapter-snapshot",
        servers: [activeServer],
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      platform.install({
        adapterSnapshot: { ...contract.adapterSnapshot, definitionId: "different-definition" },
        actorUserId: null,
        installation,
        requestId: "mismatched-adapter-snapshot",
        servers: [activeServer],
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      platform.install({
        adapterSnapshot: contract.adapterSnapshot,
        actorUserId: null,
        installation,
        requestId: "valid-adapter-snapshot",
        servers: [activeServer],
      }),
    ).resolves.toMatchObject({
      installation: { id: installationId, status: "active" },
      requestEvents: [],
    });
  });

  it("keeps a skills-only installation granted across content changes", async ({
    storeFixture,
  }) => {
    const { createRunFixture, store, database } = storeFixture;
    const fixture = await createRunFixture("integration-skill-lifecycle");
    const specialized = await store.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: "wsp_integration_skill_lifecycle_specialized",
      },
      capacityPolicy: {
        blockHardLimitBytes: 10_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota",
      },
      createdBy: fixture.userId,
      idempotencyKey: "workspace-integration-skill-lifecycle-specialized",
      kind: "specialized",
      name: "Specialized integration skill lifecycle",
      status: "ready",
    });
    const platform = new IntegrationPlatformStore(database);
    const installationId = createIntegrationId("installation");
    const serverId = createIntegrationId("server");
    const skillId = createIntegrationId("skill");
    const digest = (contents: string) =>
      createHash("sha256").update(contents, "utf8").digest("base64url");
    const installation = {
      description: "A skills-only Agent Plugin",
      id: installationId,
      manifest: { name: "example-skills", version: "1.0.0" },
      name: "example-skills",
      provenance: { snapshotPath: "/immutable/example-skills" },
      sourceKind: "agent-plugin" as const,
      status: "active" as const,
      title: "Example Skills",
      trust: "administrator-approved" as const,
      version: "1.0.0",
    };
    const discoveredSkill = (contents: string) => ({
      description: "Research examples without loading unrelated plugin context",
      digest: digest(contents),
      id: skillId,
      name: "research-examples",
      status: "active" as const,
    });

    await platform.install({
      adapterSnapshot: null,
      actorUserId: fixture.userId,
      installation,
      requestId: "install-example-skills",
      servers: [
        {
          connectionRequirement: { kind: "mcp-oauth" },
          id: serverId,
          name: "optional-account-tools",
          status: "needs-attention",
          statusDetail: "Account authorization required",
          catalog: { definitions: {}, tools: [] },
          transport: {
            headers: {},
            type: "streamable-http",
            url: "https://mcp.example.test/mcp",
          },
        },
      ],
      skills: [discoveredSkill("first immutable snapshot")],
    });
    const grant = await platform.createGrant({
      access: "read",
      alias: "Research examples",
      connectionId: null,
      createdBy: fixture.userId,
      installationId,
      isDefault: true,
      ownerUserId: fixture.userId,
      providerAuthorizations: {},
      workspaceId: specialized.id,
    });

    await expect(
      platform.listGrantedSkills({
        ownerUserId: fixture.userId,
        threadId: fixture.thread.id,
        workspaceId: specialized.id,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        grant: expect.objectContaining({ id: grant.id }),
        skill: expect.objectContaining({
          digest: digest("first immutable snapshot"),
          id: skillId,
        }),
      }),
    ]);

    await platform.install({
      adapterSnapshot: null,
      actorUserId: fixture.userId,
      installation: { ...installation, version: "1.1.0" },
      requestId: "update-example-skills",
      servers: [
        {
          connectionRequirement: { kind: "mcp-oauth" },
          id: serverId,
          name: "optional-account-tools",
          status: "needs-attention",
          statusDetail: "Account authorization required",
          catalog: { definitions: {}, tools: [] },
          transport: {
            headers: {},
            type: "streamable-http",
            url: "https://mcp.example.test/mcp",
          },
        },
      ],
      skills: [discoveredSkill("second immutable snapshot")],
    });
    await expect(
      platform.listGrants({
        ownerUserId: fixture.userId,
        workspaceId: specialized.id,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        access: "read",
        id: grant.id,
        isDefault: true,
        status: "active",
      }),
    ]);
    await expect(
      platform.listGrantedSkills({
        ownerUserId: fixture.userId,
        threadId: fixture.thread.id,
        workspaceId: specialized.id,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        grant: expect.objectContaining({ id: grant.id }),
        skill: expect.objectContaining({
          digest: digest("second immutable snapshot"),
          id: skillId,
        }),
      }),
    ]);
  });

  it.for(["wsp_00000000-0000-4000-8000-000000000001", "wsp_ffffffff-ffff-4fff-bfff-ffffffffffff"])(
    "orders covered integration origins against removal (%s)",
    async (originId, { storeFixture }) => {
      const {
        startRunFixture,
        store,
        database,
        createSpecializedWorkspace,
        enqueueHumanTrigger,
        stagedRequestRace,
      } = storeFixture;
      const fixture = await startRunFixture("integration-access-widening");
      const specialized = await store.createWorkspace({
        backing: {
          generation: 1,
          kind: "portablefs",
          serviceId: "test-portablefs",
          volumeId: "wsp_integration_access_widening",
        },
        capacityPolicy: {
          blockHardLimitBytes: 10_000_000,
          inodeHardLimit: 10_000,
          kind: "hard-quota",
        },
        createdBy: fixture.userId,
        idempotencyKey: "workspace-integration-access-widening-specialized",
        kind: "specialized",
        name: "Integration access widening",
        status: "ready",
      });
      const platform = new IntegrationPlatformStore(database);
      const installationId = createIntegrationId("installation");
      const serverId = createIntegrationId("server");
      const makeTool = (name: "create" | "get" | "list") => {
        const inputSchema = { properties: {}, type: "object" };
        return {
          annotations: { readOnlyHint: name !== "create" },
          connectionId: null,
          description: `${name} records`,
          id: createIntegrationId("tool"),
          inputSchema,
          name,
          outputSchema: null,

          status: "active" as const,
          title: `${name} records`,
        };
      };
      const tools = [makeTool("list"), makeTool("get"), makeTool("create")];
      await platform.install({
        adapterSnapshot: null,
        actorUserId: fixture.userId,
        installation: {
          description: "Record operations",
          id: installationId,
          manifest: {},
          name: "records-access-widening",
          provenance: { maintainedBy: "test" },
          sourceKind: "remote-mcp",
          status: "active",
          title: "Records",
          trust: "administrator-approved",
          version: "1",
        },
        requestId: "install-records-access-widening",
        servers: [
          {
            connectionRequirement: { kind: "none" },
            id: serverId,
            name: "default",
            status: "active",
            statusDetail: null,
            catalog: { definitions: {}, tools: tools },
            transport: {
              headers: {},
              type: "streamable-http",
              url: "https://records-access-widening.example.test/mcp",
            },
          },
        ],
      });
      const request = (access: "read" | "read-write", callId: string) =>
        platform.requests.createIntegrationAccessRequest({
          access,
          callId,
          installationId,
          originatingRunId: fixture.run.id,
          originatingThreadId: fixture.thread.id,
          originatingWorkspaceId: fixture.workspace.id,
          reason: `Need ${access} records access`,
          requestedBy: fixture.userId,
          requestedServerId: serverId,
          targetWorkspaceId: specialized.id,
        });
      const resolve = (
        requestId: ReturnType<typeof createId<"request">>,
        access: "read" | "read-write",
      ) =>
        platform.requests.resolveIntegrationAccessRequest({
          providerAuthorizations: {},
          requestId,
          resolvedBy: fixture.userId,
          response: {
            kind: "external",
            value: {
              access,
              alias: "Records",
              connectionId: null,
              decision: "fulfilled",
              isDefault: true,
            },
          },
        });

      const origin = await createSpecializedWorkspace(
        fixture.userId,
        "covered-removal",
        WorkspaceIdSchema.parse(originId),
      );
      const { thread } = await store.createThread({
        createdBy: fixture.userId,
        environmentId: fixture.environmentId,
        harnessInstanceId: fixture.harnessInstance.id,
        idempotencyKey: "covered-removal",
        modelSelection: testModelSelection,
        title: "Covered origin",
        workspaceId: origin.id,
      });
      const turn = await enqueueHumanTrigger({
        content: [{ type: "text", text: "Start" }],
        idempotencyKey: "covered-removal",
        requestedBy: fixture.userId,
        threadId: thread.id,
      });
      const writing = await request("read-write", "covered-removal-write");
      const template = await database
        .selectFrom("requests")
        .selectAll()
        .where("id", "=", writing.request.id)
        .executeTakeFirstOrThrow();
      const detail = await database
        .selectFrom("integrationRequestDetails")
        .selectAll()
        .where("requestId", "=", writing.request.id)
        .executeTakeFirstOrThrow();
      const coveredId = createId("request");
      await database.transaction().execute(async (transaction) => {
        await transaction
          .insertInto("requests")
          .values({
            ...template,
            id: coveredId,
            callId: "covered-removal-read",
            originatingRunId: turn.run.id,
            originatingThreadId: thread.id,
            originatingWorkspaceId: origin.id,
            payload: jsonValue({ ...writing.request.payload, access: "read" }),
          })
          .execute();
        await transaction
          .insertInto("integrationRequestDetails")
          .values({ ...detail, requestId: coveredId, access: "read" })
          .execute();
      });
      const results = await stagedRequestRace(
        (transaction) =>
          transaction
            .selectFrom("requests")
            .select("id")
            .where("id", "=", writing.request.id)
            .forUpdate()
            .execute(),
        () => resolve(writing.request.id, "read-write"),
        () =>
          store.requestWorkspaceDeletion({
            requestedBy: fixture.userId,
            workspaceId: specialized.id,
            purgeAfter: new Date(Date.now() + 86_400_000),
          }),
      );
      expect(results[1]).toMatchObject({ status: "fulfilled" });
      expect((await store.requests.get(coveredId))?.status).toMatch(/cancelled|fulfilled/);
    },
  );

  it("avoids a deadlock when integration resolution discovers a new origin during withdrawal", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, database, createSpecializedWorkspace, enqueueHumanTrigger } =
      storeFixture;
    const fixture = await startRunFixture("integration-access-widening");
    const specialized = await store.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: "wsp_integration_access_widening",
      },
      capacityPolicy: {
        blockHardLimitBytes: 10_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota",
      },
      createdBy: fixture.userId,
      idempotencyKey: "workspace-integration-access-widening-specialized",
      kind: "specialized",
      name: "Integration access widening",
      status: "ready",
    });
    const { database: resolutionDatabase } = await ownTestDatabaseProducer(
      storeFixture.databaseUrl,
      async () => {
        // A transaction retry may acquire another backend. Force that ordinary
        // pool behavior so lock-wait observations cannot rely on PID reuse.
        const database = new Kysely<DatabaseSchema>({
          dialect: new PostgresDialect({
            pool: new Pool({
              connectionString: storeFixture.databaseUrl,
              application_name: "opensteer-integration-test",
              maxUses: 1,
            }),
          }),
          plugins: [new CamelCasePlugin({ maintainNestedObjectKeys: true })],
        });
        return { database, close: () => database.destroy() };
      },
    );
    const platform = new IntegrationPlatformStore(resolutionDatabase);
    const installationId = createIntegrationId("installation");
    const serverId = createIntegrationId("server");
    const makeTool = (name: "create" | "get" | "list") => {
      const inputSchema = { properties: {}, type: "object" };
      return {
        annotations: { readOnlyHint: name !== "create" },
        connectionId: null,
        description: `${name} records`,
        id: createIntegrationId("tool"),
        inputSchema,
        name,
        outputSchema: null,

        status: "active" as const,
        title: `${name} records`,
      };
    };
    const tools = [makeTool("list"), makeTool("get"), makeTool("create")];
    await platform.install({
      adapterSnapshot: null,
      actorUserId: fixture.userId,
      installation: {
        description: "Record operations",
        id: installationId,
        manifest: {},
        name: "records-access-widening",
        provenance: { maintainedBy: "test" },
        sourceKind: "remote-mcp",
        status: "active",
        title: "Records",
        trust: "administrator-approved",
        version: "1",
      },
      requestId: "install-records-access-widening",
      servers: [
        {
          connectionRequirement: { kind: "none" },
          id: serverId,
          name: "default",
          status: "active",
          statusDetail: null,
          catalog: { definitions: {}, tools: tools },
          transport: {
            headers: {},
            type: "streamable-http",
            url: "https://records-access-widening.example.test/mcp",
          },
        },
      ],
    });
    const request = (access: "read" | "read-write", callId: string) =>
      platform.requests.createIntegrationAccessRequest({
        access,
        callId,
        installationId,
        originatingRunId: fixture.run.id,
        originatingThreadId: fixture.thread.id,
        originatingWorkspaceId: fixture.workspace.id,
        reason: `Need ${access} records access`,
        requestedBy: fixture.userId,
        requestedServerId: serverId,
        targetWorkspaceId: specialized.id,
      });
    const resolve = (
      requestId: ReturnType<typeof createId<"request">>,
      access: "read" | "read-write",
    ) =>
      platform.requests.resolveIntegrationAccessRequest({
        providerAuthorizations: {},
        requestId,
        resolvedBy: fixture.userId,
        response: {
          kind: "external",
          value: {
            access,
            alias: "Records",
            connectionId: null,
            decision: "fulfilled",
            isDefault: true,
          },
        },
      });

    const newWorkspace = await createSpecializedWorkspace(fixture.userId, "new-request-origin");
    const { thread: newThread } = await store.createThread({
      createdBy: fixture.userId,
      environmentId: fixture.environmentId,
      harnessInstanceId: fixture.harnessInstance.id,
      idempotencyKey: "new-request-origin",
      modelSelection: testModelSelection,
      title: "New origin",
      workspaceId: newWorkspace.id,
    });
    const turn = await enqueueHumanTrigger({
      content: [{ type: "text", text: "Start" }],
      idempotencyKey: "new-request-origin",
      requestedBy: fixture.userId,
      threadId: newThread.id,
    });
    const writing = await request("read-write", "origin-race-write");
    const template = await database
      .selectFrom("requests")
      .selectAll()
      .where("id", "=", writing.request.id)
      .executeTakeFirstOrThrow();
    const detail = await database
      .selectFrom("integrationRequestDetails")
      .selectAll()
      .where("requestId", "=", writing.request.id)
      .executeTakeFirstOrThrow();
    const hold = async (workspaceId: WorkspaceId) => {
      const held = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const done = database.transaction().execute(async (transaction) => {
        await transaction
          .selectFrom("workspaces")
          .select("id")
          .where("id", "=", workspaceId)
          .forNoKeyUpdate()
          .execute();
        held.resolve();
        await release.promise;
      });
      await held.promise;
      return async () => {
        release.resolve();
        await done;
      };
    };
    const waitingQueries = async () =>
      (
        await sql<{
          pid: number;
          query: string;
        }>`select pid, query from pg_stat_activity where datname = current_database() and application_name = 'opensteer-integration-test' and wait_event_type = 'Lock'`.execute(
          database,
        )
      ).rows;
    const releaseTarget = await hold(specialized.id);
    const resolving = resolve(writing.request.id, "read-write");
    void resolving.catch(() => undefined);
    let releaseOrigin: (() => Promise<void>) | undefined;
    let withdrawing: Promise<unknown> | undefined;
    try {
      await expect.poll(async () => (await waitingQueries()).length).toBe(1);
      const initialWaiter = (await waitingQueries())[0]!;
      const newId = createId("request");
      await database.transaction().execute(async (transaction) => {
        await transaction
          .insertInto("requests")
          .values({
            ...template,
            id: newId,
            callId: "new-origin-read",
            originatingRunId: turn.run.id,
            originatingThreadId: newThread.id,
            originatingWorkspaceId: newWorkspace.id,
            payload: jsonValue({ ...writing.request.payload, access: "read" }),
          })
          .execute();
        await transaction
          .insertInto("integrationRequestDetails")
          .values({ ...detail, requestId: newId, access: "read" })
          .execute();
      });
      releaseOrigin = await hold(newWorkspace.id);
      withdrawing = store.requests.withdraw({
        requestId: newId,
        threadId: newThread.id,
        withdrawnBy: fixture.userId,
      });
      void withdrawing.catch(() => undefined);
      await expect.poll(async () => (await waitingQueries()).length).toBe(2);
      const expandedLockQuery = database
        .selectFrom("workspaces")
        .select("id")
        .where("id", "in", [fixture.workspace.id, specialized.id, newWorkspace.id])
        .orderBy("id", "asc")
        .forNoKeyUpdate()
        .compile().sql;
      await releaseTarget();
      // Growth rolls back the original transaction. The retry must wait on its
      // complete lock set, but it need not reacquire the same pooled backend.
      await expect
        .poll(
          async () =>
            (await waitingQueries()).filter(({ query }) => query === expandedLockQuery).length,
        )
        .toBe(1);
      const expandedWaiter = (await waitingQueries()).find(
        ({ query }) => query === expandedLockQuery,
      )!;
      expect(expandedWaiter.pid).not.toBe(initialWaiter.pid);
    } finally {
      await releaseTarget();
      await releaseOrigin?.();
      await Promise.allSettled([resolving, ...(withdrawing ? [withdrawing] : [])]);
    }
    const results = await Promise.allSettled([resolving, withdrawing!]);
    expect(results[0]).toMatchObject({ status: "fulfilled" });
    for (const result of results)
      if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "conflict" });
  });

  it("grants read operations and widens the same grant while satisfying a pending read ask", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, database } = storeFixture;
    const fixture = await startRunFixture("integration-access-widening");
    const specialized = await store.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: "wsp_integration_access_widening",
      },
      capacityPolicy: {
        blockHardLimitBytes: 10_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota",
      },
      createdBy: fixture.userId,
      idempotencyKey: "workspace-integration-access-widening-specialized",
      kind: "specialized",
      name: "Integration access widening",
      status: "ready",
    });
    const platform = new IntegrationPlatformStore(database);
    const installationId = createIntegrationId("installation");
    const serverId = createIntegrationId("server");
    const makeTool = (name: "create" | "get" | "list") => {
      const inputSchema = { properties: {}, type: "object" };
      return {
        annotations: { readOnlyHint: name !== "create" },
        connectionId: null,
        description: `${name} records`,
        id: createIntegrationId("tool"),
        inputSchema,
        name,
        outputSchema: null,

        status: "active" as const,
        title: `${name} records`,
      };
    };
    const tools = [makeTool("list"), makeTool("get"), makeTool("create")];
    await platform.install({
      adapterSnapshot: null,
      actorUserId: fixture.userId,
      installation: {
        description: "Record operations",
        id: installationId,
        manifest: {},
        name: "records-access-widening",
        provenance: { maintainedBy: "test" },
        sourceKind: "remote-mcp",
        status: "active",
        title: "Records",
        trust: "administrator-approved",
        version: "1",
      },
      requestId: "install-records-access-widening",
      servers: [
        {
          connectionRequirement: { kind: "none" },
          id: serverId,
          name: "default",
          status: "active",
          statusDetail: null,
          catalog: { definitions: {}, tools: tools },
          transport: {
            headers: {},
            type: "streamable-http",
            url: "https://records-access-widening.example.test/mcp",
          },
        },
      ],
    });
    const request = (access: "read" | "read-write", callId: string) =>
      platform.requests.createIntegrationAccessRequest({
        access,
        callId,
        installationId,
        originatingRunId: fixture.run.id,
        originatingThreadId: fixture.thread.id,
        originatingWorkspaceId: fixture.workspace.id,
        reason: `Need ${access} records access`,
        requestedBy: fixture.userId,
        requestedServerId: serverId,
        targetWorkspaceId: specialized.id,
      });
    const resolve = (
      requestId: ReturnType<typeof createId<"request">>,
      access: "read" | "read-write",
    ) =>
      platform.requests.resolveIntegrationAccessRequest({
        providerAuthorizations: {},
        requestId,
        resolvedBy: fixture.userId,
        response: {
          kind: "external",
          value: {
            access,
            alias: "Records",
            connectionId: null,
            decision: "fulfilled",
            isDefault: true,
          },
        },
      });

    const initial = await request("read", "records-read-initial");
    const readResolution = await resolve(initial.request.id, "read");
    expect(readResolution.grant).toMatchObject({ access: "read" });
    await expect(
      platform.listCallableTools({
        ownerUserId: fixture.userId,
        threadId: fixture.thread.id,
        providerAuthorizations: {},
        workspaceId: specialized.id,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ tool: expect.objectContaining({ name: "get" }) }),
      expect.objectContaining({ tool: expect.objectContaining({ name: "list" }) }),
    ]);

    const pendingRead = await request("read", "records-read-pending");
    const widening = await request("read-write", "records-write-widening");
    const widened = await resolve(widening.request.id, "read-write");
    expect(widened.grant).toMatchObject({
      access: "read-write",
      id: readResolution.grant?.id,
    });
    await expect(platform.requests.get(pendingRead.request.id)).resolves.toMatchObject({
      status: "fulfilled",
    });
    await expect(
      platform.listCallableTools({
        ownerUserId: fixture.userId,
        threadId: fixture.thread.id,
        providerAuthorizations: {},
        workspaceId: specialized.id,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ tool: expect.objectContaining({ name: "create" }) }),
      expect.objectContaining({ tool: expect.objectContaining({ name: "get" }) }),
      expect.objectContaining({ tool: expect.objectContaining({ name: "list" }) }),
    ]);
  });

  it("derives all user-scoped integration access in Main and keeps specialized access explicit", async ({
    storeFixture,
  }) => {
    const { createRunFixture, store, database } = storeFixture;
    const fixture = await createRunFixture("integration-main-inheritance");
    const specialized = await store.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: "wsp_integration-main-inheritance-specialized",
      },
      capacityPolicy: {
        blockHardLimitBytes: 10_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota",
      },
      createdBy: fixture.userId,
      idempotencyKey: "integration-main-inheritance-specialized",
      kind: "specialized",
      name: "Mail specialist",
      status: "ready",
    });
    const platform = new IntegrationPlatformStore(database);
    const installationId = createIntegrationId("installation");
    const gmailServerId = createIntegrationId("server");
    const localServerId = createIntegrationId("server");
    const readToolId = createIntegrationId("tool");
    const sendToolId = createIntegrationId("tool");
    const localToolId = createIntegrationId("tool");
    const tool = (id: typeof readToolId, name: string) => {
      const inputSchema = { properties: {}, type: "object" };
      return {
        annotations: { readOnlyHint: name === "search" || name === "format" },
        connectionId: null,
        description: name,
        id,
        inputSchema,
        name,
        outputSchema: null,

        status: "active" as const,
        title: name,
      };
    };
    const readTool = tool(readToolId, "search");
    const sendTool = tool(sendToolId, "send");
    const localTool = tool(localToolId, "format");
    const adapterContract = testOpenApiAdapterContract({
      definitionId: "test-mail",
      provider: "google",
    });
    await platform.install({
      adapterSnapshot: adapterContract.adapterSnapshot,
      actorUserId: fixture.userId,
      installation: {
        description: "Mail tools",
        id: installationId,
        manifest: adapterContract.manifest,
        name: "test-main-mail",
        provenance: { maintainedBy: "test" },
        sourceKind: "built-in",
        status: "active",
        title: "Mail",
        trust: "built-in",
        version: "1",
      },
      requestId: "install-test-main-mail",
      servers: [
        {
          connectionRequirement: {
            definitionId: "test-mail",
            kind: "provider",
            provider: "google",
            providerApplicationRequired: true,
          },
          id: gmailServerId,
          name: "gmail",
          status: "active",
          statusDetail: null,
          catalog: { definitions: {}, tools: [readTool, sendTool] },
          transport: { adapter: "openapi", definitionId: "test-mail", type: "adapter" },
        },
        {
          connectionRequirement: { kind: "none" },
          id: localServerId,
          name: "local",
          status: "active",
          statusDetail: null,
          catalog: { definitions: {}, tools: [localTool] },
          transport: { adapter: "openapi", definitionId: "test-mail", type: "adapter" },
        },
      ],
    });
    const providerApplicationId = createIntegrationId("providerApplication");
    await database
      .insertInto("integrationProviderApplications")
      .values({
        clientId: "test-google-client",
        createdBy: fixture.userId,
        displayName: "Test Google",
        encryptedSecrets: Buffer.from("test-encrypted-provider-secret"),
        encryptionKeyVersion: 1,
        id: providerApplicationId,
        provider: "google",
        revision: 1,
        status: "active",
        updatedBy: fixture.userId,
      })
      .executeTakeFirstOrThrow();
    const providerAuthorizations = {
      google: {
        availableSources: [
          {
            callbackUrl: "https://host.example.test/v1/integrations/oauth/callback/google",
            kind: "deployment-oauth" as const,
            providerApplicationId,
            providerApplicationRevision: 1,
          },
        ],
        code: "READY" as const,
        detail: "Using the deployment OAuth application.",
        hostedOAuthStatus: "unsupported" as const,
        selectedSource: {
          callbackUrl: "https://host.example.test/v1/integrations/oauth/callback/google",
          kind: "deployment-oauth" as const,
          providerApplicationId,
          providerApplicationRevision: 1,
        },
        selectedSourceKind: "deployment-oauth" as const,
      },
    };

    await expect(
      platform.listCallableTools({
        ownerUserId: fixture.userId,
        threadId: fixture.thread.id,
        providerAuthorizations,
        workspaceId: fixture.workspace.id,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        grant: expect.objectContaining({ source: "main-inherited" }),
        tool: expect.objectContaining({ id: localToolId }),
      }),
    ]);
    await expect(
      platform.listCallableTools({
        ownerUserId: fixture.userId,
        threadId: fixture.thread.id,
        providerAuthorizations,
        workspaceId: specialized.id,
      }),
    ).resolves.toEqual([]);

    const personalConnectionId = createChannelId("connection");
    const workConnectionId = createChannelId("connection");
    for (const connection of [
      {
        displayName: "Personal Gmail",
        externalIdentityId: "google-personal",
        id: personalConnectionId,
      },
      {
        displayName: "Work Gmail",
        externalIdentityId: "google-work",
        id: workConnectionId,
      },
    ] as const) {
      await database
        .insertInto("integrationConnections")
        .values({
          accountIdentifier: null,
          applicationSource: sql`${JSON.stringify({
            callbackUrl: "https://host.example.test/v1/integrations/oauth/callback/google",
            kind: "deployment-oauth",
            providerApplicationId,
            providerApplicationRevision: 1,
          })}::jsonb`,
          authMethodId: "oauth",
          authorizationDigest: "a".repeat(43),
          capabilities: sql`'[]'::jsonb`,
          runnerId: null,
          connectionKind: "provider-account",
          connectionMethod: "managed-oauth",
          credentialId: null,
          displayName: connection.displayName,
          externalIdentityId: connection.externalIdentityId,
          externalTenantId: null,
          grantedScopes: sql`'[]'::jsonb`,
          id: connection.id,
          integrationDefinitionId: "test-mail",
          integrationServerId: null,
          ownerUserId: fixture.userId,
          provider: "google",
          providerApplicationId,
          status: "connected",
          statusDetail: null,
          transportKind: null,
          updatedAt: new Date(),
        })
        .executeTakeFirstOrThrow();
    }
    const firstMainTools = await platform.listCallableTools({
      ownerUserId: fixture.userId,
      threadId: fixture.thread.id,
      providerAuthorizations,
      workspaceId: fixture.workspace.id,
    });
    expect(
      firstMainTools.map(({ grant, tool: candidate }) => ({
        alias: grant.alias,
        id: grant.id,
        tool: candidate.name,
      })),
    ).toEqual([
      expect.objectContaining({ alias: "Personal Gmail", tool: "search" }),
      expect.objectContaining({ alias: "Work Gmail", tool: "search" }),
      expect.objectContaining({ alias: "Personal Gmail", tool: "send" }),
      expect.objectContaining({ alias: "Work Gmail", tool: "send" }),
      expect.objectContaining({ alias: "Mail", tool: "format" }),
    ]);
    expect(
      (
        await platform.listCallableTools({
          ownerUserId: fixture.userId,
          threadId: fixture.thread.id,
          providerAuthorizations,
          workspaceId: fixture.workspace.id,
        })
      ).map(({ grant }) => grant.id),
    ).toEqual(firstMainTools.map(({ grant }) => grant.id));

    const specializedGrant = await platform.createGrant({
      access: "read",
      alias: "Personal only",
      connectionId: personalConnectionId,
      createdBy: fixture.userId,
      installationId,
      isDefault: true,
      ownerUserId: fixture.userId,
      providerAuthorizations,
      workspaceId: specialized.id,
    });
    await expect(
      platform.listCallableTools({
        ownerUserId: fixture.userId,
        threadId: fixture.thread.id,
        providerAuthorizations,
        workspaceId: specialized.id,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        grant: expect.objectContaining({
          alias: "Personal only",
          connectionId: personalConnectionId,
        }),
        tool: expect.objectContaining({ id: readToolId }),
      }),
    ]);
    await platform.revokeGrant({
      grantId: specializedGrant.id,
      ownerUserId: fixture.userId,
      requestId: "revoke-specialized-main-inheritance-grant",
      workspaceId: specialized.id,
    });
    await expect(
      platform.listCallableTools({
        ownerUserId: fixture.userId,
        threadId: fixture.thread.id,
        providerAuthorizations,
        workspaceId: specialized.id,
      }),
    ).resolves.toEqual([]);

    await database
      .updateTable("integrationProviderApplications")
      .set({ status: "disabled", updatedAt: new Date() })
      .where("id", "=", providerApplicationId)
      .executeTakeFirstOrThrow();
    await expect(
      platform.listCallableTools({
        ownerUserId: fixture.userId,
        threadId: fixture.thread.id,
        providerAuthorizations,
        workspaceId: fixture.workspace.id,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ tool: expect.objectContaining({ id: localToolId }) }),
    ]);
    await expect(
      platform.listCallableTools({
        ownerUserId: fixture.userId,
        threadId: fixture.thread.id,
        providerAuthorizations,
        workspaceId: specialized.id,
      }),
    ).resolves.toEqual([]);
  });

  describe("machine access", () => {
    async function shellMachine(
      storeFixture: StoreFixture,
      input: {
        readonly name: string;
        readonly ownerId: ReturnType<typeof createId<"user">>;
        readonly runnerKind?: "local" | "main";
        readonly tokenSuffix: string;
      },
    ): Promise<RunnerId> {
      const { store, database } = storeFixture;
      const runnerId = createId("runner");
      const environmentId = createId("environment");
      await enrollTestRunner(store, {
        createdBy: input.ownerId,
        environmentId,
        name: input.name,
        runnerId,
        runnerKind: input.runnerKind ?? "local",
        tokenSuffix: input.tokenSuffix,
      });
      // The descriptor a Runner advertises is what reach reads; the enrollment
      // grant only says it is allowed to.
      await database
        .updateTable("runners")
        .set({
          moduleDescriptors: sql`module_descriptors || ${JSON.stringify({
            shell: { hostPublicKey: `ssh-ed25519 ${"A".repeat(68)}`, platform: "linux" },
          })}::jsonb`,
        })
        .where("id", "=", runnerId)
        .executeTakeFirstOrThrow();
      return runnerId;
    }

    const openPolicy = {
      commands: true,
      forwarding: false,
      reach: "owner" as const,
      shares: [{ mode: "read" as const, path: "/srv/data" }],
    };

    async function reserve(
      storeFixture: StoreFixture,
      input: {
        readonly callerRunnerId: RunnerId;
        readonly ownerId: ReturnType<typeof createId<"user">>;
        readonly runnerId: RunnerId;
        readonly startedAt?: Date;
      },
    ) {
      const { store } = storeFixture;
      const sessionId = ShellSessionIdSchema.parse(`shs_${randomUUID()}`);
      await store.reserveShellSession({
        callerMachineName: "Caller",
        callerRunnerId: input.callerRunnerId,
        policyRevision: 1,
        requestedBy: input.ownerId,
        runId: createId("run"),
        runnerId: input.runnerId,
        sessionId,
        startedAt: input.startedAt ?? new Date(),
        threadId: createId("thread"),
        threadTitle: "Fix the deploy",
      });
      return sessionId;
    }

    it("updates full access only on a non-revoked shell descriptor", async ({ storeFixture }) => {
      const { store, database } = storeFixture;
      const ownerId = await store.createUser("Full access owner");
      const runnerId = await shellMachine(storeFixture, {
        ownerId,
        name: "Mac",
        tokenSuffix: "fda",
      });
      await database
        .updateTable("runners")
        .set({
          moduleDescriptors: sql`jsonb_set(module_descriptors, '{shell,platform}', '"darwin"'::jsonb)`,
        })
        .where("id", "=", runnerId)
        .execute();
      expect(await store.setRunnerShellFullDiskAccess(runnerId, true)).toBe(true);
      expect((await store.getMachineAccessTarget(runnerId))?.shell?.fullDiskAccess).toBe(true);
      expect(await store.setRunnerShellFullDiskAccess(runnerId, false)).toBe(true);
      await database
        .updateTable("runners")
        .set({ revokedAt: new Date() })
        .where("id", "=", runnerId)
        .execute();
      expect(await store.setRunnerShellFullDiskAccess(runnerId, true)).toBe(false);
      await database
        .updateTable("runners")
        .set({ revokedAt: null, moduleDescriptors: sql`module_descriptors - 'shell'` })
        .where("id", "=", runnerId)
        .execute();
      expect(await store.setRunnerShellFullDiskAccess(runnerId, true)).toBe(false);
      expect(await store.setRunnerShellFullDiskAccess(createId("runner"), true)).toBe(false);
    });

    it("writes a policy only over the revision the editor read", async ({ storeFixture }) => {
      const { store } = storeFixture;
      const ownerId = await store.createUser("Machine owner");
      const runnerId = await shellMachine(storeFixture, {
        ownerId,
        name: "Laptop",
        tokenSuffix: "cas",
      });

      await expect(store.getMachineAccessTarget(runnerId)).resolves.toMatchObject({
        policy: { commands: false, forwarding: false, reach: "nobody", shares: [] },
        revision: 1,
      });
      await expect(
        store.updateMachineAccessPolicy({
          allowDeployment: false,
          expectedRevision: 1,
          ownerId,
          policy: openPolicy,
          runnerId,
        }),
      ).resolves.toEqual({ outcome: "updated", replayed: false, revision: 2 });
      // A second editor still holding revision 1 changes nothing at all.
      await expect(
        store.updateMachineAccessPolicy({
          allowDeployment: false,
          expectedRevision: 1,
          ownerId,
          policy: { ...openPolicy, commands: false },
          runnerId,
        }),
      ).resolves.toEqual({ outcome: "conflict", replayed: false });
      await expect(store.getMachineAccessTarget(runnerId)).resolves.toMatchObject({
        policy: openPolicy,
        revision: 2,
      });
      // A write of equal value still moves the revision.
      await expect(
        store.updateMachineAccessPolicy({
          allowDeployment: false,
          expectedRevision: 2,
          ownerId,
          policy: openPolicy,
          runnerId,
        }),
      ).resolves.toEqual({ outcome: "updated", replayed: false, revision: 3 });
    });

    it("replays a recorded policy write instead of bumping a second revision", async ({
      storeFixture,
    }) => {
      const { store } = storeFixture;
      const ownerId = await store.createUser("Machine owner");
      const runnerId = await shellMachine(storeFixture, {
        ownerId,
        name: "Laptop",
        tokenSuffix: "idem-update",
      });
      const write = {
        allowDeployment: false,
        expectedRevision: 1,
        idempotency: { key: "save-access-1", requestedBy: ownerId },
        ownerId,
        policy: openPolicy,
        runnerId,
      };

      await expect(store.updateMachineAccessPolicy(write)).resolves.toEqual({
        outcome: "updated",
        replayed: false,
        revision: 2,
      });
      // The retried click: the same answer, the revision does not move, and it
      // says it committed nothing — what the Host reads to decide whether the
      // sessions open now were opened under the policy this describes.
      await expect(store.updateMachineAccessPolicy(write)).resolves.toEqual({
        outcome: "updated",
        replayed: true,
        revision: 2,
      });
      await expect(store.getMachineAccessTarget(runnerId)).resolves.toMatchObject({
        revision: 2,
      });

      // A recorded conflict replays as a conflict, not as a late success.
      const stale = {
        ...write,
        idempotency: { key: "save-access-2", requestedBy: ownerId },
        policy: { ...openPolicy, commands: false },
      };
      await expect(store.updateMachineAccessPolicy(stale)).resolves.toEqual({
        outcome: "conflict",
        replayed: false,
      });
      await expect(store.updateMachineAccessPolicy(stale)).resolves.toEqual({
        outcome: "conflict",
        replayed: true,
      });
      // One person's key never answers another's, and never answers a
      // different request of their own.
      await expect(
        store.updateMachineAccessPolicy({ ...write, expectedRevision: 2 }),
      ).rejects.toMatchObject({ code: "conflict" });
    });

    it("replays a recorded Stop rather than reporting that nothing ended", async ({
      storeFixture,
    }) => {
      const { store } = storeFixture;
      const ownerId = await store.createUser("Machine owner");
      const target = await shellMachine(storeFixture, {
        ownerId,
        name: "Target",
        tokenSuffix: "idem-stop",
      });
      const caller = await shellMachine(storeFixture, {
        ownerId,
        name: "Caller",
        tokenSuffix: "idem-stop-c",
      });
      const sessionId = await reserve(storeFixture, {
        callerRunnerId: caller,
        ownerId,
        runnerId: target,
      });
      const stop = {
        idempotency: { key: "stop-1", requestedBy: ownerId },
        reason: "stopped-by-owner" as const,
        sessionId,
      };

      await expect(store.endShellSession({ ...stop, bytesIn: 9, bytesOut: 3 })).resolves.toEqual({
        ended: true,
      });
      await expect(store.endShellSession(stop)).resolves.toEqual({ ended: true });
      // The replay wrote nothing: the reason and the counters are the first
      // call's, not a second ending's zeroes.
      const [row] = await store
        .listShellHistory({ limit: 1, runnerId: target })
        .then((page) => page.sessions);
      expect(row).toMatchObject({ bytesIn: 9, bytesOut: 3, endReason: "stopped-by-owner" });
      // A key that named a different session is a mistake, not an answer.
      await expect(
        store.endShellSession({
          ...stop,
          sessionId: ShellSessionIdSchema.parse(`shs_${randomUUID()}`),
        }),
      ).rejects.toMatchObject({ code: "conflict" });
    });

    it("refuses owner reach on a computer that has no owner", async ({ storeFixture }) => {
      const { store, database } = storeFixture;
      const adminId = await store.createUser("Administrator");
      await database
        .updateTable("users")
        .set({ instanceRole: "administrator" })
        .where("id", "=", adminId)
        .executeTakeFirstOrThrow();
      // A server Deployment's own main computer: the Deployment owns it and
      // nobody in particular does, so "My agents" would name nobody.
      const runnerId = await shellMachine(storeFixture, {
        name: "Build box",
        ownerId: adminId,
        runnerKind: "main",
        tokenSuffix: "owner-reach-none",
      });

      await expect(store.effectiveMachineOwner(runnerId)).resolves.toEqual({
        effectiveOwner: null,
        ownerKind: "deployment",
      });
      await expect(
        store.updateMachineAccessPolicy({
          allowDeployment: true,
          expectedRevision: 1,
          ownerId: adminId,
          policy: { ...openPolicy, reach: "owner" },
          runnerId,
        }),
      ).rejects.toMatchObject({
        code: "bad_request",
        message:
          "This computer belongs to the Deployment rather than to a person, so it cannot be limited to its owner's agents.",
      });
      // Nothing was written, so the revision did not move either.
      await expect(store.getMachineAccessTarget(runnerId)).resolves.toMatchObject({
        revision: 1,
      });
      await expect(
        store.updateMachineAccessPolicy({
          allowDeployment: true,
          expectedRevision: 1,
          ownerId: adminId,
          policy: { ...openPolicy, reach: "deployment" },
          runnerId,
        }),
      ).resolves.toMatchObject({ outcome: "updated" });
    });

    it("reports effective owners for a page of computers in one read", async ({ storeFixture }) => {
      const { store } = storeFixture;
      const ownerId = await store.createUser("Machine owner");
      const mine = await shellMachine(storeFixture, {
        ownerId,
        name: "Mine",
        tokenSuffix: "owners-mine",
      });
      const theirs = createId("runner");

      await expect(store.effectiveMachineOwners([mine, theirs])).resolves.toEqual(
        new Map([[mine, { effectiveOwner: ownerId, ownerKind: "user" }]]),
      );
      await expect(store.effectiveMachineOwners([])).resolves.toEqual(new Map());
    });

    it("refuses a policy write from somebody else's account", async ({ storeFixture }) => {
      const { store } = storeFixture;
      const ownerId = await store.createUser("Machine owner");
      const strangerId = await store.createUser("Stranger");
      const runnerId = await shellMachine(storeFixture, {
        ownerId,
        name: "Laptop",
        tokenSuffix: "cas-owner",
      });

      await expect(
        store.updateMachineAccessPolicy({
          allowDeployment: false,
          expectedRevision: 1,
          ownerId: strangerId,
          policy: openPolicy,
          runnerId,
        }),
      ).rejects.toMatchObject({ code: "not_found" });
    });

    it("names the Personal Deployment owner as the Main machine's owner", async ({
      storeFixture,
    }) => {
      const { store, database } = storeFixture;
      const ownerId = await store.createUser("Personal owner");
      await database
        .updateTable("users")
        .set({ instanceRole: "administrator" })
        .where("id", "=", ownerId)
        .executeTakeFirstOrThrow();
      await store.ensureDeployment({
        canonicalOrigin: "http://127.0.0.1:4310",
        deploymentId: createId("deployment"),
        deploymentShape: { defaultWorkspaceBacking: "local-directory", kind: "personal" },
        hostInstanceId: createId("hostInstance"),
      });
      const mainId = await shellMachine(storeFixture, {
        name: "This Mac",
        ownerId,
        runnerKind: "main",
        tokenSuffix: "personal-main",
      });

      await expect(store.effectiveMachineOwner(mainId)).resolves.toEqual({
        effectiveOwner: ownerId,
        ownerKind: "deployment",
      });
      await expect(store.effectiveMachineOwner(createId("runner"))).resolves.toBeNull();
    });

    it("lists only the machines whose reach admits the caller, never itself", async ({
      storeFixture,
    }) => {
      const { store } = storeFixture;
      const ownerId = await store.createUser("Machine owner");
      const strangerId = await store.createUser("Stranger");
      const closed = await shellMachine(storeFixture, {
        ownerId,
        name: "Closed",
        tokenSuffix: "reach-closed",
      });
      const mine = await shellMachine(storeFixture, {
        ownerId,
        name: "Mine",
        tokenSuffix: "reach-mine",
      });
      const shared = await shellMachine(storeFixture, {
        ownerId,
        name: "Shared",
        tokenSuffix: "reach-shared",
      });
      // The machine the Run itself is on: Deployment-reachable, yet excluded.
      const self = await shellMachine(storeFixture, {
        ownerId,
        name: "Self",
        tokenSuffix: "reach-self",
      });
      const noModule = createId("runner");
      await enrollTestRunner(store, {
        createdBy: ownerId,
        environmentId: createId("environment"),
        name: "No shell",
        runnerId: noModule,
        runnerKind: "local",
        tokenSuffix: "reach-no-module",
      });
      for (const [runnerId, reach] of [
        [mine, "owner"],
        [shared, "deployment"],
        [self, "deployment"],
        [noModule, "deployment"],
      ] as const) {
        await expect(
          store.updateMachineAccessPolicy({
            allowDeployment: false,
            expectedRevision: 1,
            ownerId,
            policy: { ...openPolicy, reach },
            runnerId,
          }),
        ).resolves.toMatchObject({ outcome: "updated" });
      }

      const reachable = await store.listReachableMachines(ownerId, self);
      expect(reachable.map((machine) => machine.runnerId).sort()).toEqual([mine, shared].sort());
      expect(reachable.some((machine) => machine.runnerId === self)).toBe(false);
      expect(reachable.find((machine) => machine.runnerId === mine)).toMatchObject({
        commands: true,
        forwarding: false,
        name: "Mine",
        platform: "linux",
        shares: [{ mode: "read", path: "/srv/data" }],
      });
      // A stranger reaches the Deployment-wide machines it is not one of.
      await expect(store.listReachableMachines(strangerId, self)).resolves.toMatchObject([
        { runnerId: shared },
      ]);
      expect(reachable.some((machine) => machine.runnerId === closed)).toBe(false);

      await store.revokeRunner(shared, ownerId);
      await expect(store.listReachableMachines(strangerId, self)).resolves.toEqual([]);
    });

    it("lists reachable machines by name so the budget keeps a predictable set", async ({
      storeFixture,
    }) => {
      const { store } = storeFixture;
      const ownerId = await store.createUser("Machine owner");
      const self = await shellMachine(storeFixture, {
        ownerId,
        name: "Caller",
        tokenSuffix: "order-self",
      });
      // Enrolled in an order that has nothing to do with their names.
      const named = ["Zulu", "Alpha", "Mike"];
      for (const [index, name] of named.entries()) {
        const runnerId = await shellMachine(storeFixture, {
          name,
          ownerId,
          tokenSuffix: `order-${index}`,
        });
        await store.updateMachineAccessPolicy({
          allowDeployment: false,
          expectedRevision: 1,
          ownerId,
          policy: { ...openPolicy, reach: "owner" },
          runnerId,
        });
      }

      await expect(
        store
          .listReachableMachines(ownerId, self)
          .then((machines) => machines.map((machine) => machine.name)),
      ).resolves.toEqual(["Alpha", "Mike", "Zulu"]);
    });

    it("resolves a connect target whatever its reach says, and forgets a revoked one", async ({
      storeFixture,
    }) => {
      const { store } = storeFixture;
      const ownerId = await store.createUser("Machine owner");
      const target = await shellMachine(storeFixture, {
        ownerId,
        name: "Laptop",
        tokenSuffix: "connect-target",
      });
      const noModule = createId("runner");
      await enrollTestRunner(store, {
        createdBy: ownerId,
        environmentId: createId("environment"),
        name: "Old computer",
        runnerId: noModule,
        runnerKind: "local",
        tokenSuffix: "connect-no-module",
      });

      // Reach is still `nobody`, and admission still needs the name and the
      // descriptor to say so in a sentence.
      await expect(store.getMachineAccessTarget(target)).resolves.toMatchObject({
        name: "Laptop",
        policy: { commands: false, forwarding: false, reach: "nobody", shares: [] },
        revision: 1,
        shell: { platform: "linux" },
      });
      await expect(store.getMachineAccessTarget(noModule)).resolves.toMatchObject({
        name: "Old computer",
        shell: null,
      });

      await store.updateMachineAccessPolicy({
        allowDeployment: false,
        expectedRevision: 1,
        ownerId,
        policy: openPolicy,
        runnerId: target,
      });
      await expect(store.getMachineAccessTarget(target)).resolves.toMatchObject({ revision: 2 });

      await store.revokeRunner(target, ownerId);
      await expect(store.getMachineAccessTarget(target)).resolves.toBeNull();
      await expect(store.getMachineAccessTarget(createId("runner"))).resolves.toBeNull();
    });

    it("ends a session once, writing final counters and keeping the first reason", async ({
      storeFixture,
    }) => {
      const { store } = storeFixture;
      const ownerId = await store.createUser("Machine owner");
      const target = await shellMachine(storeFixture, {
        ownerId,
        name: "Target",
        tokenSuffix: "end-target",
      });
      const caller = await shellMachine(storeFixture, {
        ownerId,
        name: "Caller",
        tokenSuffix: "end-caller",
      });
      const sessionId = await reserve(storeFixture, {
        callerRunnerId: caller,
        ownerId,
        runnerId: target,
      });

      await expect(store.activateShellSession(sessionId)).resolves.toBe(true);
      await expect(store.activateShellSession(sessionId)).resolves.toBe(false);
      await expect(
        store.endShellSession({
          bytesIn: 10,
          bytesOut: 20,
          reason: "client-closed",
          sessionId,
        }),
      ).resolves.toEqual({ ended: true });
      // A duplicate call transitions nothing and changes neither reason nor counters.
      await expect(
        store.endShellSession({ bytesIn: 5, bytesOut: 1, reason: "host-shutdown", sessionId }),
      ).resolves.toEqual({ ended: false });

      const page = await store.listShellHistory({ limit: 10, runnerId: target });
      expect(page.sessions).toMatchObject([
        {
          bytesIn: 10,
          bytesOut: 20,
          callerMachineName: "Caller",
          endReason: "client-closed",
          threadTitle: "Fix the deploy",
        },
      ]);
      expect(page.sessions[0]?.endedAt).toBeInstanceOf(Date);
      await expect(
        store.endShellSession({
          reason: "run-ended",
          sessionId: ShellSessionIdSchema.parse(`shs_${randomUUID()}`),
        }),
      ).resolves.toEqual({ ended: false });
    });

    it("ends every open session at Host startup", async ({ storeFixture }) => {
      const { store } = storeFixture;
      const ownerId = await store.createUser("Machine owner");
      const target = await shellMachine(storeFixture, {
        ownerId,
        name: "Target",
        tokenSuffix: "startup-target",
      });
      const caller = await shellMachine(storeFixture, {
        ownerId,
        name: "Caller",
        tokenSuffix: "startup-caller",
      });
      const pending = await reserve(storeFixture, {
        callerRunnerId: caller,
        ownerId,
        runnerId: target,
      });
      const active = await reserve(storeFixture, {
        callerRunnerId: caller,
        ownerId,
        runnerId: target,
      });
      await store.activateShellSession(active);
      const closed = await reserve(storeFixture, {
        callerRunnerId: caller,
        ownerId,
        runnerId: target,
      });
      await store.endShellSession({ reason: "client-closed", sessionId: closed });

      await expect(store.endAllOpenShellSessions("host-shutdown")).resolves.toBe(2);
      await expect(store.listActiveShellSessions(target)).resolves.toEqual([]);
      const page = await store.listShellHistory({ limit: 10, runnerId: target });
      expect(Object.fromEntries(page.sessions.map((entry) => [entry.id, entry.endReason]))).toEqual(
        {
          [pending]: "host-shutdown",
          [active]: "host-shutdown",
          [closed]: "client-closed",
        },
      );
      await expect(store.endAllOpenShellSessions("host-shutdown")).resolves.toBe(0);
    });

    it("caps a session's audit at a thousand requests plus one marker", async ({
      storeFixture,
    }) => {
      const { store } = storeFixture;
      const ownerId = await store.createUser("Machine owner");
      const target = await shellMachine(storeFixture, {
        ownerId,
        name: "Target",
        tokenSuffix: "audit-target",
      });
      const caller = await shellMachine(storeFixture, {
        ownerId,
        name: "Caller",
        tokenSuffix: "audit-caller",
      });
      const sessionId = await reserve(storeFixture, {
        callerRunnerId: caller,
        ownerId,
        runnerId: target,
      });
      const at = new Date();
      const exec = (channel: number) =>
        ({ at, event: { channel, command: "echo", kind: "exec" } }) as const;

      await expect(
        store.appendShellEvents(
          sessionId,
          Array.from({ length: 990 }, (_, index) => exec(index)),
        ),
      ).resolves.toBe(990);
      await expect(
        store.appendShellEvents(
          sessionId,
          Array.from({ length: 20 }, (_, index) => exec(1_000 + index)),
        ),
      ).resolves.toBe(10);
      // Everything after the marker is dropped rather than stored.
      await expect(store.appendShellEvents(sessionId, [exec(9_999)])).resolves.toBe(0);

      const page = await store.listShellHistory({ limit: 10, runnerId: target });
      const events = page.sessions[0]?.events ?? [];
      expect(events).toHaveLength(1_001);
      expect(events.at(-1)).toEqual({ kind: "truncated" });
      expect(events.filter((event) => event.kind === "truncated")).toHaveLength(1);
    });

    it("pages history newest first and stops at the last row", async ({ storeFixture }) => {
      const { store } = storeFixture;
      const ownerId = await store.createUser("Machine owner");
      const target = await shellMachine(storeFixture, {
        ownerId,
        name: "Target",
        tokenSuffix: "page-target",
      });
      const caller = await shellMachine(storeFixture, {
        ownerId,
        name: "Caller",
        tokenSuffix: "page-caller",
      });
      const startedAt = Date.parse("2026-09-13T12:00:00.000Z");
      const sessions: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        sessions.push(
          await reserve(storeFixture, {
            callerRunnerId: caller,
            ownerId,
            runnerId: target,
            startedAt: new Date(startedAt + index * 1_000),
          }),
        );
      }

      const first = await store.listShellHistory({ limit: 2, runnerId: target });
      expect(first.sessions.map((entry) => entry.id)).toEqual([sessions[4], sessions[3]]);
      expect(first.nextCursor).not.toBeNull();
      const second = await store.listShellHistory({
        before: first.nextCursor ?? "",
        limit: 2,
        runnerId: target,
      });
      expect(second.sessions.map((entry) => entry.id)).toEqual([sessions[2], sessions[1]]);
      const last = await store.listShellHistory({
        before: second.nextCursor ?? "",
        limit: 2,
        runnerId: target,
      });
      expect(last.sessions.map((entry) => entry.id)).toEqual([sessions[0]]);
      expect(last.nextCursor).toBeNull();
      await expect(
        store.listShellHistory({ before: "not-a-cursor", limit: 2, runnerId: target }),
      ).rejects.toMatchObject({ code: "bad_request" });
      await expect(store.listShellHistory({ limit: 51, runnerId: target })).rejects.toMatchObject({
        code: "bad_request",
      });
    });

    it("shows the sessions open on a machine right now", async ({ storeFixture }) => {
      const { store } = storeFixture;
      const ownerId = await store.createUser("Machine owner");
      const target = await shellMachine(storeFixture, {
        ownerId,
        name: "Target",
        tokenSuffix: "live-target",
      });
      const caller = await shellMachine(storeFixture, {
        ownerId,
        name: "Caller",
        tokenSuffix: "live-caller",
      });
      const sessionId = await reserve(storeFixture, {
        callerRunnerId: caller,
        ownerId,
        runnerId: target,
      });
      await store.activateShellSession(sessionId);

      await expect(store.listActiveShellSessions(target)).resolves.toMatchObject([
        { bytesIn: 0, bytesOut: 0, callerMachineName: "Caller", id: sessionId },
      ]);
      // The full row resolves the session's machine and stays readable once ended.
      await expect(store.getShellSession(sessionId)).resolves.toMatchObject({
        runnerId: target,
        state: "active",
      });
      await store.endShellSession({ reason: "stopped-by-owner", sessionId });
      await expect(store.listActiveShellSessions(target)).resolves.toEqual([]);
      await expect(store.getShellSession(sessionId)).resolves.toMatchObject({
        endedAt: expect.any(Date),
        runnerId: target,
        state: "ended",
      });
      await expect(
        store.getShellSession(ShellSessionIdSchema.parse(`shs_${randomUUID()}`)),
      ).resolves.toBeNull();
    });

    it("stores and replays exactly the requested enrollment grant", async ({ storeFixture }) => {
      const { store } = storeFixture;
      const ownerId = await store.createUser("Machine owner");
      const request = {
        allowedModules: ["agents"] as const,
        createdBy: ownerId,
        expiresAt: new Date(Date.now() + 60_000),
        id: `ren_${randomUUID()}`,
        idempotencyKey: "replay-with-shell",
        name: "Laptop",
        requestFingerprint: "sha256:replay-with-shell",
        runnerKind: "local" as const,
        tokenHash: "sha256:replay-with-shell-token",
      };
      const created = await store.createRunnerEnrollment(request);
      expect(created.allowedModules).toEqual(["agents"]);

      await expect(store.createRunnerEnrollment(request)).resolves.toMatchObject({
        allowedModules: ["agents"],
        id: created.id,
      });
      await expect(
        store.createRunnerEnrollment({
          ...request,
          allowedModules: ["agents", "browser"],
          id: `ren_${randomUUID()}`,
        }),
      ).rejects.toMatchObject({ code: "conflict" });
    });
  });
});
