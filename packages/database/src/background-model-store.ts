import {
  AutomaticModelConfigSchema,
  emptyAutomaticModelConfig,
  type AutomaticModelConfig,
  type UserId,
} from "@opensteer/core";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { withPersonalTransaction } from "./personal-transaction.js";
import { requirePersonalOwner } from "./personal-settings-store.js";
import { jsonValue } from "./store-primitives.js";

export async function getAutomaticModelConfig(
  database: Kysely<DatabaseSchema>,
  userId: UserId,
): Promise<AutomaticModelConfig> {
  const row = await database
    .selectFrom("personalSettings")
    .select("backgroundModelPreferences")
    .where("ownerId", "=", userId)
    .executeTakeFirst();
  return row
    ? AutomaticModelConfigSchema.parse(row.backgroundModelPreferences)
    : structuredClone(emptyAutomaticModelConfig);
}
export async function setAutomaticModelConfig(
  database: Kysely<DatabaseSchema>,
  userId: UserId,
  config: AutomaticModelConfig,
): Promise<AutomaticModelConfig> {
  return withPersonalTransaction(database, async (transaction) => {
    await requirePersonalOwner(transaction, userId);
    const parsed = AutomaticModelConfigSchema.parse(config);
    await transaction
      .updateTable("personalSettings")
      .set({ backgroundModelPreferences: jsonValue(parsed) })
      .where("ownerId", "=", userId)
      .execute();
    return parsed;
  });
}
