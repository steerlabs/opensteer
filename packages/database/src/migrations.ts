import { DEVICE_DRIVERS_SQL, deviceDriversMigrationName } from "./device-model-migration.js";
export { deviceDriversMigrationName } from "./device-model-migration.js";
import { TABS_AND_APPS_SQL, tabsAndAppsMigrationName } from "./tabs-apps-migration.js";
export { tabsAndAppsMigrationName } from "./tabs-apps-migration.js";
import { localMachineOwnerEmail } from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import { Migrator, type MigrationProvider, type MigrationResultSet } from "kysely/migration";
import { migrateTeamAgentAsks } from "./team-agent-asks-migration.js";
import { migrateTeamAgents } from "./team-agent-migration.js";
import { migrateTeamSharedAgents } from "./team-shared-agents-migration.js";
import { migrateTeamChannelShares } from "./team-shares-migration.js";
import { migrateTeamShareFiles } from "./team-share-files-migration.js";
import { migrateTeamShareFileCache } from "./team-share-file-cache-migration.js";
import { migrateTeamPartnerLinks } from "./team-partner-links-migration.js";
import { migrateTeamPrincipals } from "./team-principals-migration.js";
import { PERSONAL_TEAM_BASELINE_SQL } from "./baseline-schema.js";
import { TEAM_COPIES_SQL, teamCopiesMigrationName } from "./team-copies-migration.js";
import { TEAM_KNOWLEDGE_NOTES_SQL } from "./team-knowledge-schema.js";
import {
  answeredQuestionRecordsMigrationName,
  applyAnsweredQuestionRecords,
  applyBrowserSessionTabsIndex,
  applyInlineTranscriptMessages,
  applyStoppedRunsNotNews,
  applyTaskOpenIndexes,
  applyThreadDoneBy,
  applyRunProviderRetry,
  applyPersonalStateSchema,
  browserSessionTabsIndexMigrationName,
  applyDropDeviceAccessCount,
  applyTaskApprovalReceipts,
  dropDeviceAccessCountMigrationName,
  inlineTranscriptMessagesMigrationName,
  stoppedRunsNotNewsMigrationName,
  taskOpenIndexesMigrationName,
  threadDoneByMigrationName,
  runProviderRetryMigrationName,
  taskApprovalReceiptsMigrationName,
} from "./personal-state-schema.js";
import { agentGrantsMigrationName, applyAgentGrants } from "./agent-grants-migration.js";
import { agentSessionsMigrationName, applyAgentSessions } from "./agent-sessions-migration.js";
import {
  agentDirectoryMigrationName,
  applyAgentDirectoryVerification,
} from "./agent-directory-migration.js";
import { platformVerificationRemovalMigration } from "./platform-verification-removal-migration.js";
import {
  onePersonHomeContractMigration,
  onePersonHomeFirstMigration,
} from "./one-person-home-migration.js";
import {
  browserPoolMigrationName,
  applyBrowserPool,
  browserPoolSessionsMigrationName,
  applyBrowserPoolSessions,
} from "./browser-pool-migration.js";
import {
  applyBridgeConnections,
  bridgeConnectionsMigrationName,
} from "./bridge-connections-migration.js";
import { applyChatRoutesEnd, chatRoutesEndMigrationName } from "./chat-routes-end-migration.js";
import {
  applyAutomationsContract,
  automationsContractMigrationName,
} from "./automation-scripts-migration.js";
export { automationsContractMigrationName } from "./automation-scripts-migration.js";
import {
  completePersonalStateConversion,
  personalCurrentStateMigrationName,
  withPersonalStateStartupLock,
} from "./personal-state-upgrade.js";
import type { DatabaseSchema } from "./schema.js";
import { PLUGIN_HOST_SQL } from "./plugin-host-migration.js";

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

/**
 * Waiting messages a person edits in place, under a device's edit lease, with
 * every version kept; teammates' asks admitted on arrival behind an approval
 * gate bound to the revision approved. Asks approved before this migration
 * were already running or done, so they count as released at their decision.
 */
const WAITING_INPUT_EDITS_SQL = `
alter table messages
  add column revision integer not null default 0 check (revision >= 0),
  add column edited_at timestamptz,
  add constraint messages_edit check ((revision = 0) = (edited_at is null));
create table message_revisions (
  message_id text not null references messages(id) on delete cascade,
  revision integer not null check (revision >= 0),
  content jsonb not null,
  author jsonb not null,
  device_label text,
  created_at timestamptz not null,
  primary key (message_id, revision)
);
alter table thread_inputs
  add column edit_lease_id text,
  add column edit_lease_session_id text,
  add column edit_lease_device_label text,
  add column edit_lease_expires_at timestamptz,
  add constraint thread_inputs_edit_lease check (
    (edit_lease_id is null) = (edit_lease_expires_at is null)
    and (edit_lease_id is null) = (edit_lease_device_label is null)
    and (edit_lease_id is null) = (edit_lease_session_id is null));
create index thread_inputs_edit_lease_expiry on thread_inputs(edit_lease_expires_at) where edit_lease_id is not null;
create index thread_inputs_awaiting_approval on thread_inputs(thread_id, created_at, message_id) where state = 'awaiting-approval';
create or replace view thread_work_inputs as select * from thread_inputs where policy in ('queue','steer');
alter table threads add column team_ask_origin boolean not null default false;
alter table personal_team_requests
  add column approved_revision integer check (approved_revision >= 0),
  add column released_at timestamptz,
  add constraint personal_team_requests_release check (
    (approved_revision is null or (kind = 'ask' and local_decision = 'approve'))
    and (released_at is null or approved_revision is not null));
update personal_team_requests set approved_revision = 0,
  released_at = case when local_task_id is not null then decision_at else null end
  where kind = 'ask' and local_decision = 'approve';
`;
export const waitingInputEditsMigrationName = "0024_waiting_input_edits";
export const personalTeamBaselineName = "0002_personal_team_baseline";
export const threadVisitsMigrationName = "0004_thread_visits";
export const teamKnowledgeNotesMigrationName = "0006_team_knowledge_notes";
export const teamAgentMigrationName = "0011_team_agent_contracts";
export const teamAgentAsksMigrationName = "0012_team_agent_asks";
export const teamPrincipalsMigrationName = "0015_team_principals";
export const teamPartnerLinksMigrationName = "0016_team_partner_links";
export const agentHomeSettingsMigrationName = "0023_agent_home_settings";
const messageOriginMigrationName = "0027_message_origin";
export { personalCurrentStateMigrationName } from "./personal-state-upgrade.js";
const MESSAGE_ORIGIN_SQL = `
alter table messages add column origin jsonb;
`;
/** Databases created from the current baseline never had this storage. */
export const dropSpecialistsMigrationName = "0030_drop_specialists_contract";
const DROP_SPECIALISTS_SQL = `
drop table if exists specialists;
alter table threads drop column if exists specialist_id;
alter table plugin_versions drop column if exists specialist_manifest;
delete from plugin_owner_settings where target->>'kind' = 'specialist';
`;
/**
 * Service integrations are gone: provider applications, their OAuth sources and MCP OAuth
 * credentials, every installation that is not a device app or a local server, and the Requests
 * only they could answer. Computer, messaging and local-server rows stay. Databases created from
 * the current baseline never had the dropped storage.
 */
export const dropServiceIntegrationsMigrationName = "0033_drop_service_integrations_contract";
const DROP_SERVICE_INTEGRATIONS_SQL = `
create temporary table service_servers on commit drop as
  select id from integration_servers where transport->>'type' not in ('computer', 'runner');
create temporary table service_installations on commit drop as
  select id from integration_installations installation
    where source_kind in ('proposed', 'remote-mcp')
      or (plugin_id is null and not exists (
        select 1 from integration_servers server
          where server.installation_id = installation.id
            and server.id not in (select id from service_servers)));
create temporary table service_connections on commit drop as
  select id, credential_id from integration_connections
    where connection_kind in ('provider-account', 'mcp-oauth');
create temporary table service_requests on commit drop as
  select id from requests where kind in ('integration.install', 'integration.input')
  union select request_id from integration_request_details
    where installation_id in (select id from service_installations)
      or requested_server_id in (select id from service_servers)
      or requested_connection_id in (select id from service_connections)
      or (installation_id is null and manifest is not null
        and (manifest->>'kind' <> 'catalog' or manifest->'definition'->>'adapter' is distinct from 'computer'))
  union select id from requests where kind = 'integration.access' and (
    payload->>'installationId' in (select id from service_installations)
    or payload->>'requestedServerId' in (select id from service_servers)
    or payload->>'requestedConnectionId' in (select id from service_connections)
    or (payload->'manifest' is not null and payload->'manifest' <> 'null'::jsonb
      and payload->'manifest'->'definition'->>'adapter' is distinct from 'computer'))
  union select data->'request'->>'id' from deployment_events
    where type like 'request.%' and (
      data->'request'->>'kind' in ('integration.install', 'integration.input')
      or (data->'request'->>'kind' = 'integration.access' and (
        data->'request'->'payload'->>'installationId' in (select id from service_installations)
        or data->'request'->'payload'->>'requestedServerId' in (select id from service_servers)
        or data->'request'->'payload'->>'requestedConnectionId' in (select id from service_connections)
        or (data->'request'->'payload'->'manifest' is not null
          and data->'request'->'payload'->'manifest' <> 'null'::jsonb
          and data->'request'->'payload'->'manifest'->'definition'->>'adapter' is distinct from 'computer'))));
delete from deployment_events where type like 'request.%' and (
  data->>'requestId' in (select id from service_requests)
  or data->'request'->>'id' in (select id from service_requests)
  or data->'request'->>'kind' in ('integration.install', 'integration.input')
  or (data->'request'->>'kind' = 'integration.access' and
    data->'request'->'payload'->'manifest' is not null and
    data->'request'->'payload'->'manifest' <> 'null'::jsonb and
    data->'request'->'payload'->'manifest'->'definition'->>'adapter' is distinct from 'computer'));
update deployment_events set data = jsonb_set(data - 'integration', '{tool}',
  '{"name":"retired_service","namespace":"history"}'::jsonb)
  where type = 'tool.started' and data->'tool'->>'name' in
    ('integration_search', 'integration_describe', 'integration_call', 'integration_request',
      'integration_list', 'integration_remove', 'custom_integration_request');
delete from task_question_notices where request_id in (select id from service_requests);
delete from request_call_joins where request_id in (select id from service_requests);
delete from watch_control_requests where request_id in (select id from service_requests);
delete from trigger_control_requests where request_id in (select id from service_requests);
delete from agent_control_requests where request_id in (select id from service_requests);
delete from request_continuations where request_id in (select id from service_requests);
delete from requests where id in (select id from service_requests);

delete from integration_grants where connection_id in (select id from service_connections)
  or installation_id in (select id from service_installations);
delete from integration_tools where connection_id in (select id from service_connections)
  or server_id in (select id from service_servers)
  or server_id in (select id from integration_servers
    where installation_id in (select id from service_installations));
delete from integration_tool_definitions where connection_id in (select id from service_connections)
  or server_id in (select id from service_servers)
  or server_id in (select id from integration_servers
    where installation_id in (select id from service_installations));
delete from credential_access_audit where connection_id in (select id from service_connections)
  or credential_id in (select credential_id from service_connections);
delete from integration_connections where id in (select id from service_connections);
delete from credentials where id in (select credential_id from service_connections);
delete from integration_server_secrets where server_id in (select id from service_servers)
  or server_id in (select id from integration_servers
    where installation_id in (select id from service_installations));
delete from integration_servers where id in (select id from service_servers)
  or installation_id in (select id from service_installations);
delete from integration_installations where id in (select id from service_installations);
delete from plugin_owner_settings where target->>'kind' = 'service';

drop index if exists integration_connections_definition_identity_unique;
drop table if exists mcp_oauth_credentials;
drop table if exists integration_application_source_defaults;
alter table integration_connections
  drop column if exists provider_application_id,
  drop column if exists application_source,
  drop column if exists auth_method_id,
  drop column if exists authorization_digest,
  drop column if exists granted_scopes;
drop table if exists integration_provider_applications;
alter table integration_connections drop constraint if exists integration_connections_connection_kind_check;
alter table integration_connections add constraint integration_connections_connection_kind_check
  check (connection_kind in ('channel', 'computer'));
alter table integration_installations drop column if exists adapter_snapshot;
alter table integration_installations drop constraint if exists integration_installations_source_kind_check;
alter table integration_installations add constraint integration_installations_source_kind_check
  check (source_kind in ('plugin', 'built-in'));
alter table integration_auth_attempts drop column if exists result_connection_id;
`;
/**
 * Releases before the plugin overhaul stored a null \`apiKey\` on every device-app definition. The
 * field is gone from the definition, so a stored copy that still has it cannot be read.
 */
export const dropStoredDefinitionApiKeyMigrationName = "0035_drop_stored_definition_api_key";
export const DROP_STORED_DEFINITION_API_KEY_SQL = `
update integration_installations set manifest = manifest #- '{definition,apiKey}'
  where manifest->'definition' ? 'apiKey';
update integration_request_details set manifest = manifest #- '{definition,apiKey}'
  where manifest->'definition' ? 'apiKey';
update requests set payload = payload #- '{manifest,definition,apiKey}'
  where payload->'manifest'->'definition' ? 'apiKey';
`;
export const unifyLocalPluginAccessMigrationName = "0034_unify_local_plugin_access_contract";
const UNIFY_LOCAL_PLUGIN_ACCESS_SQL = `
insert into plugin_agent_settings (owner_user_id, plugin_id, access, author)
  select setting.owner_user_id, 'app_device_' || connection.id, 'off', 'agent'
  from plugin_owner_settings setting
  join integration_connections connection
    on connection.owner_user_id = setting.owner_user_id
    and connection.integration_definition_id = setting.target->>'definitionId'
  where setting.target->>'kind' = 'device-app' and not setting.enabled
    and connection.connection_kind = 'computer' and connection.status <> 'revoked'
    and connection.integration_definition_id not in ('macos-app', 'android-phone', 'iphone-screen')
  union
  select setting.owner_user_id, 'app_server_' || server.id, 'off', 'agent'
  from plugin_owner_settings setting
  join integration_installations installation on installation.plugin_id = setting.target->>'pluginId'
  join integration_servers server on server.installation_id = installation.id
  where setting.target->>'kind' = 'plugin' and not setting.enabled and server.transport->>'type' = 'runner'
  on conflict (owner_user_id, plugin_id) do update set access = excluded.access;

drop trigger if exists plugin_owner_settings_authority_generation on plugin_owner_settings;
delete from plugin_owner_settings setting
  where setting.target->>'kind' = 'device-app'
    or (setting.target->>'kind' = 'plugin' and exists (
      select 1 from integration_installations installation
      join integration_servers server on server.installation_id = installation.id
      where installation.plugin_id = setting.target->>'pluginId' and server.transport->>'type' = 'runner'
    ));

update trigger_revisions set program = jsonb_set(program, '{toolContractVersion}', '5')
  where program->'toolContractVersion' = '4'::jsonb
    and program->>'source' !~ 'integration_(call|describe|list|remove|request|search)';
`;
/**
 * One plugin per person and name. Two first registrations of one name at once could each create a
 * plugin; the later of any such pair keeps its rows under its name with the end of its id added,
 * and a number after that when the person already has that name. Every name it gives stays a
 * valid server name (at most 63 characters), so the person can remove it by name.
 */
export const onePluginPerOwnerNameMigrationName = "0036_one_plugin_per_owner_name";
const ONE_PLUGIN_PER_OWNER_NAME_SQL = `
do $$
declare
  duplicate record;
  candidate text;
  attempt integer;
begin
  for duplicate in
    select id, installed_by, name from (
      select id, installed_by, name, created_at,
        row_number() over (partition by installed_by, name order by created_at, id) as rank
      from plugins
    ) ranked
    where rank > 1
    order by created_at, id
  loop
    attempt := 1;
    loop
      candidate := rtrim(left(duplicate.name, 50), '-.') || '-' || right(duplicate.id, 8)
        || case when attempt = 1 then '' else '-' || attempt end;
      exit when not exists (
        select 1 from plugins
        where installed_by is not distinct from duplicate.installed_by and name = candidate
      );
      attempt := attempt + 1;
    end loop;
    update plugins set name = candidate where id = duplicate.id;
  end loop;
end $$;
create unique index plugins_owner_name on plugins(installed_by, name);
`;
/**
 * The definition each plugin version's package digest follows. Versions stored before it was
 * recorded are null: their digests follow the earlier definition, which no reader accepts now, so
 * the Host stores each such package again under its current digest at startup.
 */
export const pluginPackageFormatMigrationName = "0037_plugin_package_format";
export const commandRequestsMigrationName = "0112_command_requests";
const PLUGIN_PACKAGE_FORMAT_SQL = `
alter table plugin_versions add column package_format text;
`;
export function migrationProvider(options?: {
  readonly personalCurrentState?: boolean;
}): MigrationProvider {
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
        "0014_claude_idle_compaction": {
          async up(database) {
            await sql`
              alter table personal_settings add column idle_compaction_policy jsonb not null default '{"mode":"onReturn"}'::jsonb;
              alter table provider_sessions add column context_snapshot jsonb null;
              alter table runs add column maintenance jsonb null;
              create unique index runs_compaction_source_idx on runs (
                thread_id, (maintenance->>'providerSessionId'), (maintenance->>'sourceRunId')
              ) where maintenance is not null;
            `.execute(database);
          },
        },
        [teamPrincipalsMigrationName]: { up: migrateTeamPrincipals },
        [teamPartnerLinksMigrationName]: { up: migrateTeamPartnerLinks },
        "0017_team_channel_shares": { up: migrateTeamChannelShares },
        "0018_team_share_files": { up: migrateTeamShareFiles },
        "0019_team_shared_agents": { up: migrateTeamSharedAgents },
        "0020_team_share_file_cache": { up: migrateTeamShareFileCache },
        "0021_team_share_relay_policy": {
          async up(database) {
            await sql`alter table team_shares add column policy_revision bigint not null default 0;
              alter table team_share_relays add column pending_bodies text[] not null default '{}'`.execute(
              database,
            );
          },
        },
        // A personal owner's name is theirs to set; a team keeps the newest Account revision of each
        // member's. The seeded placeholder owner keeps no name, so its computer's name can fill it.
        "0022_person_names": {
          async up(database) {
            await sql`alter table personal_settings
                add column owner_name text,
                add column owner_name_set_at timestamptz,
                add column owner_name_revision bigint check (owner_name_revision >= 1),
                add column owner_name_account jsonb,
                add constraint personal_settings_owner_name_source
                  check ((owner_name_revision is null) = (owner_name_account is null)),
                add constraint personal_settings_owner_name_account_named
                  check (owner_name_account is null or owner_name is not null);
              update personal_settings
                set owner_name = users.display_name, owner_name_set_at = now()
                from users
                where users.id = personal_settings.owner_id
                  and users.email <> ${sql.lit(localMachineOwnerEmail)};
              alter table users add column name_revision bigint not null default 0
                check (name_revision >= 0)`.execute(database);
          },
        },
        [agentHomeSettingsMigrationName]: {
          /**
           * Background model choices moved to settings.json in Agent home; nothing carries over.
           * Only databases created before this migration have the column: the baseline no longer does.
           */
          async up(database) {
            await sql`alter table personal_settings drop column if exists background_model_preferences;
              create table agent_home_settings (
                computer_id text not null primary key references runners(id) on delete cascade,
                environment_id text not null references execution_environments(id) on delete cascade,
                boot_id text not null,
                connection_generation bigint not null,
                connection_id text not null,
                connection_lease_id text not null,
                read_sequence bigint not null,
                read_at timestamptz not null,
                file_status text not null check(file_status in ('valid','missing','invalid')),
                file_error jsonb,
                settings jsonb not null
              )`.execute(database);
          },
        },
        [waitingInputEditsMigrationName]: {
          async up(database) {
            await sql.raw(WAITING_INPUT_EDITS_SQL).execute(database);
          },
        },
        [teamCopiesMigrationName]: {
          async up(database) {
            await sql.raw(TEAM_COPIES_SQL).execute(database);
          },
        },
        [tabsAndAppsMigrationName]: {
          async up(database) {
            await sql.raw(TABS_AND_APPS_SQL).execute(database);
          },
        },
        [messageOriginMigrationName]: {
          async up(database) {
            await sql.raw(MESSAGE_ORIGIN_SQL).execute(database);
          },
        },
        [deviceDriversMigrationName]: {
          async up(database) {
            await sql.raw(DEVICE_DRIVERS_SQL).execute(database);
          },
        },
        // opensteer_task_list's changedSince reads only messages written or delivered after it.
        "0029_changed_since_indexes": {
          async up(database) {
            await sql`create index messages_created_at on messages(created_at);
              create index thread_inputs_updated_at on thread_inputs(updated_at)`.execute(database);
          },
        },
        [dropSpecialistsMigrationName]: {
          async up(database) {
            await sql.raw(DROP_SPECIALISTS_SQL).execute(database);
          },
        },
        "0031_plugin_host": {
          async up(database) {
            await sql.raw(PLUGIN_HOST_SQL).execute(database);
          },
        },
        "0032_plugin_oauth": {
          async up(database) {
            await sql
              .raw(
                `CREATE TABLE plugin_oauth_records (
              id text PRIMARY KEY, owner_user_id text NOT NULL REFERENCES users(id),
              expires_at timestamptz, begun_at timestamptz, encrypted_payload bytea NOT NULL
            ); CREATE INDEX plugin_oauth_records_expiry ON plugin_oauth_records(expires_at) WHERE expires_at IS NOT NULL;`,
              )
              .execute(database);
          },
        },
        [dropServiceIntegrationsMigrationName]: {
          async up(database) {
            await sql.raw(DROP_SERVICE_INTEGRATIONS_SQL).execute(database);
          },
        },
        [unifyLocalPluginAccessMigrationName]: {
          async up(database) {
            await sql.raw(UNIFY_LOCAL_PLUGIN_ACCESS_SQL).execute(database);
          },
        },
        [dropStoredDefinitionApiKeyMigrationName]: {
          async up(database) {
            await sql.raw(DROP_STORED_DEFINITION_API_KEY_SQL).execute(database);
          },
        },
        [onePluginPerOwnerNameMigrationName]: {
          async up(database) {
            await sql.raw(ONE_PLUGIN_PER_OWNER_NAME_SQL).execute(database);
          },
        },
        [pluginPackageFormatMigrationName]: {
          async up(database) {
            await sql.raw(PLUGIN_PACKAGE_FORMAT_SQL).execute(database);
          },
        },
        ...(options?.personalCurrentState !== false
          ? {
              [personalCurrentStateMigrationName]: { up: applyPersonalStateSchema },
              [taskApprovalReceiptsMigrationName]: { up: applyTaskApprovalReceipts },
              [answeredQuestionRecordsMigrationName]: { up: applyAnsweredQuestionRecords },
              [dropDeviceAccessCountMigrationName]: { up: applyDropDeviceAccessCount },
              [browserSessionTabsIndexMigrationName]: { up: applyBrowserSessionTabsIndex },
              [inlineTranscriptMessagesMigrationName]: { up: applyInlineTranscriptMessages },
              [stoppedRunsNotNewsMigrationName]: { up: applyStoppedRunsNotNews },
              [threadDoneByMigrationName]: { up: applyThreadDoneBy },
              [runProviderRetryMigrationName]: { up: applyRunProviderRetry },
              [taskOpenIndexesMigrationName]: { up: applyTaskOpenIndexes },
              [agentGrantsMigrationName]: { up: applyAgentGrants },
              [agentSessionsMigrationName]: { up: applyAgentSessions },
              "0102_chrome_live_tabs_source": {
                async up(database: Kysely<unknown>) {
                  await sql`alter table browser_sources add column live_tabs_only boolean not null default false`.execute(
                    database,
                  );
                },
              },
              [agentDirectoryMigrationName]: { up: applyAgentDirectoryVerification },
              "0104_shared_chrome_grants": {
                async up(database: Kysely<unknown>) {
                  await sql`
                    alter table browser_source_pairings add column device_id text;
                    alter table browser_sources add column device_id text;
                    alter table agent_connections add column shared_chrome_attempts jsonb not null default '{}';
                  `.execute(database);
                },
              },
              ...onePersonHomeFirstMigration,
              [browserPoolMigrationName]: { up: applyBrowserPool },
              "0107_needs_you_counts_requests": {
                /**
                 * A Home that used teams counted its teammates' asks in Needs you, and those
                 * rows no longer list: the count is what the list shows, Requests alone, and the
                 * pending count with it, so neither can sit below the other. A database still
                 * converting gets the same: one past its count stage keeps this, one before it
                 * counts again the same way.
                 */
                async up(database: Kysely<unknown>) {
                  await sql`update client_sync_state set pending_request_count=listed.count,
                      needs_you_count=listed.count
                    from (select count(*)::integer as count from personal_attention where kind='request') listed
                    where pending_request_count is distinct from listed.count
                      or needs_you_count is distinct from listed.count`.execute(database);
                },
              },
              [bridgeConnectionsMigrationName]: { up: applyBridgeConnections },
              [chatRoutesEndMigrationName]: { up: applyChatRoutesEnd },
              // A Home is one person's, and a connected agent holds only what they granted.
              ...onePersonHomeContractMigration,
              // A connected agent is verified by the origin it is reached at, and nothing else.
              ...platformVerificationRemovalMigration,
              [commandRequestsMigrationName]: {
                /**
                 * An agent's proposed Home command rides an ordinary Request, with its parts in one
                 * column. One open ask per proposer and thing.
                 * An approval a restart cut off is found by its own small index, however many
                 * Requests the Home has. Activity finds an agent's asks and the commands it ran at
                 * once by who sent them (C5).
                 */
                async up(database: Kysely<unknown>) {
                  await sql`
                    alter table requests add column command jsonb;
                    create unique index requests_command_open on requests
                      (requested_by, (command->>'askKey'))
                      where command is not null and status = 'pending';
                    create index requests_command_running on requests (id)
                      where status = 'fulfilled' and (command->'outcome'->>'status') = 'running';
                    create index requests_command_proposer on requests
                      ((command->'proposer'->>'key'), created_at desc)
                      where command is not null;
                    create index requests_command_thread on requests
                      (originating_thread_id, created_at desc)
                      where command is not null;
                    create index commands_agent_caller on commands
                      ((authority_source->>'callerKey'), created_at desc)
                      where authority_source->>'kind' = 'mcp';
                    -- A command with an effect outside the database, recorded before it acts and
                    -- settled after: what a Disconnect waits on for a connection's (G4).
                    create table command_attempts (
                      id text primary key,
                      requested_by text not null references users(id) on delete cascade,
                      caller_key text not null,
                      connection_id text references agent_connections(id) on delete cascade,
                      type text not null,
                      idempotency_key text not null,
                      state text not null default 'running'
                        check (state in ('running', 'done', 'failed', 'unknown')),
                      started_at timestamptz not null default now(),
                      settled_at timestamptz,
                      check ((state = 'running') = (settled_at is null))
                    );
                    create index command_attempts_connection on command_attempts (connection_id)
                      where connection_id is not null;
                    create index command_attempts_running on command_attempts (id)
                      where state = 'running';
                    -- One key, one attempt (K1): an earlier one that did not fail answers instead.
                    create unique index command_attempts_one_key on command_attempts
                      (requested_by, caller_key, idempotency_key) where state <> 'failed';
                  `.execute(database);
                },
              },
              [automationsContractMigrationName]: { up: applyAutomationsContract },
              "0114_thread_inputs_written_by_connection": {
                /**
                 * Indexes connection-written inputs per task so `threadContextLineage` checks
                 * whether any ancestor task was written into by a connected agent without
                 * scanning `thread_inputs` per ancestor.
                 */
                async up(database: Kysely<unknown>) {
                  await sql`
                    create index thread_inputs_written_by_connection
                    on thread_inputs(thread_id)
                    where connection_id is not null
                      and (
                        state <> 'cancelled'
                        or run_id is not null
                        or steer_command_id is not null
                        or delivered_at is not null
                      )
                  `.execute(database);
                },
              },
              "0115_provider_session_person_lineage": {
                /**
                 * Tracks whether a native provider session was created under the person's own
                 * lineage so a narrowing (`true -> false`) rotates the session instead of
                 * resuming a conversation that already loaded the person's own configuration.
                 */
                async up(database: Kysely<unknown>) {
                  await sql`
                    alter table provider_sessions
                    add column person_lineage boolean not null default true
                  `.execute(database);
                },
              },
              [browserPoolSessionsMigrationName]: { up: applyBrowserPoolSessions },
              "0117_stop_truth_and_recovery": {
                /**
                 * Records why an interrupted Run ended (e.g. a shared engine had to retire),
                 * why a queued Run is being held back from starting, when a late stop proof
                 * arrived, and the failure code of a failed task so lists do not collapse
                 * unconfirmed stops into generic failures. A shell a connected agent's Run opens
                 * carries its Disconnect attempt: the connection and grant it was admitted under,
                 * the target's stream, and that stream's end evidence.
                 */
                async up(database: Kysely<unknown>) {
                  await sql`
                    alter table runs
                      add column if not exists interrupted_cause text check (interrupted_cause in ('lease-lost', 'engine-retired')),
                      add column if not exists start_hold_reason text check (start_hold_reason in ('previous-stop-unconfirmed')),
                      add column if not exists stop_confirmed_at timestamptz;
                    alter table threads
                      add column if not exists failure_code text,
                      add column if not exists run_start_hold_reason text check (run_start_hold_reason in ('previous-stop-unconfirmed')),
                      add column if not exists unconfirmed_stop_run_id text;
                    alter table runners
                      add column if not exists machine_boot_id text;
                    alter table run_attempts
                      add column if not exists machine_boot_id text;
                    -- A shell a connection's Run opens is an attempt in its Disconnect set:
                    -- admitted under the live connection, bound to the target's exact shell
                    -- stream, ended by that stream's close receipt or by contact loss (A4).
                    alter table machine_access_sessions
                      add column if not exists connection_id text
                        references agent_connections(id) on delete cascade,
                      add column if not exists admitted_grant_revision integer,
                      add column if not exists admitted_access_mode text,
                      add column if not exists target_fence jsonb,
                      add column if not exists terminal_evidence_at timestamptz,
                      add column if not exists contact_lost_at timestamptz;
                    create index if not exists machine_access_sessions_connection
                      on machine_access_sessions(connection_id)
                      where connection_id is not null;
                    create index if not exists machine_access_sessions_unsettled
                      on machine_access_sessions(runner_id)
                      where connection_id is not null and terminal_evidence_at is null;
                    create index if not exists threads_unconfirmed_stop_idx
                      on threads(environment_id)
                      where unconfirmed_stop_run_id is not null or run_start_hold_reason is not null;
                    update threads t
                      set failure_code = last_run.code,
                          unconfirmed_stop_run_id = case when last_run.code = 'execution_termination_unproven' then last_run.id else t.unconfirmed_stop_run_id end
                      from (
                        select distinct on (thread_id) thread_id, id, failure->>'code' as code
                        from runs
                        where maintenance is null
                        order by thread_id, run_ordinal desc
                      ) last_run
                      where t.id = last_run.thread_id
                        and t.status = 'failed'
                        and last_run.code is not null;
                    update client_sync_state set epoch = gen_random_uuid();
                  `.execute(database);
                },
              },
            }
          : {}),
      };
    },
  };
}
/** A team server's database, which this release does not open. */
export class RetiredTeamServerDatabaseError extends Error {
  constructor() {
    super(
      "This database is a team server's. Team servers were removed in this release of Opensteer; the previous release still opens this database.",
    );
    this.name = "RetiredTeamServerDatabaseError";
  }
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
  conversion?: Parameters<typeof completePersonalStateConversion>[2] & {
    /** Called as each pending migration starts: the `step`th of `of`. */
    readonly beforeMigration?: ((step: number, of: number) => void) | undefined;
  },
): Promise<MigrationResultSet> {
  const migrations = await provider.getMigrations();
  const resolved: MigrationProvider = { getMigrations: async () => migrations };
  const before = conversion?.beforeMigration;
  if (!Object.hasOwn(migrations, personalCurrentStateMigrationName))
    return migrateRegisteredLineage(database, resolved, Object.keys(migrations), before);
  return withPersonalStateStartupLock(database, async (signal) => {
    const result = await migrateRegisteredLineage(
      database,
      resolved,
      Object.keys(migrations),
      before,
    );
    signal.throwIfAborted();
    await completePersonalStateConversion(database, signal, conversion);
    return result;
  });
}

async function migrateRegisteredLineage(
  database: Kysely<DatabaseSchema>,
  provider: MigrationProvider,
  migrationNames: readonly string[],
  beforeMigration?: (step: number, of: number) => void,
): Promise<MigrationResultSet> {
  const ledger = await sql<{
    exists: boolean;
  }>`select to_regclass('public.kysely_migration') is not null as exists`.execute(database);
  let hasAppliedMigrations = false;
  const appliedNames = new Set<string>();
  if (ledger.rows[0]?.exists) {
    const known = new Set(migrationNames);
    const applied = await sql<{
      name: string;
    }>`select name from public.kysely_migration order by name`.execute(database);
    hasAppliedMigrations = applied.rows.length > 0;
    for (const { name } of applied.rows) appliedNames.add(name);
    const unknown = applied.rows.map((row) => row.name).filter((name) => !known.has(name));
    if (unknown.length) throw new MigrationLineageError(unknown);
    // Every migrated lineage has its Deployment row; a team server's is refused before any
    // migration, schema or data, or the personal conversion touches its database.
    if (hasAppliedMigrations) {
      const deployment = await sql<{
        kind: unknown;
      }>`select deployment_shape->>'kind' as kind from deployments where singleton_key='primary'`.execute(
        database,
      );
      const kind = deployment.rows[0]?.kind;
      if (kind !== undefined && kind !== "personal") throw new RetiredTeamServerDatabaseError();
    }
  }
  if (!hasAppliedMigrations) {
    const existing = await sql<{
      name: string;
    }>`select tablename as name from pg_tables where schemaname='public' and tablename not in ('kysely_migration','kysely_migration_lock') order by tablename`.execute(
      database,
    );
    if (existing.rows.length) throw new MigrationLineageError(["unversioned-database"]);
  }
  // Kysely has no hook as a migration starts: each pending one says so before its own body.
  const pending = migrationNames.filter((name) => !appliedNames.has(name));
  const migrations = await provider.getMigrations();
  const announced: MigrationProvider = beforeMigration
    ? {
        getMigrations: async () =>
          Object.fromEntries(
            Object.entries(migrations).map(([name, migration]) => {
              const step = pending.indexOf(name) + 1;
              if (!step) return [name, migration];
              const up = async (db: Kysely<unknown>) => {
                beforeMigration(step, pending.length);
                await migration.up(db);
              };
              return [name, { ...migration, up }];
            }),
          ),
      }
    : provider;
  const result = await new Migrator({ db: database, provider: announced }).migrateToLatest();
  const failure = result.results?.find((entry) => entry.status === "Error");
  if (result.error || failure)
    throw new Error(`Database migration failed${failure ? ` at ${failure.migrationName}` : ""}`, {
      cause: result.error,
    });
  return result;
}
