import { OpensteerError, PersonalSettingsSchema, type UserId } from "@opensteer/core";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";

export async function personalSettings(database: Kysely<DatabaseSchema>) {
  const row = await database
    .selectFrom("personalSettings")
    .selectAll()
    .where("singletonKey", "=", "personal")
    .executeTakeFirstOrThrow();
  return PersonalSettingsSchema.parse({
    ownerId: row.ownerId,
    agentHome: { computerId: row.agentHomeComputerId, path: row.agentHomePath },
    voiceThreadId: row.voiceThreadId,
  });
}

export async function requirePersonalOwner(database: Kysely<DatabaseSchema>, userId: UserId) {
  const owner = await database
    .selectFrom("personalSettings")
    .innerJoin("users", "users.id", "personalSettings.ownerId")
    .innerJoin("deployments", (join) => join.on("deployments.singletonKey", "=", "primary"))
    .select("personalSettings.ownerId")
    .where("personalSettings.singletonKey", "=", "personal")
    .where("personalSettings.ownerId", "=", userId)
    .where("users.disabledAt", "is", null)
    .where(({ eb }) => eb("deployments.deploymentShape", "=", { kind: "personal" }))
    .executeTakeFirst();
  if (!owner)
    throw new OpensteerError({ code: "forbidden", message: "The personal owner is required." });
}

export async function personalExecutionLocation(
  database: Kysely<DatabaseSchema>,
  threadId: import("@opensteer/core").ThreadId,
) {
  const [settings, thread] = await Promise.all([
    personalSettings(database),
    database
      .selectFrom("threads")
      .select(["folderComputerId", "folderPath"])
      .where("id", "=", threadId)
      .executeTakeFirstOrThrow(),
  ]);
  if (thread.folderComputerId !== settings.agentHome.computerId)
    throw new OpensteerError({
      code: "forbidden",
      message: "Tasks can run only on the hosting computer.",
    });
  return {
    folder: { computerId: thread.folderComputerId, path: thread.folderPath },
    agentHome: settings.agentHome,
  };
}
