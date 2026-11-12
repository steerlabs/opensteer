import type { TestProject } from "vitest/node";
import setup from "../packages/database/src/integration-global-setup.test-support.js";
import { createDatabase } from "../packages/database/src/connection.js";
import { migrateToLatest } from "../packages/database/src/migrations.js";
import { runMigrationPhase } from "./migration-compat.test-support.js";

export default function setupPreviousRelease(project: TestProject) {
  const root = process.env.OPENSTEER_MIGRATION_BASELINE_ROOT;
  if (!root) throw new Error("Use pnpm test:migration-compat to resolve the released baseline");
  return setup(project, {
    migrate: async (authority, url) => {
      if (authority === "controlPlane") await runMigrationPhase(root, "migrate", authority, url);
      else {
        const database = createDatabase({ connectionString: url });
        try {
          await migrateToLatest(database);
        } finally {
          await database.destroy();
        }
      }
    },
  });
}
