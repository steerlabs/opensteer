import { randomUUID } from "node:crypto";
import {
  IntegrationDefinitionSchema,
  createIntegrationId,
  integrationDefinitionSummary,
} from "@opensteer/integration-core";
import { integrationDefinitionDigest } from "@opensteer/integration-core/digest";
import {
  emptyExecutionPreferences,
  HarnessIdSchema,
  ThreadAccessModeSchema,
  ModelSelectionSchema,
  RequestViewSchema,
  WorkspaceIdSchema,
  createId,
  type Workspace,
  type RequestId,
} from "@opensteer/core";
import { createBrowserSessionId, HarnessInstanceCatalogSchema } from "@opensteer/protocol";
import { sql } from "kysely";
import { expect } from "vitest";
import { admitThreadExecution } from "./execution-authority.js";
import {
  ChannelIngressDeferredError,
  ChannelStore,
  IntegrationPlatformStore,
  installIntegrationInTransaction,
  OpensteerStore,
} from "./index.js";
import {
  describeStore,
  testModelSelection,
  testContinuationIdentity,
  testMessagingRunnerId,
  testChannelNotices,
  testChannelAccessPolicy,
  writeBrowserUsageArtifact,
  enrollTestRunner,
  testOpenApiAdapterContract,
} from "./store.integration.test-support.js";

describeStore("PostgreSQL store", (it) => {
  it("keeps Occurrence Request resolution compatible with Trigger inbox admission", async ({
    storeFixture,
  }) => {
    const {
      startRunFixture,
      startTriggerOccurrence,
      createSpecializedWorkspace,
      store,
      stagedRequestRace,
    } = storeFixture;
    const fixture = await startRunFixture("request-occurrence-fk-race");
    const occurrence = await startTriggerOccurrence(fixture, "request-occurrence-fk-race");
    const target = await createSpecializedWorkspace(fixture.userId, "request-occurrence-fk-target");
    const opened = await store.requests.create({
      callId: "request-occurrence-fk-race",
      kind: "browser.access",
      mode: "durable",
      originatingOccurrenceId: occurrence.id,
      originatingThreadId: fixture.thread.id,
      originatingWorkspaceId: fixture.workspace.id,
      targetWorkspaceId: target.id,
      requestedBy: fixture.userId,
      requiredActor: "requester",
      payload: {
        kind: "browser.access",
        reason: "Choose a profile",
        suggestion: { kind: "user_choice" },
      },
      presentation: {
        kind: "external",
        title: "Choose browser access",
        subject: { id: target.id, kind: "workspace" },
      },
    });
    const results = await stagedRequestRace(
      (transaction) =>
        transaction
          .selectFrom("requests")
          .select("id")
          .where("id", "=", opened.request.id)
          .forUpdate()
          .execute(),
      () =>
        store.requests.resolveBrowserRequest({
          requestId: opened.request.id,
          resolvedBy: fixture.userId,
          response: { kind: "external", value: { decision: "declined" } },
        }),
      () =>
        store.enqueueThreadInput({
          content: [{ type: "text", text: "Trigger report" }],
          idempotencyKey: "request-occurrence-fk-race",
          policy: "report",
          requestedBy: fixture.userId,
          source: { kind: "trigger", occurrenceId: occurrence.id },
          threadId: fixture.thread.id,
        }),
    );
    expect(results.map(({ status }) => status)).toEqual(["fulfilled", "fulfilled"]);
    expect(results[0]).toMatchObject({
      value: {
        request: { status: "declined", originatingOccurrenceId: occurrence.id },
        events: [expect.objectContaining({ type: "request.resolved", runId: null })],
      },
    });
  });

  it("serializes durable Request withdrawal behind the resolution event", async ({
    storeFixture,
  }) => {
    const { startRunFixture, createSpecializedWorkspace, store, database } = storeFixture;
    const fixture = await startRunFixture("request-withdrawal-state-race");
    const target = await createSpecializedWorkspace(
      fixture.userId,
      "request_withdrawal_state_race",
    );
    const opened = await store.requests.create({
      callId: "request-withdrawal-state-race",
      kind: "browser.access",
      mode: "durable",
      originatingRunId: fixture.run.id,
      originatingThreadId: fixture.thread.id,
      originatingWorkspaceId: fixture.workspace.id,
      payload: {
        kind: "browser.access",
        reason: "Choose a profile",
        suggestion: { kind: "user_choice" },
      },
      presentation: {
        kind: "external",
        subject: { id: target.id, kind: "workspace" },
        title: "Choose browser access",
      },
      requestedBy: fixture.userId,
      requiredActor: "requester",
      targetWorkspaceId: target.id,
    });
    let releaseThread!: () => void;
    const releaseSignal = new Promise<void>((resolve) => {
      releaseThread = resolve;
    });
    let announceThread!: () => void;
    const threadLocked = new Promise<void>((resolve) => {
      announceThread = resolve;
    });
    const blocker = database.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom("threads")
        .select("id")
        .where("id", "=", fixture.thread.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      announceThread();
      await releaseSignal;
    });
    await threadLocked;
    const waitForWaiters = (count: number) =>
      expect
        .poll(async () => {
          const result = await sql<{ readonly waiting: number }>`
        select count(*)::integer as waiting from pg_stat_activity
        where datname = current_database()
          and application_name = 'opensteer-integration-test'
          and wait_event_type = 'Lock'
      `.execute(database);
          return Number(result.rows[0]?.waiting ?? 0);
        })
        .toBeGreaterThanOrEqual(count);
    const resolving = store.requests.resolveBrowserRequest({
      requestId: opened.request.id,
      resolvedBy: fixture.userId,
      response: { kind: "external", value: { decision: "declined" } },
    });
    void resolving.catch(() => undefined);
    const withdrawing = (async () => {
      await waitForWaiters(1);
      return store.requests.withdraw({
        requestId: opened.request.id,
        threadId: fixture.thread.id,
        withdrawnBy: fixture.userId,
      });
    })();
    void withdrawing.catch(() => undefined);
    try {
      await waitForWaiters(2);
    } finally {
      releaseThread();
      await blocker;
    }
    const [resolution, withdrawal] = await Promise.allSettled([resolving, withdrawing]);
    expect(resolution).toMatchObject({
      status: "fulfilled",
      value: { request: { status: "declined" } },
    });
    expect(withdrawal).toMatchObject({ status: "rejected", reason: { code: "conflict" } });
    await expect(store.getThreadForOwner(fixture.thread.id, fixture.userId)).resolves.toMatchObject(
      { pendingRequests: 0 },
    );
    await expect(
      database
        .selectFrom("threads")
        .select("pendingRequestCount")
        .where("id", "=", fixture.thread.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ pendingRequestCount: 0 });
  });

  it("opens, replays, and withdraws a durable Request that originates from a Trigger Occurrence", async ({
    storeFixture,
  }) => {
    const { startRunFixture, createSpecializedWorkspace, startTriggerOccurrence, store } =
      storeFixture;
    const fixture = await startRunFixture("request-trigger-origin");
    const targetWorkspace = await createSpecializedWorkspace(
      fixture.userId,
      "request_trigger_origin_target",
    );
    const occurrence = await startTriggerOccurrence(fixture, "request-trigger-origin");
    const input = {
      callId: "trigger-browser-access-call-1",
      kind: "browser.access" as const,
      mode: "durable" as const,
      originatingOccurrenceId: occurrence.id,
      originatingThreadId: fixture.thread.id,
      originatingWorkspaceId: fixture.workspace.id,
      payload: {
        kind: "browser.access" as const,
        reason: "The schedule needs the signed-in browser profile",
        suggestion: { kind: "user_choice" as const },
      },
      presentation: {
        kind: "external" as const,
        subject: { id: targetWorkspace.id, kind: "workspace" },
        title: "Choose browser access",
      },
      requestedBy: fixture.userId,
      requiredActor: "requester" as const,
      targetWorkspaceId: targetWorkspace.id,
    };

    const created = await store.requests.create(input);
    const replay = await store.requests.create(input);

    expect(created).toMatchObject({
      // A Trigger Occurrence has no Run to attribute its event to.
      events: [expect.objectContaining({ runId: null, type: "request.opened" })],
      replayed: false,
      request: {
        originatingOccurrenceId: occurrence.id,
        originatingRunId: null,
        status: "pending",
      },
    });
    expect(replay).toMatchObject({ replayed: true, request: { id: created.request.id } });
    await expect(
      store.requests.findByCallIdentity({
        callId: input.callId,
        originatingOccurrenceId: occurrence.id,
      }),
    ).resolves.toMatchObject({ id: created.request.id });
    // The same call identity under the Run origin is a different Request.
    await expect(
      store.requests.findByCallIdentity({
        callId: input.callId,
        originatingRunId: fixture.run.id,
      }),
    ).resolves.toBeNull();
    const { originatingOccurrenceId: _occurrenceOrigin, ...runOriginInput } = input;
    await expect(
      store.requests.create({ ...runOriginInput, originatingRunId: fixture.run.id }),
    ).resolves.toMatchObject({ replayed: false, request: { originatingRunId: fixture.run.id } });

    const withdrawn = await store.requests.withdraw({
      requestId: created.request.id,
      threadId: fixture.thread.id,
      withdrawnBy: fixture.userId,
    });
    expect(withdrawn).toMatchObject({
      events: [expect.objectContaining({ runId: null, type: "request.resolved" })],
      replayed: false,
      request: { status: "withdrawn" },
    });

    // Authority removal reaches a Trigger-originated Request the same way, and
    // its cancellation event reads the environment from the Occurrence.
    const cancelled = await store.requests.create({
      ...input,
      callId: "trigger-browser-access-call-2",
    });
    const deletion = await store.requestWorkspaceDeletion({
      purgeAfter: new Date(Date.now() + 60_000),
      requestedBy: fixture.userId,
      workspaceId: targetWorkspace.id,
    });
    expect(deletion.requestEvents).toContainEqual(
      expect.objectContaining({
        data: { reason: "workspace-deleted", requestId: cancelled.request.id },
        runId: null,
        type: "request.cancelled",
      }),
    );
    await expect(store.requests.get(cancelled.request.id)).resolves.toMatchObject({
      cancellationReason: "workspace-deleted",
      status: "cancelled",
    });
  });

  it("refuses a Trigger-originated Request whose Occurrence is not the one that is running", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, startTriggerOccurrence } = storeFixture;
    const fixture = await startRunFixture("request-trigger-authority");
    const otherOwner = await store.createUser("Other trigger owner");
    const occurrence = await startTriggerOccurrence(fixture, "request-trigger-authority");
    const input = {
      callId: "trigger-authority-call-1",
      kind: "integration.install" as const,
      mode: "durable" as const,
      originatingThreadId: fixture.thread.id,
      originatingWorkspaceId: fixture.workspace.id,
      payload: {
        kind: "integration.install" as const,
        manifest: { kind: "catalog" },
        reason: "The schedule needs it",
      },
      presentation: {
        kind: "choice" as const,
        options: [{ hint: "confirm" as const, id: "installed", label: "Install" }],
        title: "Install?",
      },
      requestedBy: fixture.userId,
      requiredActor: "administrator" as const,
      targetWorkspaceId: fixture.workspace.id,
    };

    await expect(
      store.requests.create({
        ...input,
        originatingOccurrenceId: createId("triggerOccurrence"),
      }),
    ).rejects.toThrow("Trigger Occurrence authority");
    await expect(
      store.requests.create({
        ...input,
        originatingOccurrenceId: occurrence.id,
        requestedBy: otherOwner,
      }),
    ).rejects.toThrow("Trigger Occurrence authority");
  });

  it("holds the Request origin invariants in the schema itself", async ({ storeFixture }) => {
    const { startRunFixture, startTriggerOccurrence, database } = storeFixture;
    const fixture = await startRunFixture("request-origin-constraints");
    const occurrence = await startTriggerOccurrence(fixture, "request-origin-constraints");
    const insertRequest = (values: {
      readonly callId: string;
      readonly mode: "durable" | "live";
      readonly occurrenceId: string | null;
      readonly runId: string | null;
    }) =>
      database
        .insertInto("requests")
        .values({
          callId: values.callId,
          cancellationReason: null,
          createdAt: new Date(),
          id: createId("request"),
          kind: values.mode === "live" ? "harness.approval" : "integration.install",
          mode: values.mode,
          originatingOccurrenceId: values.occurrenceId as never,
          originatingRunId: values.runId as never,
          originatingThreadId: fixture.thread.id,
          originatingWorkspaceId: fixture.workspace.id,
          payload: sql`${JSON.stringify({ kind: "integration.install" })}::jsonb`,
          presentation: sql`${JSON.stringify({ kind: "choice", options: [], title: "x" })}::jsonb`,
          requestedBy: fixture.userId,
          requiredActor: "administrator",
          resolvedAt: null,
          resolvedBy: null,
          response: null,
          status: "pending",
          targetWorkspaceId: fixture.workspace.id,
        })
        .execute();

    // Exactly one origin, never both and never neither.
    await expect(
      insertRequest({
        callId: "both",
        mode: "durable",
        occurrenceId: occurrence.id,
        runId: fixture.run.id,
      }),
    ).rejects.toThrow("requests_origin_check");
    await expect(
      insertRequest({ callId: "neither", mode: "durable", occurrenceId: null, runId: null }),
    ).rejects.toThrow("requests_origin_check");
    // A live Request is answered back into the Run that opened it.
    await expect(
      insertRequest({ callId: "live", mode: "live", occurrenceId: occurrence.id, runId: null }),
    ).rejects.toThrow("requests_origin_check");

    // Call identity is unique per origin, and NULLs on the other side never collide.
    await insertRequest({
      callId: "shared",
      mode: "durable",
      occurrenceId: occurrence.id,
      runId: null,
    });
    await insertRequest({
      callId: "shared",
      mode: "durable",
      occurrenceId: null,
      runId: fixture.run.id,
    });
    await expect(
      insertRequest({
        callId: "shared",
        mode: "durable",
        occurrenceId: occurrence.id,
        runId: null,
      }),
    ).rejects.toThrow("requests_occurrence_call_identity_unique");
    await expect(
      insertRequest({
        callId: "shared",
        mode: "durable",
        occurrenceId: null,
        runId: fixture.run.id,
      }),
    ).rejects.toThrow("requests_run_call_identity_unique");
  });

  it("cancels Requests atomically when membership or target Workspace authority is removed", async ({
    storeFixture,
  }) => {
    const { startRunFixture, createSpecializedWorkspace, store, database } = storeFixture;
    const fixture = await startRunFixture("request-authority-removal");
    const requestInput = (callId: string, targetWorkspaceId: Workspace["id"]) => ({
      callId,
      kind: "browser.access" as const,
      mode: "durable" as const,
      originatingRunId: fixture.run.id,
      originatingThreadId: fixture.thread.id,
      originatingWorkspaceId: fixture.workspace.id,
      payload: {
        kind: "browser.access" as const,
        reason: "Use the signed-in browser profile",
        suggestion: { kind: "user_choice" as const },
      },
      presentation: {
        kind: "external" as const,
        subject: { id: targetWorkspaceId, kind: "workspace" },
        title: "Choose browser access",
      },
      requestedBy: fixture.userId,
      requiredActor: "requester" as const,
      targetWorkspaceId,
    });

    const membershipTarget = await createSpecializedWorkspace(
      fixture.userId,
      "request_membership_revocation",
    );
    const revokingOwnerId = await store.createUser("Request revoking owner");
    await database
      .insertInto("workspaceMemberships")
      .values({
        generation: 1,
        id: createId("workspaceMembership"),
        invitedBy: fixture.userId,
        joinedAt: new Date(),
        revokedAt: null,
        revokedBy: null,
        role: "owner",
        state: "active",
        updatedAt: new Date(),
        userId: revokingOwnerId,
        workspaceId: membershipTarget.id,
      })
      .executeTakeFirstOrThrow();
    const membershipRequest = await store.requests.create(
      requestInput("request-membership-revocation", membershipTarget.id),
    );
    const revoked = await store.changeWorkspaceMembership({
      actorId: revokingOwnerId,
      state: "revoked",
      targetUserId: fixture.userId,
      workspaceId: membershipTarget.id,
    });
    expect(revoked.requestEvents).toEqual([
      expect.objectContaining({
        data: { reason: "membership-revoked", requestId: membershipRequest.request.id },
        type: "request.cancelled",
      }),
    ]);
    await expect(store.requests.get(membershipRequest.request.id)).resolves.toMatchObject({
      cancellationReason: "membership-revoked",
      status: "cancelled",
    });
    await expect(
      store.requests.create(requestInput("request-membership-revocation", membershipTarget.id)),
    ).resolves.toMatchObject({ replayed: true, request: { status: "cancelled" } });
    await expect(
      store.requests.create(
        requestInput("request-membership-after-revocation", membershipTarget.id),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });

    const deletionTarget = await createSpecializedWorkspace(
      fixture.userId,
      "request_workspace_deletion",
    );
    const deletionRequest = await store.requests.create(
      requestInput("request-workspace-deletion", deletionTarget.id),
    );
    const deletion = await store.requestWorkspaceDeletion({
      purgeAfter: new Date(Date.now() + 60_000),
      requestedBy: fixture.userId,
      workspaceId: deletionTarget.id,
    });
    expect(deletion.requestEvents).toEqual([
      expect.objectContaining({
        data: { reason: "workspace-deleted", requestId: deletionRequest.request.id },
        type: "request.cancelled",
      }),
    ]);
    await expect(store.requests.get(deletionRequest.request.id)).resolves.toMatchObject({
      cancellationReason: "workspace-deleted",
      status: "cancelled",
    });
    await expect(
      store.requests.create(requestInput("request-workspace-deletion", deletionTarget.id)),
    ).resolves.toMatchObject({ replayed: true, request: { status: "cancelled" } });
    await expect(
      store.requests.create(requestInput("request-workspace-after-deletion", deletionTarget.id)),
    ).rejects.toMatchObject({ code: "conflict" });
    await store.recoverWorkspaceDeletion({
      requestedBy: fixture.userId,
      workspaceId: deletionTarget.id,
    });
    await expect(store.requests.get(deletionRequest.request.id)).resolves.toMatchObject({
      cancellationReason: "workspace-deleted",
      status: "cancelled",
    });
    await expect(store.requests.listPendingContinuations()).resolves.toEqual([]);
  });

  it("serializes cross-Workspace Request creation against source membership revocation", async ({
    storeFixture,
  }) => {
    const { startRunFixture, createSpecializedWorkspace, store, database } = storeFixture;
    const fixture = await startRunFixture("request-source-membership-race");
    const targetWorkspace = await createSpecializedWorkspace(
      fixture.userId,
      "request_source_membership_race_target",
    );
    const revokingOwnerId = await store.createUser("Source revocation race owner");
    await database
      .insertInto("workspaceMemberships")
      .values({
        generation: 1,
        id: createId("workspaceMembership"),
        invitedBy: fixture.userId,
        joinedAt: new Date(),
        revokedAt: null,
        revokedBy: null,
        role: "owner",
        state: "active",
        updatedAt: new Date(),
        userId: revokingOwnerId,
        workspaceId: fixture.workspace.id,
      })
      .executeTakeFirstOrThrow();
    const input = {
      callId: "request-source-membership-race-call",
      kind: "browser.access" as const,
      mode: "durable" as const,
      originatingRunId: fixture.run.id,
      originatingThreadId: fixture.thread.id,
      originatingWorkspaceId: fixture.workspace.id,
      payload: {
        kind: "browser.access" as const,
        reason: "Use a specialized browser from Main",
        suggestion: { kind: "user_choice" as const },
      },
      presentation: {
        kind: "external" as const,
        subject: { id: targetWorkspace.id, kind: "workspace" },
        title: "Choose browser access",
      },
      requestedBy: fixture.userId,
      requiredActor: "requester" as const,
      targetWorkspaceId: targetWorkspace.id,
    };

    const [creation, revocation] = await Promise.allSettled([
      store.requests.create(input),
      store.changeWorkspaceMembership({
        actorId: revokingOwnerId,
        state: "revoked",
        targetUserId: fixture.userId,
        workspaceId: fixture.workspace.id,
      }),
    ]);

    expect(revocation.status).toBe("fulfilled");
    const canonical = await database
      .selectFrom("requests")
      .select(["id", "status"])
      .where("originatingRunId", "=", fixture.run.id)
      .where("callId", "=", input.callId)
      .executeTakeFirst();
    if (creation.status === "fulfilled") {
      expect(canonical).toMatchObject({ id: creation.value.request.id, status: "cancelled" });
      await expect(store.requests.create(input)).resolves.toMatchObject({
        replayed: true,
        request: { id: creation.value.request.id, status: "cancelled" },
      });
    } else {
      expect(creation.reason).toMatchObject({ code: "forbidden" });
      expect(canonical).toBeUndefined();
    }
  });

  it("serializes cross-Workspace Request creation against source Workspace deletion", async ({
    storeFixture,
  }) => {
    const { startRunFixture, createSpecializedWorkspace, store, database } = storeFixture;
    const fixture = await startRunFixture("request-source-deletion-race");
    const targetWorkspace = await createSpecializedWorkspace(
      fixture.userId,
      "request_source_deletion_race_target",
    );
    const input = {
      callId: "request-source-deletion-race-call",
      kind: "browser.access" as const,
      mode: "durable" as const,
      originatingRunId: fixture.run.id,
      originatingThreadId: fixture.thread.id,
      originatingWorkspaceId: fixture.workspace.id,
      payload: {
        kind: "browser.access" as const,
        reason: "Use a specialized browser from Main",
        suggestion: { kind: "user_choice" as const },
      },
      presentation: {
        kind: "external" as const,
        subject: { id: targetWorkspace.id, kind: "workspace" },
        title: "Choose browser access",
      },
      requestedBy: fixture.userId,
      requiredActor: "requester" as const,
      targetWorkspaceId: targetWorkspace.id,
    };

    const [creation, deletion] = await Promise.allSettled([
      store.requests.create(input),
      store.requestWorkspaceDeletion({
        purgeAfter: new Date(Date.now() + 60_000),
        requestedBy: fixture.userId,
        workspaceId: fixture.workspace.id,
      }),
    ]);

    expect(deletion.status).toBe("fulfilled");
    const canonical = await database
      .selectFrom("requests")
      .select(["id", "status"])
      .where("originatingRunId", "=", fixture.run.id)
      .where("callId", "=", input.callId)
      .executeTakeFirst();
    if (creation.status === "fulfilled") {
      expect(canonical).toMatchObject({ id: creation.value.request.id, status: "cancelled" });
      await expect(store.requests.create(input)).resolves.toMatchObject({
        replayed: true,
        request: { id: creation.value.request.id, status: "cancelled" },
      });
    } else {
      expect(creation.reason).toMatchObject({ code: "conflict" });
      expect(canonical).toBeUndefined();
    }
  });

  it.for(
    ["source revocation", "target revocation", "target deletion"].flatMap((removal) =>
      ["wsp_00000000-0000-4000-8000-000000000001", "wsp_ffffffff-ffff-4fff-bfff-ffffffffffff"].map(
        (targetId) => ({ removal, targetId }),
      ),
    ),
  )(
    "serializes cross-Workspace Browser resolution against $removal ($targetId)",
    async ({ removal, targetId }, { storeFixture }) => {
      const { startRunFixture, createSpecializedWorkspace, store, database } = storeFixture;
      const fixture = await startRunFixture("request-source-resolution-race");
      const targetWorkspace = await createSpecializedWorkspace(
        fixture.userId,
        "request_source_resolution_race_target",
        WorkspaceIdSchema.parse(targetId),
      );
      const revokingOwnerId = await store.createUser("Source resolution race owner");
      const removedWorkspaceId =
        removal === "source revocation" ? fixture.workspace.id : targetWorkspace.id;
      await database
        .insertInto("workspaceMemberships")
        .values({
          generation: 1,
          id: createId("workspaceMembership"),
          invitedBy: fixture.userId,
          joinedAt: new Date(),
          revokedAt: null,
          revokedBy: null,
          role: "owner",
          state: "active",
          updatedAt: new Date(),
          userId: revokingOwnerId,
          workspaceId: removedWorkspaceId,
        })
        .executeTakeFirstOrThrow();
      const opened = await store.requests.create({
        callId: "request-source-resolution-race-call",
        kind: "browser.access",
        mode: "durable",
        originatingRunId: fixture.run.id,
        originatingThreadId: fixture.thread.id,
        originatingWorkspaceId: fixture.workspace.id,
        payload: {
          kind: "browser.access",
          reason: "Create browser authority in the specialized Workspace",
          suggestion: { kind: "user_choice" },
        },
        presentation: {
          kind: "external",
          subject: { id: targetWorkspace.id, kind: "workspace" },
          title: "Choose browser access",
        },
        requestedBy: fixture.userId,
        requiredActor: "requester",
        targetWorkspaceId: targetWorkspace.id,
      });

      let releaseWorkspace!: () => void;
      const releaseSignal = new Promise<void>((resolve) => {
        releaseWorkspace = resolve;
      });
      let announceWorkspace!: () => void;
      const workspaceLocked = new Promise<void>((resolve) => {
        announceWorkspace = resolve;
      });
      const blocker = database.transaction().execute(async (transaction) => {
        await transaction
          .selectFrom("workspaces")
          .select("id")
          .where("id", "=", removedWorkspaceId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        announceWorkspace();
        await releaseSignal;
      });
      await workspaceLocked;
      const waitForWorkspaceWaiters = (count: number) =>
        expect
          .poll(async () => {
            const result = await sql<{ readonly waiting: number }>`
            select count(*)::integer as waiting from pg_stat_activity
            where datname = current_database()
              and application_name = 'opensteer-integration-test'
              and wait_event_type = 'Lock'
              and query ilike '%workspaces%'
          `.execute(database);
            return Number(result.rows[0]?.waiting ?? 0);
          })
          .toBeGreaterThanOrEqual(count);
      const revoking =
        removal === "target deletion"
          ? store.requestWorkspaceDeletion({
              requestedBy: revokingOwnerId,
              workspaceId: removedWorkspaceId,
              purgeAfter: new Date(Date.now() + 86_400_000),
            })
          : store.changeWorkspaceMembership({
              actorId: revokingOwnerId,
              state: "revoked",
              targetUserId: fixture.userId,
              workspaceId: removedWorkspaceId,
            });
      void revoking.catch(() => undefined);
      const resolving = (async () => {
        await waitForWorkspaceWaiters(1);
        return store.requests.resolveBrowserRequest({
          requestId: opened.request.id,
          resolvedBy: fixture.userId,
          response: {
            kind: "external",
            value: { createProfile: { name: "Race profile" }, decision: "fulfilled" },
          },
        });
      })();
      void resolving.catch(() => undefined);
      try {
        await waitForWorkspaceWaiters(2);
      } finally {
        releaseWorkspace();
        await blocker;
      }
      const [resolution, revocation] = await Promise.allSettled([resolving, revoking]);

      expect(revocation.status).toBe("fulfilled");
      const canonical = await store.requests.get(opened.request.id);
      const profileCount = await database
        .selectFrom("browserProfiles")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("ownerId", "=", fixture.userId)
        .executeTakeFirstOrThrow();
      const grantCount = await database
        .selectFrom("browserProfileGrants")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("workspaceId", "=", targetWorkspace.id)
        .executeTakeFirstOrThrow();
      if (resolution.status === "fulfilled") {
        expect(canonical).toMatchObject({ status: "fulfilled" });
        expect(Number(profileCount.count)).toBe(1);
        expect(Number(grantCount.count)).toBe(1);
      } else {
        expect(resolution.reason).toMatchObject({
          code: expect.stringMatching(/conflict|forbidden/),
        });
        expect(canonical).toMatchObject({
          cancellationReason:
            removal === "target deletion" ? "workspace-deleted" : "membership-revoked",
          status: "cancelled",
        });
        expect(Number(profileCount.count)).toBe(0);
        expect(Number(grantCount.count)).toBe(0);
      }
    },
  );

  it.for(["existing", "new", "declined"] as const)(
    "persists the Host-derived browser access outcome for %s decisions",
    async (choice, { storeFixture }) => {
      const { startRunFixture, createSpecializedWorkspace, store, database } = storeFixture;
      const fixture = await startRunFixture(`browser-outcome-${choice}`);
      const target = await createSpecializedWorkspace(fixture.userId, `browser_outcome_${choice}`);
      const existing = await store.createBrowserProfile({
        idempotencyKey: `store.integration.test-browser-outcome-${choice}`,
        ownerId: fixture.userId,
        name: "Chosen profile",
      });
      const opened = await store.requests.create({
        callId: `browser-outcome-${choice}`,
        kind: "browser.access",
        mode: "durable",
        originatingRunId: fixture.run.id,
        originatingThreadId: fixture.thread.id,
        originatingWorkspaceId: fixture.workspace.id,
        targetWorkspaceId: target.id,
        requestedBy: fixture.userId,
        requiredActor: "requester",
        payload: {
          kind: "browser.access",
          reason: "Create a work profile",
          suggestion: { kind: "new", suggestedName: "Suggested work" },
        },
        presentation: {
          kind: "external",
          title: "Choose a profile",
          subject: { id: target.id, kind: "workspace" },
        },
      });
      const value =
        choice === "existing"
          ? { decision: "fulfilled", profileId: existing.id }
          : choice === "new"
            ? { decision: "fulfilled", createProfile: { name: 'Owner "renamed" work' } }
            : { decision: "declined" };
      await expect(
        store.requests.resolveBrowserRequest({
          requestId: opened.request.id,
          resolvedBy: fixture.userId,
          response: {
            kind: "external",
            value: { ...value, profile: { id: existing.id, name: "Forged" } },
          },
        }),
      ).rejects.toMatchObject({ code: "bad_request" });
      expect((await store.requests.get(opened.request.id))?.status).toBe("pending");
      const resolved = await store.requests.resolveBrowserRequest({
        requestId: opened.request.id,
        resolvedBy: fixture.userId,
        response: { kind: "external", value },
      });
      const reread = await new OpensteerStore(database).requests.get(opened.request.id);
      const raw = await database
        .selectFrom("requests")
        .select("response")
        .where("id", "=", opened.request.id)
        .executeTakeFirstOrThrow();
      await writeBrowserUsageArtifact(`browser-request-outcome-${choice}.json`, {
        resolved,
        reread,
        raw,
      });
      const expectedResponse = {
        kind: "external",
        value: {
          ...value,
          ...(choice === "declined"
            ? {}
            : {
                profile: {
                  id: choice === "existing" ? existing.id : resolved.profile?.id,
                  name: choice === "existing" ? existing.name : 'Owner "renamed" work',
                },
              }),
        },
      };
      expect(resolved.request.response).toEqual(expectedResponse);
      expect(reread?.response).toEqual(expectedResponse);
      expect(RequestViewSchema.parse(reread).response).toEqual(expectedResponse);
      expect(raw.response).toEqual(expectedResponse);
      expect(reread?.status).toBe(choice === "declined" ? "declined" : "fulfilled");
      if (choice === "declined") {
        expect(resolved.profile).toBeNull();
        expect(resolved.grant).toBeNull();
      } else {
        expect(resolved.profile).toMatchObject({
          id: expect.any(String),
          name: choice === "existing" ? existing.name : 'Owner "renamed" work',
        });
        expect(resolved.grant?.profileId).toBe(resolved.profile?.id);
      }
    },
  );

  it("fulfills repeated browser access requests with one existing grant, including at capacity", async ({
    storeFixture,
  }) => {
    const { startRunFixture, createSpecializedWorkspace, store, database } = storeFixture;
    const fixture = await startRunFixture("browser-access-existing");
    const target = await createSpecializedWorkspace(fixture.userId, "browser_access_existing");
    const profile = await store.createBrowserProfile({
      idempotencyKey: "store.integration.test-browser-profile-1",
      ownerId: fixture.userId,
      name: "Personal",
    });
    const grant = await store.createBrowserProfileGrant({
      access: "full-control",
      createdBy: fixture.userId,
      profileId: profile.id,
      workspaceId: target.id,
    });
    const open = (callId: string) =>
      store.requests.create({
        callId,
        kind: "browser.access",
        mode: "durable",
        originatingRunId: fixture.run.id,
        originatingThreadId: fixture.thread.id,
        originatingWorkspaceId: fixture.workspace.id,
        targetWorkspaceId: target.id,
        requestedBy: fixture.userId,
        requiredActor: "requester",
        payload: {
          kind: "browser.access",
          reason: "Use this profile",
          suggestion: { kind: "user_choice" },
        },
        presentation: {
          kind: "external",
          title: "Choose a profile",
          subject: { id: target.id, kind: "workspace" },
        },
      });
    const resolve = (requestId: RequestId, profileId = profile.id) =>
      store.requests.resolveBrowserRequest({
        requestId,
        resolvedBy: fixture.userId,
        response: { kind: "external", value: { decision: "fulfilled", profileId } },
      });
    const extraProfiles = Array.from({ length: 99 }, (_, i) => ({
      id: createId("browserProfile"),
      name: `Profile ${i}`,
      ownerId: fixture.userId,
      revision: 0,
    }));
    await database.insertInto("browserProfiles").values(extraProfiles).execute();
    await database
      .insertInto("browserProfileGrants")
      .values(
        extraProfiles.map(({ id }) => ({
          id: createId("browserProfileGrant"),
          createdBy: fixture.userId,
          profileId: id,
          workspaceId: target.id,
          access: "full-control",
          revokedAt: null,
        })),
      )
      .execute();
    const first = await open("existing-first");
    const second = await open("existing-second");
    const results = await Promise.all([resolve(first.request.id), resolve(second.request.id)]);
    for (const result of results) {
      expect(result).toMatchObject({
        grant: { grantId: grant.grantId },
        request: { status: "fulfilled" },
      });
    }
    const continuations = await database
      .selectFrom("requestContinuations")
      .select("requestId")
      .where("requestId", "in", [first.request.id, second.request.id])
      .execute();
    expect(continuations).toHaveLength(2);
    expect(
      await store.listActiveBrowserProfileGrantsForWorkspace(target.id, fixture.userId),
    ).toHaveLength(100);
    const newProfile = await store.createBrowserProfile({
      idempotencyKey: "store.integration.test-browser-profile-2",
      ownerId: fixture.userId,
      name: "New",
    });
    const atCapacity = await open("new-at-capacity");
    await expect(resolve(atCapacity.request.id, newProfile.id)).rejects.toMatchObject({
      code: "resource_exhausted",
    });
    expect((await store.requests.get(atCapacity.request.id))?.status).toBe("pending");
    await store.revokeBrowserProfileGrant(grant.grantId, fixture.userId);
    const renewed = await open("revoked-grant");
    const renewedResult = await resolve(renewed.request.id);
    expect(renewedResult.request.status).toBe("fulfilled");
    expect(renewedResult.grant?.grantId).not.toBe(grant.grantId);
    const foreignOwner = await store.createUser("Other profile owner");
    const foreign = await store.createBrowserProfile({
      idempotencyKey: "store.integration.test-browser-profile-3",
      ownerId: foreignOwner,
      name: "Private",
    });
    const forbidden = await open("foreign-profile");
    await expect(resolve(forbidden.request.id, foreign.id)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect((await store.requests.get(forbidden.request.id))?.status).toBe("pending");
  });

  it("avoids a deadlock between browser closure and profile-save resolution", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, stagedRequestRace } = storeFixture;
    const fixture = await startRunFixture("request-browser-save");
    const sessionId = createBrowserSessionId();
    await store.createBrowserSession({
      id: sessionId,
      leaseGeneration: 1,
      leaseTokenHash: null,
      origin: "agent",
      placementKey: `runner:${fixture.runnerId}:request-browser-save`,
      profileId: null,
      runnerId: fixture.runnerId,
      runtimeId: "request-browser-save",
      workspaceId: fixture.workspace.id,
    });
    await store.transitionBrowserSession({
      from: ["starting"],
      sessionId,
      state: "ready",
    });
    const requestInput = {
      callId: "browser-save-call-1",
      kind: "browser.profile.save" as const,
      mode: "durable" as const,
      originatingRunId: fixture.run.id,
      originatingThreadId: fixture.thread.id,
      originatingWorkspaceId: fixture.workspace.id,
      payload: {
        kind: "browser.profile.save" as const,
        reason: "Keep the authenticated session",
        sessionId,
        suggestedName: "Calendar",
      },
      presentation: {
        kind: "external" as const,
        subject: { id: sessionId, kind: "browser-session" },
        title: "Save browser profile",
      },
      requestedBy: fixture.userId,
      requiredActor: "requester" as const,
      targetWorkspaceId: fixture.workspace.id,
    };
    const created = await store.requests.create(requestInput);
    const results = await stagedRequestRace(
      (transaction) =>
        transaction
          .selectFrom("browserSessions")
          .select("id")
          .where("id", "=", sessionId)
          .forUpdate()
          .execute(),
      () => store.transitionBrowserSession({ from: ["ready"], sessionId, state: "closing" }),
      () =>
        store.requests.resolveBrowserRequest({
          requestId: created.request.id,
          resolvedBy: fixture.userId,
          response: { kind: "external", value: { decision: "declined" } },
        }),
    );
    expect(results[0]!.status).toBe("fulfilled");
    expect((await store.requests.get(created.request.id))?.status).toBe("cancelled");
  });

  it.for(["closed", "failed"] as const)(
    "keeps a %s Browser Session immutable through late transitions",
    async (terminal, { storeFixture }) => {
      const { startRunFixture, store, database } = storeFixture;
      const fixture = await startRunFixture(`browser-terminal-${terminal}`);
      const sessionId = createBrowserSessionId();
      await store.createBrowserSession({
        id: sessionId,
        leaseGeneration: 1,
        leaseTokenHash: null,
        origin: "agent",
        placementKey: `runner:${fixture.runnerId}:browser-terminal-${terminal}`,
        profileId: null,
        runnerId: fixture.runnerId,
        runtimeId: `browser-terminal-${terminal}`,
        workspaceId: fixture.workspace.id,
      });
      await store.transitionBrowserSession({ sessionId, state: terminal });
      const before = await database
        .selectFrom("browserSessions")
        .selectAll()
        .where("id", "=", sessionId)
        .executeTakeFirstOrThrow();
      const writes = [];
      for (const from of [undefined, [terminal]] as const) {
        for (const state of ["starting", "ready", "closing", "closed", "failed"] as const) {
          const result = await store.transitionBrowserSession({
            ...(from ? { from } : {}),
            sessionId,
            state,
          });
          writes.push({ from, requested: state, persisted: result.session.state });
          const after = await database
            .selectFrom("browserSessions")
            .selectAll()
            .where("id", "=", sessionId)
            .executeTakeFirstOrThrow();
          await writeBrowserUsageArtifact(`browser-terminal-${terminal}.json`, {
            before,
            after,
            writes,
          });
          expect(result.session.state).toBe(terminal);
          expect(result.events).toEqual([]);
          expect(after).toEqual(before);
        }
      }
    },
  );

  it("atomically fulfills Browser Profile save Requests and rotates continuation attempts", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, database } = storeFixture;
    const fixture = await startRunFixture("request-browser-save");
    const sessionId = createBrowserSessionId();
    await store.createBrowserSession({
      id: sessionId,
      leaseGeneration: 1,
      leaseTokenHash: null,
      origin: "agent",
      placementKey: `runner:${fixture.runnerId}:request-browser-save`,
      profileId: null,
      runnerId: fixture.runnerId,
      runtimeId: "request-browser-save",
      workspaceId: fixture.workspace.id,
    });
    await store.transitionBrowserSession({
      from: ["starting"],
      sessionId,
      state: "ready",
    });
    const requestInput = {
      callId: "browser-save-call-1",
      kind: "browser.profile.save" as const,
      mode: "durable" as const,
      originatingRunId: fixture.run.id,
      originatingThreadId: fixture.thread.id,
      originatingWorkspaceId: fixture.workspace.id,
      payload: {
        kind: "browser.profile.save" as const,
        reason: "Keep the authenticated session",
        sessionId,
        suggestedName: "Calendar",
      },
      presentation: {
        kind: "external" as const,
        subject: { id: sessionId, kind: "browser-session" },
        title: "Save browser profile",
      },
      requestedBy: fixture.userId,
      requiredActor: "requester" as const,
      targetWorkspaceId: fixture.workspace.id,
    };
    const created = await store.requests.create(requestInput);
    const profileId = createId("browserProfile");
    const resolved = await store.requests.resolveBrowserRequest({
      preparedProfile: {
        ciphertext: Buffer.from("encrypted-browser-profile-revision-v1"),
        ciphertextSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        id: profileId,
        name: "Calendar",
        revision: 1,
      },
      requestId: created.request.id,
      resolvedBy: fixture.userId,
      response: {
        kind: "external",
        value: { decision: "fulfilled", name: "Calendar" },
      },
    });
    expect(resolved).toMatchObject({
      events: [expect.objectContaining({ type: "request.resolved" })],
      grant: null,
      profile: { id: profileId, revision: 1 },
      request: { status: "fulfilled" },
      saveSessionId: sessionId,
    });
    const expectedResponse = {
      kind: "external",
      value: {
        decision: "fulfilled",
        name: "Calendar",
        profile: { id: profileId, name: "Calendar" },
      },
    };
    const reread = await new OpensteerStore(database).requests.get(created.request.id);
    const raw = await database
      .selectFrom("requests")
      .select("response")
      .where("id", "=", created.request.id)
      .executeTakeFirstOrThrow();
    const sourceSession = await database
      .selectFrom("browserSessions")
      .select("profileId")
      .where("id", "=", sessionId)
      .executeTakeFirstOrThrow();
    await writeBrowserUsageArtifact("browser-request-save-outcome.json", {
      resolved,
      reread,
      raw,
      sourceSession,
    });
    expect(resolved.request.response).toEqual(expectedResponse);
    expect(reread?.response).toEqual(expectedResponse);
    expect(raw.response).toEqual(expectedResponse);
    expect(sourceSession?.profileId).toBeNull();
    const declined = await store.requests.create({
      ...requestInput,
      callId: "browser-save-declined",
    });
    await expect(
      store.requests.resolveBrowserRequest({
        requestId: declined.request.id,
        resolvedBy: fixture.userId,
        response: {
          kind: "external",
          value: {
            decision: "fulfilled",
            name: "Calendar",
            profile: { id: profileId, name: "Forged" },
          },
        },
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    const declinedResult = await store.requests.resolveBrowserRequest({
      requestId: declined.request.id,
      resolvedBy: fixture.userId,
      response: { kind: "external", value: { decision: "declined" } },
    });
    expect(declinedResult.profile).toBeNull();
    expect(
      (await new OpensteerStore(database).requests.get(declined.request.id))?.response,
    ).toEqual({
      kind: "external",
      value: { decision: "declined" },
    });
    await expect(
      store.requests.recordContinuationAttempt({
        reason: null,
        requestId: declined.request.id,
        status: "queued",
      }),
    ).resolves.toBe(true);
    await expect(store.readBrowserProfileRevision(profileId)).resolves.toMatchObject({
      ciphertextSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      revision: 1,
    });

    const cancelled = await store.requests.create({
      ...requestInput,
      callId: "browser-save-call-2",
    });
    const closed = await store.transitionBrowserSession({
      from: ["ready"],
      sessionId,
      state: "closing",
    });
    expect(closed.events).toEqual([
      expect.objectContaining({
        data: { reason: "resource-deleted", requestId: cancelled.request.id },
        type: "request.cancelled",
      }),
    ]);
    await expect(store.requests.get(cancelled.request.id)).resolves.toMatchObject({
      cancellationReason: "resource-deleted",
      status: "cancelled",
    });
    await expect(
      store.requests.create({ ...requestInput, callId: "browser-save-call-2" }),
    ).resolves.toMatchObject({
      replayed: true,
      request: { id: cancelled.request.id, status: "cancelled" },
    });
    await expect(
      store.requests.create({ ...requestInput, callId: "browser-save-call-after-close" }),
    ).rejects.toMatchObject({ code: "conflict" });

    const [continuation] = await store.requests.listPendingContinuations();
    expect(continuation).toMatchObject({
      attemptedAt: null,
      request: { id: created.request.id },
      status: "waiting",
    });
    await expect(
      store.requests.recordContinuationAttempt({
        reason: null,
        requestId: created.request.id,
        status: "waiting",
      }),
    ).resolves.toBe(true);
    await expect(store.requests.listPendingContinuations()).resolves.toEqual([
      expect.objectContaining({
        attemptedAt: expect.any(String),
        request: expect.objectContaining({ id: created.request.id }),
        status: "waiting",
      }),
    ]);
    await expect(
      store.requests.recordContinuationAttempt({
        reason: null,
        requestId: created.request.id,
        status: "queued",
      }),
    ).resolves.toBe(true);
    await expect(store.requests.listPendingContinuations()).resolves.toEqual([]);
  });

  it("binds prepared integration material to the exact approved manifest", async ({
    storeFixture,
  }) => {
    const { startRunFixture, database } = storeFixture;
    const fixture = await startRunFixture("request-integration-install");
    await database
      .updateTable("users")
      .set({ instanceRole: "administrator", updatedAt: new Date() })
      .where("id", "=", fixture.userId)
      .executeTakeFirstOrThrow();
    const platform = new IntegrationPlatformStore(database);
    const contract = testOpenApiAdapterContract({
      definitionId: "request-installed-calendar",
      provider: "calendar",
    });
    const approvalManifest = {
      definition: integrationDefinitionSummary(contract.definition),
      digest: integrationDefinitionDigest(contract.definition),
      kind: "catalog" as const,
    };
    const opened = await platform.requests.createIntegrationInstallRequest({
      callId: "request-integration-install-call",
      manifest: approvalManifest,
      originatingRunId: fixture.run.id,
      originatingThreadId: fixture.thread.id,
      originatingWorkspaceId: fixture.workspace.id,
      reason: "Install the approved calendar integration",
      requestedBy: fixture.userId,
      targetWorkspaceId: fixture.workspace.id,
    });
    expect(opened.request.presentation.title).toBe(`Install ${contract.definition.name}?`);
    const installationId = createIntegrationId("installation");
    const material = {
      adapterSnapshot: contract.adapterSnapshot,
      installation: {
        description: contract.definition.description,
        id: installationId,
        manifest: contract.manifest,
        name: contract.definition.id,
        provenance: {
          definitionDigest: approvalManifest.digest,
          definitionId: contract.definition.id,
          maintainedBy: "opensteer",
        },
        sourceKind: "built-in" as const,
        status: "active" as const,
        title: contract.definition.name,
        trust: "built-in" as const,
        version: approvalManifest.digest,
      },
      servers: [
        {
          connectionRequirement: {
            definitionId: contract.definition.id,
            kind: "provider" as const,
            provider: contract.definition.provider,
            providerApplicationRequired: false,
          },
          id: createIntegrationId("server"),
          name: "default",
          status: "active" as const,
          statusDetail: null,
          catalog: { definitions: {}, tools: [] },
          transport: {
            adapter: "openapi" as const,
            definitionId: contract.definition.id,
            type: "adapter" as const,
          },
        },
      ],
    };
    const differentDefinition = IntegrationDefinitionSchema.parse({
      ...contract.definition,
      name: "Different approved integration",
    });
    const differentApprovalManifest = {
      definition: integrationDefinitionSummary(differentDefinition),
      digest: integrationDefinitionDigest(differentDefinition),
      kind: "catalog" as const,
    };

    await expect(
      platform.requests.resolveIntegrationInstallRequest({
        preparedFulfillment: {
          approvalManifest: differentApprovalManifest,
          material,
        },
        requestId: opened.request.id,
        resolvedBy: fixture.userId,
        response: { kind: "choice", optionId: "installed" },
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "Prepared installation does not match the approved manifest",
    });
    await expect(platform.requests.get(opened.request.id)).resolves.toMatchObject({
      status: "pending",
    });
    await expect(platform.listInstallations()).resolves.toEqual([]);

    const resolved = await platform.requests.resolveIntegrationInstallRequest({
      preparedFulfillment: { approvalManifest, material },
      requestId: opened.request.id,
      resolvedBy: fixture.userId,
      response: { kind: "choice", optionId: "installed" },
    });

    expect(resolved).toMatchObject({
      events: [expect.objectContaining({ type: "request.resolved" })],
      installation: {
        id: installationId,
        manifest: contract.manifest,
        sourceKind: "built-in",
      },
      request: { id: opened.request.id, status: "fulfilled" },
    });
    await expect(platform.listInstallations()).resolves.toEqual([
      expect.objectContaining({
        id: installationId,
        manifest: contract.manifest,
      }),
    ]);
    await expect(platform.requests.listPendingContinuations()).resolves.toEqual([
      expect.objectContaining({
        request: expect.objectContaining({ id: opened.request.id }),
        status: "waiting",
      }),
    ]);
  });

  it("enriches valid integration access, rejects mismatched accounts, and preserves specialized grants", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, database } = storeFixture;
    const fixture = await startRunFixture("integration-access-target-authority");
    const specialized = await store.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: "wsp_integration-access-target-authority-specialized",
      },
      capacityPolicy: {
        blockHardLimitBytes: 10_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota",
      },
      createdBy: fixture.userId,
      idempotencyKey: "workspace-integration-access-target-authority-specialized",
      kind: "specialized",
      name: "Integration access specialist",
      status: "ready",
    });
    const platform = new IntegrationPlatformStore(database);
    const installationId = createIntegrationId("installation");
    const serverId = createIntegrationId("server");
    const mcpServerId = createIntegrationId("server");
    const toolId = createIntegrationId("tool");
    const inputSchema = { properties: {}, type: "object" };
    const installed = await platform.install({
      actorUserId: fixture.userId,
      adapterSnapshot: null,
      installation: {
        description: "Connectionless tools",
        id: installationId,
        manifest: {},
        name: "request-target-authority",
        provenance: {},
        sourceKind: "remote-mcp",
        status: "active",
        title: "Request target authority",
        trust: "administrator-approved",
        version: "1",
      },
      requestId: "install-integration-access-target-authority",
      servers: [
        {
          connectionRequirement: {
            definitionId: "request-target-authority",
            kind: "provider",
            provider: "records",
            providerApplicationRequired: false,
          },
          id: serverId,
          name: "default",
          status: "active",
          statusDetail: null,
          catalog: {
            definitions: {},
            tools: [
              {
                annotations: {},
                connectionId: null,
                description: "Read records",
                id: toolId,
                inputSchema,
                name: "records.read",
                outputSchema: null,

                status: "active",
                title: "Read records",
              },
            ],
          },
          transport: {
            headers: {},
            type: "streamable-http",
            url: "https://request-target-authority.example.test/mcp",
          },
        },
        {
          connectionRequirement: { kind: "mcp-oauth" },
          id: mcpServerId,
          name: "oauth",
          status: "active",
          statusDetail: null,
          catalog: { definitions: {}, tools: [] },
          transport: {
            headers: {},
            type: "streamable-http",
            url: "https://request-target-authority.example.test/oauth-mcp",
          },
        },
      ],
    });
    const [server] = await platform.listServers(installationId);
    if (!server) throw new Error("Installed integration server is missing");
    const connectionId = createIntegrationId("connection");
    await database
      .insertInto("integrationConnections")
      .values({
        accountIdentifier: "alex@example.com",
        applicationSource: sql`'{"kind":"api-key"}'::jsonb`,
        authMethodId: "api-key",
        authorizationDigest: "a".repeat(43),
        capabilities: sql`'[]'::jsonb`,
        runnerId: null,
        connectionKind: "provider-account",
        connectionMethod: "api-key",
        credentialId: null,
        displayName: "Alex",
        externalIdentityId: "alex-authoritative",
        externalTenantId: null,
        grantedScopes: sql`'[]'::jsonb`,
        id: connectionId,
        integrationDefinitionId: "request-target-authority",
        integrationServerId: null,
        ownerUserId: fixture.userId,
        provider: "records",
        providerApplicationId: null,
        status: "connected",
        statusDetail: null,
        transportKind: null,
        updatedAt: new Date(),
      })
      .executeTakeFirstOrThrow();
    const mcpConnectionId = createIntegrationId("connection");
    await database
      .insertInto("integrationConnections")
      .values({
        accountIdentifier: null,
        applicationSource: null,
        authMethodId: null,
        authorizationDigest: null,
        capabilities: sql`'[]'::jsonb`,
        runnerId: null,
        connectionKind: "mcp-oauth",
        connectionMethod: "managed-oauth",
        credentialId: null,
        displayName: "Team MCP",
        externalIdentityId: null,
        externalTenantId: null,
        grantedScopes: sql`'[]'::jsonb`,
        id: mcpConnectionId,
        integrationDefinitionId: null,
        integrationServerId: mcpServerId,
        ownerUserId: fixture.userId,
        provider: `mcp:${mcpServerId}`,
        providerApplicationId: null,
        status: "connected",
        statusDetail: null,
        transportKind: null,
        updatedAt: new Date(),
      })
      .executeTakeFirstOrThrow();
    await expect(
      Promise.all([
        platform.getConnectionKind({ connectionId, ownerUserId: fixture.userId }),
        platform.getConnectionKind({
          connectionId: mcpConnectionId,
          ownerUserId: fixture.userId,
        }),
        platform.getConnectionKind({ connectionId, ownerUserId: createId("user") }),
      ]),
    ).resolves.toEqual(["provider-account", "mcp-oauth", null]);
    const requestInput = {
      access: "read" as const,
      installationId,
      originatingRunId: fixture.run.id,
      originatingThreadId: fixture.thread.id,
      originatingWorkspaceId: fixture.workspace.id,
      reason: "Read records",
      requestedBy: fixture.userId,
      requestedServerId: serverId,
    };
    const mainRequest = await platform.requests.createIntegrationAccessRequest({
      ...requestInput,
      callId: "integration-access-main-target",
      targetWorkspaceId: fixture.workspace.id,
    });
    expect(mainRequest.request.presentation.title).toBe(`${installed.installation.title} access`);
    const mainResolution = await platform.requests.resolveIntegrationAccessRequest({
      providerAuthorizations: {},
      requestId: mainRequest.request.id,
      resolvedBy: fixture.userId,
      response: {
        kind: "external",
        value: {
          account: { accountIdentifier: "forged@example.com", displayName: "Forged Alias" },
          connectionId,
          decision: "fulfilled",
        },
      },
    });

    expect(mainResolution).toMatchObject({
      events: [expect.objectContaining({ type: "request.resolved" })],
      grant: null,
      request: {
        response: {
          kind: "external",
          value: {
            account: { accountIdentifier: "alex@example.com", displayName: "Alex" },
            connectionId,
            decision: "fulfilled",
          },
        },
        status: "fulfilled",
      },
    });
    await expect(platform.requests.get(mainRequest.request.id)).resolves.toMatchObject({
      response: {
        kind: "external",
        value: {
          account: { accountIdentifier: "alex@example.com", displayName: "Alex" },
          connectionId,
          decision: "fulfilled",
        },
      },
    });
    await expect(
      platform.listGrants({
        ownerUserId: fixture.userId,
        workspaceId: fixture.workspace.id,
      }),
    ).resolves.toEqual([]);

    const specializedRequest = await platform.requests.createIntegrationAccessRequest({
      ...requestInput,
      callId: "integration-access-specialized-target",
      requestedServerId: null,
      targetWorkspaceId: specialized.id,
    });
    await platform.requests.selectIntegrationAccessServer({
      requestId: specializedRequest.request.id,
      requestedServerId: serverId,
      resolvedBy: fixture.userId,
    });
    const specializedResolution = await platform.requests.resolveIntegrationAccessRequest({
      providerAuthorizations: {},
      requestId: specializedRequest.request.id,
      resolvedBy: fixture.userId,
      response: {
        kind: "external",
        value: {
          account: { accountIdentifier: "forged@example.com", displayName: "Forged Alias" },
          access: "read",
          alias: "Records",
          connectionId,
          decision: "fulfilled",
          isDefault: false,
        },
      },
    });

    expect(specializedResolution).toMatchObject({
      events: [expect.objectContaining({ type: "request.resolved" })],
      grant: { workspaceId: specialized.id },
      request: { status: "fulfilled" },
    });
    expect(specializedResolution.request.response).toEqual({
      kind: "external",
      value: {
        access: "read",
        alias: "Records",
        account: { accountIdentifier: "alex@example.com", displayName: "Alex" },
        connectionId,
        decision: "fulfilled",
        isDefault: false,
      },
    });
    const requiredWrite = await platform.requests.createIntegrationAccessRequest({
      ...requestInput,
      access: "read-write",
      callId: "integration-access-required-write",
      targetWorkspaceId: specialized.id,
    });
    await expect(
      platform.requests.resolveIntegrationAccessRequest({
        providerAuthorizations: {},
        requestId: requiredWrite.request.id,
        resolvedBy: fixture.userId,
        response: {
          kind: "external",
          value: {
            access: "read",
            alias: "Records",
            connectionId,
            decision: "fulfilled",
            isDefault: false,
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "Integration access does not cover the requested write operations",
    });
    await expect(platform.requests.get(requiredWrite.request.id)).resolves.toMatchObject({
      status: "pending",
    });
    const missingConnectionId = createIntegrationId("connection");
    const missingConnectionRequest = await platform.requests.createIntegrationAccessRequest({
      ...requestInput,
      callId: "integration-access-missing-account-row",
      targetWorkspaceId: fixture.workspace.id,
    });
    await expect(
      platform.requests.resolveIntegrationAccessRequest({
        providerAuthorizations: {},
        requestId: missingConnectionRequest.request.id,
        resolvedBy: fixture.userId,
        response: {
          kind: "external",
          value: {
            account: { accountIdentifier: "forged@example.com", displayName: "Forged Alias" },
            connectionId: missingConnectionId,
            decision: "fulfilled",
          },
        },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(platform.requests.get(missingConnectionRequest.request.id)).resolves.toMatchObject(
      {
        response: null,
        status: "pending",
      },
    );
    await expect(
      platform.requests.resolveIntegrationAccessRequest({
        providerAuthorizations: {},
        requestId: missingConnectionRequest.request.id,
        resolvedBy: fixture.userId,
        response: {
          kind: "external",
          value: { connectionId: mcpConnectionId, decision: "fulfilled" },
        },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const declinedRequest = await platform.requests.createIntegrationAccessRequest({
      ...requestInput,
      callId: "integration-access-declined",
      targetWorkspaceId: fixture.workspace.id,
    });
    const declinedResolution = await platform.requests.resolveIntegrationAccessRequest({
      providerAuthorizations: {},
      requestId: declinedRequest.request.id,
      resolvedBy: fixture.userId,
      response: {
        kind: "external",
        value: {
          account: { accountIdentifier: "forged@example.com", displayName: "Forged Alias" },
          decision: "declined",
        },
      },
    });
    expect(declinedResolution.request).toMatchObject({
      id: declinedRequest.request.id,
      status: "declined",
    });
    expect(declinedResolution.request.response).toEqual({
      kind: "external",
      value: { decision: "declined" },
    });
    const persistedDecline = await platform.requests.get(declinedRequest.request.id);
    expect(persistedDecline?.response).toEqual({
      kind: "external",
      value: { decision: "declined" },
    });
    const mcpRequest = await platform.requests.createIntegrationAccessRequest({
      ...requestInput,
      callId: "integration-access-mcp-account",
      requestedServerId: mcpServerId,
      targetWorkspaceId: fixture.workspace.id,
    });
    await expect(
      platform.requests.resolveIntegrationAccessRequest({
        providerAuthorizations: {},
        requestId: mcpRequest.request.id,
        resolvedBy: fixture.userId,
        response: {
          kind: "external",
          value: { connectionId: mcpConnectionId, decision: "fulfilled" },
        },
      }),
    ).resolves.toMatchObject({ request: { status: "fulfilled" } });
    await expect(
      platform.listGrants({ ownerUserId: fixture.userId, workspaceId: specialized.id }),
    ).resolves.toEqual([
      expect.objectContaining({
        access: "read",
        workspaceId: specialized.id,
      }),
    ]);
    await expect(platform.requests.listPendingContinuations()).resolves.toEqual([
      expect.objectContaining({
        request: expect.objectContaining({ id: mainRequest.request.id }),
      }),
      expect.objectContaining({
        request: expect.objectContaining({ id: specializedRequest.request.id }),
      }),
      expect.objectContaining({
        request: expect.objectContaining({ id: declinedRequest.request.id, status: "declined" }),
        status: "waiting",
      }),
      expect.objectContaining({
        request: expect.objectContaining({ id: mcpRequest.request.id }),
      }),
    ]);
  });

  it("serializes catalog Request currentness by exact definition identity and preserves replay", async ({
    storeFixture,
  }) => {
    const { startRunFixture, database } = storeFixture;
    const fixture = await startRunFixture("catalog-request-currentness");
    const platform = new IntegrationPlatformStore(database);
    const contract = testOpenApiAdapterContract({
      definitionId: "catalog-request-currentness",
      provider: "calendar",
    });
    const manifest = {
      definition: integrationDefinitionSummary(contract.definition),
      digest: integrationDefinitionDigest(contract.definition),
      kind: "catalog" as const,
    };
    const requestInput = {
      manifest,
      originatingRunId: fixture.run.id,
      originatingThreadId: fixture.thread.id,
      originatingWorkspaceId: fixture.workspace.id,
      reason: "Install the current catalog definition",
      requestedBy: fixture.userId,
      targetWorkspaceId: fixture.workspace.id,
    };

    // Neither a matching installation name nor public manifest is catalog
    // identity. Only exact built-in provenance.definitionId closes selection.
    await platform.install({
      actorUserId: fixture.userId,
      adapterSnapshot: null,
      installation: {
        description: "Legacy built-in without catalog provenance",
        id: createIntegrationId("installation"),
        manifest: contract.manifest,
        name: contract.definition.id,
        provenance: { maintainedBy: "test" },
        sourceKind: "built-in",
        status: "active",
        title: "Legacy built-in",
        trust: "built-in",
        version: "legacy",
      },
      requestId: "install-catalog-currentness-decoy",
      servers: [],
    });
    const original = await platform.requests.createIntegrationInstallRequest({
      ...requestInput,
      callId: "catalog-currentness-original",
    });
    expect(original).toMatchObject({ replayed: false, request: { status: "pending" } });

    const material = {
      adapterSnapshot: contract.adapterSnapshot,
      installation: {
        description: contract.definition.description,
        id: createIntegrationId("installation"),
        manifest: contract.manifest,
        name: contract.definition.id,
        provenance: {
          definitionDigest: manifest.digest,
          definitionId: contract.definition.id,
          maintainedBy: "opensteer",
        },
        sourceKind: "built-in" as const,
        status: "active" as const,
        title: contract.definition.name,
        trust: "built-in" as const,
        version: manifest.digest,
      },
      servers: [
        {
          connectionRequirement: {
            definitionId: contract.definition.id,
            kind: "provider" as const,
            provider: contract.definition.provider,
            providerApplicationRequired: false,
          },
          id: createIntegrationId("server"),
          name: "default",
          status: "active" as const,
          statusDetail: null,
          catalog: { definitions: {}, tools: [] },
          transport: {
            adapter: "openapi" as const,
            definitionId: contract.definition.id,
            type: "adapter" as const,
          },
        },
      ],
    };
    let releaseInstallation: () => void = () => {};
    const releaseSignal = new Promise<void>((resolve) => {
      releaseInstallation = resolve;
    });
    let announceInstallation: () => void = () => {};
    const installationWritten = new Promise<void>((resolve) => {
      announceInstallation = resolve;
    });
    const installing = database.transaction().execute(async (transaction) => {
      const mutation = await installIntegrationInTransaction(transaction, {
        ...material,
        actorUserId: fixture.userId,
        requestId: "install-exact-catalog-currentness",
      });
      announceInstallation();
      await releaseSignal;
      return mutation;
    });
    await installationWritten;

    const raced = platform.requests.createIntegrationInstallRequest({
      ...requestInput,
      callId: "catalog-currentness-raced",
    });
    void raced.catch(() => undefined);
    try {
      let waiting = 0;
      for (let attempt = 0; attempt < 200 && waiting === 0; attempt += 1) {
        const result = await sql<{ readonly waiting: number }>`
          select count(*)::integer as waiting
          from pg_locks locks
          join pg_stat_activity activity on activity.pid = locks.pid
          where locks.granted = false
            and locks.locktype = 'advisory'
            and activity.datname = current_database()
            and activity.application_name = 'opensteer-integration-test'
        `.execute(database);
        waiting = Number(result.rows[0]?.waiting ?? 0);
        if (waiting === 0) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(waiting).toBeGreaterThan(0);
    } finally {
      releaseInstallation();
    }
    await installing;

    await expect(raced).rejects.toMatchObject({
      code: "conflict",
      message:
        "Catalog integration is already installed; search current integration inventory before requesting setup",
    });
    await expect(
      platform.requests.createIntegrationInstallRequest({
        ...requestInput,
        callId: "catalog-currentness-original",
      }),
    ).resolves.toMatchObject({
      replayed: true,
      request: { id: original.request.id, status: "pending" },
    });
  });

  /**
   * A built-in that materialized badly used to be unreachable: the catalog gate
   * treated any installation row as "already installed", so the one action that
   * could repair it — reinstalling from the current definition — was refused.
   */
  it("keeps a needs-attention built-in requestable and refuses only an active one", async ({
    storeFixture,
  }) => {
    const { startRunFixture, database } = storeFixture;
    const fixture = await startRunFixture("catalog-needs-attention-reinstall");
    const platform = new IntegrationPlatformStore(database);
    const contract = testOpenApiAdapterContract({
      definitionId: "catalog-needs-attention-reinstall",
      provider: "calendar",
    });
    const manifest = {
      definition: integrationDefinitionSummary(contract.definition),
      digest: integrationDefinitionDigest(contract.definition),
      kind: "catalog" as const,
    };
    const requestInput = {
      manifest,
      originatingRunId: fixture.run.id,
      originatingThreadId: fixture.thread.id,
      originatingWorkspaceId: fixture.workspace.id,
      reason: "Reinstall the integration that failed discovery",
      requestedBy: fixture.userId,
      targetWorkspaceId: fixture.workspace.id,
    };
    const installationId = createIntegrationId("installation");
    const installedMaterial = (status: "active" | "needs-attention") => ({
      actorUserId: fixture.userId,
      adapterSnapshot: contract.adapterSnapshot,
      installation: {
        description: contract.definition.description,
        id: installationId,
        manifest: contract.manifest,
        name: contract.definition.id,
        provenance: {
          definitionDigest: manifest.digest,
          definitionId: contract.definition.id,
          maintainedBy: "opensteer",
        },
        sourceKind: "built-in" as const,
        status,
        title: contract.definition.name,
        trust: "built-in" as const,
        version: manifest.digest,
      },
      servers: [
        {
          connectionRequirement: { kind: "none" as const },
          id: createIntegrationId("server"),
          name: "default",
          status,
          statusDetail: status === "active" ? null : "Discovery fetch failed: HTTP 502",
          catalog: { definitions: {}, tools: [] },
          transport: {
            adapter: "openapi" as const,
            definitionId: contract.definition.id,
            type: "adapter" as const,
          },
        },
      ],
    });

    await platform.install({
      ...installedMaterial("needs-attention"),
      requestId: "install-needs-attention-builtin",
    });
    const reinstall = await platform.requests.createIntegrationInstallRequest({
      ...requestInput,
      callId: "catalog-needs-attention-reinstall-call",
    });
    expect(reinstall).toMatchObject({ replayed: false, request: { status: "pending" } });
    expect(reinstall.request.presentation.title).toBe(`Install ${contract.definition.name}?`);

    await platform.install({
      ...installedMaterial("active"),
      requestId: "install-active-builtin",
    });
    await expect(
      platform.requests.createIntegrationInstallRequest({
        ...requestInput,
        callId: "catalog-active-reinstall-call",
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message:
        "Catalog integration is already installed; search current integration inventory before requesting setup",
    });
  });

  /**
   * A Trigger fires again on its own schedule and each Occurrence carries a
   * fresh call identity, so an unanswered ask would otherwise leave one approval
   * card per tick. A Run keeps its own Request: its continuation is delivered to
   * the Run that opened it.
   */
  it("folds a Trigger Occurrence's repeated installation ask into the pending Request", async ({
    storeFixture,
  }) => {
    const { startRunFixture, startTriggerOccurrence, database } = storeFixture;
    const fixture = await startRunFixture("trigger-install-dedup");
    const occurrence = await startTriggerOccurrence(fixture, "trigger-install-dedup");
    const platform = new IntegrationPlatformStore(database);
    const contract = testOpenApiAdapterContract({
      definitionId: "trigger-install-dedup",
      provider: "calendar",
    });
    const base = {
      manifest: {
        definition: integrationDefinitionSummary(contract.definition),
        digest: integrationDefinitionDigest(contract.definition),
        kind: "catalog" as const,
      },
      originatingThreadId: fixture.thread.id,
      originatingWorkspaceId: fixture.workspace.id,
      reason: "The schedule needs the calendar",
      requestedBy: fixture.userId,
      targetWorkspaceId: fixture.workspace.id,
    };
    const proposal = {
      kind: "proposal" as const,
      proposal: {
        authMethods: ["api-key" as const],
        digest: "p".repeat(43),
        kind: "openapi" as const,
        preview: { operationCount: 3, title: "Researched API" },
        source: { content: '{"openapi":"3.1.0"}', type: "inline" as const },
      },
    };

    const first = await platform.requests.createIntegrationInstallRequest({
      ...base,
      callId: "occurrence-install-call-1",
      originatingOccurrenceId: occurrence.id,
    });
    const repeated = await platform.requests.createIntegrationInstallRequest({
      ...base,
      callId: "occurrence-install-call-2",
      originatingOccurrenceId: occurrence.id,
    });

    expect(first).toMatchObject({ replayed: false, request: { status: "pending" } });
    expect(repeated).toMatchObject({
      events: [],
      replayed: true,
      request: { id: first.request.id },
    });

    const proposed = await platform.requests.createIntegrationInstallRequest({
      ...base,
      callId: "occurrence-install-call-3",
      manifest: proposal,
      originatingOccurrenceId: occurrence.id,
    });
    const proposedAgain = await platform.requests.createIntegrationInstallRequest({
      ...base,
      callId: "occurrence-install-call-4",
      manifest: proposal,
      originatingOccurrenceId: occurrence.id,
    });

    // A different artifact is a different ask, and an agent-supplied title is
    // marked as proposed by an agent so it cannot read as Opensteer's own prose.
    expect(proposed.replayed).toBe(false);
    expect(proposed.request.presentation).toMatchObject({
      agentProposed: true,
      title: "Install Researched API?",
    });
    expect(proposedAgain).toMatchObject({ replayed: true, request: { id: proposed.request.id } });

    const runOriginated = await platform.requests.createIntegrationInstallRequest({
      ...base,
      callId: "run-install-call-1",
      originatingRunId: fixture.run.id,
    });

    expect(runOriginated.replayed).toBe(false);
    expect(runOriginated.request.id).not.toBe(first.request.id);
  });

  it("deduplicates integration access only for the same installation, class, and server", async ({
    storeFixture,
  }) => {
    const { startRunFixture, startTriggerOccurrence, database } = storeFixture;
    const fixture = await startRunFixture("trigger-access-dedup");
    const occurrence = await startTriggerOccurrence(fixture, "trigger-access-dedup");
    const platform = new IntegrationPlatformStore(database);
    const installationId = createIntegrationId("installation");
    const inputSchema = { properties: {}, type: "object" };
    const serverMaterial = (name: string) => {
      const serverId = createIntegrationId("server");
      const toolId = createIntegrationId("tool");
      return {
        connectionRequirement: { kind: "none" as const },
        id: serverId,
        name,
        status: "active" as const,
        statusDetail: null,
        catalog: {
          definitions: {},
          tools: [
            {
              annotations: {},
              connectionId: null,
              description: "Read records",
              id: toolId,
              inputSchema,
              name: `${name}.read`,
              outputSchema: null,

              status: "active" as const,
              title: "Read records",
            },
          ],
        },
        transport: {
          headers: {},
          type: "streamable-http" as const,
          url: `https://trigger-access-dedup.example.test/${name}`,
        },
      };
    };
    const primary = serverMaterial("primary");
    const secondary = serverMaterial("secondary");
    await platform.install({
      actorUserId: fixture.userId,
      adapterSnapshot: null,
      installation: {
        description: "Researched by an agent",
        id: installationId,
        manifest: {},
        name: "trigger-access-dedup",
        provenance: { artifactDigest: "q".repeat(43), proposalKind: "openapi" },
        sourceKind: "proposed",
        status: "active",
        title: "Records — approved by your administrator",
        trust: "administrator-approved",
        version: "1",
      },
      requestId: "install-trigger-access-dedup",
      servers: [primary, secondary],
    });
    const servers = await platform.listServers(installationId);
    const primaryServer = servers.find(({ name }) => name === "primary");
    const secondaryServer = servers.find(({ name }) => name === "secondary");
    if (!primaryServer || !secondaryServer) throw new Error("Both servers must be installed");
    const base = {
      access: "read" as const,
      installationId,
      originatingOccurrenceId: occurrence.id,
      originatingThreadId: fixture.thread.id,
      originatingWorkspaceId: fixture.workspace.id,
      reason: "The schedule needs the records",
      requestedBy: fixture.userId,
      targetWorkspaceId: fixture.workspace.id,
    };

    const first = await platform.requests.createIntegrationAccessRequest({
      ...base,
      callId: "occurrence-access-call-1",
      requestedServerId: primaryServer.id,
    });
    const repeated = await platform.requests.createIntegrationAccessRequest({
      ...base,
      callId: "occurrence-access-call-2",
      requestedServerId: primaryServer.id,
    });
    const other = await platform.requests.createIntegrationAccessRequest({
      ...base,
      callId: "occurrence-access-call-3",
      requestedServerId: secondaryServer.id,
    });

    // A proposed installation's title is text an agent supplied, so every
    // surface marks it rather than letting it read as the platform's own words.
    expect(first.request.presentation).toMatchObject({
      agentProposed: true,
      title: "Records — approved by your administrator access",
    });
    expect(repeated).toMatchObject({
      events: [],
      replayed: true,
      request: { id: first.request.id },
    });
    expect(other).toMatchObject({
      events: [expect.objectContaining({ type: "request.opened" })],
      replayed: false,
      request: { payload: { requestedServerId: secondaryServer.id } },
    });
  });

  it("refuses an unclaimed Command with no work location", async ({ storeFixture }) => {
    const { createRunFixture, database } = storeFixture;
    const fixture = await createRunFixture("unbound-command");
    const principalId = await sql<{
      readonly id: string;
    }>`select id from principals where user_id = ${fixture.userId}`
      .execute(database)
      .then((result) => result.rows[0]?.id);
    expect(principalId).toBeDefined();

    await expect(
      sql`
        insert into commands (
          id, environment_id, thread_id, requested_by, actor_principal_id,
          authority_source, idempotency_key, type, payload, status
        ) values (
          ${createId("command")}, null, ${fixture.thread.id}, ${fixture.userId}, ${principalId},
          ${JSON.stringify({ kind: "user-session", userId: fixture.userId })}::jsonb,
          ${createId("command")}, 'run.interrupt',
          ${JSON.stringify({ runId: createId("run"), threadId: fixture.thread.id, type: "run.interrupt" })}::jsonb,
          'pending'
        )
      `.execute(database),
    ).rejects.toThrow("command requester cannot execute the thread environment");
  });

  it("keeps a bound managed Runner private to the person it was attached for", async ({
    storeFixture,
  }) => {
    const { createCloudBindingFixture, store, sqlCanExecute, database, principalIdFor, triggers } =
      storeFixture;
    const fixture = await createCloudBindingFixture("cloud-binding");

    // The TypeScript predicate, the SQL mirror the triggers call, and the
    // listing all have to agree; a gap in any one of them is the whole bug.
    await expect(
      store.environmentIsAvailableToUser(fixture.aliceEnvironmentId, fixture.aliceId),
    ).resolves.toBe(true);
    await expect(
      store.environmentIsAvailableToUser(fixture.aliceEnvironmentId, fixture.bobId),
    ).resolves.toBe(false);
    await expect(sqlCanExecute(fixture.aliceEnvironmentId, fixture.aliceId)).resolves.toBe(true);
    await expect(sqlCanExecute(fixture.aliceEnvironmentId, fixture.bobId)).resolves.toBe(false);
    expect((await store.listEnvironmentsForUser(fixture.aliceId)).map((item) => item.id)).toEqual(
      expect.arrayContaining([fixture.aliceEnvironmentId, fixture.mainEnvironmentId]),
    );
    expect((await store.listEnvironmentsForUser(fixture.bobId)).map((item) => item.id)).toEqual([
      fixture.mainEnvironmentId,
    ]);

    const directory = await store.listEnvironmentsForUser(fixture.aliceId, 1, {});
    expect(directory).toHaveLength(1);
    const nextDirectory = await store.listEnvironmentsForUser(fixture.aliceId, 65, {
      afterId: directory[0]!.id,
    });
    expect(nextDirectory.map(({ id }) => id)).not.toContain(directory[0]!.id);
    expect([...directory, ...nextDirectory].map(({ id }) => id).sort()).toEqual(
      (await store.listEnvironmentsForUser(fixture.aliceId)).map(({ id }) => id).sort(),
    );
    expect(
      await store.listEnvironmentsForUser(fixture.bobId, 1, { id: fixture.aliceEnvironmentId }),
    ).toEqual([]);

    await expect(
      store.createThread({
        createdBy: fixture.bobId,
        environmentId: fixture.aliceEnvironmentId,
        harnessInstanceId: fixture.harness.id,
        idempotencyKey: "cloud-binding-bob-thread",
        modelSelection: testModelSelection,
        title: "Bob's attempt",
        workspaceId: fixture.workspace.id,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const { thread } = await store.createThread({
      createdBy: fixture.aliceId,
      environmentId: fixture.aliceEnvironmentId,
      harnessInstanceId: fixture.harness.id,
      idempotencyKey: "cloud-binding-alice-thread",
      modelSelection: testModelSelection,
      title: "Alice's work",
      workspaceId: fixture.workspace.id,
    });
    await expect(admitThreadExecution(database, thread.id, fixture.aliceId)).resolves.toMatchObject(
      { environmentId: fixture.aliceEnvironmentId },
    );
    await expect(admitThreadExecution(database, thread.id, fixture.bobId)).resolves.toBeNull();

    // The store is not the only writer, so the triggers are checked directly
    // rather than through the methods that pre-check the same thing.
    const bobPrincipalId = await principalIdFor(fixture.bobId);
    await expect(
      sql`
        insert into threads (
          id, workspace_id, title, environment_id, harness_instance_id, created_by,
          created_by_principal_id, model_selection, capability_profile_id
        ) values (
          ${createId("thread")}, ${fixture.workspace.id}, 'Raw', ${fixture.aliceEnvironmentId},
          ${fixture.harness.id}, ${fixture.bobId}, ${bobPrincipalId},
          ${JSON.stringify(testModelSelection)}::jsonb, 'workspace'
        )
      `.execute(database),
    ).rejects.toThrow(/thread creator cannot execute on the selected environment/u);
    await expect(
      sql`
        insert into runs (
          id, thread_id, environment_id, harness_instance_id, requested_by, run_ordinal,
          actor_principal_id, authority_source, model_selection, membership_generation
        ) values (
          ${createId("run")}, ${thread.id}, ${fixture.aliceEnvironmentId}, ${fixture.harness.id},
          ${fixture.bobId}, 0, ${bobPrincipalId},
          ${JSON.stringify({ kind: "user-session", userId: fixture.bobId })}::jsonb,
          ${JSON.stringify(testModelSelection)}::jsonb, 1
        )
      `.execute(database),
    ).rejects.toThrow(/run requester cannot execute the thread environment/u);
    await expect(
      sql`
        insert into commands (
          id, environment_id, thread_id, requested_by, actor_principal_id, authority_source,
          idempotency_key, type, payload
        ) values (
          ${createId("command")}, ${fixture.aliceEnvironmentId}, ${thread.id}, ${fixture.bobId},
          ${bobPrincipalId},
          ${JSON.stringify({ kind: "user-session", userId: fixture.bobId })}::jsonb,
          'cloud-binding-bob-command', 'run.interrupt',
          ${JSON.stringify({ runId: createId("run"), threadId: thread.id, type: "run.interrupt" })}::jsonb
        )
      `.execute(database),
    ).rejects.toThrow(/command requester cannot execute the thread environment/u);
    await expect(
      triggers.create({
        actorThreadId: null,
        anchorThreadId: thread.id,
        createdBy: fixture.bobId,
        idempotencyKey: "cloud-binding-bob-trigger",
        name: "Bob's schedule",
        program: {
          toolContractVersion: 2,
          language: "typescript",
          source: "export default async function () { return {}; }",
        },
        source: {
          kind: "schedule",
          schedule: { at: new Date(Date.now() + 60_000).toISOString(), kind: "at", payload: {} },
        },
      }),
    ).rejects.toThrow();
  });

  it("leaves an unbound managed Runner shared, the way a self-hosted admin enrolls one", async ({
    storeFixture,
  }) => {
    const { store, sqlCanExecute } = storeFixture;
    // kind='managed' exists outside the Cloud too: an administrator enrolls one
    // by hand and no attachment ever names an owner. Enforcement is by binding,
    // not by kind, so those keep working for everybody.
    const adminId = await store.createUser("Admin");
    const memberId = await store.createUser("Member");
    const sharedEnvironmentId = createId("environment");
    await enrollTestRunner(store, {
      createdBy: adminId,
      environmentId: createId("environment"),
      name: "Main runner",
      runnerId: createId("runner"),
      tokenSuffix: "unbound-managed-main",
    });
    await enrollTestRunner(store, {
      createdBy: adminId,
      environmentId: sharedEnvironmentId,
      name: "Shared managed runner",
      runnerId: createId("runner"),
      runnerKind: "managed",
      tokenSuffix: "unbound-managed-shared",
    });

    for (const userId of [adminId, memberId]) {
      await expect(store.environmentIsAvailableToUser(sharedEnvironmentId, userId)).resolves.toBe(
        true,
      );
      await expect(sqlCanExecute(sharedEnvironmentId, userId)).resolves.toBe(true);
      expect((await store.listEnvironmentsForUser(userId)).map((item) => item.id)).toContain(
        sharedEnvironmentId,
      );
    }
  });

  it("leaves Main and local work locations untouched by the ownership binding", async ({
    storeFixture,
  }) => {
    const { store, sqlCanExecute } = storeFixture;
    const ownerId = await store.createUser("Owner");
    const otherId = await store.createUser("Other");
    const mainEnvironmentId = createId("environment");
    const laptopEnvironmentId = createId("environment");
    await enrollTestRunner(store, {
      createdBy: ownerId,
      environmentId: mainEnvironmentId,
      name: "Main runner",
      runnerId: createId("runner"),
      tokenSuffix: "binding-regression-main",
    });
    await enrollTestRunner(store, {
      createdBy: ownerId,
      environmentId: laptopEnvironmentId,
      name: "Owner's laptop",
      runnerId: createId("runner"),
      runnerKind: "local",
      tokenSuffix: "binding-regression-laptop",
    });

    for (const userId of [ownerId, otherId]) {
      await expect(store.environmentIsAvailableToUser(mainEnvironmentId, userId)).resolves.toBe(
        true,
      );
      await expect(sqlCanExecute(mainEnvironmentId, userId)).resolves.toBe(true);
    }
    await expect(store.environmentIsAvailableToUser(laptopEnvironmentId, ownerId)).resolves.toBe(
      true,
    );
    await expect(store.environmentIsAvailableToUser(laptopEnvironmentId, otherId)).resolves.toBe(
      false,
    );
    await expect(sqlCanExecute(laptopEnvironmentId, ownerId)).resolves.toBe(true);
    await expect(sqlCanExecute(laptopEnvironmentId, otherId)).resolves.toBe(false);
    expect((await store.listEnvironmentsForUser(otherId)).map((item) => item.id)).toEqual([
      mainEnvironmentId,
    ]);
  });

  it("admits a work location only when kind, binding, Deployment mode and role all allow it", async ({
    storeFixture,
  }) => {
    const { store, database, sqlCanExecute } = storeFixture;
    const adminId = await store.createUser("Administrator");
    const memberId = await store.createUser("Member");
    await sql`update users set instance_role = 'administrator' where id = ${adminId}`.execute(
      database,
    );
    await sql`update users set instance_role = 'user' where id = ${memberId}`.execute(database);
    const mainEnvironmentId = createId("environment");
    const boundEnvironmentId = createId("environment");
    const unboundEnvironmentId = createId("environment");
    await enrollTestRunner(store, {
      createdBy: adminId,
      environmentId: mainEnvironmentId,
      name: "Main runner",
      runnerId: createId("runner"),
      tokenSuffix: "truth-table-main",
    });
    await enrollTestRunner(store, {
      createdBy: adminId,
      environmentId: boundEnvironmentId,
      name: "Admin's managed Runner",
      ownerUserId: adminId,
      runnerId: createId("runner"),
      runnerKind: "managed",
      tokenSuffix: "truth-table-bound",
    });
    await enrollTestRunner(store, {
      createdBy: adminId,
      environmentId: unboundEnvironmentId,
      name: "Shared managed runner",
      runnerId: createId("runner"),
      runnerKind: "managed",
      tokenSuffix: "truth-table-unbound",
    });

    const truthTable = [
      // [environment, user, shared mode, personal mode]
      [mainEnvironmentId, adminId, true, true],
      [mainEnvironmentId, memberId, true, false],
      [boundEnvironmentId, adminId, true, true],
      [boundEnvironmentId, memberId, false, false],
      [unboundEnvironmentId, adminId, true, true],
      [unboundEnvironmentId, memberId, true, false],
    ] as const;
    for (const [environmentId, userId, shared] of truthTable) {
      await expect(store.environmentIsAvailableToUser(environmentId, userId)).resolves.toBe(shared);
      await expect(sqlCanExecute(environmentId, userId)).resolves.toBe(shared);
    }
    // Personal kind narrows deployment-administered work locations to the sole
    // administrator; the binding narrows further and never widens.
    await sql`
      update deployments
      set deployment_shape = ${JSON.stringify({
        defaultWorkspaceBacking: "local-directory",
        kind: "personal" as const,
      })}::jsonb
      where singleton_key = 'primary'
    `.execute(database);
    for (const [environmentId, userId, , personal] of truthTable) {
      await expect(store.environmentIsAvailableToUser(environmentId, userId)).resolves.toBe(
        personal,
      );
      await expect(sqlCanExecute(environmentId, userId)).resolves.toBe(personal);
    }
  });

  it("refuses an ownership binding the Runner ledger has no shape for", async ({
    storeFixture,
  }) => {
    const { store, database } = storeFixture;
    const userId = await store.createUser("Alex");
    await expect(
      store.createRunnerEnrollment({
        allowedModules: ["agents"],
        createdBy: userId,
        expiresAt: new Date(Date.now() + 60_000),
        id: `ren_${randomUUID()}`,
        idempotencyKey: "binding-shape-local",
        name: "Invalid local computer",
        ownerUserId: userId,
        requestFingerprint: "sha256:binding-shape-local",
        runnerKind: "local",
        tokenHash: "sha256:binding-shape-local-token",
      }),
    ).rejects.toMatchObject({ code: "bad_request" });

    const rawRunner = (kind: string, ownerKind: string, ownerUserId: string | null) => sql`
      insert into runners (
        id, owner_kind, owner_user_id, name, kind, public_key_pem, public_key_fingerprint,
        enrollment_token_hash, max_concurrent_runs
      ) values (
        ${createId("runner")}, ${ownerKind}, ${ownerUserId}, ${`Raw ${kind}`}, ${kind},
        'pem', ${`sha256:raw-${kind}-${ownerKind}-${ownerUserId ?? "null"}`},
        ${`sha256:raw-token-${kind}-${ownerKind}-${ownerUserId ?? "null"}`}, 1
      )
    `;
    // A Main Runner belongs to nobody, a managed one may belong to someone, and
    // administration never moves to the user in either case.
    await expect(rawRunner("main", "deployment", userId).execute(database)).rejects.toThrow(
      /runners_owner_binding_check/u,
    );
    await expect(rawRunner("managed", "user", userId).execute(database)).rejects.toThrow(
      /runners_owner_binding_check/u,
    );
    await expect(rawRunner("local", "user", null).execute(database)).rejects.toThrow(
      /runners_owner_binding_check/u,
    );
    await expect(
      rawRunner("managed", "deployment", userId).execute(database),
    ).resolves.toBeTruthy();
    await expect(rawRunner("managed", "deployment", null).execute(database)).resolves.toBeTruthy();
  });

  it("places an adopted channel message on a work location its sender may use", async ({
    storeFixture,
  }) => {
    const { enrollMessagingRunner, createCloudBindingFixture, store, database } = storeFixture;
    await enrollMessagingRunner(testMessagingRunnerId, "Test messaging service");
    // The Host cannot choose the work location: it does not know who the
    // message belongs to until the channel identity has been resolved here.
    // Offering somebody else's managed Runner first and letting the Thread
    // authority trigger reject the insert is a retry loop that never ends.
    const fixture = await createCloudBindingFixture("channel-placement");
    const bobWorkspace = await store.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: "wsp_channel_placement_bob",
      },
      capacityPolicy: {
        blockHardLimitBytes: 10_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota",
      },
      createdBy: fixture.bobId,
      idempotencyKey: "workspace-channel-placement-bob",
      name: "Bob's Workspace",
      status: "ready",
    });
    const channels = new ChannelStore(database);
    const configured = await channels.createConnection({
      accessPolicy: testChannelAccessPolicy("anyone"),
      account: {
        displayName: "Opensteer",
        externalAccountId: "T-PLACEMENT",
        handle: "@opensteer",
        routingMode: "dedicated",
      },
      connection: {
        capabilities: ["messages"],
        runnerId: testMessagingRunnerId,
        connectionMethod: "bring-your-own",
        displayName: "Bob's Slack",
        externalIdentityId: "U-BOT-PLACEMENT",
        externalTenantId: "T-PLACEMENT",
        provider: "slack",
        transportKind: "socket",
      },
      createdBy: fixture.bobId,
      credential: {
        encryptedPayload: Buffer.from("encrypted-channel-credential"),
        encryptionKeyVersion: 1,
        id: createId("credential"),
        name: "Slack bot",
        ownerId: fixture.bobId,
        provider: "channel:slack",
      },
      executionPolicy: { harness: "default", harnessInstanceId: null },
      selector: {
        conversationId: null,
        conversationType: null,
        scopeId: null,
        threadId: null,
      },
      workspaceId: bobWorkspace.id,
    });
    await channels.setRuntimeConnectionHealth({
      connectionId: configured.connection.id,
      detail: null,
      reason: null,
      runnerId: testMessagingRunnerId,
      status: "connected",
    });
    const committed = await channels.commitIngress(configured.connection.id, {
      accountExternalId: "T-PLACEMENT",
      actor: { displayName: "Bob", externalUserId: "U-BOB" },
      content: [{ text: "Take a look", type: "text" as const }],
      conversation: {
        displayName: "placement",
        externalConversationId: "C-PLACEMENT",
        externalScopeId: "T-PLACEMENT",
        externalThreadId: "1786320000.000100",
        type: "channel" as const,
      },
      eventId: "Ev-PLACEMENT-1",
      occurredAt: new Date().toISOString(),
      provider: "slack" as const,
      providerMessageId: "1786320000.000100",
      trigger: "mention" as const,
    });
    const claimed = await channels.claimIngress("placement-worker");
    expect(claimed?.id).toBe(committed.ingressId);

    // Alice's managed Runner is offered first and must be passed over.
    const adopted = await channels.adoptIngress({
      claimToken: claimed!.claimToken,
      ingressId: claimed!.id,
      notices: testChannelNotices,
      placementCandidates: [
        { environmentId: fixture.aliceEnvironmentId, harnessInstanceId: fixture.harness.id },
        { environmentId: fixture.mainEnvironmentId, harnessInstanceId: fixture.mainHarness.id },
      ],
    });
    expect(adopted).toMatchObject({
      kind: "adopted",
      run: { environmentId: fixture.mainEnvironmentId, requestedBy: fixture.bobId },
    });

    // With nothing but somebody else's managed Runner on offer the message is
    // deferred for a later pass, never placed and never silently dropped.
    const nextCommitted = await channels.commitIngress(configured.connection.id, {
      accountExternalId: "T-PLACEMENT",
      actor: { displayName: "Bob", externalUserId: "U-BOB" },
      content: [{ text: "And this one", type: "text" as const }],
      conversation: {
        displayName: "placement",
        externalConversationId: "C-PLACEMENT",
        externalScopeId: "T-PLACEMENT",
        externalThreadId: "1786320000.000100",
        type: "channel" as const,
      },
      eventId: "Ev-PLACEMENT-2",
      occurredAt: new Date().toISOString(),
      provider: "slack" as const,
      providerMessageId: "1786320002.000200",
      trigger: "conversation-followup" as const,
    });
    const nextClaim = await channels.claimIngress("placement-worker");
    expect(nextClaim?.id).toBe(nextCommitted.ingressId);
    await expect(
      channels.adoptIngress({
        claimToken: nextClaim!.claimToken,
        ingressId: nextClaim!.id,
        notices: testChannelNotices,
        placementCandidates: [
          { environmentId: fixture.aliceEnvironmentId, harnessInstanceId: fixture.harness.id },
        ],
      }),
    ).rejects.toBeInstanceOf(ChannelIngressDeferredError);
  });

  it("lets an administrator inventory and retire a bound managed Runner", async ({
    storeFixture,
  }) => {
    const { createCloudBindingFixture, store, sqlCanExecute } = storeFixture;
    const fixture = await createCloudBindingFixture("cloud-revocation");
    const inventoryFor = async (userId: ReturnType<typeof createId<"user">>) =>
      (
        await store.listRunners({ includeDeployment: true, limit: 100, ownerId: userId })
      ).runners.map((runner) => runner.id);
    expect(await inventoryFor(fixture.aliceId)).toContain(fixture.aliceRunnerId);
    expect(await inventoryFor(fixture.bobId)).toContain(fixture.aliceRunnerId);
    expect(
      (
        await store.listRunners({
          includeDeployment: false,
          limit: 100,
          ownerId: fixture.bobId,
        })
      ).runners.map((runner) => runner.id),
    ).not.toContain(fixture.aliceRunnerId);

    // Revocation is administration, not execution: the owning user cannot do
    // it, and the administrator route is not blocked by the binding.
    await expect(store.revokeRunner(fixture.aliceRunnerId, fixture.aliceId)).rejects.toMatchObject({
      code: "not_found",
    });
    await store.revokeRunner(fixture.aliceRunnerId, fixture.bobId, { allowDeployment: true });
    await expect(
      store.environmentIsAvailableToUser(fixture.aliceEnvironmentId, fixture.aliceId),
    ).resolves.toBe(false);
    await expect(sqlCanExecute(fixture.aliceEnvironmentId, fixture.aliceId)).resolves.toBe(false);
  });

  it("keeps one harness catalog per environment and AI engine, newest answer wins", async ({
    storeFixture,
  }) => {
    const { store } = storeFixture;
    const userId = await store.createUser("Alex");
    const environmentId = createId("environment");
    await enrollTestRunner(store, {
      createdBy: userId,
      environmentId,
      name: "Managed Runner",
      runnerId: createId("runner"),
      tokenSuffix: "harness-catalogs",
    });
    const laptopEnvironmentId = await store.createEnvironment({ kind: "local", name: "Laptop" });
    const native = await store.createHarnessInstance({
      config: { model: "test" },
      driverKind: HarnessIdSchema.parse("native"),
      environmentId,
      name: "Native",
      stateKind: "isolated",
    });
    const codex = await store.createHarnessInstance({
      config: { model: "test" },
      driverKind: HarnessIdSchema.parse("codex"),
      environmentId,
      name: "Codex",
      stateKind: "isolated",
    });
    const laptopNative = await store.createHarnessInstance({
      config: { model: "test" },
      driverKind: HarnessIdSchema.parse("native"),
      environmentId: laptopEnvironmentId,
      name: "Native",
      stateKind: "isolated",
    });
    const readyNative = HarnessInstanceCatalogSchema.parse({
      continuationIdentity: testContinuationIdentity,
      driverKind: "native",
      harnessInstanceId: native.id,
      models: [
        {
          displayName: "GPT-5.6 Sol",
          isDefault: true,
          modelId: "gpt-5.6-sol",
          options: [],
          providerId: "openai",
        },
      ],
      status: "ready",
    });
    const unavailableCodex = HarnessInstanceCatalogSchema.parse({
      detail: "Codex is not installed on this work location",
      driverKind: "codex",
      harnessInstanceId: codex.id,
      models: [],
      status: "unavailable",
    });

    await store.recordHarnessCatalogs({
      catalogs: [readyNative, unavailableCodex],
      environmentId,
      expectedRevisions: new Map([
        [native.id, native.runtimeRevision],
        [codex.id, codex.runtimeRevision],
      ]),
    });
    await store.recordHarnessCatalogs({
      catalogs: [{ ...readyNative, harnessInstanceId: laptopNative.id }],
      environmentId: laptopEnvironmentId,
      expectedRevisions: new Map([[laptopNative.id, laptopNative.runtimeRevision]]),
    });

    expect(await store.getHarnessCatalog(environmentId, native.id)).toMatchObject({
      models: [{ modelId: "gpt-5.6-sol" }],
      status: "ready",
    });
    expect(await store.getHarnessCatalog(laptopEnvironmentId, codex.id)).toBeNull();
    expect(await store.listHarnessCatalogs([])).toEqual([]);
    const both = await store.listHarnessCatalogs([environmentId, laptopEnvironmentId]);
    expect(both).toHaveLength(3);
    const captured = both.find(
      (record) => record.environmentId === environmentId && record.harnessInstanceId === native.id,
    );
    expect(captured?.capturedAt).toBeInstanceOf(Date);

    await store.recordHarnessCatalogs({
      catalogs: [
        HarnessInstanceCatalogSchema.parse({
          detail: "Sign in to continue",
          driverKind: "native",
          harnessInstanceId: native.id,
          models: [],
          setupMethods: [
            {
              connectionSlot: "primary",
              kind: "device-code",
              label: "Subscription",
              methodId: "subscription",
            },
          ],
          status: "authentication-required",
        }),
      ],
      environmentId,
      expectedRevisions: new Map([[native.id, native.runtimeRevision]]),
    });

    expect(await store.getHarnessCatalog(environmentId, native.id)).toMatchObject({
      setupMethods: [expect.objectContaining({ methodId: "subscription" })],
      status: "authentication-required",
    });
    expect(await store.listHarnessCatalogs([environmentId])).toHaveLength(2);
    const recaptured = (await store.listHarnessCatalogs([environmentId])).find(
      (record) => record.harnessInstanceId === native.id,
    );
    expect(recaptured?.capturedAt.getTime()).toBeGreaterThanOrEqual(
      captured?.capturedAt.getTime() ?? 0,
    );
  });

  it("keeps one execution-preference record per person, newest choice first", async ({
    storeFixture,
  }) => {
    const { store } = storeFixture;
    const userId = await store.createUser("Alex");
    const environmentId = createId("environment");
    const harnessInstanceId = createId("harnessInstance");
    const lowEffort = ModelSelectionSchema.parse({
      modelId: "gpt-5.6-sol",
      options: { effort: "low" },
      providerId: "openai",
    });
    const highEffort = ModelSelectionSchema.parse({
      modelId: "gpt-5.6-sol",
      options: { effort: "high" },
      providerId: "openai",
    });
    const otherModel = ModelSelectionSchema.parse({
      modelId: "claude-opus-5",
      options: {},
      providerId: "anthropic",
    });

    // A person who has never chosen reads the empty record, not nothing.
    await expect(store.getExecutionPreferences(userId)).resolves.toEqual(emptyExecutionPreferences);

    await store.rememberExecutionChoice(userId, {
      selection: { environmentId, harnessInstanceId, modelSelection: lowEffort },
    });
    const second = await store.rememberExecutionChoice(userId, {
      selection: { environmentId, harnessInstanceId, modelSelection: otherModel },
    });
    expect(second.history).toEqual([
      { environmentId, harnessInstanceId, modelSelection: otherModel },
      { environmentId, harnessInstanceId, modelSelection: lowEffort },
    ]);
    expect(second.accessMode).toBe(emptyExecutionPreferences.accessMode);

    // The same choice with newer options replaces its earlier entry rather
    // than accumulating a second one.
    const reopened = await store.rememberExecutionChoice(userId, {
      selection: { environmentId, harnessInstanceId, modelSelection: highEffort },
    });
    expect(reopened.history).toEqual([
      { environmentId, harnessInstanceId, modelSelection: highEffort },
      { environmentId, harnessInstanceId, modelSelection: otherModel },
    ]);

    // An access mode travels on its own and leaves the history alone.
    const supervised = await store.rememberExecutionChoice(userId, {
      accessMode: ThreadAccessModeSchema.parse("approval-required"),
    });
    expect(supervised).toEqual({
      accessMode: "approval-required",
      history: reopened.history,
    });

    // Both halves at once is one write.
    const both = await store.rememberExecutionChoice(userId, {
      accessMode: ThreadAccessModeSchema.parse("auto"),
      selection: { environmentId, harnessInstanceId, modelSelection: otherModel },
    });
    expect(both).toEqual({
      accessMode: "auto",
      history: [
        { environmentId, harnessInstanceId, modelSelection: otherModel },
        { environmentId, harnessInstanceId, modelSelection: highEffort },
      ],
    });
    await expect(store.getExecutionPreferences(userId)).resolves.toEqual(both);
  });
});
