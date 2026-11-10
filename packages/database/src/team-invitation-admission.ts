import { createHash, timingSafeEqual } from "node:crypto";
import {
  normalizeIdentityEmail,
  OpensteerError,
  type AuthAdmissionId,
  type AuthSessionId,
  type UserId,
} from "@opensteer/core";
import { sql, type Kysely, type Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";

export interface TeamAdmissionInput {
  readonly admissionId: AuthAdmissionId;
  readonly browserNonce: string;
  readonly userId: UserId;
  readonly sessionId: AuthSessionId;
}

export function unavailableInvitation(): never {
  throw new OpensteerError({
    code: "forbidden",
    reason: "invite-unavailable",
    message: "This invitation is unavailable.",
  });
}

export async function readTeamAdmission(
  database: Kysely<DatabaseSchema>,
  input: TeamAdmissionInput,
) {
  const now = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(database)).rows[0]!
    .now;
  const proof = await database
    .selectFrom("authAdmissions")
    .selectAll()
    .where("id", "=", input.admissionId)
    .executeTakeFirst();
  const digest = createHash("sha256").update(input.browserNonce).digest("hex");
  if (
    !proof ||
    proof.purpose !== "invitation" ||
    proof.expiresAt <= now ||
    proof.browserNonceHash.length !== digest.length ||
    !timingSafeEqual(Buffer.from(proof.browserNonceHash), Buffer.from(digest))
  )
    unavailableInvitation();
  const workspaceInvitation = await database
    .selectFrom("workspaceInvitations")
    .select("id")
    .where("selector", "=", proof.subjectSelector)
    .executeTakeFirst();
  if (workspaceInvitation) unavailableInvitation();
  const invitation = await database
    .selectFrom("teamInvitations")
    .selectAll()
    .where("selector", "=", proof.subjectSelector)
    .executeTakeFirst();
  const user = await database
    .selectFrom("users")
    .select([
      "id",
      "email",
      "emailVerified",
      "admittedAt",
      "memberState",
      "disabledAt",
      "authorityGeneration",
    ])
    .where("id", "=", input.userId)
    .executeTakeFirst();
  const session = await database
    .selectFrom("authSessions")
    .select(["id", "memberGeneration"])
    .where("id", "=", input.sessionId)
    .where("userId", "=", input.userId)
    .where("expiresAt", ">", now)
    .where("absoluteExpiresAt", ">", now)
    .executeTakeFirst();
  if (
    !invitation ||
    invitation.revokedAt ||
    invitation.expiresAt <= now ||
    !user ||
    !session ||
    session.memberGeneration === null ||
    session.memberGeneration !== user.authorityGeneration ||
    !user.emailVerified ||
    user.disabledAt ||
    user.memberState === "suspended" ||
    (user.memberState === "removed" && user.admittedAt === null) ||
    normalizeIdentityEmail(user.email) !== invitation.intendedEmail ||
    proof.reservedEmail !== invitation.intendedEmail ||
    (proof.consumedAt && proof.consumedBy !== user.id) ||
    (invitation.acceptedAt && invitation.acceptedBy !== user.id) ||
    !!proof.consumedAt !== !!invitation.acceptedAt ||
    (invitation.acceptedAt
      ? !user.admittedAt || user.memberState !== "active"
      : user.admittedAt !== null && user.memberState !== "removed")
  )
    unavailableInvitation();
  return invitation;
}

export async function consumeTeamAdmission(
  transaction: Transaction<DatabaseSchema>,
  input: TeamAdmissionInput,
  now: Date,
) {
  await transaction
    .selectFrom("authAdmissions")
    .select("id")
    .where("id", "=", input.admissionId)
    .forNoKeyUpdate()
    .executeTakeFirstOrThrow();
  const invitation = await readTeamAdmission(transaction, input);
  await transaction
    .selectFrom("teamInvitations")
    .select("id")
    .where("id", "=", invitation.id)
    .forNoKeyUpdate()
    .executeTakeFirstOrThrow();
  await readTeamAdmission(transaction, input);
  await transaction
    .updateTable("authAdmissions")
    .set({ consumedAt: now, consumedBy: input.userId })
    .where("id", "=", input.admissionId)
    .where("consumedAt", "is", null)
    .execute();
  await transaction
    .updateTable("teamInvitations")
    .set({ acceptedAt: now, acceptedBy: input.userId })
    .where("id", "=", invitation.id)
    .where("acceptedAt", "is", null)
    .execute();
  return invitation;
}
