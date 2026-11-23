import { sql, type Kysely } from "kysely";

export const chatRoutesEndMigrationName = "0053_chat_routes_end";

/**
 * The Messaging routes of the release before chats end with this update: nothing of them is
 * converted or kept, and the person adds the chats they want again. Their tables go (routes,
 * their approvals, the conversations they pinned, their deliveries and link codes). Two facts
 * about the person's work stay true, here and nowhere else:
 * - a task the previous release ran without the person's personal context (a conversation where
 *   anyone could speak) stays without it: it and everything under it is tied to one connection,
 *   ended already, named "Chats from before the update", so it takes no new work. A task it ran
 *   with their personal context stays their own, as it was;
 * - a message a route queued is never run: what is still waiting is cancelled at start, with its
 *   task's queue (`cancelChatMessagesFromBeforeTheUpdate`), and the dispatcher refuses one whose
 *   Run was already queued, because only code ends queued work with what the person's screens show.
 */
export async function applyChatRoutesEnd(database: Kysely<unknown>): Promise<void> {
  await sql`
    -- "Me" is one identity on an account. The image before this one let a person link several
    -- (a phone number and an email address): the most recently used stays linked, the others
    -- are unlinked, and the database keeps it to one from here on.
    update channel_identities older set status = 'unlinked', linked_user_id = null,
      updated_at = now()
    where older.status = 'linked' and older.linked_user_id is not null and exists (
      select 1 from channel_identities newer
      where newer.account_id = older.account_id and newer.linked_user_id = older.linked_user_id
        and newer.status = 'linked'
        and (newer.updated_at, newer.id) > (older.updated_at, older.id));
    create unique index if not exists channel_identities_one_me
      on channel_identities(account_id, linked_user_id)
      where status = 'linked' and linked_user_id is not null;

    -- Work that ran without the person's personal context, and everything under it.
    create temporary table chat_routes_unpersonal on commit drop as
      with recursive tainted(id) as (
        select c.active_thread_id from channel_conversations c
        where c.active_thread_id is not null and not c.personal_context
        union
        select i.thread_id from thread_inputs i
        join channel_conversations c on c.id = i.authority_source->>'conversationId'
        left join channel_identities identity on identity.principal_id = i.actor_principal_id
        join threads t on t.id = i.thread_id
        where i.authority_source->>'kind' = 'channel-ingress' and i.state <> 'cancelled'
          and (c.conversation_type <> 'dm' or identity.status is distinct from 'linked'
            or identity.linked_user_id is distinct from t.created_by)
        union
        select child.id from tainted
        cross join lateral (
          select t.id from threads t where t.parent_thread_id = tainted.id
          union
          select d.child_thread_id from delegations d where d.parent_thread_id = tainted.id
          union
          select i.thread_id from thread_inputs i
          join runs source_run on source_run.id = i.authority_source->>'runId'
          where source_run.thread_id = tainted.id and i.state <> 'cancelled'
            and i.authority_source->>'kind' = 'thread-agent'
          union
          select i.thread_id from thread_inputs i
          join trigger_occurrences o on o.id = i.authority_source->>'occurrenceId'
          join triggers tr on tr.id = o.trigger_id
          where tr.anchor_thread_id = tainted.id and i.state <> 'cancelled'
            and i.authority_source->>'kind' = 'trigger-occurrence'
          union
          select i.thread_id from thread_inputs i
          join triggers tr on tr.id = i.authority_source->>'triggerId'
          where tr.anchor_thread_id = tainted.id and i.state <> 'cancelled'
            and i.authority_source->>'kind' = 'watch-observation'
        ) child
      )
      select t.id, t.created_by from tainted join threads t on t.id = tainted.id
      where t.origin_connection_id is null;

    create temporary table chat_routes_ended on commit drop as
      select owner.created_by as user_id, 'mcn_' || gen_random_uuid() as id
      from (select distinct created_by from chat_routes_unpersonal) owner;

    -- Its sender rule is "anyone": the same rule that keeps work from an "anyone" bridge out of
    -- the person's personal context keeps these tasks out of it, for ever.
    insert into agent_connections (
      id, user_id, label, client_name, access_mode, resource, token_hash, created_at,
      expires_at, revoked_at, "grant", grant_revision, consent_version,
      cleanup_reason, cleanup_requested_at, bridge_senders)
    select legacy.id, legacy.user_id, 'Chats from before the update', 'Messaging',
      'approval-required', 'opensteer:bridge', null, now(), now(), now(),
      '{"scope":"selected","tasks":true,"resources":[]}'::jsonb, 2, 2, 'revoked', now(), 'anyone'
    from chat_routes_ended legacy;

    update threads t set origin_connection_id = legacy.id
    from chat_routes_unpersonal unpersonal
    join chat_routes_ended legacy on legacy.user_id = unpersonal.created_by
    where t.id = unpersonal.id and t.origin_connection_id is null;

    update triggers tr set origin_connection_id = t.origin_connection_id
    from threads t join chat_routes_ended legacy on legacy.id = t.origin_connection_id
    where tr.anchor_thread_id = t.id and tr.origin_connection_id is null;

    -- The routes and everything only they used.
    drop table channel_deliveries;
    drop table channel_access_grants;
    drop table channel_link_codes;
    alter table channel_ingress_events drop column conversation_id;
    drop table channel_conversations;
    drop table channel_bindings;
  `.execute(database);
}
