import { assertPersonalOwner } from "./private-resource-owner.js";
import { OpensteerError, type RunnerId, type UserId } from "@opensteer/core";
import { sql, type Kysely, type Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { databaseOperationOptions } from "./operation-budget.js";

async function eligibleBrowserRunners(database: Kysely<DatabaseSchema>, ownerId: UserId) {
  await assertPersonalOwner(database, ownerId);
  return database
    .selectFrom("runners")
    .select(["id", "name", "kind", "ownerKind", "ownerUserId", "allowedModules"])
    .where("revokedAt", "is", null)
    .where(sql<boolean>`allowed_modules @> '["browser"]'::jsonb`)
    .where((eb) =>
      eb.or([
        eb("ownerUserId", "=", ownerId),
        eb.and([
          eb("ownerKind", "=", "deployment"),
          eb("ownerUserId", "is", null),
          eb("kind", "=", "main"),
        ]),
      ]),
    );
}

/** Offline owner-enrolled computers remain eligible. */
export async function listEligibleBrowserRunners(
  database: Kysely<DatabaseSchema>,
  ownerId: UserId,
) {
  return (await eligibleBrowserRunners(database, ownerId))
    .orderBy("id")
    .execute(databaseOperationOptions());
}

export async function lockBrowserHomeRunner(
  transaction: Transaction<DatabaseSchema>,
  ownerId: UserId,
  homeRunnerId?: RunnerId,
): Promise<RunnerId> {
  const eligible = await eligibleBrowserRunners(transaction, ownerId);
  const candidates = await (homeRunnerId ? eligible.where("id", "=", homeRunnerId) : eligible)
    .orderBy("id")
    .limit(2)
    .forShare()
    .execute(databaseOperationOptions());
  if (!homeRunnerId && candidates.length !== 1)
    throw new OpensteerError({
      code: "conflict",
      message: "Choose a computer for this browser profile.",
    });
  const runner = candidates[0];
  if (!runner)
    throw new OpensteerError({
      code: "forbidden",
      message: "This computer cannot hold your browser profiles.",
    });
  return runner.id;
}
