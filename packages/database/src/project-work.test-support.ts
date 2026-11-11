import { TriggerStore } from "./trigger-store.js";
import { readProjectRunBinding } from "./execution-authority.js";
import { HumanRootSchema, type RunId, type RunnerId } from "@opensteer/core";
import { HarnessInstanceCatalogSchema } from "@opensteer/protocol";
import { ProjectWorkStore } from "./project-work-store.js";
import { setProjectRuntimeSettings } from "./project-runtime-settings-store.js";
import { testReadyHarnessCatalog } from "./store.integration.test-support.js";
import { randomUUID } from "node:crypto";
import { issueRunGrant } from "./run-grants.js";
import { jsonValue, principalIdForUser } from "./store-primitives.js";
import { testModelSelection } from "./store.integration.test-support.js";
import {
  threadFromRow,
  runFromRow,
  messageFromRow,
  threadInputFromRow,
} from "./thread-row-mappers.js";
import { createId, HarnessIdSchema } from "@opensteer/core";
import { ensureProjectPrincipal } from "./project-work-store.js";
import { enrollTestRunner, type StoreFixture } from "./store.integration.test-support.js";
import { createTestWorkspace } from "./workspace-fixture.test-support.js";

export async function createProjectIdentityFixture(
  fixture: StoreFixture,
  suffix: string,
  model: 1 | 2 = 2,
) {
  const { database, store } = fixture;
  await database
    .insertInto("deployments")
    .values({
      id: createId("deployment"),
      singletonKey: "primary",
      activeHostInstanceId: createId("hostInstance"),
      canonicalOrigin: "https://test-host.invalid",
      deploymentShape: { kind: "server", defaultWorkspaceBacking: "local-directory" },
      authorityModelVersion: model,
      lifecycle: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .execute();
  const userId = await store.createUser("Alex");
  await database
    .updateTable("users")
    .set({ admittedAt: new Date() })
    .where("id", "=", userId)
    .execute();
  const runnerId = createId("runner");
  const environmentId = createId("environment");
  await enrollTestRunner(store, {
    createdBy: null,
    environmentId,
    name: "Project computer",
    runnerId,
    tokenSuffix: suffix,
  });
  const workspace = await createTestWorkspace(store, {
    backing: {
      kind: "local-directory",
      bindingId: createId("workspaceBinding"),
      generation: 1,
      ownerEnvironmentId: environmentId,
      storageAuthorityId: null,
    },
    kind: "project",
    createdBy: userId,
    name: `Project ${suffix}`,
    idempotencyKey: `project-${suffix}`,
    status: "ready",
  });
  const principalId =
    model === 2
      ? await database.transaction().execute(async (transaction) => {
          await transaction
            .selectFrom("workspaces")
            .select("id")
            .where("id", "=", workspace.id)
            .forShare()
            .executeTakeFirstOrThrow();
          return ensureProjectPrincipal(transaction, workspace.id);
        })
      : null;
  return { environmentId, runnerId, userId, workspace, principalId };
}

export async function insertProjectRunFixture(
  fixture: StoreFixture,
  project: Awaited<ReturnType<typeof createProjectIdentityFixture>>,
  suffix: string,
  requestedBy = project.userId,
  status: "queued" | "running" = "queued",
) {
  const { database, store } = fixture;
  if (!project.principalId) throw new Error("Project work requires a model-2 identity fixture");
  const principalId = project.principalId;
  const runner = await database
    .selectFrom("runners")
    .select("capabilities")
    .where("id", "=", project.runnerId)
    .executeTakeFirstOrThrow();
  if (!runner.capabilities.includes("project-authority-v1"))
    await database
      .updateTable("runners")
      .set({ capabilities: jsonValue([...runner.capabilities, "project-authority-v1"]) })
      .where("id", "=", project.runnerId)
      .execute();
  const harnessInstance = await store.createHarnessInstance({
    driverKind: HarnessIdSchema.parse("codex"),
    config: {},
    environmentId: project.environmentId,
    name: "Project Codex",
    stateKind: "isolated",
    sourceId: "openai",
  });
  const threadId = createId("thread");
  const runId = createId("run");
  const messageId = createId("message");
  const providerSessionId = createId("providerSession");
  const runnerBootId = `rbt_${randomUUID()}`;
  const result = await database.transaction().execute(async (transaction) => {
    const membership = await transaction
      .selectFrom("workspaceMemberships")
      .select("generation")
      .where("workspaceId", "=", project.workspace.id)
      .where("userId", "=", requestedBy)
      .executeTakeFirstOrThrow();
    const user = await transaction
      .selectFrom("users")
      .select("authorityGeneration")
      .where("id", "=", requestedBy)
      .executeTakeFirstOrThrow();
    const root = {
      actorPrincipalId: principalId,
      requestedBy,
      membershipGeneration: membership.generation,
      initiatorGeneration: user.authorityGeneration,
      originConnectionId: null,
      authoritySource: jsonValue({ kind: "workspace-membership", userId: requestedBy }),
    };
    const thread = await transaction
      .insertInto("threads")
      .values({
        id: threadId,
        lineageRootThreadId: threadId,
        workspaceId: project.workspace.id,
        parentThreadId: null,
        createdBy: requestedBy,
        createdByPrincipalId: principalId,
        environmentId: project.environmentId,
        harnessInstanceId: harnessInstance.id,
        modelSelection: jsonValue(testModelSelection),
        status: "idle",
        title: suffix,
        listed: true,
        inheritsMain: false,
        icon: null,
        iconSource: "provisional",
        color: "blue",
        askedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const causalChainId = createId("causalChain");
    await transaction
      .insertInto("causalChains")
      .values({
        id: causalChainId,
        maxDelegations: 32,
        maxAutonomousRuns: 32,
        rootMessageId: messageId,
        rootOccurrenceId: null,
        usedDelegations: 0,
        usedAutonomousRuns: 0,
        createdAt: new Date(),
      })
      .execute();
    const humanPrincipalId = await principalIdForUser(transaction, requestedBy);
    const message = await transaction
      .insertInto("messages")
      .values({
        id: messageId,
        threadId,
        runId: null,
        actorPrincipalId: humanPrincipalId,
        author: jsonValue({
          kind: "human",
          userId: requestedBy,
          principalId: humanPrincipalId,
          displayName: "Alex",
        }),
        content: jsonValue([{ type: "text", text: "Project work" }]),
        kind: "input",
        sequence: 0,
        createdAt: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const input = await transaction
      .insertInto("threadInputs")
      .values({
        ...root,
        threadId,
        messageId,
        assignmentId: null,
        causalChainId,
        cancelReason: null,
        deliveredAt: null,
        idempotencyKey: `${suffix}-input`,
        policy: "queue",
        queueRank: 0,
        replyTarget: null,
        requestFingerprint: suffix,
        runId: null,
        state: "pending",
        steerCommandId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("providerSessions")
      .values({
        id: providerSessionId,
        active: true,
        stateLayout: "session",
        threadId,
        harnessInstanceId: harnessInstance.id,
        continuationIdentity: null,
        providerSessionReference: null,
        runnerId: status === "running" ? project.runnerId : null,
        runnerBootId: status === "running" ? runnerBootId : null,
        bindingGeneration: status === "running" ? 1 : 0,
        leaseTokenHash: status === "running" ? suffix : null,
        leaseExpiresAt: status === "running" ? new Date(Date.now() + 60_000) : null,
        status: status === "running" ? "running" : "ready",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .execute();
    const run = await transaction
      .insertInto("runs")
      .values({
        ...root,
        id: runId,
        activationInputId: messageId,
        seedInputId: messageId,
        threadId,
        environmentId: project.environmentId,
        harnessInstanceId: harnessInstance.id,
        modelSelection: jsonValue(testModelSelection),
        accessMode: "full-access",
        assignmentId: null,
        causalChainId,
        providerSessionId,
        replyTarget: null,
        runOrdinal: 0,
        bindingGeneration: status === "running" ? 1 : null,
        status,
        startedAt: status === "running" ? new Date() : null,
        completedAt: null,
        createdAt: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const command = await transaction
      .insertInto("commands")
      .values({
        ...root,
        id: createId("command"),
        environmentId: project.environmentId,
        threadId,
        runId,
        idempotencyKey: `run:${runId}`,
        payload: jsonValue({ type: "run.execute.project", threadId, runId }),
        type: "run.execute.project",
        status: status === "running" ? "dispatched" : "pending",
        dispatcherId: null,
        lastError: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    if (status === "running")
      await issueRunGrant(transaction, {
        runId,
        runnerId: project.runnerId,
        runnerBootId,
        bindingGeneration: 1,
        modelSelection: testModelSelection,
      });
    return {
      thread: threadFromRow({
        ...thread,
        continuationIdentity: null,
        providerSessionId,
        pendingRequests: 0,
      }),
      run: runFromRow(run),
      turn: {
        input: threadInputFromRow(input),
        message: messageFromRow(message),
        run: runFromRow(run),
        command,
      },
    };
  });
  return {
    ...project,
    ...result,
    harnessInstance,
    runnerBootId,
    bindingGeneration: status === "running" ? 1 : 0,
  };
}

export async function prepareProjectAdmission(storeFixture: StoreFixture, running = false) {
  const project = await createProjectIdentityFixture(storeFixture, "admission");
  let prepared = await insertProjectRunFixture(
    storeFixture,
    project,
    "existing-thread",
    project.userId,
    "queued",
  );
  const database = storeFixture.database;
  {
    await database.deleteFrom("commands").where("runId", "=", prepared.run.id).execute();
    await database.deleteFrom("runs").where("id", "=", prepared.run.id).execute();
    await database
      .updateTable("threadInputs")
      .set({ state: "cancelled", cancelReason: "fixture-seed-retired" })
      .where("messageId", "=", prepared.turn.input.messageId)
      .execute();
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
  const store = new ProjectWorkStore(database, {
    runnerIsConnected: () => true,
    runnerIsAttached: () => true,
  });
  if (running) {
    const admitted = await store.admitProjectWork({
      threadId: prepared.thread.id,
      origin,
      source: { kind: "human" },
      content: [{ type: "text", text: "bound parent" }],
      policy: "queue",
      idempotencyKey: "bound-parent",
    });
    if (!admitted.runId || !admitted.commandId) throw new Error("Parent fixture was not admitted");
    await bindProjectRun(storeFixture, admitted.runId, project.runnerId);
    const run = runFromRow(
      await database
        .selectFrom("runs")
        .selectAll()
        .where("id", "=", admitted.runId)
        .executeTakeFirstOrThrow(),
    );
    const message = messageFromRow(
      await database
        .selectFrom("messages")
        .selectAll()
        .where("id", "=", admitted.input.messageId)
        .executeTakeFirstOrThrow(),
    );
    const command = await database
      .selectFrom("commands")
      .selectAll()
      .where("id", "=", admitted.commandId)
      .executeTakeFirstOrThrow();
    prepared = { ...prepared, run, turn: { run, message, input: admitted.input, command } };
  }
  return { project, prepared, database, origin, store };
}

export async function bindProjectRun(fixture: StoreFixture, runId: RunId, runnerId: RunnerId) {
  const runnerBootId = `rbt_${randomUUID()}`;
  const grantId = await fixture.database.transaction().execute(async (transaction) => {
    const run = await transaction
      .selectFrom("runs")
      .selectAll()
      .where("id", "=", runId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    const thread = await transaction
      .selectFrom("threads")
      .selectAll()
      .where("id", "=", run.threadId)
      .executeTakeFirstOrThrow();
    await transaction
      .selectFrom("workspaces")
      .select("id")
      .where("id", "=", thread.workspaceId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    await transaction
      .selectFrom("providerSessions")
      .select("id")
      .where("threadId", "=", thread.id)
      .orderBy("id")
      .forNoKeyUpdate()
      .execute();
    await transaction
      .updateTable("providerSessions")
      .set({ active: false })
      .where("threadId", "=", thread.id)
      .execute();
    await transaction
      .updateTable("providerSessions")
      .set({
        active: true,
        status: "running",
        runnerId,
        runnerBootId,
        bindingGeneration: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
        leaseTokenHash: "fixture-lease",
      })
      .where("id", "=", run.providerSessionId)
      .execute();
    await transaction
      .updateTable("runs")
      .set({ status: "running", bindingGeneration: 1, startedAt: new Date() })
      .where("id", "=", runId)
      .execute();
    return (
      await issueRunGrant(transaction, {
        runId,
        runnerId,
        runnerBootId,
        bindingGeneration: 1,
        modelSelection: testModelSelection,
      })
    ).grantId;
  });
  const saved = await readProjectRunBinding(fixture.database, { runId, grantId });
  if (!saved) throw new Error("Project binding fixture was not retained");
  return saved.binding;
}

export async function projectWatchWorkSource(
  {
    database,
    project,
    prepared,
  }: Pick<Awaited<ReturnType<typeof prepareProjectAdmission>>, "database" | "project" | "prepared">,
  observationId = "one",
) {
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
    observationId,
    revisionId: activation.revisionId,
    triggerId: activation.triggerId,
    executionGeneration: Number(activation.executionGeneration),
  };
  return { activation, source };
}
