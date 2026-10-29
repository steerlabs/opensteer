import { sql, type Kysely } from "kysely";
import { Migrator } from "kysely/migration";
import type { createDatabase } from "./connection.js";
import { migrationProvider } from "./migrations.js";

/** Negative controls use the same ordered production set plus one real migration. */
export async function migrateWithCompatibilityControl(
  database: ReturnType<typeof createDatabase>,
  control: "break-column" | "timeout",
  started: () => Promise<void>,
) {
  const migrator = new Migrator({
    db: database,
    provider: {
      getMigrations: async () => ({
        ...(await migrationProvider().getMigrations()),
        zzz_migration_compat_control: {
          up: async (migrationDatabase: Kysely<unknown>) => {
            await started();
            await sql
              .raw(
                control === "break-column"
                  ? "alter table users rename column display_name to incompatible_name"
                  : "select pg_sleep(31)",
              )
              .execute(migrationDatabase);
          },
        },
      }),
    },
  });
  const result = await migrator.migrateToLatest();
  if (result.error) throw new Error("Migration control failed", { cause: result.error });
}
