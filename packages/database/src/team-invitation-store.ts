import { createHash, timingSafeEqual } from "node:crypto";
import { createId, normalizeIdentityEmail, type AuthenticatedHuman } from "@opensteer/core";
import { TeamCommandSchema, type TeamCommand } from "@opensteer/protocol";
import { sql, type Kysely } from "kysely";
import { z } from "zod";
import type { DatabaseSchema } from "./schema.js";
import {
  requireTeamAuthority,
  requireTeamHuman,
  teamRefusal,
} from "./team-administration-authority.js";
import { jsonValue, safeGeneration } from "./store-primitives.js";
export { acceptTeamInvitation } from "./access-store.js";

type InvitationCommand = Extract<
  TeamCommand,
  { type: "team.invitation.create" | "team.invitation.revoke" }
>;
const resultSchema = z.union([
  z.object({ invitationId: z.uuid(), selector: z.string(), expiresAt: z.iso.datetime() }),
  z.object({ revoked: z.literal(true) }),
]);

export async function readTeamInvitation(
  database: Kysely<DatabaseSchema>,
  selector: string,
  verifier?: string,
) {
  await requireTeamAuthority(database);
  const row = await database
    .selectFrom("teamInvitations")
    .innerJoin("users", "users.id", "teamInvitations.createdBy")
    .select([
      "teamInvitations.id",
      "selector",
      "tokenHash",
      "intendedEmail",
      "teamInvitations.memberKind",
      "expiresAt",
      "acceptedAt",
      "revokedAt",
      "users.displayName as inviterName",
    ])
    .where("selector", "=", selector)
    .executeTakeFirst();
  const now = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(database)).rows[0]!
    .now;
  if (!row || row.revokedAt || row.expiresAt <= now) return null;
  if (verifier !== undefined) {
    const digest = createHash("sha256").update(verifier).digest("hex");
    if (
      row.acceptedAt ||
      row.tokenHash.length !== digest.length ||
      !timingSafeEqual(Buffer.from(row.tokenHash), Buffer.from(digest))
    )
      return null;
  }
  return row;
}

export async function mutateTeamInvitation(
  database: Kysely<DatabaseSchema>,
  actor: AuthenticatedHuman,
  input: InvitationCommand,
) {
  const command = TeamCommandSchema.parse(input);
  if (command.type !== "team.invitation.create" && command.type !== "team.invitation.revoke")
    teamRefusal("invalid-selection", "bad_request");
  await requireTeamHuman(database, actor, true);
  const fingerprint = createHash("sha256").update(JSON.stringify(command)).digest("hex");
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
    await requireTeamHuman(transaction, actor, true);
    const accessRevision = safeGeneration(state.revision);
    const prior = await transaction
      .selectFrom("securityAudit")
      .select("metadata")
      .where("actorUserId", "=", actor.userId)
      .where("action", "=", command.type)
      .where("requestId", "=", command.idempotencyKey)
      .executeTakeFirst();
    if (prior) {
      if (prior.metadata.fingerprint !== fingerprint)
        teamRefusal("idempotency-conflict", "conflict");
      return { accessRevision, result: resultSchema.parse(prior.metadata.result) };
    }
    if (accessRevision !== command.expectedRevision)
      teamRefusal("access-revision-changed", "conflict");
    const now = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(transaction))
      .rows[0]!.now;
    let result: z.infer<typeof resultSchema>;
    if (command.type === "team.invitation.create") {
      const expiresAt = new Date(now.getTime() + (command.validFor === "1d" ? 1 : 7) * 86_400_000);
      const collision = await transaction
        .selectFrom("teamInvitations")
        .select("id")
        .where((expression) =>
          expression.or([
            expression("id", "=", command.id),
            expression("selector", "=", command.selector),
          ]),
        )
        .executeTakeFirst();
      if (collision) teamRefusal("idempotency-conflict", "conflict");
      await transaction
        .insertInto("teamInvitations")
        .values({
          id: command.id,
          selector: command.selector,
          tokenHash: command.tokenHash,
          intendedEmail: normalizeIdentityEmail(command.intendedEmail),
          memberKind: command.memberKind,
          createdBy: actor.userId,
          createdAt: now,
          expiresAt,
          acceptedAt: null,
          acceptedBy: null,
          revokedAt: null,
          revokedBy: null,
          commandId: command.idempotencyKey,
          requestFingerprint: fingerprint,
        })
        .execute();
      result = {
        invitationId: command.id,
        selector: command.selector,
        expiresAt: expiresAt.toISOString(),
      };
    } else {
      const invitation = await transaction
        .selectFrom("teamInvitations")
        .select("id")
        .where("id", "=", command.invitationId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!invitation) teamRefusal("team-object-unavailable", "not_found");
      await transaction
        .updateTable("teamInvitations")
        .set({ revokedAt: now, revokedBy: actor.userId })
        .where("id", "=", invitation.id)
        .where("revokedAt", "is", null)
        .execute();
      result = { revoked: true as const };
    }
    await transaction
      .insertInto("securityAudit")
      .values({
        id: createId("securityAudit"),
        action: command.type,
        actorUserId: actor.userId,
        actorSessionId: actor.sessionId ?? null,
        workspaceId: null,
        requestId: command.idempotencyKey,
        targetType: "invitation",
        targetId: command.type === "team.invitation.create" ? command.id : command.invitationId,
        metadata: jsonValue({ fingerprint, result }),
      })
      .execute();
    return { accessRevision, result };
  });
}
