import { OpensteerError, type AuthenticatedHuman } from "@opensteer/core";
import type { TeamReason } from "@opensteer/protocol";
import type { Kysely, Transaction } from "kysely";
import { readDeploymentAuthority } from "./deployment-execution-authority.js";
import type { DatabaseSchema } from "./schema.js";
import { safeGeneration } from "./store-primitives.js";

export function teamRefusal(
  reason: TeamReason,
  code: "forbidden" | "conflict" | "not_found" | "unauthorized" | "bad_request" = "forbidden",
): never {
  throw new OpensteerError({
    code,
    reason,
    message: `Team administration refused: ${reason}.`,
    retryable: reason === "access-revision-changed" || reason === "settings-revision-changed",
  });
}

export async function requireTeamAuthority(database: Kysely<DatabaseSchema>) {
  const authority = await readDeploymentAuthority(database);
  if (authority.kind !== "server" || authority.model !== 2) teamRefusal("team-unavailable");
}

export async function requireTeamHuman(
  database: Kysely<DatabaseSchema>,
  actor: AuthenticatedHuman,
  administrator = false,
) {
  await requireTeamAuthority(database);
  const user = await database
    .selectFrom("users")
    .select([
      "id",
      "displayName",
      "memberKind",
      "memberState",
      "admittedAt",
      "disabledAt",
      "instanceRole",
      "authorityGeneration",
    ])
    .where("id", "=", actor.userId)
    .executeTakeFirst();
  if (!user || !user.admittedAt) teamRefusal("membership-lost");
  if (user.memberState === "removed") teamRefusal("member-removed");
  if (user.memberState === "suspended" || user.disabledAt) teamRefusal("member-suspended");
  if (
    actor.authorityGeneration !== undefined &&
    actor.authorityGeneration !== safeGeneration(user.authorityGeneration)
  )
    teamRefusal("member-generation-changed", "unauthorized");
  if (actor.sessionId) {
    const session = await database
      .selectFrom("authSessions")
      .select("id")
      .where("id", "=", actor.sessionId)
      .where("userId", "=", user.id)
      .where("memberGeneration", "=", String(user.authorityGeneration))
      .where("expiresAt", ">", new Date())
      .where("absoluteExpiresAt", ">", new Date())
      .executeTakeFirst();
    if (!session) teamRefusal("member-generation-changed", "unauthorized");
  }
  if (administrator && user.instanceRole !== "administrator") teamRefusal("team-admin-required");
  return user;
}

export async function lockTeamHuman(
  transaction: Transaction<DatabaseSchema>,
  actor: AuthenticatedHuman,
  administrator = false,
) {
  await transaction
    .selectFrom("users")
    .select("id")
    .where("id", "=", actor.userId)
    .forShare()
    .executeTakeFirst();
  if (actor.sessionId)
    await transaction
      .selectFrom("authSessions")
      .select("id")
      .where("id", "=", actor.sessionId)
      .forShare()
      .executeTakeFirst();
  return requireTeamHuman(transaction, actor, administrator);
}
