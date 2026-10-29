import { CamelCasePlugin, Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import type { ControlPlaneDatabaseSchema } from "./schema.js";

export function createControlPlaneDatabase(options: {
  readonly connectionString: string;
  readonly maxConnections?: number;
}): Kysely<ControlPlaneDatabaseSchema> {
  const pool = new Pool({
    application_name: "opensteer-control-plane",
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
  });
  return new Kysely<ControlPlaneDatabaseSchema>({
    dialect: new PostgresDialect({ pool }),
    plugins: [new CamelCasePlugin()],
  });
}
