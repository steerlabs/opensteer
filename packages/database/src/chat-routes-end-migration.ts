import { sql, type Kysely } from "kysely";

/** A contract migration: it drops what a running previous Home still uses (`migrations.test.ts`). */
export const chatRoutesEndMigrationName = "0053_chat_routes_end_contract";

/**
 * The Messaging routes of the release before chats end with this update: nothing of them is
 * converted or kept, and the person adds the chats they want again. Their tables go (routes,
 * their approvals, the conversations they pinned, their deliveries and link codes). Facts about
 * the person's work stay true:
 * - work the previous release ran without the person's personal context (a conversation where
 *   anyone could speak, or a direct message from someone who was not them) stays without it.
 *   That is each such task, every task and automation it made or whose script it last wrote,
 *   and everything those sent work to: all are tied to one connection per person, ended and
 *   removed already (no list draws it), a chat for anyone, so none of it takes new work or runs
 *   as the person. Work they ran with the person's personal context stays theirs, as it was;
 * - an app a task made (`apps.thread_id`) and a plugin a task set up (`plugins.setup_thread_id`)
 *   stay: the app is the person's, started and stopped by them, and a plugin's local server is
 *   approved by them before it runs; the task is only named beside each;
 * - "me" is one identity on an account. The release before let a person link several (a phone
 *   number and an email address); the one they last sent a message from stays linked (or, never
 *   used, the one linked last), after the work above is read against the identities as they
 *   were, so what they said from any of them stays theirs;
 * - a message a route queued is never run: what is still waiting is cancelled at start, with its
 *   task's queue (`cancelChatMessagesFromBeforeTheUpdate`).
 */
export async function applyChatRoutesEnd(database: Kysely<unknown>): Promise<void> {
  await sql`
    -- Work that ran without the person's personal context, and everything under it.
    -- Work that ran without the person's personal context, and everything it reached: tasks
    -- ('thread') and automations ('trigger'), walked together.
    create temporary table chat_routes_reached on commit drop as
      with recursive tainted(kind, id) as (
        select 'thread', c.active_thread_id from channel_conversations c
        where c.active_thread_id is not null and not c.personal_context
        union
        select 'thread', i.thread_id from thread_inputs i
        join channel_conversations c on c.id = i.authority_source->>'conversationId'
        left join channel_identities identity on identity.principal_id = i.actor_principal_id
        join threads t on t.id = i.thread_id
        where i.authority_source->>'kind' = 'channel-ingress' and i.state <> 'cancelled'
          and (c.conversation_type <> 'dm' or not c.personal_context
            or identity.status is distinct from 'linked'
            or identity.linked_user_id is distinct from t.created_by)
        union
        select next.kind, next.id from tainted
        cross join lateral (
          select 'thread', t.id from threads t
          where tainted.kind = 'thread' and t.parent_thread_id = tainted.id
          union
          select 'thread', d.child_thread_id from delegations d
          where tainted.kind = 'thread' and d.parent_thread_id = tainted.id
          union
          select 'thread', i.thread_id from thread_inputs i
          join runs source_run on source_run.id = i.authority_source->>'runId'
          where tainted.kind = 'thread' and source_run.thread_id = tainted.id
            and i.state <> 'cancelled' and i.authority_source->>'kind' = 'thread-agent'
          union
          -- An automation it is anchored to, it made, or whose current script it wrote.
          select 'trigger', tr.id from triggers tr
          where tainted.kind = 'thread' and (tr.anchor_thread_id = tainted.id
            or tr.created_by_thread_id = tainted.id
            or exists (select 1 from trigger_revisions r
              where r.id = tr.current_revision_id and r.created_by_thread_id = tainted.id))
          union
          -- What such an automation sent work to.
          select 'thread', i.thread_id from thread_inputs i
          join trigger_occurrences o on o.id = i.authority_source->>'occurrenceId'
          where tainted.kind = 'trigger' and o.trigger_id = tainted.id
            and i.state <> 'cancelled' and i.authority_source->>'kind' = 'trigger-occurrence'
          union
          select 'thread', i.thread_id from thread_inputs i
          where tainted.kind = 'trigger' and i.authority_source->>'triggerId' = tainted.id
            and i.state <> 'cancelled' and i.authority_source->>'kind' = 'watch-observation'
        ) as next(kind, id)
      )
      select 'thread' as kind, t.id, t.created_by from tainted join threads t on t.id = tainted.id
      where tainted.kind = 'thread' and t.origin_connection_id is null
      union
      select 'trigger', tr.id, tr.created_by from tainted join triggers tr on tr.id = tainted.id
      where tainted.kind = 'trigger' and tr.origin_connection_id is null;

    create temporary table chat_routes_ended on commit drop as
      select owner.created_by as user_id, 'mcn_' || gen_random_uuid() as id
      from (select distinct created_by from chat_routes_reached) owner;

    -- Its sender rule is "anyone": the same rule that keeps work from an "anyone" bridge out of
    -- the person's personal context keeps this work out of it, for ever. Ended and removed: it is
    -- a chat that has ended, and no list draws it.
    insert into agent_connections (
      id, user_id, label, client_name, access_mode, resource, token_hash, created_at,
      expires_at, revoked_at, removed_at, "grant", grant_revision, consent_version,
      cleanup_reason, cleanup_requested_at, bridge_senders)
    select legacy.id, legacy.user_id, 'Chats from before the update', 'Messaging',
      'approval-required', 'opensteer:bridge', null, now(), now(), now(), now(),
      '{"scope":"selected","tasks":true,"resources":[]}'::jsonb, 2, 2, 'revoked', now(), 'anyone'
    from chat_routes_ended legacy;

    update threads t set origin_connection_id = legacy.id
    from chat_routes_reached reached
    join chat_routes_ended legacy on legacy.user_id = reached.created_by
    where reached.kind = 'thread' and t.id = reached.id and t.origin_connection_id is null;

    update triggers tr set origin_connection_id = legacy.id
    from chat_routes_reached reached
    join chat_routes_ended legacy on legacy.user_id = reached.created_by
    where reached.kind = 'trigger' and tr.id = reached.id and tr.origin_connection_id is null;

    -- "Me", once the work above was read against the identities as they were: the one each
    -- person last sent a message from stays linked (never used: the one linked last).
    update channel_identities older set status = 'unlinked', linked_user_id = null,
      updated_at = now()
    from (
      select identity.id, row_number() over (
        partition by identity.account_id, identity.linked_user_id
        order by (select max(i.created_at) from thread_inputs i
            where i.actor_principal_id = identity.principal_id) desc nulls last,
          identity.updated_at desc, identity.id desc) as place
      from channel_identities identity
      where identity.status = 'linked' and identity.linked_user_id is not null
    ) ranked
    where ranked.id = older.id and ranked.place > 1;
    create unique index if not exists channel_identities_one_me
      on channel_identities(account_id, linked_user_id)
      where status = 'linked' and linked_user_id is not null;

    -- The routes and everything only they used.
    drop index if exists thread_inputs_current_channel_binding;
    drop table channel_deliveries;
    drop table channel_access_grants;
    drop table channel_link_codes;
    alter table channel_ingress_events drop column conversation_id;
    drop table channel_conversations;
    drop table channel_bindings;
  `.execute(database);
}
