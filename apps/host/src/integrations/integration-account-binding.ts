import { ControlPlaneAccountIdSchema } from "@opensteer/control-plane-protocol";
import { OpensteerError, type UserId } from "@opensteer/core";
import type { DatabaseSchema } from "@opensteer/database";
import { integrationSchemaDigest } from "@opensteer/integration-core/digest";
import type { Kysely } from "kysely";
import { z } from "zod";

export const IntegrationAccountBindingSchema = z.strictObject({
  issuer: z.url(),
  linkGeneration: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  subject: ControlPlaneAccountIdSchema,
});
export type IntegrationAccountBinding = z.infer<typeof IntegrationAccountBindingSchema>;

/** Invalid internal bindings are deployment faults, never invalid user input. */
export function validateIntegrationAccountBinding(
  value: unknown,
): IntegrationAccountBinding | null {
  if (value === null) return null;
  const parsed = IntegrationAccountBindingSchema.safeParse(value);
  if (!parsed.success) {
    throw new OpensteerError({
      code: "internal",
      message: "This deployment's Opensteer Account binding is invalid",
    });
  }
  return parsed.data;
}

/** Resolve the same binding at launch and completion so replacing it invalidates outstanding consent. */
export async function resolveIntegrationAccountBinding(input: {
  readonly database: Kysely<DatabaseSchema>;
  readonly accountAttached: boolean;
  readonly kind: "personal" | "server";
  readonly ownerUserId: UserId;
}): Promise<IntegrationAccountBinding | null> {
  const { database, ownerUserId } = input;
  if (input.kind === "server" && input.accountAttached) {
    const account = await database
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
      .where("accountDirectoryProvider.singletonKey", "=", "opensteer-account")
      .executeTakeFirst();
    if (!account) return null;
    // Hash stable binding identity, not access/refresh tokens or login timestamps.
    // The row id changes on unlink/relink, even for the same issuer and subject.
    return validateIntegrationAccountBinding({
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
    });
  }
  if (input.kind !== "personal") return null;
  const owner = await database
    .selectFrom("users")
    .select("id")
    .where("id", "=", ownerUserId)
    .where("instanceRole", "=", "administrator")
    .where("disabledAt", "is", null)
    .executeTakeFirst();
  if (!owner) return null;
  const link = await database
    .selectFrom("personalRemoteAccountLink")
    .select(["issuer", "linkGeneration", "subject"])
    .where("singletonKey", "=", "opensteer-account")
    .where("state", "=", "active")
    .executeTakeFirst();
  return validateIntegrationAccountBinding(link ?? null);
}
