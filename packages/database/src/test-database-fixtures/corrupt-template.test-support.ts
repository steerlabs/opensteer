import { sql } from "kysely";
import type { TestProject } from "vitest/node";
import setup from "../integration-global-setup.test-support.js";
import { migrationProvider } from "../migrations.js";

export default async function corruptTemplate(project: TestProject) {
  const baseline = (await migrationProvider().getMigrations())["0001_baseline"]!;
  const original = baseline.up;
  baseline.up = async (database) => {
    await sql.raw("deliberately invalid migration SQL").execute(database);
  };
  try {
    return await setup(project);
  } finally {
    baseline.up = original;
  }
}
