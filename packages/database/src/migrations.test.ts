import { expect, it } from "vitest";
import { migrationProvider, personalTeamBaselineName } from "./migrations.js";
it("exposes only the fresh, uniquely named Host baseline", async () => {
  expect(Object.keys(await migrationProvider().getMigrations())).toEqual([
    personalTeamBaselineName,
  ]);
  expect(personalTeamBaselineName).toBe("0001_personal_team_baseline");
});
