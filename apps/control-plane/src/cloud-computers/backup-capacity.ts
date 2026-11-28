import type { ExpressionBuilder, Kysely } from "kysely";
import type { ControlPlaneDatabaseSchema } from "../database/schema.js";

type DB = Kysely<ControlPlaneDatabaseSchema>;

function isFreeTarget(
  eb: ExpressionBuilder<ControlPlaneDatabaseSchema, "cloudComputerBackupTargets">,
) {
  return eb.and([
    eb("computerId", "is", null),
    eb("checkoutKey", "is", null),
    eb("purgeComputerId", "is", null),
    eb("needsRotation", "=", false),
  ]);
}

export function freeBackupTargets(db: DB) {
  return db.selectFrom("cloudComputerBackupTargets").where(isFreeTarget);
}
