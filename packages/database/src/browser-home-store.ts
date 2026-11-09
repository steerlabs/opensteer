import { OpensteerError, type RunnerId, type UserId } from "@opensteer/core";
import { sql, type Kysely, type Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { databaseOperationOptions } from "./operation-budget.js";

function eligibleBrowserRunners(database: Kysely<DatabaseSchema>, ownerId: UserId) {
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
          eb.or([
            eb("kind", "=", "main"),
            eb.not(
              eb.exists(
                eb
                  .selectFrom("deployments")
                  .select("id")
                  .where(sql<string>`deployment_shape->>'kind'`, "=", "personal"),
              ),
            ),
          ]),
        ]),
      ]),
    );
}

/** Offline computers remain eligible; Workspace membership confers no computer authority. */
export function listEligibleBrowserRunners(database: Kysely<DatabaseSchema>, ownerId: UserId) {
  return eligibleBrowserRunners(database, ownerId)
    .orderBy("id")
    .execute(databaseOperationOptions());
}

export async function lockBrowserHomeRunner(
  transaction: Transaction<DatabaseSchema>,
  ownerId: UserId,
  homeRunnerId?: RunnerId,
): Promise<RunnerId> {
  const candidates = homeRunnerId
    ? undefined
    : await listEligibleBrowserRunners(transaction, ownerId);
  const selected = homeRunnerId ?? (candidates?.length === 1 ? candidates[0]?.id : undefined);
  if (!selected)
    throw new OpensteerError({
      code: "conflict",
      message: "Choose a computer for this browser profile.",
    });
  const runner = await eligibleBrowserRunners(transaction, ownerId)
    .where("id", "=", selected)
    .forShare()
    .executeTakeFirst(databaseOperationOptions());
  if (!runner)
    throw new OpensteerError({
      code: "forbidden",
      message: "This computer cannot hold your browser profiles.",
    });
  return runner.id;
}
