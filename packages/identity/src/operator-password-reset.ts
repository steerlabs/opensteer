import { randomBytes } from "node:crypto";
import { createId, normalizeIdentityEmail, type IdentityEmail, type UserId } from "@opensteer/core";
import type { DatabaseSchema } from "@opensteer/database";
import { sql, type Kysely } from "kysely";

const localPasswordRecoveryTokenPrefix = "olpr_";
const defaultRecoveryLifetimeMilliseconds = 30 * 60 * 1_000;

interface OperatorPasswordRecoveryLink {
  readonly email: IdentityEmail;
  readonly expiresAt: Date;
  readonly url: URL;
  readonly userId: UserId;
}

/**
 * Issues the same one-use password-reset capability Better Auth consumes, but
 * from the deployment boundary instead of an email provider. The secret rides
 * in a URL fragment, so it is not sent in the initial HTTP request or recorded
 * in access logs. Issuing a new link invalidates any older operator-issued link
 * for the same administrator.
 */
export async function issueLocalAdministratorPasswordRecovery(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly email?: string | undefined;
    readonly lifetimeMilliseconds?: number | undefined;
    readonly publicOrigin: URL;
  },
): Promise<OperatorPasswordRecoveryLink> {
  const requestedEmail = input.email ? normalizeIdentityEmail(input.email) : null;
  const lifetimeMilliseconds = input.lifetimeMilliseconds ?? defaultRecoveryLifetimeMilliseconds;
  if (!Number.isSafeInteger(lifetimeMilliseconds) || lifetimeMilliseconds < 60_000) {
    throw new Error("Password recovery lifetime must be at least one minute.");
  }
  if (input.publicOrigin.username || input.publicOrigin.password) {
    throw new Error("Opensteer public URL must not contain credentials.");
  }
  const administrator = await selectAdministrator(database, requestedEmail);
  const token = `${localPasswordRecoveryTokenPrefix}${randomBytes(32).toString("base64url")}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + lifetimeMilliseconds);

  await database.transaction().execute(async (transaction) => {
    const liveAdministrator = await transaction
      .selectFrom("users")
      .select(["id", "email", "instanceRole", "disabledAt"])
      .where("id", "=", administrator.id)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (
      !liveAdministrator ||
      liveAdministrator.instanceRole !== "administrator" ||
      liveAdministrator.disabledAt !== null
    ) {
      throw new Error("The administrator changed while recovery was being issued; try again.");
    }
    const passwordAccount = await transaction
      .selectFrom("authAccounts")
      .select("id")
      .where("userId", "=", liveAdministrator.id)
      .where("providerId", "=", "credential")
      .where("password", "is not", null)
      .executeTakeFirst();
    if (!passwordAccount) {
      throw new Error("The administrator does not have a local password account.");
    }

    await transaction
      .deleteFrom("authVerifications")
      .where("value", "=", liveAdministrator.id)
      .where("identifier", "like", `reset-password:${localPasswordRecoveryTokenPrefix}%`)
      .execute();
    await transaction
      .insertInto("authVerifications")
      .values({
        createdAt: now,
        expiresAt,
        id: createId("authVerification"),
        identifier: `reset-password:${token}`,
        updatedAt: now,
        value: liveAdministrator.id,
      })
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("securityAudit")
      .values({
        action: "auth.password-recovery-issued-by-local-operator",
        actorSessionId: null,
        actorUserId: null,
        id: createId("securityAudit"),
        metadata: sql<Readonly<Record<string, unknown>>>`${JSON.stringify({
          expiresAt: expiresAt.toISOString(),
        })}::jsonb`,
        requestId: null,
        targetId: liveAdministrator.id,
        targetType: "user",
        workspaceId: null,
      })
      .executeTakeFirstOrThrow();
  });

  const url = new URL("/recover", input.publicOrigin);
  url.hash = new URLSearchParams({ token }).toString();
  return {
    email: normalizeIdentityEmail(administrator.email),
    expiresAt,
    url,
    userId: administrator.id,
  };
}

async function selectAdministrator(
  database: Kysely<DatabaseSchema>,
  requestedEmail: IdentityEmail | null,
): Promise<{ readonly email: string; readonly id: UserId }> {
  let query = database
    .selectFrom("users")
    .select(["id", "email"])
    .where("instanceRole", "=", "administrator")
    .where("disabledAt", "is", null);
  if (requestedEmail) query = query.where("email", "=", requestedEmail);
  const administrators = await query.orderBy("createdAt", "asc").limit(2).execute();
  if (administrators.length === 0) {
    throw new Error(
      requestedEmail
        ? `No active administrator exists for ${requestedEmail}.`
        : "This Host has no active administrator to recover.",
    );
  }
  if (administrators.length > 1) {
    throw new Error("This Host has multiple administrators; specify the exact email with --email.");
  }
  return administrators[0]!;
}
