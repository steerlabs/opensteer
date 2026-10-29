import { loadControlPlaneMigrationConfig } from "./config.js";
import { createControlPlaneDatabase } from "./database/database.js";
import { migrateControlPlaneToLatest } from "./database/migrations.js";

async function main(): Promise<void> {
  const database = createControlPlaneDatabase({
    connectionString: loadControlPlaneMigrationConfig().databaseUrl,
  });
  try {
    await migrateControlPlaneToLatest(database);
  } finally {
    await database.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
