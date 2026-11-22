import { sql, type Kysely } from "kysely";

export const bridgeConversionMigrationName = "0053_bridge_conversion";

/**
 * Each Messaging route the person had becomes bridges that can only do less than it did:
 * answering only the person, Supervised, with `tasks` alone, until the person chooses what each
 * may use on its consent. Nothing the previous image reads is rewritten: routes, approvals and
 * conversations stay exactly as they are and the new code never reads them again. The rows
 * written here are additions, plus two changes that only reduce in either image: work that ran
 * without the person's personal context is tied to one revoked connection, so it can never run
 * with their authority again (queued chat messages are cancelled at start, where their tasks'
 * queues are refreshed with them).
 */
export async function applyBridgeConversion(database: Kysely<unknown>): Promise<void> {
  await sql`
    -- A work Home's ceiling applies as to any connection: a bridge it refuses is made revoked.
    create temporary table bridge_conversion_policy on commit drop as
      select coalesce((
        select p.state <> 'active' or not coalesce((p.policy->>'allowTasks')::boolean, false)
        from work_home_policy p where p.singleton
      ), false) as refused;

    -- What each live route matched, and nothing more: its selector (a route for one kind of
    -- conversation, one conversation, one workspace; one for a single thread matched less than
    -- any bridge covers, so it makes none), its direct messages unless off, and its channels
    -- unless their scope or their senders were off. Where two routes cover the same thing, the
    -- one that answered there wins: the more specific, then the earlier.
    create temporary table bridge_conversion_route on commit drop as
      select b.id as binding_id, b.created_by, b.created_at, a.id as account_id, a.provider,
        (select count(*) from jsonb_each(b.selector) part
          where part.key in ('scopeId', 'conversationId', 'threadId', 'conversationType')
            and part.value <> 'null'::jsonb) as specificity,
        b.selector->>'conversationType' as only_type,
        b.selector->>'conversationId' as only_conversation,
        (b.selector->>'scopeId' is null or b.selector->>'scopeId' = a.external_account_id)
          and b.selector->>'threadId' is null as whole,
        coalesce(b.access_policy->'directMessages'->>'mode', 'off') <> 'off' as direct_on,
        coalesce(b.access_policy->'channels'->>'scope', 'off') as channel_scope,
        coalesce(b.access_policy->'channels'->'conversationIds', '[]'::jsonb) as channel_ids,
        coalesce(b.access_policy->'channels'->'sender'->>'mode', 'off') <> 'off'
          and coalesce(b.access_policy->'channels'->>'scope', 'off') <> 'off' as channels_on
      from channel_bindings b join channel_accounts a on a.id = b.account_id
      where b.status = 'active' and a.status <> 'revoked';

    -- What each route would make: its direct messages, and each channel it named.
    create temporary table bridge_conversion_candidate on commit drop as
      select r.binding_id, r.created_by, r.created_at, r.specificity, r.account_id, r.provider,
        null::text as conversation_id, null::text as conversation_name
      from bridge_conversion_route r
      where r.whole and r.direct_on and r.only_conversation is null
        and (r.only_type is null or r.only_type = 'dm')
      union all
      select r.binding_id, r.created_by, r.created_at, r.specificity, r.account_id, r.provider,
        named.id,
        coalesce((select c.display_name from channel_conversations c
          where c.account_id = r.account_id and c.external_conversation_id = named.id
            and c.display_name is not null order by c.created_at limit 1), named.id)
      from bridge_conversion_route r
      cross join lateral (
        select r.only_conversation as id
        where r.only_conversation is not null
          and (r.channel_scope = 'all' or r.channel_ids ? r.only_conversation)
        union
        select listed.id from jsonb_array_elements_text(r.channel_ids) as listed(id)
        where r.only_conversation is null and r.channel_scope = 'selected'
      ) named
      where r.whole and r.channels_on and (r.only_type is null or r.only_type in ('channel', 'group'));

    -- Accounts where a route answered every channel: no channel is guessed, and the notice says
    -- that channels are not covered any more.
    create temporary table bridge_conversion_all_channels on commit drop as
      select distinct on (r.account_id) r.binding_id, r.created_by, r.created_at, r.specificity,
        r.account_id, r.provider
      from bridge_conversion_route r
      where r.whole and r.channels_on and r.only_conversation is null and r.channel_scope = 'all'
        and (r.only_type is null or r.only_type in ('channel', 'group'))
      order by r.account_id, r.created_at, r.binding_id;

    create temporary table bridge_conversion_plan on commit drop as
      -- A target converts only from the route that answered there: none more specific matched
      -- it (whatever that route did with it, off included).
      select c.*,
        case when c.conversation_id is null and exists (
            select 1 from bridge_conversion_all_channels a where a.account_id = c.account_id)
          then 'converted-without-channels' else 'converted' end as notice,
        false as ended
      from bridge_conversion_candidate c
      where not exists (
        select 1 from bridge_conversion_route s
        where s.account_id = c.account_id and s.whole and s.specificity > c.specificity
          and (case when c.conversation_id is null
            then s.only_conversation is null and (s.only_type is null or s.only_type = 'dm')
            else (s.only_conversation is null or s.only_conversation = c.conversation_id)
              and (s.only_type is null or s.only_type in ('channel', 'group')) end))
      union all
      -- Every channel, and no bridge for direct messages to carry the notice: an ended bridge
      -- keeps it.
      select a.binding_id, a.created_by, a.created_at, a.specificity, a.account_id, a.provider,
        null, null, 'converted-without-channels', true
      from bridge_conversion_all_channels a
      where not exists (
        select 1 from bridge_conversion_candidate c
        where c.account_id = a.account_id and c.conversation_id is null
          and not exists (
            select 1 from bridge_conversion_route s
            where s.account_id = c.account_id and s.whole and s.specificity > c.specificity
              and s.only_conversation is null and (s.only_type is null or s.only_type = 'dm')));

    insert into agent_connections (
      id, user_id, label, client_name, access_mode, resource, token_hash, created_at,
      expires_at, revoked_at, "grant", grant_revision, consent_version,
      cleanup_reason, cleanup_requested_at,
      bridge_account_id, bridge_conversation_id, bridge_senders, bridge_from_binding_id,
      bridge_notice)
    select 'mcn_' || gen_random_uuid(), plan.created_by,
      left(case when plan.conversation_name is null then provider_label
        else provider_label || ' · ' || plan.conversation_name end, 120),
      provider_label, 'approval-required', 'opensteer:bridge', null, now(),
      '9999-12-31T00:00:00Z'::timestamptz,
      case when policy.refused or plan.ended then now() end,
      '{"scope":"selected","tasks":true,"resources":[]}'::jsonb, 1, 2,
      case when policy.refused or plan.ended then 'revoked' end,
      case when policy.refused or plan.ended then now() end,
      plan.account_id, plan.conversation_id, 'owner', plan.binding_id, plan.notice
    from bridge_conversion_plan plan
    cross join bridge_conversion_policy policy
    cross join lateral (select case plan.provider when 'slack' then 'Slack'
      when 'imessage' then 'iMessage' else plan.provider end as provider_label) label
    where not exists (
      select 1 from agent_connections taken
      where taken.bridge_account_id = plan.account_id
        and coalesce(taken.bridge_conversation_id, '') = coalesce(plan.conversation_id, '')
        and (taken.revoked_at is null or taken.bridge_from_binding_id is not null))
    order by plan.ended, plan.specificity desc, plan.created_at, plan.binding_id
    on conflict do nothing;

    -- Work that ran without the person's personal context, and everything under it.
    create temporary table bridge_conversion_unpersonal on commit drop as
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

    create temporary table bridge_conversion_legacy on commit drop as
      select owner.created_by as user_id, 'mcn_' || gen_random_uuid() as id
      from (select distinct created_by from bridge_conversion_unpersonal) owner;

    -- Its sender rule is "anyone": the same rule that keeps work from an "anyone" bridge out of
    -- the person's personal context keeps these tasks out of it, for ever.
    insert into agent_connections (
      id, user_id, label, client_name, access_mode, resource, token_hash, created_at,
      expires_at, revoked_at, "grant", grant_revision, consent_version,
      cleanup_reason, cleanup_requested_at, bridge_senders)
    select legacy.id, legacy.user_id, 'Messages before the update', 'Messaging',
      'approval-required', 'opensteer:bridge', null, now(), now(), now(),
      '{"scope":"selected","tasks":true,"resources":[]}'::jsonb, 2, 2, 'revoked', now(), 'anyone'
    from bridge_conversion_legacy legacy;

    update threads t set origin_connection_id = legacy.id
    from bridge_conversion_unpersonal unpersonal
    join bridge_conversion_legacy legacy on legacy.user_id = unpersonal.created_by
    where t.id = unpersonal.id and t.origin_connection_id is null;

    update triggers tr set origin_connection_id = t.origin_connection_id
    from threads t join bridge_conversion_legacy legacy on legacy.id = t.origin_connection_id
    where tr.anchor_thread_id = t.id and tr.origin_connection_id is null;
  `.execute(database);
}
