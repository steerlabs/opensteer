import { sql, type Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";

export async function lockBrowserTabGroupMembersForTabs(
  transaction: Transaction<DatabaseSchema>,
  tabIds: readonly string[],
): Promise<void> {
  if (!tabIds.length) return;
  await transaction
    .selectFrom("browserTabGroupMembers")
    .select(["ownerId", "tabId"])
    .where("tabId", "=", sql<string>`any(${tabIds}::text[])`)
    .orderBy("ownerId")
    .orderBy("tabId")
    // FOR UPDATE: Parent-tab deletion cascades these memberships.
    .forUpdate()
    .execute();
}
