import { requirePersonalOwner } from "./personal-settings-store.js";
import { OpensteerError, type UserId } from "@opensteer/core";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";

export async function assertPersonalOwner(database: Kysely<DatabaseSchema>, ownerId: UserId) {
  await requirePersonalOwner(database, ownerId);
  const owner = await database
    .selectFrom("personalSettings")
    .innerJoin("users", "users.id", "personalSettings.ownerId")
    .innerJoin("deployments", (join) => join.on("deployments.singletonKey", "=", "primary"))
    .innerJoin("runners as hostComputer", (join) =>
      join
        .on("hostComputer.ownerKind", "=", "deployment")
        .on("hostComputer.kind", "=", "main")
        .on("hostComputer.revokedAt", "is", null),
    )
    .select([
      "hostComputer.id as hostingComputerId",
      "personalSettings.ownerId",
      "personalSettings.agentHomeComputerId",
      "personalSettings.agentHomePath",
      "deployments.id as deploymentId",
      "deployments.deploymentShape",
      "deployments.lifecycle",
    ])
    .where("personalSettings.ownerId", "=", ownerId)
    .where("users.disabledAt", "is", null)
    .executeTakeFirst();
  if (!owner || owner.deploymentShape.kind !== "personal" || owner.lifecycle !== "active")
    throw new OpensteerError({ code: "forbidden", message: "Personal owner access is required" });
  return owner;
}
