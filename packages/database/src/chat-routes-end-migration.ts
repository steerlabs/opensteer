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
 * - what each message a route brought in says about where it came from becomes what is true of
 *   it now, its state untouched: in a task tied to the ended row, it came from that connection
 *   (which stands for the chat), and a Run it seeded that has not ended names that connection; in
 *   a task that stays the person's own, every chat message in it came from them, so it is a
 *   message the person sent. Nothing is cancelled here: a waiting message of the ended row is
 *   cancelled, with its task's queue, by the code that cancels any waiting message of an ended
 *   connection (`ensureQueuedRun`, which start recovery runs for every task with waiting work),
 *   and a waiting message the person sent runs as theirs.
 */
/**
 * The names stored before the Home cleaned them where they enter (`outsideName` in
 * `@opensteer/shared`), cleaned the same way: line breaks and tabs to one space, every Cc and Cf
 * character removed (Postgres has no category classes, so Cf is spelled out, Unicode 17), runs of
 * space collapsed, trimmed, cut at the field's maximum.
 */
const cleanStoredNames = String.raw`
  create function pg_temp.outside_name(value text, maximum integer, fallback text) returns text
  language sql immutable as $clean$
    select coalesce(nullif(rtrim(left(btrim(regexp_replace(regexp_replace(
      regexp_replace(value, '\r\n|[\n\r\t\v\f\u0085\u2028\u2029]', ' ', 'g'),
      '[\x01-\x1f\x7f-\x9f\u00ad\u0600-\u0605\u061c\u06dd\u070f\u0890-\u0891\u08e2\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb\U000110bd\U000110cd\U00013430-\U0001343f\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0001\U000e0020-\U000e007f]', '', 'g'), '\s+', ' ', 'g')), maximum)), ''), fallback)
  $clean$;
  update agent_connections set
    label = pg_temp.outside_name(label, 120, client_name),
    client_name = pg_temp.outside_name(client_name, 100, 'Agent'),
    bridge_conversation_name = pg_temp.outside_name(bridge_conversation_name, 160, null);
  update channel_accounts set display_name = pg_temp.outside_name(display_name, 160, external_account_id),
    handle = pg_temp.outside_name(handle, 160, null);
  update integration_connections set display_name = pg_temp.outside_name(display_name, 160, provider)
    where connection_kind = 'channel';
  update channel_identities set display_name = pg_temp.outside_name(display_name, 160, external_user_id);
  update principals set display_name = pg_temp.outside_name(display_name, 160, 'Someone')
    where kind = 'channel-identity';
  update bridge_conversations set display_name = pg_temp.outside_name(display_name, 240, null);
  update threads set title = pg_temp.outside_name(title, 240, 'Task');
  update apps set name = pg_temp.outside_name(name, 160, 'App');
  update messages set author = jsonb_set(author, '{displayName}',
      to_jsonb(pg_temp.outside_name(author->>'displayName', 160, 'Someone')))
    where author ? 'displayName'
      and author->>'displayName' <> pg_temp.outside_name(author->>'displayName', 160, 'Someone');
  drop function pg_temp.outside_name(text, integer, text);
`;

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
    -- a chat that has ended, and no list draws it. Its cleanup is complete: no Run names it.
    insert into agent_connections (
      id, user_id, label, client_name, access_mode, resource, token_hash, created_at,
      expires_at, revoked_at, removed_at, "grant", grant_revision, consent_version,
      cleanup_reason, cleanup_requested_at, cleanup_completed_at, bridge_senders)
    select legacy.id, legacy.user_id, 'Chats from before the update', 'Messaging',
      'approval-required', 'opensteer:bridge', null, now(), now(), now(), now(),
      '{"scope":"selected","tasks":true,"resources":[]}'::jsonb, 2, 2, 'revoked', now(), now(),
      'anyone'
    from chat_routes_ended legacy;

    update threads t set origin_connection_id = legacy.id
    from chat_routes_reached reached
    join chat_routes_ended legacy on legacy.user_id = reached.created_by
    where reached.kind = 'thread' and t.id = reached.id and t.origin_connection_id is null;

    update triggers tr set origin_connection_id = legacy.id
    from chat_routes_reached reached
    join chat_routes_ended legacy on legacy.user_id = reached.created_by
    where reached.kind = 'trigger' and tr.id = reached.id and tr.origin_connection_id is null;

    -- Where each message a route brought in came from, as is true now (its state untouched).
    update thread_inputs i set
      authority_source = jsonb_build_object(
        'kind', 'connection', 'connectionId', t.origin_connection_id, 'userId', i.requested_by),
      connection_id = t.origin_connection_id
    from threads t
    where i.thread_id = t.id and t.origin_connection_id is not null
      and i.authority_source->>'kind' = 'channel-ingress';
    update thread_inputs i set
      authority_source = jsonb_build_object('kind', 'user-session', 'userId', i.requested_by)
    where i.authority_source->>'kind' = 'channel-ingress';
    update runs r set connection_id = i.connection_id
    from thread_inputs i
    where r.seed_input_id = i.message_id and r.connection_id is null
      and i.connection_id in (select id from chat_routes_ended)
      and r.status in ('queued', 'starting', 'running', 'waiting');
    drop index if exists thread_inputs_channel_authority;

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
  await sql.raw(cleanStoredNames).execute(database);
}
