import type { UserId } from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";

/** Serializes future-Project consent with Project creation before either locks placements. */
export async function lockPluginOwnerConsent(database: Kysely<DatabaseSchema>, owner: UserId) {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`plugin-owner-consent:${owner}`}, 0))`.execute(
    database,
  );
}
