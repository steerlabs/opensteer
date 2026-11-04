import {
  automaticAccountOrder,
  catalogDefaultModelSelection,
  DEFAULT_THREAD_ACCESS_MODE,
  type Workspace,
} from "@opensteer/core";
import type { Kysely } from "kysely";
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
  // No history: the account a person means when they name none, then their
  // other accounts here, on that account's catalog default.
  const fresh = previous
    ? null
    : automaticAccountOrder(
        await database
          .selectFrom("harnessCatalogs")
          .innerJoin("harnessInstances", "harnessInstances.id", "harnessCatalogs.harnessInstanceId")
          .select([
            "harnessCatalogs.catalog",
            "harnessInstances.id",
            "harnessInstances.isDefault",
            "harnessInstances.sourceId",
          ])
          .where("harnessInstances.environmentId", "=", environmentId)
          .where("harnessInstances.enabled", "=", true)
          .where("harnessInstances.removedAt", "is", null)
          .orderBy("harnessInstances.id")
          .execute(),
      ).flatMap((account) => {
        // An arbitrary endpoint runs only when it is the account the person made default.
        if (account.sourceId === "openai-compatible" && !account.isDefault) return [];
        const modelSelection = catalogDefaultModelSelection(account.catalog);
        return modelSelection ? [{ harnessInstanceId: account.id, modelSelection }] : [];
      })[0];
  // With no engine yet, reconciliation will create the chat once one is connected.
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
