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
