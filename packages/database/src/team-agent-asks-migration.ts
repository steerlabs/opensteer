import { sql, type Kysely } from "kysely";

export async function migrateTeamAgentAsks(database: Kysely<unknown>): Promise<void> {
  await sql`
    alter table team_agent_requests
      add column kind text not null default 'self' check (kind in ('self','ask','return')),
      add column target_agent_handle text,
      add column presentation jsonb,
      add column return_payload jsonb,
      add column consent_expires_at timestamptz;
    alter table team_agent_requests drop constraint team_agent_requests_check;
    alter table team_agent_requests add constraint team_agent_requests_state check (
      state in ('awaiting_approval','declined','queued','working','needs_you','done','failed','cancelled','stopped') and change_seq>0);
    alter table team_agent_requests drop constraint team_agent_requests_check2;
    alter table team_agent_requests add constraint team_agent_requests_terminal check (
      (state in ('declined','done','failed','cancelled','stopped'))=(finished_at is not null));
    alter table team_agent_requests add constraint team_agent_requests_ask check (
      (kind='ask')=(presentation is not null and consent_expires_at is not null)
      and (kind='ask' or (presentation is null and consent_expires_at is null))
      and (kind='ask' or state not in ('awaiting_approval','declined')));
    alter table team_agent_requests add constraint team_agent_requests_return check (
      (kind='return')=(return_payload is not null)
      and (return_payload is null or (jsonb_typeof(return_payload)='object'
        and nullif(return_payload->>'originAskId','') is not null
        and nullif(return_payload->>'resumeRunId','') is not null)));
    alter table team_agent_requests drop constraint team_agent_requests_trigger_message_id_owner_user_id_key;
    create unique index team_requests_trigger_owner on team_agent_requests(trigger_message_id,owner_user_id) where kind in ('self','ask');
    create unique index team_requests_return_origin on team_agent_requests((return_payload->>'originAskId')) where kind='return';
    drop index team_requests_queued;
    create index team_requests_queued on team_agent_requests(owner_user_id,created_at,id) where state in ('awaiting_approval','queued') and kind<>'return';
    create index team_requests_consent_expiring on team_agent_requests(consent_expires_at,id) where state='awaiting_approval';

    alter table personal_team_requests
      alter column local_task_id drop not null,
      alter column local_input_id drop not null,
      add column kind text not null default 'self' check (kind in ('self','ask','return')),
      add column remote_state text not null default 'queued' check (remote_state in ('awaiting_approval','declined','queued','working','needs_you','done','failed','cancelled','stopped')),
      add column presentation jsonb,
      add column return_payload jsonb,
      add column consent_expires_at timestamptz,
      add column local_decision text check (local_decision in ('approve','decline')),
      add column decision_at timestamptz,
      add column return_admission text check (return_admission in ('admitted','undeliverable'));
    update personal_team_requests set remote_state=coalesce(terminal_state,case when run_id is null then 'queued' else 'working' end);
    alter table personal_team_requests add constraint personal_team_requests_input check (
      (local_task_id is null)=(local_input_id is null) and (kind<>'self' or local_task_id is not null));
    alter table personal_team_requests add constraint personal_team_requests_decision check (
      (local_decision is null)=(decision_at is null) and (kind='ask' or local_decision is null));
    alter table personal_team_requests add constraint personal_team_requests_ask check (
      (kind='ask')=(presentation is not null and consent_expires_at is not null)
      and (kind='ask' or (presentation is null and consent_expires_at is null)));
    alter table personal_team_requests add constraint personal_team_requests_return check (
      (kind='return')=(return_payload is not null)
      and (kind='return' or return_admission is null)
      and (return_admission is distinct from 'admitted' or local_input_id is not null)
      and (return_payload is null or (jsonb_typeof(return_payload)='object'
        and nullif(return_payload->>'originAskId','') is not null
        and nullif(return_payload->>'resumeRunId','') is not null)));
    create unique index personal_team_requests_return_origin on personal_team_requests(team_deployment_id,(return_payload->>'originAskId')) where kind='return' and return_admission is distinct from 'undeliverable';
    create index personal_team_requests_pending_consent on personal_team_requests(created_at desc,request_id desc)
      where kind='ask' and remote_state='awaiting_approval' and local_decision is null;
  `.execute(database);
}
