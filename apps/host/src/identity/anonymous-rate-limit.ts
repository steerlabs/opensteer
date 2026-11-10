import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { DatabaseSchema } from "@opensteer/database";

export async function consumeAnonymousRateLimit(
  database: Kysely<DatabaseSchema>,
  key: string,
  maximum: number,
  now: Date,
  windowMilliseconds = 60_000,
): Promise<boolean> {
  return database.transaction().execute(async (transaction) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(transaction);
    const current = await transaction
      .selectFrom("authRateLimits")
      .selectAll()
      .where("key", "=", key)
      .executeTakeFirst();
    const nowMilliseconds = now.getTime();
    const count =
      current && nowMilliseconds - Number(current.lastRequest) < windowMilliseconds
        ? current.count + 1
        : 1;
    if (current) {
      await transaction
        .updateTable("authRateLimits")
        .set({ count, lastRequest: nowMilliseconds })
        .where("id", "=", current.id)
        .executeTakeFirstOrThrow();
    } else {
      await transaction
        .insertInto("authRateLimits")
        .values({ id: randomUUID(), key, count, lastRequest: nowMilliseconds })
        .executeTakeFirstOrThrow();
    }
    return count <= maximum;
  });
}
