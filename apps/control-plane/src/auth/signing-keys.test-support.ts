import type { Kysely } from "kysely";
import type { ControlPlaneDatabaseSchema } from "../database/schema.js";

export async function resetAccountSigningKeys(database: Kysely<ControlPlaneDatabaseSchema>) {
  await database.deleteFrom("authJwks").execute();
}
