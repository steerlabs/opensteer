import { sql, type Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";

const signInExpiry = sql<string>`payload->>'expiresAt'`;
const pendingSignIn = sql<boolean>`kind = 'browser.password-sign-in' and status = 'pending'`;

export async function nextPersonalRequestDeadline(database: Kysely<DatabaseSchema>) {
  const result = await sql<{ deadline: Date | null }>`
    select least(
      (select (payload->>'expiresAt')::timestamptz from requests
       where ${pendingSignIn} order by payload->>'expiresAt', id limit 1),
      (select edit_lease_expires_at from thread_inputs
       where edit_lease_id is not null and edit_lease_expires_at is not null
       order by edit_lease_expires_at limit 1),
      (select expires_at from computer_app_setup_requests order by expires_at limit 1)
    ) as deadline
  `.execute(database);
  return result.rows[0]?.deadline ?? null;
}

export function expiredPersonalSignInRequests(database: Kysely<DatabaseSchema>, now: Date) {
  return database
    .selectFrom("requests")
    .select(["id", "requestedBy"])
    .where(pendingSignIn)
    .where(signInExpiry, "<=", now.toISOString())
    .orderBy(signInExpiry)
    .orderBy("id")
    .limit(128)
    .execute();
}
