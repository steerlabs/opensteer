import { OpensteerError, type UserId } from "@opensteer/core";
import type {
  IntegrationOAuthAccountBinding,
  IntegrationOAuthAccountBindingValue,
} from "@opensteer/integration-core/ports";
import type { Kysely, Transaction } from "kysely";
import { requirePersonalOwner } from "./personal-settings-store.js";
import type { DatabaseSchema } from "./schema.js";

/** Resolve the same binding at launch and completion so replacing it invalidates outstanding consent. */
export async function readIntegrationAccountBinding(input: {
  readonly database: Kysely<DatabaseSchema>;
  readonly lock?: boolean;
  readonly ownerUserId: UserId;
}): Promise<IntegrationOAuthAccountBindingValue | null> {
  const { database, ownerUserId } = input;
  await requirePersonalOwner(database, ownerUserId);
  let linkQuery = database
    .selectFrom("personalRemoteAccountLink")
    .select(["issuer", "linkGeneration", "subject"])
    .where("singletonKey", "=", "opensteer-account")
    .where("state", "=", "active");
  if (input.lock) linkQuery = linkQuery.forShare();
  const link = await linkQuery.executeTakeFirst();
  if (!link) return null;
  let ownerQuery = database
    .selectFrom("users")
    .select("id")
    .where("id", "=", ownerUserId)
    .where("disabledAt", "is", null);
  if (input.lock) ownerQuery = ownerQuery.forShare();
  const owner = await ownerQuery.executeTakeFirst();
  if (!owner) return null;
  return link;
}

/** Refuse a changed binding before doing credential work, without taking identity locks. */
export function checkIntegrationAccountBinding(
  transaction: Transaction<DatabaseSchema>,
  ownerUserId: UserId,
  expected: IntegrationOAuthAccountBinding,
): Promise<void> {
  return validateIntegrationAccountBinding(transaction, ownerUserId, expected, false);
}

/** Hold the binding through commit so unlink/relink cannot race credential creation. */
export function requireIntegrationAccountBinding(
  transaction: Transaction<DatabaseSchema>,
  ownerUserId: UserId,
  expected: IntegrationOAuthAccountBinding,
): Promise<void> {
  return validateIntegrationAccountBinding(transaction, ownerUserId, expected, true);
}

async function validateIntegrationAccountBinding(
  transaction: Transaction<DatabaseSchema>,
  ownerUserId: UserId,
  expected: IntegrationOAuthAccountBinding,
  lock: boolean,
): Promise<void> {
  const current = await readIntegrationAccountBinding({
    database: transaction,
    ownerUserId,
    lock,
  });
  if (
    !current ||
    current.issuer !== expected.issuer ||
    current.subject !== expected.subject ||
    current.linkGeneration !== expected.linkGeneration
  ) {
    throw new OpensteerError({
      code: "conflict",
      reason: "account-link-mismatch",
      message: "Opensteer Account changed during consent. Start sign-in again.",
    });
  }
}
