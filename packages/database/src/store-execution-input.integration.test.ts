import type { StoreFixture } from "./store.integration.test-support.js";
import { randomUUID } from "node:crypto";
import {
  AgentEventSchema,
  HarnessIdSchema,
  MessageContentSchema,
  messageContentMaxSerializedBytes,
  ModelSelectionSchema,
  createId,
  createToolArguments,
  createToolOutput,
  toolArgumentsMaxSerializedBytes,
  type AgentEvent,
} from "@opensteer/core";
import { type PendingAgentEvent } from "@opensteer/protocol";
import { sql } from "kysely";
import { z } from "zod";
import { describe, expect } from "vitest";
import { OpensteerStore } from "./index.js";
import {
  describeStore,
  testModelSelection,
  testContinuationIdentity,
  portableFsBacking,
  enrollTestRunner,
  pendingEvent,
} from "./store.integration.test-support.js";

describeStore("PostgreSQL store", (it) => {
  it.for(["deactivated-session", "started-run", "runner-restart"])(
    "refuses a replacement conversation with %s evidence",
    async (evidence, { storeFixture }) => {
      const { createRunFixture, enqueueHumanTrigger, store, database } = storeFixture;
      const fixture = await createRunFixture("lost-continuation");
      const first = await enqueueHumanTrigger({
        content: [{ text: "Start", type: "text" }],
        idempotencyKey: "lost-first",
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      });
      const bindingInput = {
        bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
        continuationIdentity: testContinuationIdentity,
        harnessInstanceId: fixture.harnessInstance.id,
        leaseTokenHash: "lost-lease",
        membershipGeneration: 1,
        runnerBootId: "lost-boot",
        runnerId: fixture.runnerId,
        threadId: fixture.thread.id,
      };
      await store.claimCommand(first.command.id, "test");
      const binding = await store.acquireExecutionBinding({
        ...bindingInput,
        runId: first.run.id,
      });
      if (evidence !== "runner-restart")
        await store.bindProviderSession({
          bindingGeneration: binding.bindingGeneration,
          harnessInstanceId: fixture.harnessInstance.id,
          providerSessionId: binding.providerSessionId,
          providerSessionReference: "established-session",
          runId: first.run.id,
          runnerBootId: bindingInput.runnerBootId,
          runnerId: fixture.runnerId,
          threadId: fixture.thread.id,
        });
      if (evidence === "runner-restart") {
        // The Runner confirmed the Run, then came back as a new boot without it.
        await store.succeedCommand(first.command.id);
        await store.attachRunnerExecutions({
          dispatchingRunIds: [],
          executions: [],
          leaseExpiresAt: new Date(Date.now() + 60_000),
          runnerBootId: "lost-boot-restarted",
          runnerId: fixture.runnerId,
        });
      } else await store.failCommand(first.command.id, "Execution failed");
      if (evidence === "deactivated-session") {
        await database
          .updateTable("providerSessions")
          .set({ active: false, status: "stopped" })
          .where("id", "=", binding.providerSessionId)
          .execute();
      } else if (evidence === "started-run") {
        // Even a missing/corrupt reference must not erase evidence of execution.
        await database
          .updateTable("providerSessions")
          .set({ providerSessionReference: null })
          .where("id", "=", binding.providerSessionId)
          .execute();
        await database
          .updateTable("runs")
          .set({ startedAt: new Date() })
          .where("id", "=", first.run.id)
          .execute();
      }
      if (evidence === "deactivated-session") {
        await expect(
          store.enqueueThreadInput({
            content: [{ text: "Continue", type: "text" }],
            idempotencyKey: "lost-retry",
            policy: "queue",
            requestedBy: fixture.userId,
            source: { kind: "human" },
            threadId: fixture.thread.id,
          }),
        ).rejects.toThrow("no selected provider session");
        return;
      }
      const retry = await enqueueHumanTrigger({
        content: [{ text: "Continue", type: "text" }],
        idempotencyKey: "lost-retry",
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      });
      await store.claimCommand(retry.command.id, "test");
      await expect(
        store.acquireExecutionBinding({ ...bindingInput, runId: retry.run.id }),
      ).rejects.toThrow("uncertain native start");
    },
  );

  it("records, selects, reconciles, and revokes machine-scoped Workspace mounts", async ({
    storeFixture,
  }) => {
    const { createRunFixture, store, database } = storeFixture;
    const fixture = await createRunFixture("workspace-mount-lifecycle");
    const backing = portableFsBacking(fixture.workspace);
    const input = {
      authorizedBy: fixture.userId,
      enrollmentId: "11111111-1111-4111-8111-111111111111",
      environmentId: fixture.environmentId,
      membershipGeneration: 1,
      runnerId: fixture.runnerId,
      volumeId: backing.volumeId,
      workspaceBackingGeneration: backing.generation,
      workspaceId: fixture.workspace.id,
    } as const;

    const recorded = await store.recordWorkspaceMount(input);
    expect(await store.recordWorkspaceMount(input)).toEqual(recorded);
    expect(await store.listWorkspaceMounts(fixture.workspace.id)).toMatchObject([recorded]);
    expect(
      await store.listWorkspaceMountsAuthorizedBy({
        authorizedBy: fixture.userId,
        workspaceId: fixture.workspace.id,
      }),
    ).toMatchObject([recorded]);
    expect(await store.listEnvironmentWorkspaceMounts(fixture.environmentId)).toMatchObject([
      recorded,
    ]);
    expect(
      await store.listReplacedWorkspaceMounts({
        currentGeneration: backing.generation + 1,
        workspaceId: fixture.workspace.id,
      }),
    ).toMatchObject([recorded]);

    await expect(
      store.requestWorkspaceMountRevocations({
        workspaceMountIds: [recorded.id],
        reason: "membership-revoked",
      }),
    ).resolves.toBe(1);
    await expect(store.recordWorkspaceMount(input)).rejects.toMatchObject({ code: "conflict" });
    const claimed = await store.claimPendingMountEnrollmentRevocations({
      leaseUntil: new Date(Date.now() + 60_000),
      limit: 10,
      now: new Date(),
    });
    expect(claimed).toMatchObject([
      {
        enrollmentId: input.enrollmentId,
        environmentId: fixture.environmentId,
        revocationAttempt: 1,
        terminationReason: "membership-revoked",
        workspaceId: fixture.workspace.id,
      },
    ]);
    await store.failMountEnrollmentRevocation({
      enrollmentId: input.enrollmentId,
      errorCode: "manager-unavailable",
      nextAttemptAt: new Date(),
    });
    const retried = await store.claimPendingMountEnrollmentRevocations({
      leaseUntil: new Date(Date.now() + 60_000),
      limit: 10,
      now: new Date(),
    });
    expect(retried[0]).toMatchObject({ revocationAttempt: 2 });
    await store.completeMountEnrollmentRevocation(input.enrollmentId, "REVOKED");

    const lapsed = await store.recordWorkspaceMount({
      ...input,
      enrollmentId: "44444444-4444-4444-8444-444444444444",
    });
    await store.requestWorkspaceMountRevocations({
      workspaceMountIds: [lapsed.id],
      reason: "workspace-idle-archive",
    });
    await store.claimPendingMountEnrollmentRevocations({
      leaseUntil: new Date(Date.now() + 60_000),
      limit: 10,
      now: new Date(),
    });
    await store.completeMountEnrollmentRevocation(lapsed.enrollmentId, "EXPIRED");
    expect(
      (
        await sql<{ status: string }>`
          select status from workspace_mounts where id = ${lapsed.id}
        `.execute(database)
      ).rows,
    ).toEqual([{ status: "expired" }]);
    expect(await store.listWorkspaceMounts(fixture.workspace.id)).toEqual([]);

    const adopted = await store.recordWorkspaceMount({
      ...input,
      enrollmentId: "22222222-2222-4222-8222-222222222222",
    });
    const pendingDuringInventory = await store.recordWorkspaceMount({
      ...input,
      enrollmentId: "66666666-6666-4666-8666-666666666666",
    });
    await store.requestWorkspaceMountRevocations({
      reason: "membership-revoked",
      workspaceMountIds: [pendingDuringInventory.id],
    });
    const unknown = {
      enrollmentId: "33333333-3333-4333-8333-333333333333",
      volumeId: backing.volumeId,
      workspaceId: fixture.workspace.id,
    };
    await expect(
      store.reconcileRunnerInventory({
        environmentId: fixture.environmentId,
        mounts: [unknown],
      }),
    ).resolves.toEqual([unknown]);
    expect(await store.listEnvironmentWorkspaceMounts(fixture.environmentId)).toMatchObject([
      {
        enrollmentId: adopted.enrollmentId,
        status: "revocation_pending",
        terminationReason: "runner-inventory",
      },
      {
        enrollmentId: pendingDuringInventory.enrollmentId,
        status: "revocation_pending",
        terminationReason: "membership-revoked",
      },
    ]);
    expect(
      await store.claimPendingMountEnrollmentRevocations({
        leaseUntil: new Date(Date.now() + 60_000),
        limit: 10,
        now: new Date(),
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          enrollmentId: adopted.enrollmentId,
          terminationReason: "runner-inventory",
        }),
        expect.objectContaining({
          enrollmentId: pendingDuringInventory.enrollmentId,
          terminationReason: "membership-revoked",
        }),
      ]),
    );
    await store.completeMountEnrollmentRevocation(adopted.enrollmentId, "CLOSED");
    await store.completeMountEnrollmentRevocation(pendingDuringInventory.enrollmentId, "REVOKED");
    expect(await store.listEnvironmentWorkspaceMounts(fixture.environmentId)).toEqual([]);

    const current = await store.recordWorkspaceMount({
      ...input,
      enrollmentId: "55555555-5555-4555-8555-555555555555",
    });
    expect(current.status).toBe("active");
    await expect(
      store.closeEnvironment(fixture.environmentId, "environment-stopped"),
    ).resolves.toBe(1);
    expect(adopted.environmentId).toBe(fixture.environmentId);
  });

  it("rejects stale membership generations for mount assertion and recording", async ({
    storeFixture,
  }) => {
    const { createRunFixture, store, database } = storeFixture;
    const fixture = await createRunFixture("workspace-mount-membership-fence");
    const backing = portableFsBacking(fixture.workspace);
    const authority = {
      environmentId: fixture.environmentId,
      membershipGeneration: 1,
      requestedBy: fixture.userId,
      runnerId: fixture.runnerId,
      volumeId: backing.volumeId,
      workspaceBackingGeneration: backing.generation,
      workspaceId: fixture.workspace.id,
    } as const;
    await expect(store.assertWorkspaceMountAuthority(authority)).resolves.toBeUndefined();
    await store.recordWorkspaceMount({
      ...authority,
      authorizedBy: authority.requestedBy,
      enrollmentId: `membership-current-${randomUUID()}`,
    });
    await database
      .updateTable("workspaceMemberships")
      .set({ generation: sql`${sql.ref("generation")} + 1` })
      .where("workspaceId", "=", fixture.workspace.id)
      .where("userId", "=", fixture.userId)
      .executeTakeFirstOrThrow();

    await expect(store.assertWorkspaceMountAuthority(authority)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      store.recordWorkspaceMount({
        ...authority,
        authorizedBy: authority.requestedBy,
        enrollmentId: `membership-stale-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("rejects a PortableFS backing generation after the backing is replaced", async ({
    storeFixture,
  }) => {
    const { createRunFixture, store } = storeFixture;
    const fixture = await createRunFixture("workspace-mount-backing-fence");
    const backing = portableFsBacking(fixture.workspace);
    const authority = {
      environmentId: fixture.environmentId,
      membershipGeneration: 1,
      requestedBy: fixture.userId,
      runnerId: fixture.runnerId,
      volumeId: backing.volumeId,
      workspaceBackingGeneration: backing.generation,
      workspaceId: fixture.workspace.id,
    } as const;
    const mount = await store.recordWorkspaceMount({
      ...authority,
      authorizedBy: authority.requestedBy,
      enrollmentId: `backing-current-${randomUUID()}`,
    });
    await store.requestWorkspaceMountRevocations({
      reason: "test-backing-replacement",
      workspaceMountIds: [mount.id],
    });
    await store.completeMountEnrollmentRevocation(mount.enrollmentId, "REVOKED");
    await store.claimPortableFsWorkspaceForArchive({
      backingGeneration: backing.generation,
      idleBefore: new Date(Date.now() + 60_000),
      workspaceId: fixture.workspace.id,
    });

    await expect(store.assertWorkspaceMountAuthority(authority)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      store.recordWorkspaceMount({
        ...authority,
        authorizedBy: authority.requestedBy,
        enrollmentId: `backing-stale-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("rejects a Runner that is not the environment's current Runner", async ({ storeFixture }) => {
    const { createRunFixture, store } = storeFixture;
    const fixture = await createRunFixture("workspace-mount-runner-fence");
    const backing = portableFsBacking(fixture.workspace);
    const wrongRunner = {
      environmentId: fixture.environmentId,
      membershipGeneration: 1,
      requestedBy: fixture.userId,
      runnerId: createId("runner"),
      volumeId: backing.volumeId,
      workspaceBackingGeneration: backing.generation,
      workspaceId: fixture.workspace.id,
    } as const;

    await expect(store.assertWorkspaceMountAuthority(wrongRunner)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      store.recordWorkspaceMount({
        ...wrongRunner,
        authorizedBy: fixture.userId,
        enrollmentId: `runner-stale-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("leaves attached-Workspace Runs to Runner detach during membership revocation", async ({
    storeFixture,
  }) => {
    const { createRunFixture, store, enqueueHumanTrigger, database } = storeFixture;
    const fixture = await createRunFixture("mounted-membership-revocation");
    const attached = await store.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: "wsp_mounted_membership_revocation",
      },
      capacityPolicy: {
        blockHardLimitBytes: 10_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota",
      },
      createdBy: fixture.userId,
      idempotencyKey: "mounted-membership-revocation-target",
      name: "Attached client Workspace",
      status: "ready",
    });
    const turn = await enqueueHumanTrigger({
      content: [{ text: "Work across both Workspaces", type: "text" }],
      idempotencyKey: "mounted-membership-revocation-turn",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    await store.claimCommand(turn.command.id, "mounted-membership-revocation-dispatcher");
    await store.recordWorkspaceMount({
      authorizedBy: fixture.userId,
      enrollmentId: "66666666-6666-4666-8666-666666666666",
      environmentId: fixture.environmentId,
      membershipGeneration: 1,
      runnerId: fixture.runnerId,
      volumeId: portableFsBacking(attached).volumeId,
      workspaceId: attached.id,
      workspaceBackingGeneration: portableFsBacking(attached).generation,
    });

    const recovery = await store.failActiveRunsForMembershipRevocation({
      userId: fixture.userId,
      workspaceId: attached.id,
    });
    expect(recovery.terminatedRuns).toEqual([]);
    expect(recovery.events).toEqual([]);
    const run = await database
      .selectFrom("runs")
      .select("status")
      .where("id", "=", turn.run.id)
      .executeTakeFirstOrThrow();
    expect(run.status).toBe("starting");
  });

  it("terminalizes every active Run in a Workspace once deletion is requested", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, store, database } = storeFixture;
    const fixture = await createRunFixture("workspace-deletion-active-run");
    const turn = await enqueueHumanTrigger({
      content: [{ text: "Keep working", type: "text" }],
      idempotencyKey: "workspace-deletion-active-turn",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    await store.claimCommand(turn.command.id, "workspace-deletion-active-dispatcher");

    const recovery = await store.failActiveRunsForWorkspaceDeletion(fixture.workspace.id);

    expect(recovery.terminatedRuns).toEqual([
      {
        environmentId: fixture.environmentId,
        runId: turn.run.id,
        threadId: fixture.thread.id,
      },
    ]);
    expect(recovery.events).toMatchObject([
      {
        data: { code: "workspace_access_revoked", status: "failed" },
        runId: turn.run.id,
        workspaceId: fixture.workspace.id,
      },
      {
        data: { input: { cancelReason: "run-ended-before-start", state: "cancelled" } },
        runId: turn.run.id,
        type: "thread-input.updated",
        workspaceId: fixture.workspace.id,
      },
      {
        type: "thread.state-changed",
        data: { inputQueuePaused: false, pendingRequests: 0, status: "failed" },
        runId: null,
        threadId: fixture.thread.id,
      },
    ]);
    await expect(
      database.selectFrom("runs").select("status").where("id", "=", turn.run.id).executeTakeFirst(),
    ).resolves.toEqual({ status: "failed" });
  });

  it("serializes simultaneous exact retries for every durable command writer", async ({
    storeFixture,
  }) => {
    const { database, store } = storeFixture;
    const secondHostStore = new OpensteerStore(database);
    const userId = await store.createUser("Concurrent command owner");
    const workspaceInput = {
      backing: {
        generation: 1,
        kind: "portablefs" as const,
        serviceId: "test-portablefs",
        volumeId: "wsp_concurrent_command",
      },
      capacityPolicy: {
        blockHardLimitBytes: 10_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota" as const,
      },
      createdBy: userId,
      idempotencyKey: "concurrent-command-workspace",
      name: "Concurrent Workspace",
      status: "ready" as const,
    };
    const workspaces = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        (index % 2 === 0 ? store : secondHostStore).createWorkspace(workspaceInput),
      ),
    );
    expect(new Set(workspaces.map(({ id }) => id)).size).toBe(1);

    const runnerId = createId("runner");
    const environmentId = createId("environment");
    await enrollTestRunner(store, {
      createdBy: userId,
      environmentId,
      name: "Concurrent command runner",
      runnerId,
      tokenSuffix: "concurrent_command",
    });
    const harness = await store.createHarnessInstance({
      config: { model: "test" },
      driverKind: HarnessIdSchema.parse("native"),
      environmentId,
      name: "Native",
      stateKind: "isolated",
    });
    const threadInput = {
      createdBy: userId,
      environmentId,
      harnessInstanceId: harness.id,
      idempotencyKey: "concurrent-command-thread",
      modelSelection: testModelSelection,
      title: "Concurrent Thread",
      workspaceId: workspaces[0]!.id,
    };
    const threads = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        (index % 2 === 0 ? store : secondHostStore).createThread(threadInput),
      ),
    );
    expect(threads.filter(({ wasDuplicate }) => !wasDuplicate)).toHaveLength(1);
    expect(new Set(threads.map(({ thread }) => thread.id)).size).toBe(1);
    const threadId = threads[0]!.thread.id;

    const messageInput = {
      content: [{ text: "Run this once", type: "text" as const }],
      idempotencyKey: "concurrent-command-message",
      policy: "queue" as const,
      requestedBy: userId,
      source: { kind: "human" as const },
      threadId,
    };
    const messages = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        (index % 2 === 0 ? store : secondHostStore).enqueueThreadInput(messageInput),
      ),
    );
    expect(messages.filter(({ wasDuplicate }) => !wasDuplicate)).toHaveLength(1);
    expect(new Set(messages.map(({ message }) => message.id)).size).toBe(1);
    await expect(
      database
        .selectFrom("runs")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("threadId", "=", threadId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: "1" });
    const controlInput = {
      idempotencyKey: "concurrent-command-stop",
      requestedBy: userId,
      runId: messages[0]!.run!.id,
      threadId,
      type: "run.interrupt" as const,
    };
    const controls = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        (index % 2 === 0 ? store : secondHostStore).enqueueRunnerControl(controlInput),
      ),
    );
    expect(controls.filter(({ wasDuplicate }) => !wasDuplicate)).toHaveLength(1);
    expect(new Set(controls.map(({ command }) => command.id)).size).toBe(1);
    await expect(
      database
        .selectFrom("commands")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("requestedBy", "=", userId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: "4" });
  });

  it("persists a bounded Workspace storage issue and clears it on recovery", async ({
    storeFixture,
  }) => {
    const { store } = storeFixture;
    const userId = await store.createUser("Workspace storage owner");
    const workspace = await store.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: "pending_storage_recovery",
      },
      capacityPolicy: {
        blockHardLimitBytes: 512 * 1_024 * 1_024,
        inodeHardLimit: 50_000,
        kind: "hard-quota",
      },
      createdBy: userId,
      idempotencyKey: "workspace-storage-issue",
      name: "Storage recovery",
      status: "provisioning",
    });
    expect(workspace.storageIssue).toBeNull();

    const storageIssueCodes = [
      "manager-allocation-rejected",
      "manager-configuration-invalid",
      "manager-identity-rejected",
      "manager-protocol-error",
      "manager-unavailable",
      "local-directory-inaccessible",
      "local-directory-missing",
      "local-directory-replaced",
      "local-registry-invalid",
    ] as const;
    let unavailable = workspace;
    for (const code of storageIssueCodes) {
      unavailable = await store.setWorkspaceStorageState({
        issue: {
          code,
          message: `Workspace storage issue: ${code}`,
          occurredAt: "2026-08-10T00:00:00.000Z",
          retryable: true,
        },
        status: "unavailable",
        workspaceId: workspace.id,
      });
      expect(unavailable.storageIssue?.code).toBe(code);
    }
    expect(unavailable).toMatchObject({
      status: "unavailable",
      storageIssue: {
        code: "local-registry-invalid",
        retryable: true,
      },
    });

    const expectedBacking = portableFsBacking(workspace);
    const ready = await store.setWorkspaceProvisioningResult({
      backing: {
        ...expectedBacking,
        volumeId: "00000000-0000-4000-8000-000000000099",
      },
      expectedBacking,
      status: "ready",
      workspaceId: workspace.id,
    });
    expect(ready).toMatchObject({ status: "ready", storageIssue: null });

    await expect(
      store.setWorkspaceProvisioningResult({
        backing: {
          generation: expectedBacking.generation + 1,
          kind: "portablefs",
          serviceId: expectedBacking.serviceId,
          volumeId: "00000000-0000-4000-8000-000000000100",
        },
        expectedBacking: ready.backing,
        status: "ready",
        workspaceId: workspace.id,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      store.setWorkspaceProvisioningResult({
        backing: {
          generation: expectedBacking.generation,
          kind: "portablefs",
          serviceId: "another-portablefs-authority",
          volumeId: "00000000-0000-4000-8000-000000000100",
        },
        expectedBacking: ready.backing,
        status: "ready",
        workspaceId: workspace.id,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("holds Workspace deletion for owner recovery and exposes only explicit purge tombstones", async ({
    storeFixture,
  }) => {
    const { store, database } = storeFixture;
    const ownerId = await store.createUser("Workspace deletion owner");
    const collaboratorId = await store.createUser("Workspace deletion collaborator");
    const workspace = await store.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: "workspace_deletion_lifecycle",
      },
      capacityPolicy: {
        blockHardLimitBytes: 512 * 1_024 * 1_024,
        inodeHardLimit: 50_000,
        kind: "hard-quota",
      },
      createdBy: ownerId,
      idempotencyKey: "workspace-deletion-lifecycle",
      name: "Deletion lifecycle",
      status: "ready",
    });
    await database
      .insertInto("workspaceMemberships")
      .values({
        generation: 1,
        id: createId("workspaceMembership"),
        invitedBy: ownerId,
        joinedAt: new Date(),
        revokedAt: null,
        revokedBy: null,
        role: "collaborator",
        state: "active",
        updatedAt: new Date(),
        userId: collaboratorId,
        workspaceId: workspace.id,
      })
      .executeTakeFirstOrThrow();

    await expect(
      store.requestWorkspaceDeletion({
        purgeAfter: new Date(Date.now() + 60_000),
        requestedBy: collaboratorId,
        workspaceId: workspace.id,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });

    const purgeAfter = new Date(Date.now() + 60_000);
    const deletion = await store.requestWorkspaceDeletion({
      purgeAfter,
      requestedBy: ownerId,
      workspaceId: workspace.id,
    });
    const deleting = deletion.workspace;
    expect(deleting.status).toBe("deleting");
    await expect(
      store.requestWorkspaceDeletion({
        purgeAfter: new Date(purgeAfter.getTime() + 60_000),
        requestedBy: ownerId,
        workspaceId: workspace.id,
      }),
    ).resolves.toEqual({ requestEvents: [], workspace: deleting });
    await expect(store.admitWorkspaceFiles(workspace.id, ownerId)).rejects.toMatchObject({
      code: "workspace_unavailable",
    });
    expect((await store.listWorkspacesForOwner(ownerId)).map(({ id }) => id)).toContain(
      workspace.id,
    );

    await expect(
      store.recoverWorkspaceDeletion({ requestedBy: ownerId, workspaceId: workspace.id }),
    ).resolves.toMatchObject({ status: "unavailable" });

    await store.requestWorkspaceDeletion({
      purgeAfter: new Date(Date.now() - 1),
      requestedBy: ownerId,
      workspaceId: workspace.id,
    });
    await expect(
      store.recoverWorkspaceDeletion({ requestedBy: ownerId, workspaceId: workspace.id }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      store.listWorkspacesDuePurge({ limit: 10, now: new Date() }),
    ).resolves.toMatchObject([{ id: workspace.id, status: "deleting" }]);
    await expect(store.markWorkspaceDeleted({ workspaceId: workspace.id })).resolves.toMatchObject({
      status: "deleted",
    });
    expect(await store.listWorkspacesForOwner(ownerId)).toEqual([]);
    expect((await store.workspacePageForOwner({ ownerId })).workspaces).toEqual([]);
    await expect(store.admitWorkspaceFiles(workspace.id, ownerId)).resolves.toBeNull();

    const audit = await database
      .selectFrom("securityAudit")
      .select("action")
      .where("workspaceId", "=", workspace.id)
      .orderBy("createdAt", "asc")
      .execute();
    expect(audit.map(({ action }) => action)).toEqual([
      "workspace.created",
      "workspace.deletion_requested",
      "workspace.deletion_recovered",
      "workspace.deletion_requested",
      "workspace.deleted",
    ]);
  });

  it("keeps a Thread-create retry idempotent when the native model id has moved", async ({
    storeFixture,
  }) => {
    const { createRunFixture, store } = storeFixture;
    const fixture = await createRunFixture("native-model-retry");
    const input = {
      createdBy: fixture.userId,
      environmentId: fixture.environmentId,
      harnessInstanceId: fixture.harnessInstance.id,
      idempotencyKey: "native-model-retry",
      modelSelection: ModelSelectionSchema.parse({
        ...testModelSelection,
        nativeModelId: "openai/gpt-5.6-sol",
      }),
      title: "Through a gateway",
      workspaceId: fixture.workspace.id,
    };
    const created = await store.createThread(input);

    expect(created.wasDuplicate).toBe(false);
    expect(created.thread.modelSelection.nativeModelId).toBe("openai/gpt-5.6-sol");
    // The Host reads the native id off a live catalog, so a retry can carry a
    // different one — or none. That is the same request, not a reused key.
    await expect(
      store.findThreadCreationByIdempotency({ ...input, modelSelection: testModelSelection }),
    ).resolves.toMatchObject({ thread: { id: created.thread.id }, wasDuplicate: true });
    await expect(
      store.createThread({
        ...input,
        modelSelection: ModelSelectionSchema.parse({
          ...testModelSelection,
          nativeModelId: "openai/gpt-5.6-sol:nitro",
        }),
      }),
    ).resolves.toMatchObject({ thread: { id: created.thread.id }, wasDuplicate: true });
    // The canonical pair is still the request, so changing it is a reuse.
    await expect(
      store.createThread({
        ...input,
        modelSelection: ModelSelectionSchema.parse({
          ...testModelSelection,
          modelId: "gpt-5.6-terra",
        }),
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("keeps reports passive and admits one queued work item per Run", async ({ storeFixture }) => {
    const { createRunFixture, store, database } = storeFixture;
    const fixture = await createRunFixture("thread-input-policy");
    const queueRequest = {
      content: [{ text: "Hold this input", type: "text" as const }],
      idempotencyKey: "thread-input-policy-queue",
      policy: "report" as const,
      requestedBy: fixture.userId,
      source: { kind: "human" as const },
      threadId: fixture.thread.id,
    };
    const queued = await store.enqueueThreadInput(queueRequest);
    const reports = [
      queued,
      ...(await Promise.all(
        Array.from({ length: 7 }, (_, index) =>
          store.enqueueThreadInput({
            ...queueRequest,
            content: [{ text: `Historical report ${index + 2}`, type: "text" }],
            idempotencyKey: `thread-input-policy-report-${index + 2}`,
          }),
        ),
      )),
    ];

    expect(queued).toMatchObject({
      command: null,
      disposition: "pending",
      input: { policy: "report", runId: null, state: "pending" },
      message: {
        author: { displayName: "Alex", kind: "human", userId: fixture.userId },
        kind: "input",
        runId: null,
      },
      run: null,
      wasDuplicate: false,
    });
    const replayed = await store.enqueueThreadInput(queueRequest);
    expect(replayed).toMatchObject({
      command: null,
      disposition: "pending",
      input: { messageId: queued.message.id },
      message: { id: queued.message.id },
      run: null,
      wasDuplicate: true,
    });
    await expect(
      store.enqueueThreadInput({
        ...queueRequest,
        policy: "queue",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      database
        .selectFrom("causalChains")
        .select(["rootMessageId", "rootOccurrenceId"])
        .where("id", "=", queued.input.causalChainId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ rootMessageId: queued.message.id, rootOccurrenceId: null });
    await expect(
      database.deleteFrom("messages").where("id", "=", queued.message.id).execute(),
    ).rejects.toThrow(/causal_chains_root_message_fk/u);

    const triggered = await store.enqueueThreadInput({
      content: [{ text: "Start processing the inbox", type: "text" }],
      idempotencyKey: "thread-input-policy-trigger",
      policy: "queue",
      requestedBy: fixture.userId,
      source: { kind: "human" },
      threadId: fixture.thread.id,
    });
    expect(triggered).toMatchObject({
      command: { type: "run.execute" },
      disposition: "run-queued",
      input: { policy: "queue", runId: null, state: "pending" },
      run: { status: "queued", seedInputId: triggered.message.id },
    });
    if (!triggered.command || !triggered.run) throw new Error("Expected a queued inbox Run");

    await store.claimCommand(triggered.command.id, "thread-input-policy-dispatcher");
    const context = await store.loadRunDispatchContext(triggered.command.id);
    expect(context.inputs.map(({ id }) => id)).toEqual([triggered.message.id]);
    expect(new Set(context.reports.messages.map(({ id }) => id))).toEqual(
      new Set(reports.map(({ message }) => message.id)),
    );
    expect(context.run.seedInputId).toBe(triggered.message.id);
    await expect(
      database
        .selectFrom("runs")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("threadId", "=", fixture.thread.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: "1" });
    await expect(
      database
        .selectFrom("threadInputs")
        .select(["runId", "state"])
        .where("messageId", "=", triggered.message.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ runId: triggered.run.id, state: "claimed" });

    const runnerBootId = "boot-thread-input-policy";
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: fixture.harnessInstance.id,
      leaseTokenHash: "thread-input-policy-lease",
      membershipGeneration: 1,
      runnerBootId,
      runnerId: fixture.runnerId,
      runId: triggered.run.id,
      threadId: fixture.thread.id,
    });
    await store.commitRunnerEvent({
      environmentId: fixture.environmentId,
      event: pendingEvent({
        bindingGeneration: binding.bindingGeneration,
        data: { status: "running" },
        environmentId: fixture.environmentId,
        ordinal: 0,
        runId: triggered.run.id,
        threadId: fixture.thread.id,
        type: "run.started",
        workspaceId: fixture.workspace.id,
      }),
      runnerBootId,
      runnerId: fixture.runnerId,
    });
    const lateReport = await store.enqueueThreadInput({
      ...queueRequest,
      content: [{ text: "Late passive report", type: "text" }],
      idempotencyKey: "thread-input-policy-late-report",
    });
    await store.commitRunnerEvent({
      environmentId: fixture.environmentId,
      event: pendingEvent({
        bindingGeneration: binding.bindingGeneration,
        data: { status: "completed" },
        environmentId: fixture.environmentId,
        ordinal: 1,
        runId: triggered.run.id,
        threadId: fixture.thread.id,
        type: "run.completed",
        workspaceId: fixture.workspace.id,
      }),
      runnerBootId,
      runnerId: fixture.runnerId,
    });
    await expect(
      database
        .selectFrom("threadInputs")
        .select(["runId", "state"])
        .where("messageId", "=", lateReport.message.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ runId: null, state: "pending" });
    await expect(store.recoverThreadWorkQueues()).resolves.toEqual([]);
    await expect(
      database
        .selectFrom("runs")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("threadId", "=", fixture.thread.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: "1" });

    const { thread: otherThread } = await store.createThread({
      createdBy: fixture.userId,
      environmentId: fixture.environmentId,
      harnessInstanceId: fixture.harnessInstance.id,
      idempotencyKey: "thread-input-policy-cross-thread",
      modelSelection: testModelSelection,
      title: "Cross-thread integrity target",
      workspaceId: fixture.workspace.id,
    });
    const otherInput = await store.enqueueThreadInput({
      content: [{ text: "Must remain on the other Thread", type: "text" }],
      idempotencyKey: "thread-input-policy-cross-thread-input",
      policy: "report",
      requestedBy: fixture.userId,
      source: { kind: "human" },
      threadId: otherThread.id,
    });
    await expect(
      database
        .updateTable("messages")
        .set({ runId: triggered.run.id })
        .where("id", "=", otherInput.message.id)
        .execute(),
    ).rejects.toThrow(/messages_run_thread_fk/u);
    await expect(
      database
        .updateTable("threadInputs")
        .set({ runId: triggered.run.id, state: "claimed" })
        .where("messageId", "=", otherInput.message.id)
        .execute(),
    ).rejects.toThrow(/thread_inputs_run_thread_fk/u);
  });

  it("delivers a maximum-size report without starving later context", async ({ storeFixture }) => {
    const { createRunFixture, store, enqueueHumanTrigger } = storeFixture;
    const fixture = await createRunFixture("maximum-report-context");
    const content = [
      { type: "text" as const, text: "x".repeat(256 * 1_024) },
      { type: "text" as const, text: "" },
    ];
    content[1]!.text = "y".repeat(
      messageContentMaxSerializedBytes - Buffer.byteLength(JSON.stringify(content)),
    );
    expect(Buffer.byteLength(JSON.stringify(MessageContentSchema.parse(content)))).toBe(
      messageContentMaxSerializedBytes,
    );
    const maximum = await store.enqueueThreadInput({
      content,
      idempotencyKey: "maximum-report-context-large",
      policy: "report",
      requestedBy: fixture.userId,
      source: { kind: "human" },
      threadId: fixture.thread.id,
    });
    const next = await store.enqueueThreadInput({
      content: [{ type: "text", text: "A later report must remain reachable" }],
      idempotencyKey: "maximum-report-context-next",
      policy: "report",
      requestedBy: fixture.userId,
      source: { kind: "human" },
      threadId: fixture.thread.id,
    });
    const work = await enqueueHumanTrigger({
      content: [{ type: "text", text: "Use available context" }],
      idempotencyKey: "maximum-report-context-work",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    await store.claimCommand(work.command.id, "maximum-report-context-dispatcher");
    const context = await store.loadRunDispatchContext(work.command.id);
    expect(context.reports.messages.map(({ id }) => id)).toEqual([
      maximum.message.id,
      next.message.id,
    ]);
    expect(context.reports.omittedCount).toBe(0);
  });

  it("freezes a bounded report sidecar and retries an unknown report only with real work", async ({
    storeFixture,
  }) => {
    const { createRunFixture, store, database } = storeFixture;
    const fixture = await createRunFixture("thread-report-sidecar-cap");
    const reports = [];
    // One overflowing report keeps fixture preparation bounded under load.
    for (let index = 0; index < 51; index += 1) {
      reports.push(
        await store.enqueueThreadInput({
          content: [{ text: `Passive report ${index}`, type: "text" }],
          idempotencyKey: `thread-report-sidecar-cap-${index}`,
          policy: "report",
          requestedBy: fixture.userId,
          source: { kind: "human" },
          threadId: fixture.thread.id,
        }),
      );
    }
    await expect(
      database
        .selectFrom("runs")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("threadId", "=", fixture.thread.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: "0" });

    const work = await store.enqueueThreadInput({
      content: [{ text: "Process one real task", type: "text" }],
      idempotencyKey: "thread-report-sidecar-cap-work",
      policy: "queue",
      requestedBy: fixture.userId,
      source: { kind: "human" },
      threadId: fixture.thread.id,
    });
    if (!work.command || !work.run) throw new Error("Expected one queued work Run");
    await database
      .updateTable("threadInputs")
      .set({ runId: work.run.id, state: "unknown" })
      .where("messageId", "=", reports[0]!.message.id)
      .executeTakeFirstOrThrow();
    await store.claimCommand(work.command.id, "thread-report-sidecar-cap-dispatcher");
    const context = await store.loadRunDispatchContext(work.command.id);
    expect(context.inputs.map(({ id }) => id)).toEqual([work.message.id]);
    expect(context.reports.messages).toHaveLength(50);
    expect(context.reports.messages.map(({ id }) => id)).toContain(reports[0]!.message.id);
    expect(context.reports.omittedCount).toBe(1);
    expect(context.reports.throughSequence).not.toBeNull();

    const late = await store.enqueueThreadInput({
      content: [{ text: "Arrived after the frozen snapshot", type: "text" }],
      idempotencyKey: "thread-report-sidecar-cap-late",
      policy: "report",
      requestedBy: fixture.userId,
      source: { kind: "human" },
      threadId: fixture.thread.id,
    });

    await store.retryCommand(work.command.id, new Error("Retry the same native dispatch"));
    await store.claimCommand(work.command.id, "thread-report-sidecar-cap-retry");
    const retry = await store.loadRunDispatchContext(work.command.id);
    expect(retry.reports).toEqual(context.reports);
    expect(retry.reports.messages.map(({ id }) => id)).not.toContain(late.message.id);
    await expect(
      database
        .selectFrom("threadInputs")
        .select(["runId", "state"])
        .where("messageId", "=", late.message.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ runId: null, state: "pending" });
  }, 120_000);

  it("repairs a legacy queued Run seeded by a passive report on Host recovery", async ({
    storeFixture,
  }) => {
    const { createRunFixture, store, database } = storeFixture;
    const fixture = await createRunFixture("legacy-report-seed-recovery");
    const report = await store.enqueueThreadInput({
      content: [{ text: "Historical completion report", type: "text" }],
      idempotencyKey: "legacy-report-seed-recovery-report",
      policy: "report",
      requestedBy: fixture.userId,
      source: { kind: "human" },
      threadId: fixture.thread.id,
    });
    const work = await store.enqueueThreadInput({
      content: [{ text: "The actual authorized task", type: "text" }],
      idempotencyKey: "legacy-report-seed-recovery-work",
      policy: "queue",
      requestedBy: fixture.userId,
      source: { kind: "human" },
      threadId: fixture.thread.id,
    });
    if (!work.run) throw new Error("Expected queued work Run");
    await database
      .updateTable("runs")
      .set({ seedInputId: report.message.id })
      .where("id", "=", work.run.id)
      .executeTakeFirstOrThrow();
    await database
      .updateTable("threadInputs")
      .set({ runId: work.run.id, state: "claimed" })
      .where("messageId", "=", report.message.id)
      .executeTakeFirstOrThrow();

    const events = await store.recoverThreadWorkQueues();
    expect(events.map(({ type }) => type)).toEqual([
      "run.interrupted",
      "thread-input.updated",
      "message.placed",
      "run.queued",
    ]);
    await expect(
      database
        .selectFrom("threadInputs")
        .select(["runId", "state"])
        .where("messageId", "=", report.message.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ runId: work.run.id, state: "unknown" });
    await expect(
      database
        .selectFrom("runs")
        .select(["seedInputId", "status"])
        .where("threadId", "=", fixture.thread.id)
        .orderBy("runOrdinal", "asc")
        .execute(),
    ).resolves.toEqual([
      { seedInputId: report.message.id, status: "interrupted" },
      { seedInputId: work.message.id, status: "queued" },
    ]);
  });

  it("drains an incompatible trigger after the FIFO Run ahead of it terminates", async ({
    storeFixture,
  }) => {
    const { createRunFixture, store, database } = storeFixture;
    const fixture = await createRunFixture("thread-input-terminal-trigger-drain");
    const first = await store.enqueueThreadInput({
      content: [{ text: "Run this older independent root first", type: "text" }],
      idempotencyKey: "thread-input-terminal-trigger-drain-first",
      policy: "queue",
      requestedBy: fixture.userId,
      source: { kind: "human" },
      threadId: fixture.thread.id,
    });
    const trigger = await store.enqueueThreadInput({
      content: [{ text: "Then run this incompatible root", type: "text" }],
      idempotencyKey: "thread-input-terminal-trigger-drain-trigger",
      policy: "queue",
      requestedBy: fixture.userId,
      source: { kind: "human" },
      threadId: fixture.thread.id,
    });
    expect(trigger).toMatchObject({
      command: null,
      disposition: "pending",
      run: null,
    });
    if (!first.command || !first.run) throw new Error("Expected the FIFO Run");

    const claimed = await store.claimCommand(
      first.command.id,
      "thread-input-terminal-trigger-drain-dispatcher",
    );
    expect(claimed?.events.map(({ type }) => type)).toEqual(["thread-input.updated", "run.status"]);
    const runnerBootId = "boot-thread-input-terminal-trigger-drain";
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: fixture.harnessInstance.id,
      leaseTokenHash: "thread-input-terminal-trigger-drain-lease",
      membershipGeneration: 1,
      runnerBootId,
      runnerId: fixture.runnerId,
      runId: first.run.id,
      threadId: fixture.thread.id,
    });
    const started = await store.commitRunnerEvent({
      environmentId: fixture.environmentId,
      event: pendingEvent({
        bindingGeneration: binding.bindingGeneration,
        data: { status: "running" },
        environmentId: fixture.environmentId,
        ordinal: 0,
        runId: first.run.id,
        threadId: fixture.thread.id,
        type: "run.started",
        workspaceId: fixture.workspace.id,
      }),
      runnerBootId,
      runnerId: fixture.runnerId,
    });
    expect(started.compensatingEvents.map(({ type }) => type)).toEqual(["thread-input.updated"]);
    const completed = await store.commitRunnerEvent({
      environmentId: fixture.environmentId,
      event: pendingEvent({
        bindingGeneration: binding.bindingGeneration,
        data: { status: "completed" },
        environmentId: fixture.environmentId,
        ordinal: 1,
        runId: first.run.id,
        threadId: fixture.thread.id,
        type: "run.completed",
        workspaceId: fixture.workspace.id,
      }),
      runnerBootId,
      runnerId: fixture.runnerId,
    });
    expect(completed.compensatingEvents.map(({ type }) => type)).toContain("run.queued");
    await expect(
      database
        .selectFrom("runs")
        .select(["status", "seedInputId"])
        .where("threadId", "=", fixture.thread.id)
        .where("status", "=", "queued")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "queued", seedInputId: trigger.message.id });
  });

  /*
   * A provider session keeps the lease its last Run held after that Run ends.
   * Failure mode: the expiry sweep judges the Thread's next Run, claimed and
   * still being prepared, by that stale lease and fails a Run that never held
   * a binding.
   */
  it("leaves a Run being prepared alone when its session's last lease expired", async ({
    storeFixture,
  }) => {
    const { createRunFixture, store, database } = storeFixture;
    const fixture = await createRunFixture("stale-session-lease");
    const enqueue = (key: string) =>
      store.enqueueThreadInput({
        content: [{ text: key, type: "text" }],
        idempotencyKey: key,
        policy: "queue",
        requestedBy: fixture.userId,
        source: { kind: "human" },
        threadId: fixture.thread.id,
      });
    const first = await enqueue("stale-session-lease-first");
    if (!first.command || !first.run) throw new Error("Expected a Run");
    await store.claimCommand(first.command.id, "dispatcher");
    const runnerBootId = "boot-stale-session-lease";
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: fixture.harnessInstance.id,
      leaseTokenHash: "stale-session-lease",
      membershipGeneration: 1,
      runnerBootId,
      runnerId: fixture.runnerId,
      runId: first.run.id,
      threadId: fixture.thread.id,
    });
    const base = {
      bindingGeneration: binding.bindingGeneration,
      environmentId: fixture.environmentId,
      runId: first.run.id,
      threadId: fixture.thread.id,
      workspaceId: fixture.workspace.id,
    };
    for (const [ordinal, type, data] of [
      [0, "run.started", { status: "running" }],
      [1, "run.completed", { status: "completed" }],
    ] as const) {
      await store.commitRunnerEvent({
        environmentId: fixture.environmentId,
        event: pendingEvent({ ...base, data, ordinal, type }),
        runnerBootId,
        runnerId: fixture.runnerId,
      });
    }
    await database
      .updateTable("providerSessions")
      .set({ leaseExpiresAt: new Date(Date.now() - 60_000) })
      .where("id", "=", binding.providerSessionId)
      .execute();
    const next = await enqueue("stale-session-lease-next");
    if (!next.command || !next.run) throw new Error("Expected a second Run");
    await store.claimCommand(next.command.id, "dispatcher");

    const swept = await store.recoverRunsWithExpiredExecutionBindings();

    expect(swept.terminatedRuns).toEqual([]);
    await expect(
      database
        .selectFrom("runs")
        .select("status")
        .where("id", "=", next.run.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "starting" });
  });

  /*
   * A Host that stops mid-dispatch leaves the Run's execute command claimed.
   * Failure modes after its restart:
   * - a Run claimed but never bound to a Runner has no lease and no Runner to
   *   announce it, so nothing would ever start or end it, and its Thread
   *   would wait behind it forever;
   * - a Run already bound may be running on its Runner, so only that Runner's
   *   attach may settle it.
   */
  it("returns a Run a stopped Host claimed but never bound to its queue", async ({
    storeFixture,
  }) => {
    const { createRunFixture, store, database } = storeFixture;
    const fixture = await createRunFixture("claimed-unbound-restart");
    const enqueue = (key: string) =>
      store.enqueueThreadInput({
        content: [{ text: key, type: "text" }],
        idempotencyKey: key,
        policy: "queue",
        requestedBy: fixture.userId,
        source: { kind: "human" },
        threadId: fixture.thread.id,
      });
    const unbound = await enqueue("claimed-unbound-input");
    if (!unbound.command || !unbound.run) throw new Error("Expected a Run");
    await store.claimCommand(unbound.command.id, "host-before-restart");

    const events = await store.recoverCommandsAfterHostRestart();

    expect(events).toContainEqual(
      expect.objectContaining({ data: { status: "queued" }, runId: unbound.run.id }),
    );
    await expect(
      database
        .selectFrom("commands")
        .select("status")
        .where("id", "=", unbound.command.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "pending" });

    await store.claimCommand(unbound.command.id, "host-after-restart");
    await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: fixture.harnessInstance.id,
      leaseTokenHash: "claimed-bound-lease",
      membershipGeneration: 1,
      runnerBootId: "boot-claimed-bound",
      runnerId: fixture.runnerId,
      runId: unbound.run.id,
      threadId: fixture.thread.id,
    });

    await store.recoverCommandsAfterHostRestart();

    await expect(
      database
        .selectFrom("runs")
        .select("status")
        .where("id", "=", unbound.run.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "starting" });
  });

  it("holds a starting Run after its replayed session binding commits across Host restarts", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, store, database } = storeFixture;
    const fixture = await createRunFixture("replayed-binding-restart");
    const turn = await enqueueHumanTrigger({
      content: [{ text: "Start", type: "text" }],
      idempotencyKey: "replayed-binding-input",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    await store.claimCommand(turn.command.id, "host-before-restart");
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: fixture.harnessInstance.id,
      leaseTokenHash: "replayed-binding-lease",
      membershipGeneration: 1,
      runnerBootId: "replayed-binding-boot",
      runnerId: fixture.runnerId,
      runId: turn.run.id,
      threadId: fixture.thread.id,
    });
    const attachment = {
      dispatchingRunIds: [],
      executions: [
        {
          bindingGeneration: binding.bindingGeneration,
          environmentId: fixture.environmentId,
          nextOrdinal: 1,
          runId: turn.run.id,
          terminal: false,
          threadId: fixture.thread.id,
          workspaceId: fixture.workspace.id,
        },
      ],
      leaseExpiresAt: new Date(Date.now() + 60_000),
      runnerBootId: "replayed-binding-boot",
      runnerId: fixture.runnerId,
    };
    await store.attachRunnerExecutions(attachment);
    await store.bindProviderSession({
      bindingGeneration: binding.bindingGeneration,
      harnessInstanceId: fixture.harnessInstance.id,
      providerSessionId: binding.providerSessionId,
      providerSessionReference: "replayed-native-session",
      runId: turn.run.id,
      runnerBootId: attachment.runnerBootId,
      runnerId: fixture.runnerId,
      threadId: fixture.thread.id,
    });
    // The execute acknowledgement and run.started were both lost. Only the
    // session binding committed before the Host stopped a second time.
    expect(await store.recoverCommandsAfterHostRestart()).toEqual([]);
    await expect(
      database
        .selectFrom("runs")
        .select(["status", "bindingGeneration"])
        .where("id", "=", turn.run.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      bindingGeneration: binding.bindingGeneration,
      status: "starting",
    });
    await expect(
      database
        .selectFrom("commands")
        .select("status")
        .where("id", "=", turn.command.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "dispatched" });
    expect((await store.attachRunnerExecutions(attachment)).results).toEqual([
      { nextOrdinal: 0, runId: turn.run.id, status: "attached" },
    ]);
  });

  it.for(["live", "expired"] as const)(
    "requeues a same-boot omission only with a live lease (%s)",
    async (lease, { storeFixture }) => {
      const { createRunFixture, enqueueHumanTrigger, store, database } = storeFixture;
      const fixture = await createRunFixture("omitted-binding");
      const turn = await enqueueHumanTrigger({
        content: [{ text: "Start", type: "text" }],
        idempotencyKey: "omitted-binding-input",
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      });
      await store.claimCommand(turn.command.id, "host-before-attach");
      await store.acquireExecutionBinding({
        bindingLeaseExpiresAt: new Date(Date.now() + (lease === "live" ? 60_000 : -60_000)),
        continuationIdentity: testContinuationIdentity,
        harnessInstanceId: fixture.harnessInstance.id,
        leaseTokenHash: "omitted-binding-lease",
        membershipGeneration: 1,
        runnerBootId: "omitted-binding-boot",
        runnerId: fixture.runnerId,
        runId: turn.run.id,
        threadId: fixture.thread.id,
      });
      const outcome = await store.attachRunnerExecutions({
        dispatchingRunIds: [],
        executions: [],
        leaseExpiresAt: new Date(Date.now() + 60_000),
        runnerBootId: "omitted-binding-boot",
        runnerId: fixture.runnerId,
      });
      if (lease === "live") {
        expect(outcome.events).toContainEqual(
          expect.objectContaining({
            data: { status: "queued" },
            runId: turn.run.id,
            type: "run.status",
          }),
        );
        await expect(
          database
            .selectFrom("runs")
            .select(["status", "bindingGeneration"])
            .where("id", "=", turn.run.id)
            .executeTakeFirstOrThrow(),
        ).resolves.toEqual({
          bindingGeneration: null,
          status: "queued",
        });
      } else {
        expect(outcome.events).toContainEqual(
          expect.objectContaining({
            data: expect.objectContaining({
              code: "execution_binding_expired",
              status: "failed",
            }),
            runId: turn.run.id,
            type: "run.failed",
          }),
        );
      }
      await expect(
        database
          .selectFrom("commands")
          .select("status")
          .where("id", "=", turn.command.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        status: lease === "live" ? "pending" : "failed",
      });
    },
  );

  it.for([null, 0])(
    "ignores a pre-acquire Run with binding generation %s when its session's Runner attaches",
    async (bindingGeneration, { storeFixture }) => {
      const { startRunFixture, store, enqueueHumanTrigger, database } = storeFixture;
      const fixture = await startRunFixture("pre-acquire-attach");
      await store.commitRunnerEvent({
        environmentId: fixture.environmentId,
        event: pendingEvent({
          bindingGeneration: fixture.bindingGeneration,
          data: { status: "completed" },
          environmentId: fixture.environmentId,
          ordinal: 1,
          runId: fixture.run.id,
          threadId: fixture.thread.id,
          type: "run.completed",
          workspaceId: fixture.workspace.id,
        }),
        runnerBootId: fixture.runnerBootId,
        runnerId: fixture.runnerId,
      });
      const next = await enqueueHumanTrigger({
        content: [{ text: "Continue", type: "text" }],
        idempotencyKey: "pre-acquire-next",
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      });
      await store.claimCommand(next.command.id, "host-before-acquire");
      if (bindingGeneration !== null) {
        await database
          .updateTable("runs")
          .set({ bindingGeneration })
          .where("id", "=", next.run.id)
          .executeTakeFirstOrThrow();
      }
      const outcome = await store.attachRunnerExecutions({
        dispatchingRunIds: [],
        executions: [],
        leaseExpiresAt: new Date(Date.now() + 60_000),
        runnerBootId: fixture.runnerBootId,
        runnerId: fixture.runnerId,
      });
      expect(outcome.events).toEqual([]);
      await expect(
        database
          .selectFrom("runs")
          .select("status")
          .where("id", "=", next.run.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ status: "starting" });
      expect(await store.recoverCommandsAfterHostRestart()).toContainEqual(
        expect.objectContaining({
          data: { status: "queued" },
          runId: next.run.id,
          type: "run.status",
        }),
      );
    },
  );

  /*
   * PostgreSQL refuses half of a surrogate pair in jsonb, and an engine can put
   * one in any text it reports. Failure modes:
   * - the event log stores it well-formed but a projection (the message row)
   *   writes the original, failing the whole commit;
   * - the Runner replays the identical event after a reconnect and the Host
   *   compares its normalized record with the raw replay, refusing it.
   */
  it("commits and replays an answer holding half of a surrogate pair", async ({ storeFixture }) => {
    const { createRunFixture, store, database } = storeFixture;
    const fixture = await createRunFixture("lone-surrogate-answer");
    const work = await store.enqueueThreadInput({
      content: [{ text: "Write an emoji", type: "text" }],
      idempotencyKey: "lone-surrogate-answer-input",
      policy: "queue",
      requestedBy: fixture.userId,
      source: { kind: "human" },
      threadId: fixture.thread.id,
    });
    if (!work.command || !work.run) throw new Error("Expected a Run");
    await store.claimCommand(work.command.id, "lone-surrogate-dispatcher");
    const runnerBootId = "boot-lone-surrogate";
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: fixture.harnessInstance.id,
      leaseTokenHash: "lone-surrogate-lease",
      membershipGeneration: 1,
      runnerBootId,
      runnerId: fixture.runnerId,
      runId: work.run.id,
      threadId: fixture.thread.id,
    });
    const base = {
      bindingGeneration: binding.bindingGeneration,
      environmentId: fixture.environmentId,
      runId: work.run.id,
      threadId: fixture.thread.id,
      workspaceId: fixture.workspace.id,
    };
    const commit = (event: ReturnType<typeof pendingEvent>) =>
      store.commitRunnerEvent({
        environmentId: fixture.environmentId,
        event,
        runnerBootId,
        runnerId: fixture.runnerId,
      });
    await commit(
      pendingEvent({ ...base, data: { status: "running" }, ordinal: 0, type: "run.started" }),
    );
    const messageId = createId("message");
    const answer = pendingEvent({
      ...base,
      data: { content: [{ text: "Here it is: \ud83d", type: "text" }], messageId },
      ordinal: 1,
      type: "assistant.message",
    });

    const committed = await commit(answer);
    const replayed = await commit(answer);

    expect(committed.wasDuplicate).toBe(false);
    expect(replayed.wasDuplicate).toBe(true);
    const message = await database
      .selectFrom("messages")
      .select("content")
      .where("id", "=", messageId)
      .executeTakeFirstOrThrow();
    expect(message.content).toEqual([{ text: "Here it is: �", type: "text" }]);
  });

  /*
   * Runner payload failure modes at the real jsonb boundary:
   * - a fitted shell command exceeds the event or database byte budget;
   * - jsonb formatting or replay changes the recorded arguments;
   * - fitting bulk rows loses the integration reference or Host subject;
   * - NUL passes JSON validation but fails the insert, or its message projection
   *   or replay uses the raw text instead of the durable replacement.
   */
  describe("bounded Runner event persistence", () => {
    async function runningFixture(storeFixture: StoreFixture, suffix: string) {
      const { createRunFixture, enqueueHumanTrigger, store } = storeFixture;
      const fixture = await createRunFixture(suffix);
      const work = await enqueueHumanTrigger({
        content: [{ text: "Record the provider's tool call", type: "text" }],
        idempotencyKey: `${suffix}-input`,
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      });
      await store.claimCommand(work.command.id, `${suffix}-dispatcher`);
      const runnerBootId = `boot-${suffix}`;
      const binding = await store.acquireExecutionBinding({
        bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
        continuationIdentity: testContinuationIdentity,
        harnessInstanceId: fixture.harnessInstance.id,
        leaseTokenHash: `${suffix}-lease`,
        membershipGeneration: 1,
        runnerBootId,
        runnerId: fixture.runnerId,
        runId: work.run.id,
        threadId: fixture.thread.id,
      });
      const base = {
        bindingGeneration: binding.bindingGeneration,
        environmentId: fixture.environmentId,
        runId: work.run.id,
        threadId: fixture.thread.id,
        workspaceId: fixture.workspace.id,
      };
      const commit = (
        event: PendingAgentEvent,
        integration?: Parameters<OpensteerStore["commitRunnerEvent"]>[0]["integration"],
      ) =>
        store.commitRunnerEvent({
          environmentId: fixture.environmentId,
          event,
          ...(integration ? { integration } : {}),
          runnerBootId,
          runnerId: fixture.runnerId,
        });
      await commit(
        pendingEvent({ ...base, data: { status: "running" }, ordinal: 0, type: "run.started" }),
      );
      return { base, commit };
    }

    async function storedEvent(storeFixture: StoreFixture, event: AgentEvent) {
      const { database } = storeFixture;
      const row = await database
        .selectFrom("workspaceEvents")
        .selectAll()
        .select(sql<number>`octet_length(data::text)`.as("dataBytes"))
        .where("eventId", "=", event.eventId)
        .executeTakeFirstOrThrow();
      expect(row.dataBytes).toBeLessThanOrEqual(507_904);
      const parsed = AgentEventSchema.parse({
        ...row,
        createdAt: row.createdAt.toISOString(),
      });
      expect(parsed).toEqual(event);
      return row;
    }

    it("commits and exactly replays a fitted 600 KiB Codex inline shell command", async ({
      storeFixture,
    }) => {
      const { database } = storeFixture;
      const { base, commit } = await runningFixture(storeFixture, "bounded-shell-arguments");
      const script = Buffer.from(
        `import base64\npayload = '${"x".repeat(460_800)}'\nprint(len(payload))\n`,
      ).toString("base64");
      const raw = {
        command: `/bin/zsh -lc 'python3 - <<"PY"\nimport base64\nexec(base64.b64decode("${script}"))\nPY'`,
        commandActions: [{ type: "unknown" }],
        cwd: "/workspace/opensteer",
      };
      expect(Buffer.byteLength(JSON.stringify(raw))).toBeGreaterThan(600 * 1_024);
      const args = createToolArguments(raw);
      expect(Buffer.byteLength(JSON.stringify(args))).toBeLessThanOrEqual(
        toolArgumentsMaxSerializedBytes,
      );
      const fitted = z
        .object({
          command: z.string(),
          commandActions: z.array(z.object({ type: z.string() })),
          cwd: z.string(),
        })
        .parse(args);
      expect(fitted.command).toMatch(/\n… \d+ bytes omitted …\n/u);
      expect(fitted.command.startsWith(raw.command.slice(0, 100))).toBe(true);
      expect(fitted.command.endsWith(raw.command.slice(-100))).toBe(true);
      expect(fitted.cwd).toBe(raw.cwd);
      expect(fitted.commandActions).toEqual(raw.commandActions);
      const event = pendingEvent({
        ...base,
        data: {
          arguments: args,
          callId: "call-inline-python",
          tool: { name: "exec_command", namespace: "functions" },
        },
        ordinal: 1,
        type: "tool.started",
      });
      const committed = await commit(event);
      expect(committed.wasDuplicate).toBe(false);
      expect((await storedEvent(storeFixture, committed.event)).data).toEqual(event.data);
      const replayed = await commit(event);
      expect(replayed.wasDuplicate).toBe(true);
      expect(replayed.event).toEqual(committed.event);
      expect(
        await database
          .selectFrom("workspaceEvents")
          .select(sql<number>`count(*)::int`.as("count"))
          .where("runId", "=", base.runId)
          .where("runnerOrdinal", "=", 1)
          .executeTakeFirstOrThrow(),
      ).toEqual({ count: 1 });
    });

    it("keeps a bulk integration call's toolRef and persists the Host-resolved subject", async ({
      storeFixture,
    }) => {
      const { base, commit } = await runningFixture(storeFixture, "bounded-integration-arguments");
      const toolRef = `igr_5b0c4c3e-1f7a-4a8e-9a53-6c1e2d3f4a5b.itl_9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a.${"a".repeat(43)}`;
      const args = createToolArguments({
        arguments: {
          values: Array.from({ length: 5_000 }, (_, index) => [index, `row-${index}`, "ready"]),
        },
        toolRef,
      });
      expect(Buffer.byteLength(JSON.stringify(args))).toBeLessThanOrEqual(
        toolArgumentsMaxSerializedBytes,
      );
      const fitted = z.object({ arguments: z.string(), toolRef: z.string() }).parse(args);
      expect(fitted.arguments).toMatch(/\n… \d+ bytes omitted …\n/u);
      expect(fitted.toolRef).toBe(toolRef);
      const subject = {
        account: "Work",
        computerApp: null,
        effect: "write" as const,
        integration: "Sheets",
        operation: { name: "append_rows", title: "Append rows" },
      };
      const event = pendingEvent({
        ...base,
        data: {
          arguments: args,
          callId: "call-bulk-rows",
          tool: { name: "integration_call", namespace: "opensteer.integrations" },
        },
        ordinal: 1,
        type: "tool.started",
      });
      const committed = await commit(event, subject);
      expect(committed.wasDuplicate).toBe(false);
      expect((await storedEvent(storeFixture, committed.event)).data).toEqual({
        ...event.data,
        integration: subject,
      });
      const replayed = await commit(event);
      expect(replayed.wasDuplicate).toBe(true);
      expect(replayed.event).toEqual(committed.event);
    });

    it.for(["tool.started", "assistant.message"] as const)(
      "commits and replays %s containing NUL as U+FFFD",
      async (type, { storeFixture }) => {
        const { database } = storeFixture;
        const { base, commit } = await runningFixture(
          storeFixture,
          `nul-${type.replaceAll(".", "-")}`,
        );
        const messageId = createId("message");
        const event =
          type === "tool.started"
            ? pendingEvent({
                ...base,
                data: {
                  arguments: createToolArguments({ command: "a\u0000b" }),
                  callId: "call-nul",
                  tool: { name: "exec_command", namespace: "functions" },
                },
                ordinal: 1,
                type,
              })
            : pendingEvent({
                ...base,
                data: { content: [{ text: "a\u0000b", type: "text" }], messageId },
                ordinal: 1,
                type,
              });
        const committed = await commit(event);
        const replacement = createToolOutput("a\u0000b").text;
        expect(replacement).toBe("a\uFFFDb");
        expect((await storedEvent(storeFixture, committed.event)).data).toEqual(
          type === "tool.started"
            ? { ...event.data, arguments: { command: replacement } }
            : { ...event.data, content: [{ text: replacement, type: "text" }] },
        );
        if (type === "assistant.message") {
          expect(
            await database
              .selectFrom("messages")
              .select("content")
              .where("id", "=", messageId)
              .executeTakeFirstOrThrow(),
          ).toEqual({ content: [{ text: replacement, type: "text" }] });
        }
        const replayed = await commit(event);
        expect(replayed.wasDuplicate).toBe(true);
        expect(replayed.event).toEqual(committed.event);
      },
    );
  });

  it("stores the Host's subject of an integration call, and keeps a replay a replay", async ({
    storeFixture,
  }) => {
    const { createRunFixture, store, database } = storeFixture;
    const fixture = await createRunFixture("integration-call-subject");
    const work = await store.enqueueThreadInput({
      content: [{ text: "Open the Opensteer workspace in Slack", type: "text" }],
      idempotencyKey: "integration-call-subject-input",
      policy: "queue",
      requestedBy: fixture.userId,
      source: { kind: "human" },
      threadId: fixture.thread.id,
    });
    if (!work.command || !work.run) throw new Error("Expected a Run");
    await store.claimCommand(work.command.id, "integration-call-subject-dispatcher");
    const runnerBootId = "boot-integration-call-subject";
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: fixture.harnessInstance.id,
      leaseTokenHash: "integration-call-subject-lease",
      membershipGeneration: 1,
      runnerBootId,
      runnerId: fixture.runnerId,
      runId: work.run.id,
      threadId: fixture.thread.id,
    });
    const base = {
      bindingGeneration: binding.bindingGeneration,
      environmentId: fixture.environmentId,
      runId: work.run.id,
      threadId: fixture.thread.id,
      workspaceId: fixture.workspace.id,
    };
    await store.commitRunnerEvent({
      environmentId: fixture.environmentId,
      event: pendingEvent({
        ...base,
        data: { status: "running" },
        ordinal: 0,
        type: "run.started",
      }),
      runnerBootId,
      runnerId: fixture.runnerId,
    });
    const subject = {
      account: "Slack on Alex's Mac",
      computerApp: {
        app: "Slack",
        bundleId: "com.tinyspeck.slackmacgap",
        computer: "Alex's MacBook Pro",
        runnerId: fixture.runnerId,
      },
      effect: "write" as const,
      integration: "Computer use",
      operation: { name: "act", title: "Act" },
    };
    const reported = {
      arguments: { arguments: { actions: [] }, toolRef: "igr_x.itl_y.digest" },
      callId: "call-act",
      tool: { name: "integration_call", namespace: "opensteer.integrations" },
    };
    // A Runner cannot name the subject itself; its copy is dropped at the
    // boundary and the Host's stands.
    const forged = {
      ...subject,
      account: "Someone else's account",
      computerApp: null,
    };
    const started = pendingEvent({
      ...base,
      data: { ...reported, integration: forged } as never,
      ordinal: 1,
      type: "tool.started",
    });
    const commit = (integration?: typeof subject) =>
      store.commitRunnerEvent({
        environmentId: fixture.environmentId,
        event: started,
        ...(integration ? { integration } : {}),
        runnerBootId,
        runnerId: fixture.runnerId,
      });

    const committed = await commit(subject);

    expect(committed.wasDuplicate).toBe(false);
    expect(committed.event.data).toEqual({ ...reported, integration: subject });
    await expect(
      database
        .selectFrom("workspaceEvents")
        .select("data")
        .where("eventId", "=", committed.event.eventId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ data: { ...reported, integration: subject } });

    // The same Runner payload again is a replay whatever the Host resolves
    // this time — a subject that is gone, or one that has changed — and it
    // answers with the event as it was first recorded.
    for (const replayed of [await commit(), await commit({ ...subject, account: "Renamed" })]) {
      expect(replayed.wasDuplicate).toBe(true);
      expect(replayed.event).toEqual(committed.event);
    }
    await expect(
      store.commitRunnerEvent({
        environmentId: fixture.environmentId,
        // The same ordinal and moment, with different content.
        event: { ...started, data: { ...reported, callId: "call-other" } } as PendingAgentEvent,
        integration: subject,
        runnerBootId,
        runnerId: fixture.runnerId,
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    // Without a subject the Runner's copy is still not stored.
    const unnamed = await store.commitRunnerEvent({
      environmentId: fixture.environmentId,
      event: pendingEvent({
        ...base,
        data: { ...reported, callId: "call-unnamed", integration: forged } as never,
        ordinal: 2,
        type: "tool.started",
      }),
      runnerBootId,
      runnerId: fixture.runnerId,
    });
    expect(unnamed.event.data).toEqual({ ...reported, callId: "call-unnamed" });

    await expect(
      store.commitRunnerEvent({
        environmentId: fixture.environmentId,
        event: pendingEvent({
          ...base,
          data: { callId: "call-unnamed", isError: false, output: { text: "done" } },
          ordinal: 3,
          type: "tool.completed",
        }),
        integration: subject,
        runnerBootId,
        runnerId: fixture.runnerId,
      }),
    ).rejects.toThrow("Only a tool.started event names an integration call's subject");
  });

  it("names a Run's requester only for its own Thread and Workspace", async ({ storeFixture }) => {
    const { createRunFixture, store } = storeFixture;
    const fixture = await createRunFixture("run-requester");
    const work = await store.enqueueThreadInput({
      content: [{ text: "Whose is this?", type: "text" }],
      idempotencyKey: "run-requester-input",
      policy: "queue",
      requestedBy: fixture.userId,
      source: { kind: "human" },
      threadId: fixture.thread.id,
    });
    if (!work.run) throw new Error("Expected a Run");
    const scope = {
      runId: work.run.id,
      threadId: fixture.thread.id,
      workspaceId: fixture.workspace.id,
    };

    await expect(store.runRequester(scope)).resolves.toBe(fixture.userId);
    await expect(
      store.runRequester({ ...scope, workspaceId: createId("workspace") }),
    ).resolves.toBeNull();
    await expect(
      store.runRequester({ ...scope, threadId: createId("thread") }),
    ).resolves.toBeNull();
    await expect(store.runRequester({ ...scope, runId: createId("run") })).resolves.toBeNull();
  });

  it("claims one fixed FIFO batch and preserves typed Host-authored attribution", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, database, store } = storeFixture;
    const fixture = await createRunFixture("thread-input-batch");
    const source = await enqueueHumanTrigger({
      content: [{ text: "Coordinate the batch", type: "text" }],
      idempotencyKey: "thread-input-batch-source",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    await database
      .updateTable("runs")
      .set({ status: "running" })
      .where("id", "=", source.run.id)
      .executeTakeFirstOrThrow();
    const { thread: target } = await store.createThread({
      createdBy: fixture.userId,
      environmentId: fixture.environmentId,
      harnessInstanceId: fixture.harnessInstance.id,
      idempotencyKey: "thread-input-batch-target",
      modelSelection: testModelSelection,
      title: "Batch target",
      workspaceId: fixture.workspace.id,
    });
    const agentInput = (
      idempotencyKey: string,
      text: string,
      policy: "report" | "queue" | "steer",
    ) =>
      store.enqueueThreadInput({
        content: [{ text, type: "text" }],
        idempotencyKey,
        policy,
        requestedBy: fixture.userId,
        source: { kind: "agent", runId: source.run.id },
        threadId: target.id,
      });
    const first = await agentInput("thread-input-batch-1", "FIRST", "report");
    const second = await agentInput("thread-input-batch-2", "SECOND", "report");
    const wake = await agentInput("thread-input-batch-3", "THIRD", "queue");
    const incompatible = await store.enqueueThreadInput({
      content: [{ text: "FOURTH", type: "text" }],
      idempotencyKey: "thread-input-batch-4",
      policy: "queue",
      requestedBy: fixture.userId,
      source: { kind: "human" },
      threadId: target.id,
    });

    expect(first.disposition).toBe("pending");
    expect(second.disposition).toBe("pending");
    expect(wake).toMatchObject({
      command: { type: "run.execute" },
      disposition: "run-queued",
      run: { seedInputId: wake.message.id },
    });
    expect(incompatible).toMatchObject({
      command: null,
      disposition: "pending",
      run: null,
    });
    if (!wake.command) throw new Error("Expected batch dispatch Command");

    await store.claimCommand(wake.command.id, "thread-input-batch-dispatcher");
    const context = await store.loadRunDispatchContext(wake.command.id);
    expect(context.inputs.map(({ id }) => id)).toEqual([wake.message.id]);
    expect(context.reports.messages.map(({ id }) => id)).toEqual([
      first.message.id,
      second.message.id,
    ]);
    expect(
      context.reports.messages.map(({ author }) => ({
        kind: author.kind,
        runId: author.kind === "agent" ? author.runId : null,
      })),
    ).toEqual([
      { kind: "agent", runId: source.run.id },
      { kind: "agent", runId: source.run.id },
    ]);
    await expect(
      database
        .selectFrom("threadInputs")
        .select(["runId", "state"])
        .where("messageId", "=", incompatible.message.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ runId: null, state: "pending" });
  });

  it("leaves queued inputs pending while active work continues", async ({ storeFixture }) => {
    const { startRunFixture, store, database } = storeFixture;
    const started = await startRunFixture("thread-input-steer-fifo");
    const collaboratorId = await store.createUser("Earlier collaborator");
    await database
      .insertInto("workspaceMemberships")
      .values({
        generation: 1,
        id: createId("workspaceMembership"),
        invitedBy: started.userId,
        joinedAt: new Date(),
        revokedAt: null,
        revokedBy: null,
        role: "collaborator",
        state: "active",
        updatedAt: new Date(),
        userId: collaboratorId,
        workspaceId: started.workspace.id,
      })
      .executeTakeFirstOrThrow();
    const earlier = await store.enqueueThreadInput({
      content: [{ text: "Earlier collaborator input", type: "text" }],
      idempotencyKey: "thread-input-steer-fifo-earlier",
      policy: "report",
      requestedBy: collaboratorId,
      source: { kind: "human" },
      threadId: started.thread.id,
    });
    expect(earlier).toMatchObject({ command: null, disposition: "pending" });

    const later = await store.enqueueThreadInput({
      content: [{ text: "Later owner input", type: "text" }],
      idempotencyKey: "thread-input-steer-fifo-later",
      policy: "queue",
      requestedBy: started.userId,
      source: { kind: "human" },
      threadId: started.thread.id,
    });
    expect(later).toMatchObject({
      command: null,
      disposition: "pending",
      input: { runId: null, state: "pending" },
      message: { runId: null },
    });

    const wake = await store.enqueueThreadInput({
      content: [{ text: "Wake the oldest authority", type: "text" }],
      idempotencyKey: "thread-input-steer-fifo-wake",
      policy: "queue",
      requestedBy: started.userId,
      source: { kind: "human" },
      threadId: started.thread.id,
    });
    expect(wake).toMatchObject({
      command: null,
      disposition: "pending",
      run: null,
    });
  });

  it("retries run.execute with the same already-claimed fixed batch", async ({ storeFixture }) => {
    const { createRunFixture, enqueueHumanTrigger, database, store } = storeFixture;
    const fixture = await createRunFixture("thread-input-fixed-batch-retry");
    const source = await enqueueHumanTrigger({
      content: [{ text: "Create a shared input chain", type: "text" }],
      idempotencyKey: "thread-input-fixed-batch-retry-source",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    await database
      .updateTable("runs")
      .set({ status: "running" })
      .where("id", "=", source.run.id)
      .executeTakeFirstOrThrow();
    const { thread: target } = await store.createThread({
      createdBy: fixture.userId,
      environmentId: fixture.environmentId,
      harnessInstanceId: fixture.harnessInstance.id,
      idempotencyKey: "thread-input-fixed-batch-retry-target",
      modelSelection: testModelSelection,
      title: "Fixed batch retry target",
      workspaceId: fixture.workspace.id,
    });
    const first = await store.enqueueThreadInput({
      content: [{ text: "First fixed input", type: "text" }],
      idempotencyKey: "thread-input-fixed-batch-retry-first",
      policy: "report",
      requestedBy: fixture.userId,
      source: { kind: "agent", runId: source.run.id },
      threadId: target.id,
    });
    const wake = await store.enqueueThreadInput({
      content: [{ text: "Second fixed input", type: "text" }],
      idempotencyKey: "thread-input-fixed-batch-retry-wake",
      policy: "queue",
      requestedBy: fixture.userId,
      source: { kind: "agent", runId: source.run.id },
      threadId: target.id,
    });
    if (!wake.command) throw new Error("Expected fixed batch Run command");
    await store.claimCommand(wake.command.id, "fixed-batch-first-dispatcher");
    const firstContext = await store.loadRunDispatchContext(wake.command.id);
    expect(firstContext.inputs.map(({ id }) => id)).toEqual([wake.message.id]);
    expect(firstContext.reports.messages.map(({ id }) => id)).toEqual([first.message.id]);

    await store.retryCommand(wake.command.id, new Error("Runner unavailable before dispatch"));
    await store.claimCommand(wake.command.id, "fixed-batch-second-dispatcher");
    const retriedContext = await store.loadRunDispatchContext(wake.command.id);
    expect(retriedContext.inputs.map(({ id }) => id)).toEqual(
      firstContext.inputs.map(({ id }) => id),
    );
  });

  it("delivers a steer only after the Runner acknowledges its exact Message", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, database } = storeFixture;
    const started = await startRunFixture("thread-steer-delivered");
    const steered = await store.enqueueThreadInput({
      content: [{ text: "Use the updated constraint", type: "text" }],
      idempotencyKey: "thread-steer-delivered",
      policy: "steer",
      requestedBy: started.userId,
      source: { kind: "human" },
      threadId: started.thread.id,
    });

    expect(steered).toMatchObject({
      command: { runId: started.run.id, type: "run.steer" },
      disposition: "steering",
      input: { runId: started.run.id, state: "claimed" },
      message: { runId: started.run.id },
      run: { id: started.run.id },
    });
    expect(steered.input.causalChainId).toBe(started.run.causalChainId);
    await expect(
      database
        .selectFrom("causalChains")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("rootMessageId", "=", steered.message.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: "0" });
    if (!steered.command) throw new Error("Expected steer Command");
    await store.claimCommand(steered.command.id, "thread-steer-delivered-dispatcher");
    const delivered = await store.commitRunnerEvent({
      environmentId: started.environmentId,
      event: pendingEvent({
        bindingGeneration: started.bindingGeneration,
        data: { messageId: steered.message.id },
        environmentId: started.environmentId,
        ordinal: 1,
        runId: started.run.id,
        threadId: started.thread.id,
        type: "message.injected",
        workspaceId: started.workspace.id,
      }),
      runnerBootId: started.runnerBootId,
      runnerId: started.runnerId,
    });

    expect(delivered.compensatingEvents.map(({ type }) => type)).toEqual(["thread-input.updated"]);
    await expect(
      store.markSteerUnknown(steered.command.id, "Late ambiguous transport result"),
    ).resolves.toEqual([]);
    await expect(
      database
        .selectFrom("threadInputs")
        .select(["deliveredAt", "runId", "state"])
        .where("messageId", "=", steered.message.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ runId: started.run.id, state: "delivered" });
    await expect(
      database
        .selectFrom("commands")
        .select("status")
        .where("id", "=", steered.command.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "succeeded" });
  });

  it("terminally cancels a proven-refused strict steer", async ({ storeFixture }) => {
    const { startRunFixture, database, store } = storeFixture;
    const refusedRun = await startRunFixture("thread-steer-refused");
    await database
      .updateTable("causalChains")
      .set({ usedAutonomousRuns: sql`max_autonomous_runs` })
      .where("id", "=", refusedRun.run.causalChainId)
      .executeTakeFirstOrThrow();
    const refused = await store.enqueueThreadInput({
      content: [{ text: "Retry this after refusal", type: "text" }],
      idempotencyKey: "thread-steer-refused",
      policy: "steer",
      requestedBy: refusedRun.userId,
      source: { kind: "human" },
      threadId: refusedRun.thread.id,
    });
    if (!refused.command) throw new Error("Expected refused steer Command");
    expect(refused.input.causalChainId).toBe(refusedRun.run.causalChainId);
    const refusedEvents = await store.refuseSteer(refused.command.id, "Harness refused steer");
    expect(refusedEvents.map(({ type }) => type)).toEqual(["thread-input.updated"]);
    const refusedInput = await database
      .selectFrom("threadInputs")
      .select(["causalChainId", "runId", "state", "steerCommandId"])
      .where("messageId", "=", refused.message.id)
      .executeTakeFirstOrThrow();
    expect(refusedInput).toMatchObject({
      runId: refusedRun.run.id,
      state: "cancelled",
      steerCommandId: refused.command.id,
    });
    expect(refusedInput.causalChainId).toBe(refusedRun.run.causalChainId);
    expect(
      await database
        .selectFrom("runs")
        .select(["runOrdinal", "status"])
        .where("threadId", "=", refusedRun.thread.id)
        .where("status", "in", ["running", "queued"])
        .orderBy("runOrdinal")
        .execute(),
    ).toEqual([{ runOrdinal: 0, status: "running" }]);
    await store.commitRunnerEvent({
      environmentId: refusedRun.environmentId,
      event: pendingEvent({
        bindingGeneration: refusedRun.bindingGeneration,
        data: { status: "completed" },
        environmentId: refusedRun.environmentId,
        ordinal: 1,
        runId: refusedRun.run.id,
        threadId: refusedRun.thread.id,
        type: "run.completed",
        workspaceId: refusedRun.workspace.id,
      }),
      runnerBootId: refusedRun.runnerBootId,
      runnerId: refusedRun.runnerId,
    });
    await expect(
      database
        .selectFrom("threadInputs")
        .select(["cancelReason", "state"])
        .where("messageId", "=", refused.message.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ cancelReason: "steer-refused", state: "cancelled" });
  });

  it("keeps an ambiguous steer attached without retrying it", async ({ storeFixture }) => {
    const { startRunFixture, store, database } = storeFixture;
    const unknownRun = await startRunFixture("thread-steer-unknown");
    const unknown = await store.enqueueThreadInput({
      content: [{ text: "Delivery could not be confirmed", type: "text" }],
      idempotencyKey: "thread-steer-unknown",
      policy: "steer",
      requestedBy: unknownRun.userId,
      source: { kind: "human" },
      threadId: unknownRun.thread.id,
    });
    if (!unknown.command) throw new Error("Expected unknown steer Command");
    await store.claimCommand(unknown.command.id, "thread-steer-unknown-dispatcher");
    const unknownEvents = await store.markSteerUnknown(
      unknown.command.id,
      "Runner disconnected after dispatch",
    );
    expect(unknownEvents.map(({ type }) => type)).toEqual(["thread-input.updated"]);
    await expect(
      database
        .selectFrom("threadInputs")
        .select(["runId", "state", "steerCommandId"])
        .where("messageId", "=", unknown.message.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      runId: unknownRun.run.id,
      state: "unknown",
      steerCommandId: unknown.command.id,
    });

    const lateProof = await store.commitRunnerEvent({
      environmentId: unknownRun.environmentId,
      event: pendingEvent({
        bindingGeneration: unknownRun.bindingGeneration,
        data: { messageId: unknown.message.id },
        environmentId: unknownRun.environmentId,
        ordinal: 1,
        runId: unknownRun.run.id,
        threadId: unknownRun.thread.id,
        type: "message.injected",
        workspaceId: unknownRun.workspace.id,
      }),
      runnerBootId: unknownRun.runnerBootId,
      runnerId: unknownRun.runnerId,
    });
    expect(lateProof.compensatingEvents.map(({ type }) => type)).toEqual(["thread-input.updated"]);
    await expect(
      database
        .selectFrom("threadInputs")
        .select(["state", "deliveredAt"])
        .where("messageId", "=", unknown.message.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ state: "delivered" });
    await expect(
      database
        .selectFrom("commands")
        .select("status")
        .where("id", "=", unknown.command.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "succeeded" });
  });
});
