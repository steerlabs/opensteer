import { AuthSessionIdSchema, OpensteerError, type UserId } from "@opensteer/core";
import { describeSessionDevice } from "@opensteer/shared/sessionDevice";
import type { Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { jsonValue } from "./store-primitives.js";

/** Lock the accepting session through settlement, so revocation cannot race acceptance. */
export async function requestSettlementActor(
  transaction: Transaction<DatabaseSchema>,
  userId: UserId,
  sessionId: string | undefined,
) {
  if (!sessionId) return null;
  const row = await transaction
    .selectFrom("authSessions")
    .innerJoin("users", "users.id", "authSessions.userId")
    .select(["authSessions.id", "authSessions.deviceLabel", "authSessions.userAgent"])
    .where("authSessions.id", "=", AuthSessionIdSchema.parse(sessionId))
    .where("authSessions.userId", "=", userId)
    .where("authSessions.expiresAt", ">", new Date())
    .where("authSessions.absoluteExpiresAt", ">", new Date())
    .where("users.disabledAt", "is", null)
    .forShare("authSessions")
    .executeTakeFirst();
  if (!row)
    throw new OpensteerError({
      code: "unauthorized",
      message: "The approving session is no longer signed in.",
    });
  return {
    sessionId: row.id,
    deviceLabel:
      row.userAgent === null ? row.deviceLabel : describeSessionDevice(row.userAgent).label,
  };
}

export async function requestSettlementProvenance(
  transaction: Transaction<DatabaseSchema>,
  userId: UserId,
  sessionId: string | undefined,
) {
  const actor = await requestSettlementActor(transaction, userId, sessionId);
  return actor ? jsonValue(actor) : null;
}
