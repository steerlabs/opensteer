import {
  OpensteerError,
  nextMarkColor,
  type EnvironmentId,
  type HarnessInstanceId,
  type UserId,
  type ThreadTitleSource,
} from "@opensteer/core";
import type { InsertObject, Transaction } from "kysely";
import type { DatabaseSchema, ThreadRow } from "./schema.js";
import { requireExecutionEnvironmentAccess } from "./store-primitives.js";

type ThreadParents = {
  readonly createdBy: UserId;
  readonly environmentId: EnvironmentId;
  readonly harnessInstanceId: HarnessInstanceId;
};
type ThreadValues = Omit<
  InsertObject<DatabaseSchema, "threads">,
  keyof ThreadParents | "titleSource" | "color"
> & {
  readonly titleSource: ThreadTitleSource;
};

/**
 * Acquire the parent prefix in ./lock-order.ts. Returning the inserter lets
 * callers check lineage under
 * Thread locks without acquiring parent locks in the opposite order. All Thread
 * creators share this boundary: FK KEY SHARE proves existence, not live authority.
 */
export async function prepareThreadInsertion(
  transaction: Transaction<DatabaseSchema>,
  parents: ThreadParents,
): Promise<(values: ThreadValues) => Promise<ThreadRow>> {
  await transaction
    .selectFrom("executionEnvironments")
    .select("id")
    .where("id", "=", parents.environmentId)
    .forShare()
    .executeTakeFirst();
  await requireExecutionEnvironmentAccess(
    transaction,
    parents.environmentId,
    parents.createdBy,
    "Execution environment is not available to this user",
  );
  const profile = await transaction
    .selectFrom("harnessInstances")
    .select(["enabled", "environmentId", "removedAt"])
    .where("id", "=", parents.harnessInstanceId)
    .forShare()
    .executeTakeFirst();
  if (!profile) throw new OpensteerError({ code: "not_found", message: "AI engine not found" });
  if (profile.environmentId !== parents.environmentId) {
    throw new OpensteerError({
      code: "bad_request",
      message: "AI engine belongs to a different execution environment",
    });
  }
  if (!profile.enabled || profile.removedAt !== null) {
    throw new OpensteerError({ code: "conflict", message: "AI engine is unavailable" });
  }
  return async (values) => {
    const recent = await transaction
      .selectFrom("threads")
      .select("color")
      .where("createdBy", "=", parents.createdBy)
      .orderBy("createdAt", "desc")
      .orderBy("id", "desc")
      .limit(6)
      .execute();
    return transaction
      .insertInto("threads")
      .values({ ...values, ...parents, color: nextMarkColor(recent.map((row) => row.color)) })
      .returningAll()
      .executeTakeFirstOrThrow();
  };
}
