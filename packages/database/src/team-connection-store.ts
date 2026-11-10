import { createHash } from "node:crypto";
import { createId, type AuthenticatedHuman } from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { requireTeamHuman, teamRefusal } from "./team-administration-authority.js";
import { jsonValue, safeGeneration } from "./store-primitives.js";

export async function revokeTeamConnection(
  database: Kysely<DatabaseSchema>,
  actor: AuthenticatedHuman,
  input: { connectionId: string; expectedRevision: number; idempotencyKey: string },
) {
  await requireTeamHuman(database, actor);
  const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  return database.transaction().execute(async (transaction) => {
    await sql`select pg_advisory_xact_lock(hashtextextended('opensteer:access-writer', 0))`.execute(
      transaction,
    );
    const state = await transaction
      .selectFrom("accessState")
      .select("revision")
      .where("singletonKey", "=", "primary")
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    const human = await requireTeamHuman(transaction, actor);
    const connection = await transaction
      .selectFrom("agentConnections")
      .select(["id", "userId"])
      .where("id", "=", input.connectionId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!connection || (human.instanceRole !== "administrator" && connection.userId !== human.id))
      teamRefusal("team-object-unavailable", "not_found");
    const receipt = await transaction
      .selectFrom("securityAudit")
      .select("metadata")
      .where("action", "=", "team.connection.revoke")
      .where("actorUserId", "=", actor.userId)
      .where("requestId", "=", input.idempotencyKey)
      .executeTakeFirst();
    if (receipt) {
      if (receipt.metadata.fingerprint !== fingerprint)
        teamRefusal("idempotency-conflict", "conflict");
      return { accessRevision: safeGeneration(state.revision), revoked: true as const };
    }
    if (safeGeneration(state.revision) !== input.expectedRevision)
      teamRefusal("access-revision-changed", "conflict");
    await transaction
      .updateTable("agentConnections")
      .set({ revokedAt: sql`clock_timestamp()` })
      .where("id", "=", connection.id)
      .where("revokedAt", "is", null)
      .execute();
    await transaction
      .insertInto("securityAudit")
      .values({
        id: createId("securityAudit"),
        action: "team.connection.revoke",
        actorUserId: actor.userId,
        actorSessionId: actor.sessionId ?? null,
        workspaceId: null,
        requestId: input.idempotencyKey,
        targetType: "connection",
        targetId: connection.id,
        metadata: jsonValue({ fingerprint }),
      })
      .execute();
    return { accessRevision: safeGeneration(state.revision), revoked: true as const };
  });
}
