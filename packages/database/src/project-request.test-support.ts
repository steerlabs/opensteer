import { createId, HumanRootSchema, type RunId } from "@opensteer/core";
import { HarnessInstanceCatalogSchema } from "@opensteer/protocol";
import { randomUUID } from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { issueRunGrant } from "./run-grants.js";
import { readProjectRunBinding } from "./execution-authority.js";
import { ProjectExecutionStore, StoredProjectControlSchema } from "./project-execution-store.js";
import { ProjectWorkStore } from "./project-work-store.js";
import { setProjectRuntimeSettings } from "./project-runtime-settings-store.js";
import { TriggerStore } from "./trigger-store.js";
import { jsonValue } from "./store-primitives.js";
import {
  testModelSelection,
  testReadyHarnessCatalog,
  type StoreFixture,
} from "./store.integration.test-support.js";
import {
  createProjectIdentityFixture,
  insertProjectRunFixture,
} from "./project-work.test-support.js";
import { runFromRow } from "./thread-row-mappers.js";

export async function projectRequestFixture(
  fixture: StoreFixture,
  suffix: string,
  root: "human" | "connection" | "unattended" = "human",
) {
  const { database } = fixture;
  const runnerBootId = `rbt_${randomUUID()}`;
  const project = await createProjectIdentityFixture(fixture, suffix);
  const seed = await insertProjectRunFixture(fixture, project, suffix);
  await database.deleteFrom("commands").where("runId", "=", seed.run.id).execute();
  await database.deleteFrom("runs").where("id", "=", seed.run.id).execute();
  await database
    .updateTable("threadInputs")
    .set({ state: "cancelled", cancelReason: "fixture-seed-retired" })
    .where("messageId", "=", seed.turn.input.messageId)
    .execute();
  await database
    .updateTable("threads")
    .set({ nextMessageSequence: "1", nextRunOrdinal: 1 })
    .where("id", "=", seed.thread.id)
    .execute();
  await database
    .insertInto("harnessCatalogs")
    .values({
      environmentId: project.environmentId,
      harnessInstanceId: seed.harnessInstance.id,
      capturedAt: new Date(),
      catalog: jsonValue(
        HarnessInstanceCatalogSchema.parse({
          ...testReadyHarnessCatalog(seed.harnessInstance.id),
          driverKind: "codex",
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
          continuationIdentity: {
            driverKind: "codex",
            continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
          },
        }),
      ),
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
      harnessInstanceId: seed.harnessInstance.id,
      modelSelection: testModelSelection,
      accessMode: "full-access",
      instructions: "Project",
      timeZone: "UTC",
    },
  );
  const connectionId = `mcn_${randomUUID()}`;
  await database
    .insertInto("agentConnections")
    .values({
      id: connectionId,
      userId: project.userId,
      label: "Root",
      clientName: "Test",
      accessMode: "full-access",
      workspaceId: project.workspace.id,
      resource: "https://team.test/mcp",
      tokenHash: null,
      createdAt: new Date(),
      lastUsedAt: null,
      expiresAt: new Date(Date.now() + 3600000),
      revokedAt: null,
      memberGeneration: "1",
      membershipGeneration: "1",
    })
    .execute();
  const origin =
    root === "unattended"
      ? null
      : HumanRootSchema.parse({
          userId: project.userId,
          initiatorGeneration: 1,
          membershipGeneration: 1,
          originConnectionId: root === "connection" ? connectionId : null,
        });
  const work = new ProjectWorkStore(database, {
    runnerIsConnected: () => true,
    runnerIsAttached: () => true,
  });
  let runId: RunId | null;
  if (root === "unattended") {
    const config = await new TriggerStore(database).create({
      actorThreadId: null,
      anchorThreadId: seed.thread.id,
      createdBy: project.userId,
      idempotencyKey: "watch-source",
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
      .where("triggerId", "=", config.trigger.id)
      .execute();
    const activation = await database
      .selectFrom("triggerWatchActivations")
      .selectAll()
      .where("triggerId", "=", config.trigger.id)
      .executeTakeFirstOrThrow();
    runId = (
      await work.admitProjectWork({
        threadId: seed.thread.id,
        origin: null,
        source: {
          kind: "watch",
          activationId: activation.id,
          observationId: "files-one",
          revisionId: activation.revisionId,
          triggerId: activation.triggerId,
          executionGeneration: 1,
        },
        content: [{ type: "text", text: "Files changed" }],
        policy: "queue",
        idempotencyKey: "request-run",
      })
    ).runId;
  } else {
    runId = (
      await work.admitProjectWork({
        threadId: seed.thread.id,
        origin,
        source: root === "connection" ? { kind: "connection", connectionId } : { kind: "human" },
        content: [{ type: "text", text: "Project work" }],
        policy: "queue",
        idempotencyKey: "request-run",
      })
    ).runId;
  }
  if (!runId) throw new Error("Project Request Run was not admitted");
  const admitted = await database
    .selectFrom("runs")
    .selectAll()
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  const grantId = await database.transaction().execute(async (tx) => {
    await tx
      .selectFrom("runs")
      .select("id")
      .where("id", "=", admitted.id)
      .forNoKeyUpdate()
      .execute();
    await tx
      .selectFrom("workspaces")
      .select("id")
      .where("id", "=", project.workspace.id)
      .forNoKeyUpdate()
      .execute();
    await tx
      .selectFrom("providerSessions")
      .select("id")
      .where("threadId", "=", seed.thread.id)
      .orderBy("id")
      .forNoKeyUpdate()
      .execute();
    await tx
      .updateTable("providerSessions")
      .set({ active: false })
      .where("threadId", "=", seed.thread.id)
      .execute();
    await tx
      .updateTable("providerSessions")
      .set({
        active: true,
        status: "running",
        runnerId: project.runnerId,
        runnerBootId,
        bindingGeneration: 1,
        leaseTokenHash: "request-lease",
        leaseExpiresAt: new Date(Date.now() + 60000),
      })
      .where("id", "=", admitted.providerSessionId)
      .execute();
    await tx
      .updateTable("runs")
      .set({ status: "running", bindingGeneration: 1, startedAt: new Date() })
      .where("id", "=", admitted.id)
      .execute();
    return (
      await issueRunGrant(tx, {
        runId: admitted.id,
        runnerId: project.runnerId,
        runnerBootId,
        bindingGeneration: 1,
        modelSelection: testModelSelection,
      })
    ).grantId;
  });
  const saved = await readProjectRunBinding(database, { runId: admitted.id, grantId });
  if (!saved) throw new Error("Project Request binding was not retained");
  const grant = await database
    .selectFrom("grants")
    .selectAll()
    .where("id", "=", grantId)
    .executeTakeFirstOrThrow();
  const sessionId = createId("authSession");
  await database
    .insertInto("authSessions")
    .values({
      id: sessionId,
      userId: project.userId,
      token: randomUUID(),
      expiresAt: new Date(Date.now() + 3600000),
      absoluteExpiresAt: new Date(Date.now() + 3600000),
      ipAddress: null,
      userAgent: null,
      deviceLabel: "Test",
      lastSeenAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      memberGeneration: "1",
    })
    .execute();
  return {
    ...seed,
    run: runFromRow({ ...admitted, status: "running" }),
    binding: saved.binding,
    grant,
    sessionId,
    connectionId,
    work,
  };
}

export function durableProjectControls(database: Kysely<DatabaseSchema>) {
  return {
    port: new ProjectExecutionStore(),
    transact: <Result>(
      connection: Kysely<DatabaseSchema>,
      operation: (tx: Transaction<DatabaseSchema>) => Promise<Result>,
    ) => connection.transaction().execute(operation),
    read: async () =>
      (
        await database
          .selectFrom("commands")
          .select("payload")
          .where("type", "=", "run.control.project")
          .orderBy("createdAt")
          .execute()
      ).map((row) => StoredProjectControlSchema.parse(row.payload).control),
  };
}
