import { MigrationLineageError } from "@opensteer/database";
import { expect, it } from "vitest";
import { withDevelopmentDatabaseReset } from "./development-database.js";

it("tells a developer in one line how to reset a database another lineage migrated", () => {
  const lineage = new MigrationLineageError(["0002_other_lineage"]);
  const reported = withDevelopmentDatabaseReset(lineage);

  expect(reported).toBeInstanceOf(Error);
  expect((reported as Error).message).toBe(
    `${lineage.message} Reset the development database: docker compose -f deploy/compose/compose.yaml down -v && pnpm setup:local`,
  );
  expect((reported as Error).message).not.toContain("\n");
  expect((reported as Error).cause).toBe(lineage);
});

it("leaves every other startup failure as it was", () => {
  const failure = new Error("Database migration failed at 0003_example: relation exists");
  expect(withDevelopmentDatabaseReset(failure)).toBe(failure);
});
