import { expect, it } from "vitest";
import { migrationProvider, personalTeamBaselineName } from "./migrations.js";
it("exposes the Host baseline followed by ordered incremental migrations", async () => {
  expect(Object.keys(await migrationProvider().getMigrations())).toEqual([
    personalTeamBaselineName,
    "0004_thread_input_fresh_context",
  ]);
  expect(personalTeamBaselineName).toBe("0002_personal_team_baseline");
});
