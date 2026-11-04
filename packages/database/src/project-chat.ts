import {
  catalogDefaultCandidate,
  DEFAULT_THREAD_ACCESS_MODE,
  type EnvironmentId,
  type UserId,
  type Workspace,
} from "@opensteer/core";
import type { Kysely } from "kysely";
import { getAutomaticModelConfig } from "./background-model-store.js";
import type { DatabaseSchema } from "./schema.js";
import { createThread } from "./thread-store.js";

/** A chat uses the owner's existing engine choice on the Project's computer. */
export async function ensureProjectChat(
  database: Kysely<DatabaseSchema>,
  workspace: Workspace,
): Promise<Workspace> {
  if (
    workspace.kind !== "project" ||
    workspace.homeThreadId ||
    workspace.status !== "ready" ||
    workspace.backing.kind !== "local-directory"
  )
    return workspace;
  const environmentId = workspace.backing.ownerEnvironmentId;
  const previous = await database
    .selectFrom("threads")
    .innerJoin("harnessInstances", "harnessInstances.id", "threads.harnessInstanceId")
    .select(["threads.modelSelection", "threads.harnessInstanceId", "threads.accessMode"])
    .where("threads.createdBy", "=", workspace.createdBy)
    .where("threads.environmentId", "=", environmentId)
    .where("harnessInstances.enabled", "=", true)
    .where("harnessInstances.removedAt", "is", null)
    .orderBy("threads.updatedAt", "desc")
    .limit(1)
    .executeTakeFirst();
  const fresh = previous
    ? null
    : await automaticChoice(database, workspace.createdBy, environmentId);
  // With no usable account yet, reconciliation creates the chat once there is one.
  const choice = previous ?? fresh;
  if (!choice) return workspace;
  const result = await createThread(database, {
    accessMode: previous?.accessMode ?? DEFAULT_THREAD_ACCESS_MODE,
    createdBy: workspace.createdBy,
    environmentId,
    harnessInstanceId: choice.harnessInstanceId,
    modelSelection: choice.modelSelection,
    home: true,
    idempotencyKey: `project-chat:${workspace.id}`,
    title: "Chat",
    workspaceId: workspace.id,
  });
  return { ...workspace, homeThreadId: result.thread.id };
}

/** No history: the owner's automatic default among the accounts on that computer they left on. */
async function automaticChoice(
  database: Kysely<DatabaseSchema>,
  ownerId: UserId,
  environmentId: EnvironmentId,
) {
  const { excludedAccounts } = await getAutomaticModelConfig(database, ownerId);
  const accounts = await database
    .selectFrom("harnessCatalogs")
    .innerJoin("harnessInstances", "harnessInstances.id", "harnessCatalogs.harnessInstanceId")
    .select([
      "harnessCatalogs.catalog",
      "harnessInstances.id as harnessInstanceId",
      "harnessInstances.isDefault",
      "harnessInstances.sourceId",
    ])
    .where("harnessInstances.environmentId", "=", environmentId)
    .where("harnessInstances.enabled", "=", true)
    .where("harnessInstances.removedAt", "is", null)
    .orderBy("harnessInstances.id")
    .execute();
  const chosen = catalogDefaultCandidate({
    accounts: accounts.map((account) => ({
      ...account,
      enabled: true,
      removed: false,
      available: true,
    })),
    excludedAccounts,
    canRun: () => ({ ok: true }),
  });
  return chosen
    ? { harnessInstanceId: chosen.account.harnessInstanceId, modelSelection: chosen.modelSelection }
    : null;
}
