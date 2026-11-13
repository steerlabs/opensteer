import { expect, it } from "vitest";
import {
  migrationProvider,
  personalTeamBaselineName,
  threadVisitsMigrationName,
} from "./migrations.js";
it("exposes the fresh, uniquely named Host baseline and the migrations after it", async () => {
  const names = Object.keys(await migrationProvider().getMigrations());
  expect(names).toEqual([
    personalTeamBaselineName,
    "0003_browser_source_binding",
    threadVisitsMigrationName,
    "0005_thread_input_fresh_context",
    "0006_team_reusable_invites",
  ]);
  // Kysely runs migrations in name order, so a later one must also sort later.
  expect(names).toEqual(names.toSorted());
  expect(personalTeamBaselineName).toBe("0002_personal_team_baseline");
});
