import { expect, it } from "vitest";
import { migrationProvider, personalTeamBaselineName } from "./migrations.js";
it("exposes the fresh, uniquely named Host baseline and the migrations after it", async () => {
  const names = Object.keys(await migrationProvider().getMigrations());
  expect(names).toEqual([personalTeamBaselineName, "0003_browser_source_binding"]);
  // Kysely runs migrations in name order, so a later one must also sort later.
  expect(names).toEqual(names.toSorted());
  expect(personalTeamBaselineName).toBe("0002_personal_team_baseline");
});
