import { expect, it } from "vitest";
import { migrationProvider, personalTeamBaselineName } from "./migrations.js";
it("exposes only the fresh, uniquely named Host baseline", async () => {
  expect(Object.keys(await migrationProvider().getMigrations())).toEqual([
    personalTeamBaselineName,
    "0003_devices",
  ]);
  expect(personalTeamBaselineName).toBe("0002_personal_team_baseline");
});
