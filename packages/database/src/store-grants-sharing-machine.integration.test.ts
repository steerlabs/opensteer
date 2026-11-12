import { NotificationStore } from "./notification-store.js";
import { runReply } from "./run-reply.js";
import type { StoreFixture } from "./store.integration.test-support.js";

import { createHash, randomUUID } from "node:crypto";

import { createIntegrationId } from "@opensteer/integration-core";
import { createId, type RunId, type RunnerId } from "@opensteer/core";
import { ShellSessionIdSchema } from "@opensteer/protocol";
import { sql } from "kysely";

import { describe, expect } from "vitest";
import { runToolMaxDelegationDepth, IntegrationPlatformStore, OpensteerStore } from "./index.js";
import {
  describeStore,
  testModelSelection,
  testContinuationIdentity,
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
    const fixture = await createRunFixture("person-message");
    const source = await enqueueHumanTrigger({
      content: [
        {
          type: "text",
          text: "Work",
        },
      ],
      idempotencyKey: "person-message-seed",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    await store.claimCommand(source.command.id, "notify-dispatcher");
    const binding = await bindAgentControlRun(fixture, source.run.id, "person-message");
    const admission = {
      ...binding,
      action: "person.message" as const,
      requestFingerprint: createHash("sha256").update("milestone").digest("hex"),
      requestId: randomUUID(),
      runId: source.run.id,
      sourceThreadId: fixture.thread.id,
    };
    const results = await Promise.all(
      Array.from(
        {
          length: 4,
        },
        () =>
          store.publishPersonMessage({
            admission,
            message: "Milestone passed.",
          }),
      ),
    );
    expect(new Set(results.map((result) => result.message.id)).size).toBe(1);
    expect(results.flatMap((result) => result.events)).toHaveLength(1);
    expect(results.flatMap((result) => result.events)[0]).toMatchObject({
      type: "message.created",
      data: {
        addressedToUserId: fixture.userId,
        input: null,
      },
    });
    const row = await database
      .selectFrom("messages")
      .selectAll()
      .where("id", "=", results[0]!.message.id)
      .executeTakeFirstOrThrow();
    expect(row.addressedToUserId).toBe(fixture.userId);
    expect(
      await database.transaction().execute((transaction) =>
        runReply(transaction, {
          id: source.run.id,
          threadId: fixture.thread.id,
        }),
      ),
    ).toBeNull();
    const notifications = await new NotificationStore(database).decide(
      results.flatMap((result) => result.events)[0]!,
    );
    expect(notifications).toMatchObject([
      {
        userId: fixture.userId,
        view: {
          kind: "reply-published",
          messageId: row.id,
          body: "Milestone passed.",
        },
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
      store.publishPersonMessage({
        admission: {
          ...admission,
          requestFingerprint: createHash("sha256").update("changed").digest("hex"),
        },
        message: "Changed",
      }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      store.publishPersonMessage({
        admission: {
          ...admission,
          requestedBy: createId("user"),
        },
        message: "Milestone passed.",
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
    for (let index = 1; index < 40; index += 1) {
      await store.admitRunToolCall({
        ...admission,
        action: "thread.message",
        requestId: randomUUID(),
        requestFingerprint: createHash("sha256").update(`shared-quota-${index}`).digest("hex"),
      });
    }
    await expect(
      store.publishPersonMessage({
        admission: {
          ...admission,
          requestId: randomUUID(),
        },
        message: "Milestone passed.",
      }),
    ).resolves.toMatchObject({
      wasDuplicate: false,
    });
    await expect(
      store.publishPersonMessage({
        admission,
        message: "Milestone passed.",
      }),
    ).resolves.toMatchObject({
      wasDuplicate: true,
      message: {
        id: row.id,
      },
      events: [],
    });
    await database
      .updateTable("runs")
      .set({
        status: "completed",
      })
      .where("id", "=", source.run.id)
      .execute();
    await expect(
      store.publishPersonMessage({
        admission,
        message: "Milestone passed.",
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
  });
  it("serializes durable per-Run receipts without an action quota", async ({ storeFixture }) => {
    const { createRunFixture, enqueueHumanTrigger, store, bindAgentControlRun, database } =
      storeFixture;
    const fixture = await createRunFixture("agent-admission-run");
    const sourceTurn = await enqueueHumanTrigger({
      content: [
        {
          text: "Start agent-control work",
          type: "text",
        },
      ],
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
      Array.from(
        {
          length: 8,
        },
        async () => store.admitRunToolCall(exactInput),
      ),
    );
    expect(exactRetries.filter(({ wasDuplicate }) => !wasDuplicate)).toHaveLength(1);
    expect(exactRetries.filter(({ wasDuplicate }) => wasDuplicate)).toHaveLength(7);
    const restartedStore = new OpensteerStore(database);
    await expect(restartedStore.admitRunToolCall(exactInput)).resolves.toMatchObject({
      actionClass: "thread.message",
      wasDuplicate: true,
    });
    await expect(
      restartedStore.admitRunToolCall({
        ...exactInput,
        requestFingerprint: createHash("sha256").update("changed-message").digest("hex"),
      }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    const remaining = 40;
    await Promise.all(
      Array.from(
        {
          length: remaining,
        },
        async (_, index) =>
          store.admitRunToolCall({
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
      restartedStore.admitRunToolCall({
        ...agentControlBinding,
        action: "thread.message",
        requestFingerprint: createHash("sha256").update("over-limit").digest("hex"),
        requestId: randomUUID(),
        runId: sourceTurn.run.id,
        sourceThreadId: fixture.thread.id,
      }),
    ).resolves.toMatchObject({
      wasDuplicate: false,
    });
    const count = await database
      .selectFrom("agentControlRequests")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("runId", "=", sourceTurn.run.id)
      .where("actionClass", "=", "thread.message")
      .executeTakeFirstOrThrow();
    expect(Number(count.count)).toBe(remaining + 2);
    await Promise.all(
      Array.from(
        {
          length: 65,
        },
        async (_, index) =>
          store.admitRunToolCall({
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
      store.admitRunToolCall({
        ...agentControlBinding,
        action: "thread.list",
        requestFingerprint: createHash("sha256").update("list-over-limit").digest("hex"),
        requestId: randomUUID(),
        runId: sourceTurn.run.id,
        sourceThreadId: fixture.thread.id,
      }),
    ).resolves.toMatchObject({
      wasDuplicate: false,
    });
    await expect(
      store.admitRunToolCall({
        ...agentControlBinding,
        action: "thread.read",
        requestFingerprint: createHash("sha256").update("read-after-list").digest("hex"),
        requestId: randomUUID(),
        runId: sourceTurn.run.id,
        sourceThreadId: fixture.thread.id,
      }),
    ).resolves.toMatchObject({
      actionClass: "thread.read",
      wasDuplicate: false,
    });
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
    });
    const requestId = randomUUID();
    const admissionRequest = {
      action: "thread.message" as const,
      bindingGeneration: source.bindingGeneration,
      environmentId: source.environmentId,
      requestedBy: source.userId,
      requestFingerprint: createHash("sha256").update("atomic-message").digest("hex"),
      requestId,
      runId: source.run.id,
      runnerBootId: source.runnerBootId,
      runnerId: source.runnerId,
      sourceThreadId: source.thread.id,
    };
    const idempotencyKey = `agent:${source.run.id}:${requestId}:message`;
    await expect(
      store.enqueueAdmittedThreadInput({
        admission: {
          kind: "agent",
          request: admissionRequest,
        },
        input: {
          content: [
            {
              text: "This transaction must roll back",
              type: "text",
            },
          ],
          idempotencyKey,
          policy: "queue",
          requestedBy: source.userId,
          source: {
            kind: "agent",
            runId: source.run.id,
          },
          threadId: createId("thread"),
        },
      }),
    ).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      database
        .selectFrom("agentControlRequests")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("runId", "=", source.run.id)
        .where("requestId", "=", requestId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      count: "0",
    });
    const committed = await store.enqueueAdmittedThreadInput({
      admission: {
        kind: "agent",
        request: admissionRequest,
      },
      input: {
        content: [
          {
            text: "Commit the receipt with its Message",
            type: "text",
          },
        ],
        idempotencyKey,
        policy: "queue",
        requestedBy: source.userId,
        source: {
          kind: "agent",
          runId: source.run.id,
        },
        threadId: target.id,
      },
    });
    expect(committed.wasDuplicate).toBe(false);
    await database
      .updateTable("runs")
      .set({
        completedAt: new Date(),
        status: "completed",
      })
      .where("id", "=", source.run.id)
      .executeTakeFirstOrThrow();
    await expect(
      store.enqueueAdmittedThreadInput({
        admission: {
          kind: "agent",
          request: admissionRequest,
        },
        input: {
          content: [
            {
              text: "Commit the receipt with its Message",
              type: "text",
            },
          ],
          idempotencyKey,
          policy: "queue",
          requestedBy: source.userId,
          source: {
            kind: "agent",
            runId: source.run.id,
          },
          threadId: target.id,
        },
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      database
        .selectFrom("messages")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("threadId", "=", target.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      count: "1",
    });
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
      requestedBy: source.userId,
      requestFingerprint: createHash("sha256").update("atomic-delegation").digest("hex"),
      requestId,
      runId: source.run.id,
      runnerBootId: source.runnerBootId,
      runnerId: source.runnerId,
      sourceThreadId: source.thread.id,
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
      task: [
        {
          text: "Create the child exactly once",
          type: "text" as const,
        },
      ],
      title: "Atomic child",
    };
    await expect(
      store.delegateAdmittedThread({
        admission: {
          kind: "agent",
          request: admissionRequest,
        },
        input: {
          ...baseInput,
        },
      }),
    ).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      database
        .selectFrom("agentControlRequests")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("runId", "=", source.run.id)
        .where("requestId", "=", requestId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      count: "0",
    });
    const delegated = await store.delegateAdmittedThread({
      admission: {
        kind: "agent",
        request: admissionRequest,
      },
      input: {
        ...baseInput,
      },
    });
    expect(delegated.wasDuplicate).toBe(false);
    await database
      .updateTable("runs")
      .set({
        completedAt: new Date(),
        status: "completed",
      })
      .where("id", "=", source.run.id)
      .executeTakeFirstOrThrow();
    await expect(
      store.delegateAdmittedThread({
        admission: {
          kind: "agent",
          request: admissionRequest,
        },
        input: {
          ...baseInput,
        },
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      database
        .selectFrom("delegations")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("parentRunId", "=", source.run.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      count: "1",
    });
  });

  /*
   * Ways tool authority could outlive what ended it:
   * - Stop and Assignment cancellation only queue an interrupt, so a token keeps
   *   working until the Runner reports the Run terminal;
   * - a Workspace being deleted still authorizes its Runs' tools;
   * - a Runner revoked or a binding replaced leaves the old grant usable;
   * - a Run-originated Request or tool call slips in after Stop;
   * - revoking tool authority also refuses the Runner's own reporting, so a
   *   stopped Run could never record how it ended.
   */
  describe("Run grants", () => {
    type Started = Awaited<ReturnType<StoreFixture["startRunFixture"]>>;
    const capability = (started: Started) => ({
      bindingGeneration: started.bindingGeneration,
      environmentId: started.environmentId,
      requestedBy: started.userId,
      runId: started.run.id,
      runnerBootId: started.runnerBootId,
      runnerId: started.runnerId,
      threadId: started.thread.id,
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
        expect.objectContaining({
          ordinal: 1,
          reason: "initial",
          status: "current",
        }),
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
        expect.objectContaining({
          revokedReason: "stopped",
          status: "revoked",
        }),
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
          data: {
            status: "interrupted",
          },
          environmentId: started.environmentId,
          ordinal: 1,
          runId: started.run.id,
          threadId: started.thread.id,
          type: "run.interrupted",
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
      ).toEqual({
        status: "interrupted",
      });
    });
    it("ends tool authority with the Run", async ({ storeFixture }) => {
      const { startRunFixture, store } = storeFixture;
      const completed = await startRunFixture("grant-run-ended");
      await store.commitRunnerEvent({
        environmentId: completed.environmentId,
        event: pendingEvent({
          bindingGeneration: completed.bindingGeneration,
          data: {
            status: "completed",
          },
          environmentId: completed.environmentId,
          ordinal: 1,
          runId: completed.run.id,
          threadId: completed.thread.id,
          type: "run.completed",
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
      await store.revokeRunner(revoked.runnerId, revoked.userId, {
        allowDeployment: true,
      });
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
        origin: {
          kind: "run",
          parentRunId: started.run.id,
          parentThreadId: started.thread.id,
        },
        task: [
          {
            text: "Child",
            type: "text",
          },
        ],
        title: "Child",
      });
      await store.claimCommand(delegated.command.id, "grant-assignment-dispatcher");
      await store.acquireExecutionBinding({
        bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
        continuationIdentity: testContinuationIdentity,
        harnessInstanceId: started.harnessInstance.id,
        leaseTokenHash: "grant-assignment-child-lease",
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
        expect.objectContaining({
          revokedReason: "assignment-cancelled",
          status: "revoked",
        }),
      ]);
    });

    it("replaces the grant when a starting Run rebinds", async ({ storeFixture }) => {
      const { createRunFixture, enqueueHumanTrigger, store } = storeFixture;
      const fixture = await createRunFixture("grant-rebind");
      const turn = await enqueueHumanTrigger({
        content: [
          {
            text: "Start",
            type: "text",
          },
        ],
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
        expect.objectContaining({
          revokedReason: "binding-replaced",
          status: "revoked",
        }),
        expect.objectContaining({
          revokedReason: null,
          status: "active",
        }),
      ]);
      expect(grants[0]!.attemptId).toBe(grants[1]!.attemptId);
    });
    it("refuses a stopped Run's Requests and tool calls", async ({ storeFixture }) => {
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
        store.admitRunToolCall({
          ...capability(started),
          action: "thread.read",
          requestFingerprint: createHash("sha256").update("after-stop").digest("hex"),
          requestId: randomUUID(),
          sourceThreadId: started.thread.id,
        }),
      ).rejects.toMatchObject({
        code: "forbidden",
      });
      await expect(
        store.requests.create({
          callId: "after-stop",
          kind: "browser.access",
          mode: "durable",
          originatingRunId: started.run.id,
          originatingThreadId: started.thread.id,
          payload: {
            kind: "browser.access",
            reason: "Choose a profile",
            suggestion: {
              kind: "user_choice",
            },
          },
          presentation: {
            kind: "external",
            subject: {
              id: started.threadId,
              kind: "thread",
            },
            title: "Browser",
          },
          requestedBy: started.userId,
          requiredActor: "requester",
        }),
      ).rejects.toMatchObject({
        code: "forbidden",
      });
    });
  });
  it("refuses an ended Run's mutation before attempting its work", async ({ storeFixture }) => {
    const { startRunFixture, database, store } = storeFixture;
    const source = await startRunFixture("agent-admission-before-work");
    await database
      .updateTable("runs")
      .set({
        completedAt: new Date(),
        status: "completed",
      })
      .where("id", "=", source.run.id)
      .executeTakeFirstOrThrow();
    const admission = (action: "thread.delegate" | "thread.message") => ({
      kind: "agent" as const,
      request: {
        action,
        bindingGeneration: source.bindingGeneration,
        environmentId: source.environmentId,
        requestedBy: source.userId,
        requestFingerprint: createHash("sha256").update(action).digest("hex"),
        requestId: randomUUID(),
        runId: source.run.id,
        runnerBootId: source.runnerBootId,
        runnerId: source.runnerId,
        sourceThreadId: source.thread.id,
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
          origin: {
            kind: "run",
            parentRunId: source.run.id,
            parentThreadId: source.thread.id,
          },
          task: [
            {
              text: "Never started",
              type: "text",
            },
          ],
          title: "Never started",
        },
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "The calling Run is no longer active",
    });
    await expect(
      store.enqueueAdmittedThreadInput({
        admission: admission("thread.message"),
        input: {
          content: [
            {
              text: "Never sent",
              type: "text",
            },
          ],
          idempotencyKey: "agent-admission-before-work-message",
          policy: "queue",
          requestedBy: source.userId,
          source: {
            kind: "agent",
            runId: source.run.id,
          },
          threadId: createId("thread"),
        },
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "The calling Run is no longer active",
    });
  });
  it("rejects every tool call after its execution terminates", async ({ storeFixture }) => {
    const { createRunFixture, enqueueHumanTrigger, store, bindAgentControlRun, database } =
      storeFixture;
    const fixture = await createRunFixture("agent-admission-authority-fence");
    const turn = await enqueueHumanTrigger({
      content: [
        {
          text: "Exercise agent authority",
          type: "text",
        },
      ],
      idempotencyKey: "agent-admission-authority-fence-turn",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    const expectedBinding = {
      bindingGeneration: 1,
      environmentId: fixture.environmentId,
      requestedBy: fixture.userId,
      runnerBootId: "boot-agent-control-agent-admission-authority-fence",
      runnerId: fixture.runnerId,
    };
    const admitted = {
      ...expectedBinding,
      action: "thread.message" as const,
      requestFingerprint: createHash("sha256").update("admitted-before-terminal").digest("hex"),
      requestId: randomUUID(),
      runId: turn.run.id,
      sourceThreadId: fixture.thread.id,
    };
    await expect(store.admitRunToolCall(admitted)).rejects.toMatchObject({
      code: "forbidden",
    });
    await store.claimCommand(turn.command.id, "agent-admission-authority-fence-dispatcher");
    expect(
      await bindAgentControlRun(fixture, turn.run.id, "agent-admission-authority-fence"),
    ).toEqual(expectedBinding);
    await expect(store.admitRunToolCall(admitted)).resolves.toMatchObject({
      wasDuplicate: false,
    });
    await database
      .updateTable("runs")
      .set({
        completedAt: new Date(),
        status: "completed",
      })
      .where("id", "=", turn.run.id)
      .executeTakeFirstOrThrow();
    await expect(store.admitRunToolCall(admitted)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      store.admitRunToolCall({
        ...admitted,
        requestFingerprint: createHash("sha256").update("new-after-terminal").digest("hex"),
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
  });
  it("rejects delegation below the durable maximum lineage depth", async ({ storeFixture }) => {
    const { createRunFixture, store, enqueueHumanTrigger, database } = storeFixture;
    const fixture = await createRunFixture("agent-admission-depth");
    let parent = fixture.thread;
    const lineage = [fixture.thread];
    for (let depth = 1; depth <= runToolMaxDelegationDepth; depth += 1) {
      const created = await store.createThread({
        createdBy: fixture.userId,
        environmentId: fixture.environmentId,
        harnessInstanceId: fixture.harnessInstance.id,
        idempotencyKey: `agent-depth-thread-${depth}`,
        modelSelection: testModelSelection,
        parentThreadId: parent.id,
        title: `Depth ${depth}`,
      });
      parent = created.thread;
      lineage.push(parent);
    }
    const allowedSource = lineage[runToolMaxDelegationDepth - 1];
    const blockedSource = lineage[runToolMaxDelegationDepth];
    if (!allowedSource || !blockedSource) throw new Error("Depth fixture is incomplete");
    const allowedTurn = await enqueueHumanTrigger({
      content: [
        {
          text: "Delegate to depth four",
          type: "text",
        },
      ],
      idempotencyKey: "agent-depth-allowed-turn",
      requestedBy: fixture.userId,
      threadId: allowedSource.id,
    });
    await store.claimCommand(allowedTurn.command.id, "agent-depth-allowed-dispatcher");
    await database
      .updateTable("runs")
      .set({
        status: "running",
      })
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
      task: [
        {
          text: "Create the deepest allowed child",
          type: "text" as const,
        },
      ],
      title: "Depth four child",
    };
    await expect(store.delegateThread(allowedInput)).resolves.toMatchObject({
      thread: {
        parentThreadId: allowedSource.id,
      },
      wasDuplicate: false,
    });
    await expect(new OpensteerStore(database).delegateThread(allowedInput)).resolves.toMatchObject({
      wasDuplicate: true,
    });
    const blockedTurn = await enqueueHumanTrigger({
      content: [
        {
          text: "Attempt depth five",
          type: "text",
        },
      ],
      idempotencyKey: "agent-depth-blocked-turn",
      requestedBy: fixture.userId,
      threadId: blockedSource.id,
    });
    await store.claimCommand(blockedTurn.command.id, "agent-depth-blocked-dispatcher");
    await database
      .updateTable("runs")
      .set({
        status: "running",
      })
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
      details: {
        maxDelegationDepth: runToolMaxDelegationDepth,
      },
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
      provenance: {
        maintainedBy: "test",
      },
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
      catalog: {
        definitions: {},
        tools: [],
      },
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
    ).rejects.toMatchObject({
      code: "bad_request",
    });
    await expect(
      platform.install({
        adapterSnapshot: {
          ...contract.adapterSnapshot,
          definitionId: "different-definition",
        },
        actorUserId: null,
        installation,
        requestId: "mismatched-adapter-snapshot",
        servers: [activeServer],
      }),
    ).rejects.toMatchObject({
      code: "bad_request",
    });
    await expect(
      platform.install({
        adapterSnapshot: contract.adapterSnapshot,
        actorUserId: null,
        installation,
        requestId: "valid-adapter-snapshot",
        servers: [activeServer],
      }),
    ).resolves.toMatchObject({
      installation: {
        id: installationId,
        status: "active",
      },
      requestEvents: [],
    });
  });

  it("grants read operations and widens the same grant while satisfying a pending read ask", async ({
    storeFixture,
  }) => {
    const {
      startRunFixture,

      database,
    } = storeFixture;
    const fixture = await startRunFixture("integration-access-widening");

    const platform = new IntegrationPlatformStore(database);
    const installationId = createIntegrationId("installation");
    const serverId = createIntegrationId("server");
    const makeTool = (name: "create" | "get" | "list") => {
      const inputSchema = {
        properties: {},
        type: "object",
      };
      return {
        annotations: {
          readOnlyHint: name !== "create",
        },
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
        provenance: {
          maintainedBy: "test",
        },
        sourceKind: "remote-mcp",
        status: "active",
        title: "Records",
        trust: "administrator-approved",
        version: "1",
      },
      requestId: "install-records-access-widening",
      servers: [
        {
          connectionRequirement: {
            kind: "none",
          },
          id: serverId,
          name: "default",
          status: "active",
          statusDetail: null,
          catalog: {
            definitions: {},
            tools: tools,
          },
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
        reason: `Need ${access} records access`,
        requestedBy: fixture.userId,
        requestedServerId: serverId,
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
    expect(readResolution.grant).toMatchObject({
      access: "read",
    });
    await expect(
      platform.listCallableTools({
        ownerUserId: fixture.userId,
        threadId: fixture.thread.id,
        providerAuthorizations: {},
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        tool: expect.objectContaining({
          name: "get",
        }),
      }),
      expect.objectContaining({
        tool: expect.objectContaining({
          name: "list",
        }),
      }),
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
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        tool: expect.objectContaining({
          name: "create",
        }),
      }),
      expect.objectContaining({
        tool: expect.objectContaining({
          name: "get",
        }),
      }),
      expect.objectContaining({
        tool: expect.objectContaining({
          name: "list",
        }),
      }),
    ]);
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
            shell: {
              hostPublicKey: `ssh-ed25519 ${"A".repeat(68)}`,
              platform: "linux",
            },
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
      shares: [
        {
          mode: "read" as const,
          path: "/srv/data",
        },
      ],
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
        .set({
          revokedAt: new Date(),
        })
        .where("id", "=", runnerId)
        .execute();
      expect(await store.setRunnerShellFullDiskAccess(runnerId, true)).toBe(false);
      await database
        .updateTable("runners")
        .set({
          revokedAt: null,
          moduleDescriptors: sql`module_descriptors - 'shell'`,
        })
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
        policy: {
          commands: false,
          forwarding: false,
          reach: "nobody",
          shares: [],
        },
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
      ).resolves.toEqual({
        outcome: "updated",
        replayed: false,
        revision: 2,
      });
      // A second editor still holding revision 1 changes nothing at all.
      await expect(
        store.updateMachineAccessPolicy({
          allowDeployment: false,
          expectedRevision: 1,
          ownerId,
          policy: {
            ...openPolicy,
            commands: false,
          },
          runnerId,
        }),
      ).resolves.toEqual({
        outcome: "conflict",
        replayed: false,
      });
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
      ).resolves.toEqual({
        outcome: "updated",
        replayed: false,
        revision: 3,
      });
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
        idempotency: {
          key: "save-access-1",
          requestedBy: ownerId,
        },
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
        idempotency: {
          key: "save-access-2",
          requestedBy: ownerId,
        },
        policy: {
          ...openPolicy,
          commands: false,
        },
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
        store.updateMachineAccessPolicy({
          ...write,
          expectedRevision: 2,
        }),
      ).rejects.toMatchObject({
        code: "conflict",
      });
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
        idempotency: {
          key: "stop-1",
          requestedBy: ownerId,
        },
        reason: "stopped-by-owner" as const,
        sessionId,
      };
      await expect(
        store.endShellSession({
          ...stop,
          bytesIn: 9,
          bytesOut: 3,
        }),
      ).resolves.toEqual({
        ended: true,
      });
      await expect(store.endShellSession(stop)).resolves.toEqual({
        ended: true,
      });
      // The replay wrote nothing: the reason and the counters are the first
      // call's, not a second ending's zeroes.
      const [row] = await store
        .listShellHistory({
          limit: 1,
          runnerId: target,
        })
        .then((page) => page.sessions);
      expect(row).toMatchObject({
        bytesIn: 9,
        bytesOut: 3,
        endReason: "stopped-by-owner",
      });
      // A key that named a different session is a mistake, not an answer.
      await expect(
        store.endShellSession({
          ...stop,
          sessionId: ShellSessionIdSchema.parse(`shs_${randomUUID()}`),
        }),
      ).rejects.toMatchObject({
        code: "conflict",
      });
    });
    it("refuses owner reach on a computer that has no owner", async ({ storeFixture }) => {
      const { store } = storeFixture;
      const adminId = await store.createUser("Administrator");

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
          policy: {
            ...openPolicy,
            reach: "owner",
          },
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
          policy: {
            ...openPolicy,
            reach: "deployment",
          },
          runnerId,
        }),
      ).resolves.toMatchObject({
        outcome: "updated",
      });
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
        new Map([
          [
            mine,
            {
              effectiveOwner: ownerId,
              ownerKind: "user",
            },
          ],
        ]),
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
      ).rejects.toMatchObject({
        code: "not_found",
      });
    });
    it("names the Personal Deployment owner as the Main machine's owner", async ({
      storeFixture,
    }) => {
      const { store } = storeFixture;
      const ownerId = await store.createUser("Personal owner");

      await store.ensureDeployment({
        canonicalOrigin: "http://127.0.0.1:4310",
        deploymentId: createId("deployment"),
        deploymentShape: {
          kind: "personal",
        },
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
            policy: {
              ...openPolicy,
              reach,
            },
            runnerId,
          }),
        ).resolves.toMatchObject({
          outcome: "updated",
        });
      }
      const reachable = await store.listReachableMachines(ownerId, self);
      expect(reachable.map((machine) => machine.runnerId).sort()).toEqual([mine, shared].sort());
      expect(reachable.some((machine) => machine.runnerId === self)).toBe(false);
      expect(reachable.find((machine) => machine.runnerId === mine)).toMatchObject({
        commands: true,
        forwarding: false,
        name: "Mine",
        platform: "linux",
        shares: [
          {
            mode: "read",
            path: "/srv/data",
          },
        ],
      });
      // A stranger reaches the Deployment-wide machines it is not one of.
      await expect(store.listReachableMachines(strangerId, self)).resolves.toMatchObject([
        {
          runnerId: shared,
        },
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
          policy: {
            ...openPolicy,
            reach: "owner",
          },
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
        policy: {
          commands: false,
          forwarding: false,
          reach: "nobody",
          shares: [],
        },
        revision: 1,
        shell: {
          platform: "linux",
        },
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
      await expect(store.getMachineAccessTarget(target)).resolves.toMatchObject({
        revision: 2,
      });
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
      ).resolves.toEqual({
        ended: true,
      });
      // A duplicate call transitions nothing and changes neither reason nor counters.
      await expect(
        store.endShellSession({
          bytesIn: 5,
          bytesOut: 1,
          reason: "host-shutdown",
          sessionId,
        }),
      ).resolves.toEqual({
        ended: false,
      });
      const page = await store.listShellHistory({
        limit: 10,
        runnerId: target,
      });
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
      ).resolves.toEqual({
        ended: false,
      });
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
      await store.endShellSession({
        reason: "client-closed",
        sessionId: closed,
      });
      await expect(store.endAllOpenShellSessions("host-shutdown")).resolves.toBe(2);
      await expect(store.listActiveShellSessions(target)).resolves.toEqual([]);
      const page = await store.listShellHistory({
        limit: 10,
        runnerId: target,
      });
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
        ({
          at,
          event: {
            channel,
            command: "echo",
            kind: "exec",
          },
        }) as const;
      await expect(
        store.appendShellEvents(
          sessionId,
          Array.from(
            {
              length: 990,
            },
            (_, index) => exec(index),
          ),
        ),
      ).resolves.toBe(990);
      await expect(
        store.appendShellEvents(
          sessionId,
          Array.from(
            {
              length: 20,
            },
            (_, index) => exec(1_000 + index),
          ),
        ),
      ).resolves.toBe(10);
      // Everything after the marker is dropped rather than stored.
      await expect(store.appendShellEvents(sessionId, [exec(9_999)])).resolves.toBe(0);
      const page = await store.listShellHistory({
        limit: 10,
        runnerId: target,
      });
      const events = page.sessions[0]?.events ?? [];
      expect(events).toHaveLength(1_001);
      expect(events.at(-1)).toEqual({
        kind: "truncated",
      });
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
      const first = await store.listShellHistory({
        limit: 2,
        runnerId: target,
      });
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
        store.listShellHistory({
          before: "not-a-cursor",
          limit: 2,
          runnerId: target,
        }),
      ).rejects.toMatchObject({
        code: "bad_request",
      });
      await expect(
        store.listShellHistory({
          limit: 51,
          runnerId: target,
        }),
      ).rejects.toMatchObject({
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
        {
          bytesIn: 0,
          bytesOut: 0,
          callerMachineName: "Caller",
          id: sessionId,
        },
      ]);
      // The full row resolves the session's machine and stays readable once ended.
      await expect(store.getShellSession(sessionId)).resolves.toMatchObject({
        runnerId: target,
        state: "active",
      });
      await store.endShellSession({
        reason: "stopped-by-owner",
        sessionId,
      });
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
      ).rejects.toMatchObject({
        code: "conflict",
      });
    });
  });
});
