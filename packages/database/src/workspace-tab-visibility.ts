import type { UserId } from "@opensteer/core";
import type { Kysely, Nullable, Selectable, SelectQueryBuilder } from "kysely";
import { ownedBrowserSession } from "./browser-session-store.js";
import type { DatabaseSchema } from "./schema.js";
type Database = Kysely<DatabaseSchema>;

export type VisibleLineageDatabase = Omit<DatabaseSchema, "browserSessions" | "browserProfiles"> & {
  browserSessions: Selectable<DatabaseSchema["browserSessions"]>;
  browserProfiles: Nullable<DatabaseSchema["browserProfiles"]>;
  lineages: DatabaseSchema["browserSessions"];
};
export type VisibleLineageTables =
  "browserSessions" | "lineages" | "workspaces" | "runners" | "browserProfiles";
type VisibleLineage = Selectable<DatabaseSchema["browserSessions"]> & {
  revision: number;
  lineageCreatedAt: Date;
  retiredAt: Date | null;
};
export function visibleWorkspaceTabLineages(
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
    .innerJoin("workspaces", "workspaces.id", "browserSessions.workspaceId")
    .innerJoin("runners", "runners.id", "browserSessions.runnerId")
    .leftJoin("browserProfiles", "browserProfiles.id", "browserSessions.profileId")
    .selectAll("browserSessions")
    .select([
      "lineages.tabRevision as revision",
      "lineages.createdAt as lineageCreatedAt",
      "runners.revokedAt as retiredAt",
    ])
    .where((eb) => ownedBrowserSession(eb, ownerId))
    .where("workspaces.status", "not in", ["deleting", "deleted"]);
}
