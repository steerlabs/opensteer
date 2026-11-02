import { OpensteerError, type UserId } from "@opensteer/core";
import { integrationSchemaDigest } from "@opensteer/integration-core/digest";
import type {
  IntegrationOAuthAccountBinding,
  IntegrationOAuthAccountBindingValue,
} from "@opensteer/integration-core/ports";
import type { Kysely, Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";

/** Resolve the same binding at launch and completion so replacing it invalidates outstanding consent. */
export async function readIntegrationAccountBinding(input: {
  readonly database: Kysely<DatabaseSchema>;
  readonly lock?: boolean;
  readonly accountAttached: boolean;
  readonly kind: "personal" | "server";
  readonly ownerUserId: UserId;
}): Promise<IntegrationOAuthAccountBindingValue | null> {
  const { database, ownerUserId } = input;
  if (input.kind === "server" && input.accountAttached) {
    let accountQuery = database
      .selectFrom("authAccounts")
      .innerJoin(
        "accountDirectoryProvider",
        "accountDirectoryProvider.providerId",
        "authAccounts.providerId",
      )
      .innerJoin("users", "users.id", "authAccounts.userId")
      .select([
        "authAccounts.id as bindingId",
        "authAccounts.accountId as subject",
        "accountDirectoryProvider.providerId as providerId",
        "accountDirectoryProvider.issuer as issuer",
        "accountDirectoryProvider.updatedAt as providerUpdatedAt",
      ])
      .where("authAccounts.userId", "=", ownerUserId)
      .where("authAccounts.password", "is", null)
      .where("users.disabledAt", "is", null)
      .where("accountDirectoryProvider.singletonKey", "=", "opensteer-account");
    if (input.lock)
      accountQuery = accountQuery.forShare(["authAccounts", "accountDirectoryProvider", "users"]);
    const account = await accountQuery.executeTakeFirst();
    if (!account) return null;
    // Hash stable binding identity, not access/refresh tokens or login timestamps.
    // The row id changes on unlink/relink, even for the same issuer and subject.
    return {
      issuer: account.issuer,
      subject: account.subject,
      linkGeneration: integrationSchemaDigest({
        kind: "server-account-binding",
        bindingId: account.bindingId,
        issuer: account.issuer,
        subject: account.subject,
        providerId: account.providerId,
        providerUpdatedAt: account.providerUpdatedAt.toISOString(),
      }),
    };
  }
  if (input.kind !== "personal") return null;
  let ownerQuery = database
    .selectFrom("users")
    .select("id")
    .where("id", "=", ownerUserId)
    .where("instanceRole", "=", "administrator")
    .where("disabledAt", "is", null);
  if (input.lock) ownerQuery = ownerQuery.forShare();
  const owner = await ownerQuery.executeTakeFirst();
  if (!owner) return null;
  let linkQuery = database
    .selectFrom("personalRemoteAccountLink")
    .select(["issuer", "linkGeneration", "subject"])
    .where("singletonKey", "=", "opensteer-account")
    .where("state", "=", "active");
  if (input.lock) linkQuery = linkQuery.forShare();
  const link = await linkQuery.executeTakeFirst();
  return link ?? null;
}

/** Hold the binding through commit so unlink/relink cannot race credential creation. */
export async function requireIntegrationAccountBinding(
  transaction: Transaction<DatabaseSchema>,
  ownerUserId: UserId,
  expected: IntegrationOAuthAccountBinding,
): Promise<void> {
  const current = await readIntegrationAccountBinding({
    database: transaction,
    ownerUserId,
    kind: expected.kind,
    accountAttached: true,
    lock: true,
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
