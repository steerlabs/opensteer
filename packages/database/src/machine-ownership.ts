import { runnerRunsItsDeployment, type RunnerId, type UserId } from "@opensteer/core";
import type { Kysely, Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";

/**
 * Who manages one computer's owner-scoped resources.
 *
 * The effective owner is null for a Deployment-owned machine outside a
 * Personal Deployment: nobody in particular owns it, so its administrators do.
 */
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
      deploymentIsPersonal: deployment?.deploymentShape.kind === "personal",
      ownerKind: runner.ownerKind,
      runnerKind: runner.kind,
    })
  ) {
    return { effectiveOwner: null, ownerKind: "deployment" };
  }
  const owner = await database
    .selectFrom("users")
    .select("id")
    .where("instanceRole", "=", "administrator")
    .where("disabledAt", "is", null)
    .orderBy("createdAt", "asc")
    .executeTakeFirst();
  return { effectiveOwner: owner?.id ?? null, ownerKind: "deployment" };
}

/** The one management rule shared by reads and writes. */
export function machineIsManagedBy(
  ownership: MachineOwnershipRecord,
  userId: UserId,
  options: { readonly allowDeployment: boolean },
): boolean {
  if (ownership.effectiveOwner === userId) return true;
  return ownership.ownerKind === "deployment" && options.allowDeployment;
}
