import { expect, it } from "vitest";
import { migrationProvider, personalTeamBaselineName } from "./migrations.js";
it("exposes the fresh, uniquely named Host baseline and the migrations after it", async () => {
  expect(Object.keys(await migrationProvider().getMigrations())).toEqual([
    personalTeamBaselineName,
    "0002_browser_source_binding",
  ]);
  expect(personalTeamBaselineName).toBe("0001_personal_team_baseline");
});
