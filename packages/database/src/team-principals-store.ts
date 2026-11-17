import { createId, DeploymentIdSchema, TeamHandleSchema, type UserId } from "@opensteer/core";
import { sql, type Kysely, type Transaction } from "kysely";
import { z } from "zod";
import type { DatabaseSchema } from "./schema.js";

type Executor = Kysely<DatabaseSchema> | Transaction<DatabaseSchema>;

export function teamPrincipalProfiles(executor: Executor) {
  return executor
    .selectFrom("teamPrincipals as p")
    .leftJoin("teamMembers as m", "m.userId", "p.memberUserId")
    .leftJoin("users as u", "u.id", "m.userId")
    .select([
      "p.id",
      "p.homeTeamId",
      "p.homeUserId",
      "p.memberUserId",
      sql<string>`coalesce(u.display_name,p.display_name)`.as("displayName"),
      sql<z.infer<typeof TeamHandleSchema>>`coalesce(m.handle,p.handle)`.as("handle"),
      "u.image",
    ]);
}

const RemoteTeamPrincipalSchema = z.strictObject({
  homeTeamId: DeploymentIdSchema,
  homeUserId: z.string().min(1).max(512),
  displayName: z.string().trim().min(1).max(160),
  handle: TeamHandleSchema,
});

export async function upsertRemoteTeamPrincipal(
  transaction: Transaction<DatabaseSchema>,
  input: z.infer<typeof RemoteTeamPrincipalSchema>,
) {
  const profile = RemoteTeamPrincipalSchema.parse(input);
  // Keep the existing UserId wire shape; a principal without a member row grants no authority.
  const id: UserId = createId("user");
  return transaction
    .insertInto("teamPrincipals")
    .values({ ...profile, id, memberUserId: null })
    .onConflict((c) =>
      c.columns(["homeTeamId", "homeUserId"]).doUpdateSet({
        displayName: profile.displayName,
        handle: profile.handle,
        updatedAt: new Date(),
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
}
