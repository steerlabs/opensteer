import { personalDeploymentOwner } from "./machine-store.js";
import { runnerRunsItsDeployment, type RunnerId, type UserId } from "@opensteer/core";
import type { Kysely, Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";

export interface MachineOwnershipRecord {
  readonly effectiveOwner: UserId | null;
  readonly ownerKind: "deployment" | "user";
}

/**
 * Whose resources a machine may expose, read through the caller's transaction
 * so ownership cannot change between an authority check and its write.
 */
export async function machineOwnershipIn(
  database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  runnerId: RunnerId,
): Promise<MachineOwnershipRecord | null> {
  const runner = await database
    .selectFrom("runners")
    .select(["kind", "ownerKind", "ownerUserId"])
    .where("id", "=", runnerId)
    .where("revokedAt", "is", null)
    .executeTakeFirst();
  if (!runner) return null;
  if (runner.ownerKind === "user") {
    return { effectiveOwner: runner.ownerUserId, ownerKind: "user" };
  }
  const deployment = await database
    .selectFrom("deployments")
    .select("deploymentShape")
    .where("singletonKey", "=", "primary")
    .executeTakeFirst();
  if (
    !runnerRunsItsDeployment({
      deploymentIsPersonal: deployment ? deployment.deploymentShape.kind === "personal" : false,
      ownerKind: runner.ownerKind,
      runnerKind: runner.kind,
    })
  ) {
    return { effectiveOwner: null, ownerKind: "deployment" };
  }
  return { effectiveOwner: await personalDeploymentOwner(database), ownerKind: "deployment" };
}

/** The one management rule shared by reads and writes. */
export function machineIsManagedBy(ownership: MachineOwnershipRecord, userId: UserId): boolean {
  return ownership.effectiveOwner === userId;
}
