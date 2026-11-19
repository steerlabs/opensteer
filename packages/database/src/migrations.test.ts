import { expect, it } from "vitest";
import {
  migrationProvider,
  personalCurrentStateMigrationName,
  tabsAndAppsMigrationName,
  personalTeamBaselineName,
  teamKnowledgeNotesMigrationName,
  threadVisitsMigrationName,
} from "./migrations.js";
import { taskApprovalReceiptsMigrationName } from "./personal-state-schema.js";
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
    "0015_team_principals",
    "0016_team_partner_links",
    "0017_team_channel_shares",
    "0018_team_share_files",
    "0019_team_shared_agents",
    "0020_team_share_file_cache",
    "0021_team_share_relay_policy",
    "0022_person_names",
    "0023_agent_home_settings",
    "0024_waiting_input_edits",
    "0025_team_copies",
    "0026_tabs_and_apps",
    "0027_message_origin",
    "0028_device_drivers",
    "0029_changed_since_indexes",
    "0030_drop_specialists_contract",
    "0031_plugin_host",
    "0032_plugin_oauth",
    "0033_drop_service_integrations_contract",
    "0034_unify_local_plugin_access_contract",
    "0035_drop_stored_definition_api_key",
    "0036_one_plugin_per_owner_name",
    "0037_plugin_package_format",
    personalCurrentStateMigrationName,
    taskApprovalReceiptsMigrationName,
  ]);
  // Kysely runs migrations in name order, so a later one must also sort later.
  expect(names).toEqual(names.toSorted());
  expect(personalTeamBaselineName).toBe("0002_personal_team_baseline");
});

it("keeps post-0025 migrations compatible with a running previous Host unless marked contract", async () => {
  const { Kysely, DummyDriver, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } =
    await import("kysely");
  const statements: string[] = [];
  const db = new Kysely<Record<string, never>>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (database) => new PostgresIntrospector(database),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    plugins: [
      {
        transformQuery({ node, queryId }) {
          statements.push(new PostgresQueryCompiler().compileQuery(node, queryId).sql);
          return node;
        },
        async transformResult({ result }) {
          return result;
        },
      },
    ],
  });
  try {
    for (const [name, migration] of Object.entries(await migrationProvider().getMigrations())) {
      if (
        // Tabs/apps have an explicitly approved breaking storage migration.
        name === tabsAndAppsMigrationName ||
        name === personalCurrentStateMigrationName ||
        Number(name.slice(0, 4)) <= 25 ||
        /(?:^|_)contract(?:_|$)/u.test(name)
      )
        continue;
      statements.length = 0;
      await migration.up(db);
      const sql = statements.join("\n").replace(/--[^\n]*|\/\*[\s\S]*?\*\//gu, " ");
      expect(sql, name).not.toMatch(
        /\bdrop\s+(?:table|column)\b|\brename\s+(?:to|column)\b|\balter\s+column\s+[^;]*?\b(?:type|set\s+not\s+null)\b/iu,
      );
    }
  } finally {
    await db.destroy();
  }
});
