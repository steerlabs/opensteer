import { randomUUID } from "node:crypto";
import type { ControlPlaneAccountId } from "@opensteer/control-plane-protocol";
import type { Kysely } from "kysely";
import type { ControlPlaneDatabaseSchema } from "../database/schema.js";
import { ControlPlaneError } from "../server/errors.js";

type Database = Kysely<ControlPlaneDatabaseSchema>;

/**
 * How long a deletion fence lasts unless its attempt renews it, which it does before each step,
 * so only an attempt that died, say in a crash, lets go.
 */
const accountDeletionFenceMilliseconds = 10 * 60_000;

/**
 * Starts deleting an Account, before anything else is undone: refuses while another attempt is
 * deleting it, and fences it until the deletion ends. Returns the attempt that holds the fence.
 */
export async function beginAccountDeletion(
  database: Database,
  accountId: ControlPlaneAccountId,
): Promise<string> {
  const attemptId = randomUUID();
  await database.transaction().execute(async (transaction) => {
    const account = await transaction
      .selectFrom("users")
      .select(["deletionAttemptId", "deletionFencedUntil"])
      .where("id", "=", accountId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!account) throw new ControlPlaneError("not_found", "Account was not found");
    if (account.deletionAttemptId !== attemptId && deletionFenced(account.deletionFencedUntil))
      throw new ControlPlaneError("conflict", "Account deletion already in progress.", {
        reason: "account-deletion-in-progress",
      });
    await transaction
      .updateTable("users")
      .set({ deletionAttemptId: attemptId, deletionFencedUntil: fenceUntil() })
      .where("id", "=", accountId)
      .execute();
  });
  return attemptId;
}

/** Keeps `attemptId`'s fence up for its next step; refuses once it lapsed or another took it. */
export async function renewAccountDeletion(
  database: Database,
  accountId: ControlPlaneAccountId,
  attemptId: string,
): Promise<void> {
  const renewed = await database
    .updateTable("users")
    .set({ deletionFencedUntil: fenceUntil() })
    .where("id", "=", accountId)
    .where("deletionAttemptId", "=", attemptId)
    .where("deletionFencedUntil", ">", new Date())
    .returning("id")
    .executeTakeFirst();
  if (!renewed)
    throw new ControlPlaneError("unavailable", "Deleting your Account stopped. Try again.");
}

/** Ends `attemptId`'s deletion that won't finish. */
export async function abandonAccountDeletion(
  database: Database,
  accountId: ControlPlaneAccountId,
  attemptId: string,
): Promise<void> {
  await database
    .updateTable("users")
    .set({ deletionAttemptId: null, deletionFencedUntil: null })
    .where("id", "=", accountId)
    .where("deletionAttemptId", "=", attemptId)
    .execute();
}

function deletionFenced(until: Date | null): boolean {
  return until !== null && until.getTime() > Date.now();
}

function fenceUntil(): Date {
  return new Date(Date.now() + accountDeletionFenceMilliseconds);
}
