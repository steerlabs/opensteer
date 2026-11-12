import { mkdir, realpath } from "node:fs/promises";
import { OpensteerError, type EnvironmentId } from "@opensteer/core";
import {
  personalDeploymentOwner,
  initializePersonalSettings,
  personalSettings,
  requirePersonalOwner,
  withPersonalTransaction,
  type DatabaseSchema,
} from "@opensteer/database";
import type { RealtimeHub } from "@opensteer/orchestration";
import type { Kysely } from "kysely";
import { FolderAdmissionService } from "../threads/folder-admission-service.js";

export async function initializePersonalState(
  database: Kysely<DatabaseSchema>,
  config: {
    readonly environmentId: EnvironmentId;
    readonly agentHome: string;
  },
  realtime: Pick<RealtimeHub, "sendToUsers">,
): Promise<FolderAdmissionService | null> {
  const ownerId = await personalDeploymentOwner(database);
  const hosting = await database
    .selectFrom("runners")
    .select("id")
    .where("kind", "=", "main")
    .where("ownerKind", "=", "deployment")
    .where("revokedAt", "is", null)
    .executeTakeFirst();
  if (!ownerId || !hosting) return null;
  const existing = await database
    .selectFrom("personalSettings")
    .select("singletonKey")
    .where("singletonKey", "=", "personal")
    .executeTakeFirst();
  if (!existing) await mkdir(config.agentHome, { recursive: true });
  const path = await realpath(config.agentHome);
  // Reconciliation runs this repeatedly; once settings exist it must not hold the
  // Deployment event fence that every personal writer queues behind.
  const created =
    !existing &&
    (await withPersonalTransaction(database, (transaction) =>
      initializePersonalSettings(transaction, ownerId, { computerId: hosting.id, path }),
    ));
  const settings = await personalSettings(database);
  if (
    settings.ownerId !== ownerId ||
    settings.agentHome.computerId !== hosting.id ||
    settings.agentHome.path !== path
  )
    throw new OpensteerError({
      code: "conflict",
      message: "Personal owner and agent home do not match durable Host state",
    });
  if (created) realtime.sendToUsers([ownerId], { type: "host.machines.changed" });
  return new FolderAdmissionService({
    hostingComputerId: hosting.id,
    ownerId,
    environmentId: config.environmentId,
    agentHome: settings.agentHome,
    assertOwner: (userId) => requirePersonalOwner(database, userId),
  });
}
