import { randomUUID } from "node:crypto";
import { ProjectRunBindingSchema, HumanRootSchema, createId } from "@opensteer/core";
import { HarnessInstanceCatalogSchema } from "@opensteer/protocol";
import { sql } from "kysely";
import { expect } from "vitest";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { pauseAfterLock } from "./lock-race.test-support.js";
import type { DatabaseSchema } from "./schema.js";
import type { Kysely } from "kysely";
import { TriggerStore } from "./trigger-store.js";
import { describeStore, type StoreFixture } from "./store.integration.test-support.js";
import { jsonValue } from "./store-primitives.js";
import { setProjectRuntimeSettings } from "./project-runtime-settings-store.js";
import {
  createProjectIdentityFixture,
  insertProjectRunFixture,
} from "./project-work.test-support.js";
import { testModelSelection, testReadyHarnessCatalog } from "./store.integration.test-support.js";
import { ensureProjectPrincipal, ProjectWorkStore } from "./project-work-store.js";

describeStore("Project principal lookup", (it) => {
  it("converges concurrent admission lookups and retains the principal after deletion", async ({
    storeFixture,
  }) => {
    const database = storeFixture.database;
    const userId = await storeFixture.store.createUser("Project creator");
    const workspaceId = createId("workspace");
    const environmentId = createId("environment");
    await database
      .insertInto("deployments")
      .values({
        id: createId("deployment"),
        singletonKey: "primary",
        activeHostInstanceId: createId("hostInstance"),
        authorityModelVersion: 2,
        canonicalOrigin: "https://project.test.invalid",
        lifecycle: "active",
        deploymentShape: { kind: "server", defaultWorkspaceBacking: "local-directory" },
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .execute();
    await database.transaction().execute(async (transaction) => {
      await sql`insert into execution_environments (id, name, kind, capabilities)
        values (${environmentId}, 'Project computer', 'main', '[]'::jsonb)`.execute(transaction);
      await sql`insert into workspaces (id, kind, name, created_by, color, backing)
        values (${workspaceId}, 'project', 'Team Project', ${userId}, 'blue', ${JSON.stringify({
          kind: "local-directory",
          ownerEnvironmentId: environmentId,
          bindingId: createId("workspaceBinding"),
          storageAuthorityId: null,
          generation: 1,
        })}::jsonb)`.execute(transaction);
      await sql`insert into workspace_memberships (id, workspace_id, user_id, role, state)
        values (${createId("workspaceMembership")}, ${workspaceId}, ${userId}, 'owner', 'active')`.execute(
        transaction,
      );
    });
    const inserted = pauseAfterLock(
      database,
      (node) => node.includes('"InsertQueryNode"') && node.includes('"principals"'),
    );
    const observed = pauseAfterLock(
      database,
      (node) => node.includes('"SelectQueryNode"') && node.includes('"principals"'),
    );
    const lookup = (connection: Kysely<DatabaseSchema>) =>
      connection.transaction().execute(async (transaction) => {
        await transaction
          .selectFrom("workspaces")
          .select("id")
          .where("id", "=", workspaceId)
          .forShare()
          .executeTakeFirstOrThrow();
        return ensureProjectPrincipal(transaction, workspaceId);
      });
    const first = lookup(inserted.database);
    void first.catch(() => undefined);
    let second: ReturnType<typeof lookup> | undefined;
    let ids: Awaited<ReturnType<typeof lookup>>[];
    try {
      await withTimeout(inserted.reached, 3000, {
        timeoutError: () => new Error("First principal insert never reached its barrier"),
      });
      second = lookup(observed.database);
      void second.catch(() => undefined);
      await withTimeout(observed.reached, 3000, {
        timeoutError: () =>
          new Error("Concurrent principal lookup never read the absent uncommitted row"),
      });
      observed.release();
      inserted.release();
      ids = await withTimeout(Promise.all([first, second]), 3000, {
        timeoutError: () => new Error("Concurrent principal lookups did not settle"),
      });
    } finally {
      observed.release();
      inserted.release();
      await withTimeout(Promise.allSettled([first, second]), 3000, {
        timeoutError: () => new Error("Principal lookup cleanup did not settle"),
      });
    }
    expect(new Set(ids).size).toBe(1);
    const rows = await database
      .selectFrom("principals")
      .selectAll()
      .where("workspaceId", "=", workspaceId)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: ids[0], kind: "project", userId: null });
    expect(
      await database
        .transaction()
        .execute((transaction) => ensureProjectPrincipal(transaction, workspaceId)),
    ).toBe(ids[0]);
    await database
      .updateTable("workspaces")
      .set({ status: "deleted", deletedAt: new Date() })
      .where("id", "=", workspaceId)
      .execute();
    await expect(
      database
        .transaction()
        .execute((transaction) => ensureProjectPrincipal(transaction, workspaceId)),
    ).rejects.toMatchObject({ code: "workspace_unavailable" });
    expect(
      await database
        .selectFrom("principals")
        .select("id")
        .where("workspaceId", "=", workspaceId)
        .execute(),
    ).toEqual([{ id: ids[0] }]);
  });
});

async function prepareProjectAdmission(storeFixture: StoreFixture, running = false) {
  const project = await createProjectIdentityFixture(storeFixture, "admission");
  const prepared = await insertProjectRunFixture(
    storeFixture,
    project,
    "existing-thread",
    project.userId,
    running ? "running" : "queued",
  );
  const database = storeFixture.database;
  if (!running) {
    await database.deleteFrom("commands").where("runId", "=", prepared.run.id).execute();
    await database.deleteFrom("runs").where("id", "=", prepared.run.id).execute();
  }
  await database
    .updateTable("threads")
    .set({ nextMessageSequence: "1", nextRunOrdinal: 1 })
    .where("id", "=", prepared.thread.id)
    .execute();
  await database
    .insertInto("harnessCatalogs")
    .values({
      environmentId: project.environmentId,
      harnessInstanceId: prepared.harnessInstance.id,
      catalog: jsonValue(
        HarnessInstanceCatalogSchema.parse({
          ...testReadyHarnessCatalog(prepared.harnessInstance.id),
          models: [
            {
              displayName: "Project model",
              isDefault: true,
              providerId: testModelSelection.providerId,
              modelId: testModelSelection.modelId,
              options: [
                {
                  id: "effort",
                  label: "Effort",
                  type: "select",
                  values: [{ value: "low", label: "Low" }],
                },
              ],
            },
          ],
          driverKind: "codex",
          continuationIdentity: {
            continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
            driverKind: "codex",
          },
        }),
      ),
      capturedAt: new Date(),
    })
    .execute();
  await setProjectRuntimeSettings(
    database,
    { userId: project.userId, authorityGeneration: 1 },
    {
      workspaceId: project.workspace.id,
      expectedAccessRevision: 1,
      expectedSettingsRevision: null,
      commandIdentity: createId("command"),
      harnessInstanceId: prepared.harnessInstance.id,
      modelSelection: testModelSelection,
      accessMode: "full-access",
      instructions: "Project only",
      timeZone: "UTC",
    },
  );
  const origin = HumanRootSchema.parse({
    userId: project.userId,
    initiatorGeneration: 1,
    membershipGeneration: 1,
    originConnectionId: null,
  });
  const store = new ProjectWorkStore(database, { runnerIsConnected: () => true });
  return { project, prepared, database, origin, store };
}

describeStore("Project work admission", (it) => {
  it("queues as the Project, freezes settings and replays without borrowing the root's preferences", async ({
    storeFixture,
  }) => {
    const { project, prepared, database, origin, store } =
      await prepareProjectAdmission(storeFixture);
    const input = {
      threadId: prepared.thread.id,
      origin,
      source: { kind: "human" as const },
      content: [{ type: "text" as const, text: "do work" }],
      policy: "queue" as const,
      idempotencyKey: "one",
    };
    const first = await store.admitProjectWork(input);
    const replay = await store.admitProjectWork(input);
    expect(first.runId).not.toBeNull();
    expect(replay).toMatchObject({
      runId: first.runId,
      commandId: first.commandId,
      wasDuplicate: true,
      events: [],
    });
    expect(first.events.map((event) => event.type)).toContain("run.queued");
    const run = await database
      .selectFrom("runs")
      .selectAll()
      .where("id", "=", first.runId)
      .executeTakeFirstOrThrow();
    expect(run).toMatchObject({
      actorPrincipalId: project.principalId,
      requestedBy: project.userId,
      initiatorGeneration: "1",
      membershipGeneration: "1",
      authoritySource: {
        projectRuntime: { instructions: "Project only", timeZone: "UTC", settingsRevision: 1 },
      },
    });
    await expect(
      store.admitProjectWork({ ...input, content: [{ type: "text", text: "different" }] }),
    ).rejects.toMatchObject({ reason: "idempotency-conflict" });
    await database
      .updateTable("users")
      .set({ authorityGeneration: "2" })
      .where("id", "=", project.userId)
      .execute();
    await expect(
      store.admitProjectWork({ ...input, idempotencyKey: "stale" }),
    ).rejects.toMatchObject({ reason: "captured-root-unavailable" });
  });
  it("creates a same-Project child with root attribution and Project authority, retaining the exact source and assignment", async ({
    storeFixture,
  }) => {
    const { project, prepared, database, origin, store } = await prepareProjectAdmission(
      storeFixture,
      true,
    );
    const grant = await database
      .selectFrom("grants")
      .selectAll()
      .where("runId", "=", prepared.run.id)
      .executeTakeFirstOrThrow();
    const binding = ProjectRunBindingSchema.parse({
      authority: {
        version: 1,
        principal: {
          kind: "project",
          principalId: project.principalId,
          workspaceId: project.workspace.id,
        },
        origin,
      },
      runId: prepared.run.id,
      threadId: prepared.thread.id,
      workspaceId: project.workspace.id,
      environmentId: project.environmentId,
      grantId: grant.id,
      bindingGeneration: grant.bindingGeneration,
      runnerId: grant.runnerId,
      runnerBootId: grant.runnerBootId,
    });
    const input = {
      binding,
      title: "Child",
      content: [{ type: "text" as const, text: "child task" }],
      idempotencyKey: randomUUID(),
    };
    const child = await store.delegateProjectWork(input);
    const replay = await store.delegateProjectWork(input);
    expect(replay).toMatchObject({
      threadId: child.threadId,
      assignmentId: child.assignmentId,
      runId: child.runId,
      wasDuplicate: true,
      events: [],
    });
    expect(
      await database
        .selectFrom("threads")
        .selectAll()
        .where("id", "=", child.threadId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      createdBy: origin.userId,
      createdByPrincipalId: project.principalId,
      workspaceId: project.workspace.id,
      parentThreadId: prepared.thread.id,
    });
    expect(
      await database
        .selectFrom("runs")
        .selectAll()
        .where("id", "=", child.runId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      requestedBy: origin.userId,
      actorPrincipalId: project.principalId,
      initiatorGeneration: "1",
      membershipGeneration: "1",
      originConnectionId: null,
      assignmentId: child.assignmentId,
      causalChainId: prepared.run.causalChainId,
      authoritySource: {
        kind: "workspace-membership",
        userId: origin.userId,
        parentRunId: prepared.run.id,
      },
    });
    expect(child.events.map((event) => event.type)).toContain("assignment.created");
  });

  it("keeps unattended observations separate, refuses stale source generations and refuses creatorless children before writing", async ({
    storeFixture,
  }) => {
    const { project, prepared, database, store } = await prepareProjectAdmission(storeFixture);
    const created = await new TriggerStore(database).create({
      actorThreadId: null,
      anchorThreadId: prepared.thread.id,
      createdBy: project.userId,
      idempotencyKey: "watch",
      name: "Files",
      source: { kind: "watch" },
      program: {
        toolContractVersion: 2,
        language: "javascript",
        source: "export default async () => {}",
      },
    });
    await database
      .updateTable("triggerWatchActivations")
      .set({ executionGeneration: 1 })
      .where("triggerId", "=", created.trigger.id)
      .execute();
    const activation = await database
      .selectFrom("triggerWatchActivations")
      .selectAll()
      .where("triggerId", "=", created.trigger.id)
      .executeTakeFirstOrThrow();
    const source = {
      kind: "watch" as const,
      activationId: activation.id,
      observationId: "one",
      revisionId: activation.revisionId,
      triggerId: activation.triggerId,
      executionGeneration: Number(activation.executionGeneration),
    };
    const input = {
      threadId: prepared.thread.id,
      origin: null,
      source,
      content: [{ type: "text" as const, text: "changed" }],
      policy: "queue" as const,
      idempotencyKey: "one",
    };
    const first = await store.admitProjectWork(input);
    expect(await store.admitProjectWork(input)).toMatchObject({
      runId: first.runId,
      wasDuplicate: true,
    });
    const second = await store.admitProjectWork({
      ...input,
      source: { ...source, observationId: "two" },
    });
    expect(second.runId).toBeNull();
    const run = await database
      .selectFrom("runs")
      .selectAll()
      .where("id", "=", first.runId)
      .executeTakeFirstOrThrow();
    expect(run).toMatchObject({
      requestedBy: null,
      membershipGeneration: null,
      initiatorGeneration: null,
      originConnectionId: null,
      actorPrincipalId: project.principalId,
      authoritySource: {
        kind: "watch-observation",
        observationId: "one",
        incarnation: activation.executionGeneration,
      },
    });
    const fakeBinding = ProjectRunBindingSchema.parse({
      authority: {
        version: 1,
        principal: {
          kind: "project",
          principalId: project.principalId,
          workspaceId: project.workspace.id,
        },
        origin: null,
      },
      runId: run.id,
      threadId: run.threadId,
      workspaceId: project.workspace.id,
      environmentId: project.environmentId,
      grantId: createId("grant"),
      bindingGeneration: 1,
      runnerId: project.runnerId,
      runnerBootId: "boot-unattended",
    });
    const before = await database.selectFrom("threads").select("id").execute();
    await expect(
      store.delegateProjectWork({
        binding: fakeBinding,
        title: "No creator",
        content: input.content,
        idempotencyKey: "creatorless",
      }),
    ).rejects.toMatchObject({ reason: "creatorless-tasks-not-supported" });
    expect(await database.selectFrom("threads").select("id").execute()).toEqual(before);
    expect(await database.selectFrom("agentControlRequests").select("requestId").execute()).toEqual(
      [],
    );
    await database
      .updateTable("triggerWatchActivations")
      .set({ executionGeneration: Number(activation.executionGeneration) + 1 })
      .where("id", "=", activation.id)
      .execute();
    await expect(
      store.admitProjectWork({ ...input, idempotencyKey: "late" }),
    ).rejects.toMatchObject({ reason: "source-unavailable" });
  });
  it("restarts admission from the Run reservation when a concurrent input expands the scope", async ({
    storeFixture,
  }) => {
    const { prepared, database, origin, store } = await prepareProjectAdmission(storeFixture);
    const barrier = pauseAfterLock(
      database,
      (node) =>
        node.includes('"SelectQueryNode"') &&
        node.includes('"runs"') &&
        node.includes("ForNoKeyUpdate"),
    );
    let reservations = 0;
    const measured = barrier.database.withPlugin({
      transformQuery(args) {
        const node = JSON.stringify(args.node);
        if (
          node.includes('"SelectQueryNode"') &&
          node.includes('"runs"') &&
          node.includes("ForNoKeyUpdate")
        )
          reservations += 1;
        return args.node;
      },
      async transformResult(args) {
        return args.result;
      },
    });
    const raced = new ProjectWorkStore(measured, { runnerIsConnected: () => true });
    const input = {
      threadId: prepared.thread.id,
      origin,
      source: { kind: "human" as const },
      content: [{ type: "text" as const, text: "first" }],
      policy: "queue" as const,
      idempotencyKey: "first",
    };
    const first = raced.admitProjectWork(input);
    void first.catch(() => undefined);
    try {
      await withTimeout(barrier.reached, 3000, {
        timeoutError: () => new Error("Admission never reached the Run reservation barrier"),
      });
      const second = await store.admitProjectWork({
        ...input,
        idempotencyKey: "second",
        content: [{ type: "text", text: "second" }],
      });
      barrier.release();
      const completed = await withTimeout(first, 3000, {
        timeoutError: () => new Error("Admission did not restart after its Run scope expanded"),
      });
      expect(completed.runId).toBeNull();
      expect(second.runId).not.toBeNull();
      expect(reservations).toBe(2);
      expect(
        await database
          .selectFrom("runs")
          .select("id")
          .where("threadId", "=", prepared.thread.id)
          .execute(),
      ).toHaveLength(1);
      expect((await store.admitProjectWork(input)).runId).toBeNull();
    } finally {
      barrier.release();
      await withTimeout(Promise.allSettled([first]), 3000, {
        timeoutError: () => new Error("Admission race cleanup did not settle"),
      });
    }
  });
});
