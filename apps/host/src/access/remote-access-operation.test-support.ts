import { randomUUID } from "node:crypto";
import type { DatabaseSchema } from "@opensteer/database";
import type { PersonalRemoteAccessMode } from "@opensteer/protocol";
import { sql, type Kysely } from "kysely";

/**
 * Runs a Remote access configure step as the Mac app does: the step of an operation the door
 * admitted. Records the person's unfinished request for this mode, runs the step, then removes
 * that record, so the Home's executor-step rule (AD10) sees what a real request leaves behind.
 */
export async function asRemoteAccessStep<Result>(
  database: Kysely<DatabaseSchema>,
  mode: PersonalRemoteAccessMode,
  step: () => Promise<Result>,
  privateOrigin: string | null = null,
): Promise<Result> {
  const owner = await database
    .selectFrom("users")
    .select("id")
    .orderBy(sql`created_at`)
    .limit(1)
    .executeTakeFirstOrThrow();
  // Only one change at a time: an earlier one this fixture left is finished first.
  await database
    .updateTable("personalRemoteAdministration")
    .set({ state: "succeeded", updatedAt: new Date() })
    .where("state", "in", ["pending", "running"])
    .execute();
  const id = randomUUID();
  const intent = {
    action: "configure" as const,
    mode,
    privateOrigin: mode === "private" ? privateOrigin : null,
  };
  await database
    .insertInto("personalRemoteAdministration")
    .values({
      id,
      executionId: id,
      requestedIntent: JSON.stringify(intent) as never,
      requestedBy: owner.id,
      idempotencyKey: randomUUID(),
      intent: JSON.stringify(intent) as never,
      state: "running",
      detail: null,
    })
    .execute();
  try {
    return await step();
  } finally {
    // The fixture's stand-in leaves no trace: a test reads only what the Home itself recorded.
    await database.deleteFrom("personalRemoteAdministration").where("id", "=", id).execute();
  }
}
