import { OpensteerError } from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { boundedWindowLimit, safeGeneration } from "./store-primitives.js";
import type { SecurityEffectRecord } from "./workspace-membership-store.js";

export { failActiveRunsForAccessRevocation } from "./execution-recovery.js";

export interface AccessSecurityEffect extends SecurityEffectRecord {
  readonly membershipGenerationCutoff: number;
}

export async function claimAccessSecurityEffects(
  database: Kysely<DatabaseSchema>,
  input: { readonly now: Date; readonly leaseUntil: Date; readonly limit: number },
): Promise<readonly AccessSecurityEffect[]> {
  if (input.leaseUntil <= input.now)
    throw new OpensteerError({ code: "bad_request", message: "Effect lease must be future" });
  return database.transaction().execute(async (transaction) => {
    const rows = await transaction
      .selectFrom("securityEffects")
      .selectAll()
      .where("causeId", "is not", null)
      .where("status", "in", ["pending", "processing"])
      .where("nextAttemptAt", "<=", input.now)
      .orderBy("id")
      .limit(boundedWindowLimit(input.limit, 100))
      .forNoKeyUpdate()
      .skipLocked()
      .execute();
    if (!rows.length) return [];
    await transaction
      .updateTable("securityEffects")
      .set({
        attempts: sql`attempts + 1`,
        lastError: null,
        nextAttemptAt: input.leaseUntil,
        status: "processing",
        updatedAt: input.now,
      })
      .where(
        "id",
        "in",
        rows.map((row) => row.id),
      )
      .execute();
    return rows.map((row) => ({
      attempts: row.attempts + 1,
      id: row.id,
      kind: row.kind,
      membershipGeneration: safeGeneration(row.membershipGeneration),
      membershipGenerationCutoff: Number(row.membershipGenerationCutoff),
      userId: row.userId,
      workspaceId: row.workspaceId,
    }));
  });
}
