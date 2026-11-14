import { expect, it } from "vitest";
import {
  migrationProvider,
  personalTeamBaselineName,
  teamKnowledgeNotesMigrationName,
  threadVisitsMigrationName,
} from "./migrations.js";
it("exposes the fresh, uniquely named Host baseline and the migrations after it", async () => {
  const names = Object.keys(await migrationProvider().getMigrations());
  expect(names).toEqual([
    personalTeamBaselineName,
    "0003_browser_source_binding",
    threadVisitsMigrationName,
    "0005_thread_input_fresh_context",
    teamKnowledgeNotesMigrationName,
    "0007_team_reusable_invites",
    "0008_devices",
    "0009_device_access_requests",
    "0010_device_setup_retirement",
    "0011_team_agent_contracts",
    "0012_team_agent_asks",
    "0013_personal_team_posts",
    "0014_claude_idle_compaction",
  ]);
  // Kysely runs migrations in name order, so a later one must also sort later.
  expect(names).toEqual(names.toSorted());
  expect(personalTeamBaselineName).toBe("0002_personal_team_baseline");
});
