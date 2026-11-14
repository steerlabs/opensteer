import { sql, type Kysely } from "kysely";
import { Migrator, type MigrationProvider, type MigrationResultSet } from "kysely/migration";
import { migrateTeamAgentAsks } from "./team-agent-asks-migration.js";
import { migrateTeamAgents } from "./team-agent-migration.js";
import { migrateTeamPrincipals } from "./team-principals-migration.js";
import { PERSONAL_TEAM_BASELINE_SQL } from "./baseline-schema.js";
import { TEAM_KNOWLEDGE_NOTES_SQL } from "./team-knowledge-schema.js";
import type { DatabaseSchema } from "./schema.js";

/**
 * One current reusable invite per team, with unlimited (`null`) or capped uses. Its verifier is
 * also sealed so managers can show the same link again; earlier single-use rows stay valid.
 */
const TEAM_REUSABLE_INVITES_SQL = `
alter table team_invites alter column max_uses drop not null;
alter table team_invites drop constraint team_invites_check;
alter table team_invites add constraint team_invites_uses check ((max_uses is null or max_uses between 1 and 1000) and used_count >= 0 and (max_uses is null or used_count <= max_uses));
alter table team_invites add column sealed_verifier bytea;
create unique index team_invites_current on team_invites((true)) where sealed_verifier is not null and revoked_at is null;
`;

export const personalTeamBaselineName = "0002_personal_team_baseline";
export const threadVisitsMigrationName = "0004_thread_visits";
export const teamKnowledgeNotesMigrationName = "0006_team_knowledge_notes";
export const teamAgentMigrationName = "0011_team_agent_contracts";
export const teamAgentAsksMigrationName = "0012_team_agent_asks";
export const teamPrincipalsMigrationName = "0014_team_principals";
export function migrationProvider(): MigrationProvider {
  return {
    async getMigrations() {
      return {
        [personalTeamBaselineName]: {
          async up(database) {
            await sql.raw(PERSONAL_TEAM_BASELINE_SQL).execute(database);
          },
        },
        "0003_browser_source_binding": {
          /** The destination a source paired on; null until a source paired before this binds. */
          async up(database) {
            await sql`alter table browser_sources add column paired_origin text, add column paired_route_generation integer`.execute(
              database,
            );
          },
        },
        [threadVisitsMigrationName]: {
          async up(database) {
            await sql`update runs set completed_at = least(date_trunc('milliseconds', completed_at), date_trunc('milliseconds', now())) where completed_at is not null`.execute(
              database,
            );
            await sql`alter table messages alter column created_at set default date_trunc('milliseconds', clock_timestamp())`.execute(
              database,
            );
            await sql`create table thread_visits (
              thread_id text not null references threads(id) on delete cascade,
              user_id text not null references users(id) on delete cascade,
              last_visited_at timestamptz not null, updated_at timestamptz not null,
              primary key(thread_id, user_id))`.execute(database);
            await sql`insert into thread_visits(thread_id, user_id, last_visited_at, updated_at)
              select thread.id, settings.owner_id,
                case when latest.completed_at is not null and exists (
                  select 1 from messages message
                  left join thread_inputs inbox on inbox.message_id = message.id
                  where message.thread_id = thread.id and message.sequence > coalesce(marker.sequence, -1)
                    and date_trunc('milliseconds', message.created_at) <= latest.completed_at
                    and message.kind in ('input', 'assistant', 'run-result')
                    and (inbox.message_id is null or inbox.state = 'delivered' or (inbox.policy = 'report' and inbox.state <> 'cancelled'))
                    and (message.author->>'kind' <> 'human'
                      or coalesce(message.author->>'userId', inbox.requested_by) is distinct from settings.owner_id)
                    and (thread.purpose <> 'voice' or message.kind in ('assistant', 'run-result') or message.author->>'kind' = 'human')
                ) then latest.completed_at - interval '1 millisecond'
                  else coalesce(latest.completed_at, least(marker.updated_at, now()), now()) end,
                least(coalesce(marker.updated_at, thread.updated_at), now())
              from threads thread cross join personal_settings settings
              left join thread_read_markers marker on marker.thread_id = thread.id and marker.user_id = settings.owner_id
              left join lateral (select case when status in ('completed', 'failed', 'interrupted') then completed_at end as completed_at
                from runs where thread_id = thread.id order by run_ordinal desc limit 1) latest on true`.execute(
              database,
            );
            await sql`drop table thread_read_markers`.execute(database);
          },
        },
        "0005_thread_input_fresh_context": {
          async up(database) {
            await sql`alter table thread_inputs add column fresh_context boolean not null default false`.execute(
              database,
            );
            await sql`create or replace view thread_work_inputs as select * from thread_inputs where policy in ('queue','steer')`.execute(
              database,
            );
          },
        },
        [teamKnowledgeNotesMigrationName]: {
          /** Team knowledge becomes notes in topics, read and written through the Host's own connection. */
          async up(database) {
            await sql.raw(TEAM_KNOWLEDGE_NOTES_SQL).execute(database);
          },
        },
        "0007_team_reusable_invites": {
          async up(database) {
            await sql.raw(TEAM_REUSABLE_INVITES_SQL).execute(database);
          },
        },
        "0008_devices": {
          async up(database) {
            await sql`
              update runners set access_policy =
                jsonb_build_object('browser', true, 'apps', true) || access_policy;
              alter table auth_sessions add column device_id text null references runners(id);
              create index auth_sessions_device_id_idx on auth_sessions(device_id);
              alter table runner_enrollments add column initial_access jsonb null;
              alter table runner_enrollments add column prepared_identity jsonb null;
            `.execute(database);
          },
        },
        "0009_device_access_requests": {
          async up(database) {
            await sql`
              alter table agent_control_requests drop constraint agent_control_requests_action_check;
              alter table agent_control_requests add constraint agent_control_requests_action_check check (action in ('assignment.cancel', 'device.access.request', 'machine.full-disk-access.request', 'browser.access.request', 'browser.sign-in', 'browser.profile.create', 'browser.profile.list', 'browser.session.close', 'browser.session.list', 'browser.tab.read', 'browser.tab.write', 'browser.session.open', 'request.list', 'request.withdraw', 'thread.delegate', 'thread.list', 'thread.message', 'person.message', 'person.show', 'thread.read', 'thread.write', 'trigger.read', 'trigger.write', 'environment.list'));
              alter table agent_control_requests drop constraint agent_control_requests_action_class_check;
              alter table agent_control_requests add constraint agent_control_requests_action_class_check check (action_class in ('assignment.cancel', 'device.access.request', 'machine.full-disk-access.request', 'browser.access.request', 'browser.sign-in', 'browser.profile.create', 'browser.profile.list', 'browser.session.close', 'browser.session.list', 'browser.tab.read', 'browser.tab.write', 'browser.session.open', 'request.list', 'request.withdraw', 'thread.delegate', 'thread.list', 'thread.message', 'person.show', 'thread.read', 'thread.write', 'trigger.read', 'trigger.write', 'environment.list'));
            `.execute(database);
          },
        },
        "0010_device_setup_retirement": {
          async up(database) {
            await sql`create table device_setup_retirements (
              runner_id text not null,
              public_key_pem text not null,
              primary key (runner_id, public_key_pem)
            )`.execute(database);
          },
        },
        [teamAgentMigrationName]: { up: migrateTeamAgents },
        [teamAgentAsksMigrationName]: { up: migrateTeamAgentAsks },
        "0013_personal_team_posts": {
          async up(database) {
            await sql`create table personal_team_posts (
              team_deployment_id text not null references personal_team_links(team_deployment_id) on delete cascade,
              client_message_id uuid not null,
              local_link_id text not null,
              remote_link_id text not null,
              run_id text not null references runs(id) on delete cascade,
              message_id bigint,
              channel_id text not null,
              thread_root_id bigint,
              target_bindings jsonb not null,
              mentioned_agent_handles text[] not null,
              body_markdown text not null,
              attachment_ids jsonb not null,
              request_id text,
              created_at timestamptz not null default now(),
              primary key(team_deployment_id, client_message_id)
            );
            create index personal_team_posts_expiry on personal_team_posts(created_at);
            create unique index personal_team_returns_post_target on personal_team_requests (
              team_deployment_id, (return_payload->>'triggerClientMessageId'), (return_payload->'author'->>'handle')
            ) where return_admission = 'admitted' and return_payload->>'triggerClientMessageId' is not null`.execute(
              database,
            );
          },
        },
        [teamPrincipalsMigrationName]: { up: migrateTeamPrincipals },
      };
    },
  };
}
export class MigrationLineageError extends Error {
  readonly unknownMigrations: readonly string[];
  constructor(unknownMigrations: readonly string[], options?: ErrorOptions) {
    super(
      `This database belongs to an earlier or unknown Opensteer lineage (${unknownMigrations.join(", ")}). Start with a fresh database.`,
      options,
    );
    this.name = "MigrationLineageError";
    this.unknownMigrations = unknownMigrations;
  }
}
export async function migrateToLatest(
  database: Kysely<DatabaseSchema>,
  provider: MigrationProvider = migrationProvider(),
): Promise<MigrationResultSet> {
  const ledger = await sql<{
    exists: boolean;
  }>`select to_regclass('public.kysely_migration') is not null as exists`.execute(database);
  let hasAppliedMigrations = false;
  if (ledger.rows[0]?.exists) {
    const known = new Set(Object.keys(await provider.getMigrations()));
    const applied = await sql<{
      name: string;
    }>`select name from public.kysely_migration order by name`.execute(database);
    hasAppliedMigrations = applied.rows.length > 0;
    const unknown = applied.rows.map((row) => row.name).filter((name) => !known.has(name));
    if (unknown.length) throw new MigrationLineageError(unknown);
  }
  if (!hasAppliedMigrations) {
    const existing = await sql<{
      name: string;
    }>`select tablename as name from pg_tables where schemaname='public' and tablename not in ('kysely_migration','kysely_migration_lock') order by tablename`.execute(
      database,
    );
    if (existing.rows.length) throw new MigrationLineageError(["unversioned-database"]);
  }
  const result = await new Migrator({ db: database, provider }).migrateToLatest();
  const failure = result.results?.find((entry) => entry.status === "Error");
  if (result.error || failure)
    throw new Error(`Database migration failed${failure ? ` at ${failure.migrationName}` : ""}`, {
      cause: result.error,
    });
  return result;
}
