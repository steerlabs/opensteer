import type { UserId } from "@opensteer/core";
import type { Kysely, Nullable, Selectable, SelectQueryBuilder } from "kysely";
import type { DatabaseSchema } from "./schema.js";
type Database = Kysely<DatabaseSchema>;

export type VisibleLineageDatabase = Omit<DatabaseSchema, "browserSessions" | "browserProfiles"> & {
  browserSessions: Selectable<DatabaseSchema["browserSessions"]>;
  browserProfiles: Nullable<DatabaseSchema["browserProfiles"]>;
  lineages: DatabaseSchema["browserSessions"];
};
export type VisibleLineageTables = "browserSessions" | "lineages" | "runners" | "browserProfiles";
type VisibleLineage = Selectable<DatabaseSchema["browserSessions"]> & {
  revision: number;
  lineageCreatedAt: Date;
  retiredAt: Date | null;
};
export function visiblePersonalTabLineages(
  database: Database,
  ownerId: UserId,
): SelectQueryBuilder<VisibleLineageDatabase, VisibleLineageTables, VisibleLineage> {
  const latest = database
    .selectFrom("browserSessions")
    .selectAll()
    .distinctOn("tabGroupId")
    .orderBy("tabGroupId")
    .orderBy("createdAt", "desc")
    .orderBy("id", "desc")
    .as("browserSessions");
  return database
    .selectFrom(latest)
    .innerJoin("browserSessions as lineages", "lineages.id", "browserSessions.tabGroupId")
    .innerJoin("runners", "runners.id", "browserSessions.runnerId")
    .leftJoin("browserProfiles", "browserProfiles.id", "browserSessions.profileId")
    .selectAll("browserSessions")
    .select([
      "lineages.tabRevision as revision",
      "lineages.createdAt as lineageCreatedAt",
      "runners.revokedAt as retiredAt",
    ])
    .where((eb) =>
      eb.and([
        eb.exists(
          eb
            .selectFrom("personalSettings")
            .innerJoin("users", "users.id", "personalSettings.ownerId")
            .select("personalSettings.ownerId")
            .where("personalSettings.ownerId", "=", ownerId)
            .where("users.disabledAt", "is", null),
        ),
        // Archived profiles retain saved descriptors, never live-session authority.
        eb.or([
          eb("browserProfiles.ownerId", "=", ownerId),
          eb("browserSessions.profileId", "is", null),
        ]),
      ]),
    );
}
