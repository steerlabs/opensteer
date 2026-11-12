import { sql } from "kysely";
import type { TestProject } from "vitest/node";
import setup from "../integration-global-setup.test-support.js";
import { createDatabase } from "../connection.js";
import { migrateToLatest, personalTeamBaselineName } from "../migrations.js";

export default async function corruptTemplate(project: TestProject) {
  return setup(project, {
    async migrate(_authority, url) {
      const database = createDatabase({ connectionString: url });
      try {
        await migrateToLatest(database, {
          async getMigrations() {
            return {
              [personalTeamBaselineName]: {
                async up(transaction) {
                  await sql.raw("deliberately invalid migration SQL").execute(transaction);
                },
              },
            };
          },
        });
      } finally {
        await database.destroy();
      }
    },
  });
}
