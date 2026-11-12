import { expect, it } from "vitest";
import {
  migrationProvider,
  personalTeamBaselineName,
  threadVisitsMigrationName,
} from "./migrations.js";
it("exposes the baseline and forward visit migration", async () => {
  expect(Object.keys(await migrationProvider().getMigrations())).toEqual([
    threadVisitsMigrationName,
    personalTeamBaselineName,
  ]);
  expect(personalTeamBaselineName).toBe("0002_personal_team_baseline");
});
