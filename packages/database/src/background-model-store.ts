import {
  AutomaticModelConfigSchema,
  emptyAutomaticModelConfig,
  type AutomaticModelConfig,
  type UserId,
} from "@opensteer/core";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import {
  withAdministrationTransaction,
  type AdministrationCommandIdentity,
} from "./administration-command.js";
import { jsonValue } from "./store-primitives.js";

export async function getAutomaticModelConfig(
  database: Kysely<DatabaseSchema>,
  userId: UserId,
): Promise<AutomaticModelConfig> {
  const row = await database
    .selectFrom("userBackgroundModelPreferences")
    .select("preferences")
    .where("userId", "=", userId)
    .executeTakeFirst();
  return row
    ? AutomaticModelConfigSchema.parse(row.preferences)
    : structuredClone(emptyAutomaticModelConfig);
}
export async function setAutomaticModelConfig(
  database: Kysely<DatabaseSchema>,
  userId: UserId,
  config: AutomaticModelConfig,
  administration?: AdministrationCommandIdentity,
): Promise<AutomaticModelConfig> {
  return withAdministrationTransaction(database, administration, async (transaction) => {
    // Lock the person, including when no preferences row exists yet.
    await transaction
      .selectFrom("users")
      .select("id")
      .where("id", "=", userId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    const parsed = AutomaticModelConfigSchema.parse(config);
    await transaction
      .insertInto("userBackgroundModelPreferences")
      .values({ userId, preferences: jsonValue(parsed), updatedAt: new Date() })
      .onConflict((conflict) =>
        conflict
          .column("userId")
          .doUpdateSet({ preferences: jsonValue(parsed), updatedAt: new Date() }),
      )
      .execute();
    return parsed;
  });
}
