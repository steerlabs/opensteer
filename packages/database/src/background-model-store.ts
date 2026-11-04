import {
  BackgroundModelPreferencesSchema,
  emptyBackgroundModelPreferences,
  type BackgroundModelPreferences,
  type BackgroundModelMode,
  type BackgroundModelRole,
  type ModelSelection,
  type UserId,
} from "@opensteer/core";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import {
  withAdministrationTransaction,
  type AdministrationCommandIdentity,
} from "./administration-command.js";
import { jsonValue } from "./store-primitives.js";

export async function getBackgroundModelPreferences(
  database: Kysely<DatabaseSchema>,
  userId: UserId,
): Promise<BackgroundModelPreferences> {
  const row = await database
    .selectFrom("userBackgroundModelPreferences")
    .select("preferences")
    .where("userId", "=", userId)
    .executeTakeFirst();
  return row
    ? BackgroundModelPreferencesSchema.parse(row.preferences)
    : structuredClone(emptyBackgroundModelPreferences);
}
export type BackgroundModelPreferenceChange =
  | { readonly role: BackgroundModelRole; readonly mode: BackgroundModelMode }
  | { readonly providerId: ModelSelection["providerId"]; readonly acknowledged: boolean };
export async function updateBackgroundModelPreferences(
  database: Kysely<DatabaseSchema>,
  userId: UserId,
  change: BackgroundModelPreferenceChange,
  administration?: AdministrationCommandIdentity,
): Promise<BackgroundModelPreferences> {
  return withAdministrationTransaction(database, administration, async (transaction) => {
    // Lock the person, including when no preferences row exists yet.
    await transaction
      .selectFrom("users")
      .select("id")
      .where("id", "=", userId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    const preferences = await getBackgroundModelPreferences(transaction, userId);
    if ("role" in change) preferences.backgroundModels[change.role] = change.mode;
    else
      preferences.backgroundProviderConsent = change.acknowledged
        ? [...new Set([...preferences.backgroundProviderConsent, change.providerId])].sort()
        : preferences.backgroundProviderConsent.filter((id) => id !== change.providerId);
    const parsed = BackgroundModelPreferencesSchema.parse(preferences);
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
