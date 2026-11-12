import { expect, it } from "vitest";
import { migrationProvider, personalTeamBaselineName } from "./migrations.js";
it("exposes the fresh, uniquely named Host baseline before its additive migrations", async () => {
  expect(Object.keys(await migrationProvider().getMigrations())).toEqual([
    personalTeamBaselineName,
    "0003_team_reusable_invites",
  ]);
  expect(personalTeamBaselineName).toBe("0002_personal_team_baseline");
});
