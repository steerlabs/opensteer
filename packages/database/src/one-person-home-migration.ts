import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { resourceRevisionsDdl } from "./personal-state-schema.js";

/**
 * Organizations and work Homes were removed: a Home is one person's, and what a connected agent
 * may use is only what that person granted. The two migrations that remain of them live here.
 */

/** Once created a work Home's policy, audit outbox and gates; it creates nothing any more. */
export const workHomeMigrationName = "0105_work_home";
export const removeOrganizationsMigrationName = "0110_remove_organizations_contract";

/**
 * Drops what a work Home had: its policy, its audit outbox and its gates. A Home that was a work
 * Home becomes an ordinary Home of its one person, and no connection can do more after this than
 * the moment before: a mode above the organization's cap becomes the cap, narrowed as an edit
 * narrows it; a grant the policy refused (everything without both allowEverything and allowTasks,
 * or Tasks without allowTasks), which could do nothing, is revoked as Disconnect revokes it, and so
 * is every connection of a work Home its organization was closing. What the policy said about
 * enrolling devices bound the person's devices, not a connection. Pending direct-operation Requests
 * of a narrowed connection are left open for the first start's cleanup: answering one requires the
 * person's explicit click, and every hand-off re-checks the connection's live access mode and grant
 * revision (`assertActiveGrant` refuses anything below `cleanup_minimum_grant_revision`), so leaving
 * them open widens nothing. A chat that ended for a reason that no longer exists keeps no reason
 * and reads as ended. On a database that never had a work Home, only the columns, the functions and
 * the chat reasons are touched, and none hold anything.
 */
export async function applyRemoveOrganizations(database: Kysely<unknown>): Promise<void> {
  await sql`
    drop trigger if exists work_audit_capture on agent_connections;
    drop trigger if exists work_audit_capture on agent_sessions;
    drop trigger if exists work_audit_capture on agent_operations;
    drop trigger if exists work_audit_capture on requests;
    drop trigger if exists work_audit_capture on devices;
    drop trigger if exists work_audit_capture on auth_sessions;
    drop trigger if exists work_audit_capture on commands;
    drop trigger if exists work_device_enrollment on devices;
    drop trigger if exists work_sign_in on auth_sessions;
    drop trigger if exists work_operation_policy on agent_operations;

    do $remove$ declare
      work record;
      modes constant text[] := array['approval-required', 'auto-accept-edits', 'auto', 'full-access'];
    begin
      if to_regclass('public.work_home_policy') is null then return; end if;
      select state, policy into work from work_home_policy where singleton;
      if not found then return; end if;
      -- What the policy refused could do nothing: it ends, as Disconnect ends it. So does every
      -- open connection of a Home its organization was closing. Already-expired connections stay
      -- as they are.
      update agent_connections set revoked_at = now(), token_hash = null,
        grant_revision = grant_revision + 1, cleanup_reason = 'revoked',
        cleanup_requested_at = now(), cleanup_completed_at = null
      where revoked_at is null and (bridge_account_id is not null or expires_at > now())
        and (work.state <> 'active' or case
        when "grant"->>'scope' = 'everything' then not (
          coalesce((work.policy->>'allowEverything')::boolean, false)
          and coalesce((work.policy->>'allowTasks')::boolean, false))
        else coalesce(("grant"->>'tasks')::boolean, false)
          and not coalesce((work.policy->>'allowTasks')::boolean, false) end);
      -- A mode above the cap becomes the cap, narrowed as the person's own edit narrows it.
      update agent_connections set access_mode = work.policy->>'externalMaxMode',
        grant_revision = grant_revision + 1, cleanup_reason = 'narrowed',
        cleanup_requested_at = now(), cleanup_minimum_grant_revision = grant_revision + 1,
        cleanup_maximum_mode = work.policy->>'externalMaxMode', cleanup_completed_at = null
      where revoked_at is null and (bridge_account_id is not null or expires_at > now())
        and array_position(modes, access_mode)
        > array_position(modes, work.policy->>'externalMaxMode');
    end $remove$;
    drop table if exists work_home_policy, work_audit_outbox, work_audit_head;
    drop function if exists work_audit_capture();
    drop function if exists work_home_gate();
    drop function if exists work_audit_append(jsonb, timestamptz);
    alter table agent_operations drop column if exists work_policy_revision;
    alter table commands drop column if exists work_owner_stop;
    alter table runner_enrollments drop column if exists work_enrollment_previewed_at;

    update agent_connections set bridge_ended_by = null
    where bridge_ended_by in ('organization', 'work-home');
    alter table agent_connections
      drop constraint if exists agent_connections_bridge_ended_by_check,
      add constraint agent_connections_bridge_ended_by_check
        check (bridge_ended_by in ('you', 'account', 'computer'));
  `.execute(database);
  await endLegacyTeamWork(database);
  await retireTeamRepliesRevision(database);
}

/**
 * What a teammate asked this Home for, written before teams ended, as this release reads it. Main
 * marked that work with a `team-thread` reply target on its inputs, Runs and delegations, and kept
 * a teammate's ask waiting for its owner in `awaiting-approval`, a state no screen releases now.
 *
 * - Not started (waiting in line or for its owner): cancelled once, with its own reason, its
 *   message kept in the task. Never put back in line as the person's own work.
 * - A Run queued for it and never started: ends through the start-up finish drain, as any queued
 *   Run ends, so its task and queue move on as they always do.
 * - Started, finishing or finished: keeps its outcome and what it did on this computer; only its
 *   delivery to the team ends. Nothing that may have happened is decided here.
 *
 * Every team reply target goes, so the finalizer and the readers never meet one. The input keeps
 * its legacy `team_request_id`: the current-state conversion (0038), which on a Home crossing it
 * runs after this, reads it to keep an unsent Team seed out of the queue, as main's did.
 *
 * On a Home crossing 0038 nothing is projected yet and the conversion projects all of it; on a
 * ready Home the cards and counts the cancellation changes are corrected here. Every client starts
 * its sync over after this release's migrations (0117), so a card's revision is only the head's.
 */
export async function endLegacyTeamWork(database: Kysely<unknown>): Promise<void> {
  await sql`
    create temporary table legacy_team_work_ended on commit drop as
      select i.message_id, i.thread_id, m.sequence, m.kind
      from thread_inputs i join messages m on m.id = i.message_id
      where i.state in ('pending', 'awaiting-approval') and i.run_id is null
        and (i.team_request_id is not null or i.reply_target->>'kind' = 'team-thread');

    do $team$ declare
      is_ready constant boolean := exists(select 1 from client_sync_state s where s.ready);
      sync_head bigint;
    begin
      if is_ready then
        -- Ended as a queued Run ends: its seed is cancelled below, so nothing starts it.
        update runs r set finish_intent = jsonb_build_object(
            'attemptId', null, 'bindingGeneration', null, 'mode', 'host',
            'outcome', 'interrupted', 'replyMessageId', null,
            'completedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'queuedInputCancellation', 'seed-input')
        from thread_inputs i
        where i.message_id = r.seed_input_id and r.status = 'queued' and r.finish_intent is null
          and (r.reply_target->>'kind' = 'team-thread' or i.team_request_id is not null
            or i.reply_target->>'kind' = 'team-thread');
      end if;

      update thread_inputs i set state = 'cancelled', cancel_reason = 'team-work-ended',
        updated_at = now()
      from legacy_team_work_ended e where i.message_id = e.message_id;

      if is_ready then
        select s.sequence into sync_head from client_sync_state s limit 1;
        -- A card the task did not show yet takes the task's next places, in message order.
        with placed as (
          select e.message_id, e.thread_id,
            row_number() over (partition by e.thread_id order by e.sequence, e.message_id) as n
          from legacy_team_work_ended e join transcript_items t on t.id = e.message_id
          where e.kind = 'input' and not t.visible
        ), counts as (
          select thread_id, count(*) as c from placed group by thread_id
        ), moved as (
          update threads th set next_transcript_position = th.next_transcript_position + counts.c
          from counts where th.id = counts.thread_id
          returning th.id, th.next_transcript_position - counts.c as base
        )
        update transcript_items t set position = moved.base + placed.n, visible = true,
          is_turn_start = true
        from placed join moved on moved.id = placed.thread_id
        where t.id = placed.message_id;
        -- The card says it did not run and why; a team's own fields are no longer read.
        update transcript_items t set revision = sync_head, view = (
          select case when octet_length(card.view::text) <= 2048 then card.view
            else jsonb_set(card.view, '{preview}', to_jsonb(left(card.view->>'preview', 256)))
              || '{"truncated":true}' end
          from (select (t.view - 'teamSource' - 'runDelivery' - 'delivery') || jsonb_build_object(
            'published', false,
            'delivery', jsonb_build_object('status', 'failed',
              'reason', 'Not run: work asked for by a team ended with this update.')) as view
          ) card)
        from legacy_team_work_ended e
        where t.id = e.message_id and e.kind = 'input' and t.visible;
        -- A teammate's ask counted as pending in its task; Requests alone count now.
        update threads th set revision = sync_head, pending_request_count = pending.count
        from (
          select e.thread_id, (select count(*)::integer from requests q
            where q.originating_thread_id = e.thread_id and q.status = 'pending') as count
          from (select distinct thread_id from legacy_team_work_ended) e
        ) pending
        where th.id = pending.thread_id and th.pending_request_count <> pending.count;
      end if;
    end $team$;

    update thread_inputs set reply_target = null where reply_target->>'kind' = 'team-thread';
    update runs set reply_target = null where reply_target->>'kind' = 'team-thread';
    update delegations set reply_target = null where reply_target->>'kind' = 'team-thread';
    drop index if exists runs_team_reply_target;
    drop table legacy_team_work_ended;
  `.execute(database);
}

/** By name, each in its place in the order: the first applies nothing, the second contracts. */
export const onePersonHomeFirstMigration: Readonly<Record<string, Migration>> = {
  [workHomeMigrationName]: { async up() {} },
};
export const onePersonHomeContractMigration: Readonly<Record<string, Migration>> = {
  [removeOrganizationsMigrationName]: { up: applyRemoveOrganizations },
};
/** The resource kinds whose revisions the Home keeps after teams ended, frozen with 0110. */
export const onePersonHomeResourceRevisionKinds = [
  "settings",
  "identity",
  "owner-profile",
  "environment",
  "machine",
  "harness",
  "harness-catalog",
  "tab",
  "tab-layout",
  "browser-profile",
  "browser-placement",
  "browser-home",
  "browser-availability",
  "plugin",
] as const;

/**
 * 0038 kept a revision for accepted team replies. Its counter, its key in the default and the
 * CHECK's requirement for it go together, the same on a Home that ran 0038 before and one that
 * runs it now; the CHECK takes one name on both.
 */
async function retireTeamRepliesRevision(database: Kysely<unknown>): Promise<void> {
  const kept = resourceRevisionsDdl(onePersonHomeResourceRevisionKinds);
  await sql`
    do $revisions$ declare old record; begin
      for old in select conname from pg_constraint
        where conrelid = 'client_sync_state'::regclass and contype = 'c'
          and pg_get_constraintdef(oid) like '%resource_revisions ?&%'
      loop
        execute format('alter table client_sync_state drop constraint %I', old.conname);
      end loop;
    end $revisions$;
    update client_sync_state set resource_revisions = resource_revisions - 'team-replies'
      where resource_revisions ? 'team-replies';
  `.execute(database);
  await sql
    .raw(
      `alter table client_sync_state
        alter column resource_revisions set default '${kept.defaultValue}',
        add constraint client_sync_state_resource_revisions check (${kept.check});`,
    )
    .execute(database);
}
