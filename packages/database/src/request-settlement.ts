import { AuthSessionIdSchema, OpensteerError, type UserId } from "@opensteer/core";
import { describeSessionDevice } from "@opensteer/shared/sessionDevice";
import type { Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { jsonValue } from "./store-primitives.js";

/** Read provenance before domain writes; the caller must fence the session before commit. */
export function readRequestSettlementActor(
  transaction: Transaction<DatabaseSchema>,
  userId: UserId,
  sessionId: string | undefined,
) {
  return settlementActor(transaction, userId, sessionId, false);
}

/** Fence after domain locks, so revocation rolls back the entire settlement. */
export function requestSettlementActor(
  transaction: Transaction<DatabaseSchema>,
  userId: UserId,
  sessionId: string | undefined,
) {
  return settlementActor(transaction, userId, sessionId, true);
}

async function settlementActor(
  transaction: Transaction<DatabaseSchema>,
  userId: UserId,
  sessionId: string | undefined,
  lock: boolean,
) {
  if (!sessionId) return null;
  let query = transaction
    .selectFrom("authSessions")
    .innerJoin("users", "users.id", "authSessions.userId")
    .select(["authSessions.id", "authSessions.deviceLabel", "authSessions.userAgent"])
    .where("authSessions.id", "=", AuthSessionIdSchema.parse(sessionId))
    .where("authSessions.userId", "=", userId)
    .where("authSessions.expiresAt", ">", new Date())
    .where("authSessions.absoluteExpiresAt", ">", new Date())
    .where("users.disabledAt", "is", null);
  if (lock) query = query.forShare("authSessions");
  const row = await query.executeTakeFirst();
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

/** The committing caller must also fence with requestSettlementActor after its domain writes. */
export async function readRequestSettlementProvenance(
  transaction: Transaction<DatabaseSchema>,
  userId: UserId,
  sessionId: string | undefined,
) {
  const actor = await readRequestSettlementActor(transaction, userId, sessionId);
  return actor ? jsonValue(actor) : null;
}
