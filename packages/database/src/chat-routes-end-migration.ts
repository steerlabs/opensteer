import { outsideName } from "@opensteer/shared/outsideName";
import { sql, type Kysely, type RawBuilder } from "kysely";

/** A contract migration: it drops what a running previous Home still uses (`migrations.test.ts`). */
export const chatRoutesEndMigrationName = "0053_chat_routes_end_contract";

const cleanBatchSize = 500;
const needsCleanPattern = "[^ -~]|^ | $|  ";

function needsClean(column: RawBuilder<unknown>, max: number) {
  return sql<boolean>`(${column} is not null and (${column} ~ ${needsCleanPattern} or length(${column}) > ${max} or ${column} = ''))`;
}

async function paginateById<Row extends { readonly id: string }>(
  fetch: (afterId: string | null) => Promise<readonly Row[]>,
  apply: (rows: readonly Row[]) => Promise<void>,
): Promise<void> {
  let afterId: string | null = null;
  for (;;) {
    const rows = await fetch(afterId);
    if (rows.length === 0) break;
    await apply(rows);
    afterId = rows[rows.length - 1]!.id;
    if (rows.length < cleanBatchSize) break;
  }
}

function cleanIdentityAtConsent(value: unknown): {
  readonly changed: boolean;
  readonly value: unknown;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { changed: false, value };
  const record = value as Record<string, unknown>;
  let changed = false;
  const next: Record<string, unknown> = { ...record };
  for (const [key, entry] of Object.entries(record)) {
    if (!key.endsWith("Name") || typeof entry !== "string") continue;
    const cleaned = outsideName(entry, 100) || "Agent";
    if (cleaned !== entry) {
      next[key] = cleaned;
      changed = true;
    }
  }
  return changed ? { changed: true, value: next } : { changed: false, value };
}

function cleanIngressEvent(value: unknown): { readonly changed: boolean; readonly value: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { changed: false, value };
  const event = value as Record<string, unknown>;
  let changed = false;
  let actor = event.actor;
  if (actor && typeof actor === "object" && !Array.isArray(actor)) {
    const record = actor as Record<string, unknown>;
    if (typeof record.displayName === "string") {
      const fallback =
        (typeof record.externalUserId === "string"
          ? outsideName(record.externalUserId, 160)
          : "") || "Someone";
      const cleaned = outsideName(record.displayName, 160) || fallback;
      if (cleaned !== record.displayName) {
        actor = { ...record, displayName: cleaned };
        changed = true;
      }
    }
  }
  let conversation = event.conversation;
  if (conversation && typeof conversation === "object" && !Array.isArray(conversation)) {
    const record = conversation as Record<string, unknown>;
    if (typeof record.displayName === "string") {
      const cleaned = outsideName(record.displayName, 240) || null;
      if (cleaned !== record.displayName) {
        conversation = { ...record, displayName: cleaned };
        changed = true;
      }
    }
  }
  return changed
    ? { changed: true, value: { ...event, actor, conversation } }
    : { changed: false, value };
}

/**
 * Cleans every stored name column and JSON place through the one `outsideName` implementation,
 * batched by primary key inside the migration's transaction. Only rows whose value changes are
 * updated; an empty cleaned value takes the store's neutral fallback.
 */
async function cleanStoredNames(database: Kysely<unknown>): Promise<void> {
  const after = (afterId: string | null) => (afterId === null ? sql`true` : sql`id > ${afterId}`);

  // 1. agent_connections (label, client_name, bridge_conversation_name, identity_at_consent)
  await paginateById(
    async (afterId) =>
      (
        await sql<{
          readonly id: string;
          readonly label: string;
          readonly clientName: string;
          readonly bridgeName: string | null;
          readonly identity: unknown;
        }>`
          select id, label, client_name as "clientName",
            bridge_conversation_name as "bridgeName", identity_at_consent as "identity"
          from agent_connections
          where ${after(afterId)}
            and (${needsClean(sql`label`, 120)}
              or ${needsClean(sql`client_name`, 100)}
              or ${needsClean(sql`bridge_conversation_name`, 160)}
              or ${needsClean(sql`identity_at_consent->>'clientName'`, 100)}
              or ${needsClean(sql`identity_at_consent->>'platformName'`, 100)}
              or ${needsClean(sql`identity_at_consent->>'embedderName'`, 100)})
          order by id
          limit ${cleanBatchSize}
        `.execute(database)
      ).rows,
    async (rows) => {
      const ids: string[] = [];
      const labels: string[] = [];
      const clientNames: string[] = [];
      const bridgeNames: (string | null)[] = [];
      const identities: (string | null)[] = [];
      for (const row of rows) {
        const clientName = outsideName(row.clientName, 100) || "Agent";
        const label = outsideName(row.label, 120) || clientName;
        const bridgeName =
          row.bridgeName === null ? null : outsideName(row.bridgeName, 160) || null;
        const identity = cleanIdentityAtConsent(row.identity);
        if (
          clientName === row.clientName &&
          label === row.label &&
          bridgeName === row.bridgeName &&
          !identity.changed
        )
          continue;
        ids.push(row.id);
        labels.push(label);
        clientNames.push(clientName);
        bridgeNames.push(bridgeName);
        identities.push(identity.value === null ? null : JSON.stringify(identity.value));
      }
      if (ids.length === 0) return;
      await sql`
        update agent_connections as t set
          label = u.label,
          client_name = u.client_name,
          bridge_conversation_name = u.bridge_conversation_name,
          identity_at_consent = u.identity_at_consent::jsonb
        from unnest(
          ${ids}::text[],
          ${labels}::text[],
          ${clientNames}::text[],
          ${bridgeNames}::text[],
          ${identities}::text[]
        ) as u(id, label, client_name, bridge_conversation_name, identity_at_consent)
        where t.id = u.id
      `.execute(database);
    },
  );

  // 2. channel_accounts (display_name, handle)
  await paginateById(
    async (afterId) =>
      (
        await sql<{
          readonly id: string;
          readonly displayName: string;
          readonly externalAccountId: string;
          readonly handle: string | null;
        }>`
          select id, display_name as "displayName",
            external_account_id as "externalAccountId", handle
          from channel_accounts
          where ${after(afterId)}
            and (${needsClean(sql`display_name`, 160)} or ${needsClean(sql`handle`, 160)})
          order by id
          limit ${cleanBatchSize}
        `.execute(database)
      ).rows,
    async (rows) => {
      const ids: string[] = [];
      const displayNames: string[] = [];
      const handles: (string | null)[] = [];
      for (const row of rows) {
        const displayName =
          outsideName(row.displayName, 160) || outsideName(row.externalAccountId, 160) || "Account";
        const handle = row.handle === null ? null : outsideName(row.handle, 160) || null;
        if (displayName === row.displayName && handle === row.handle) continue;
        ids.push(row.id);
        displayNames.push(displayName);
        handles.push(handle);
      }
      if (ids.length === 0) return;
      await sql`
        update channel_accounts as t set
          display_name = u.display_name,
          handle = u.handle
        from unnest(${ids}::text[], ${displayNames}::text[], ${handles}::text[])
          as u(id, display_name, handle)
        where t.id = u.id
      `.execute(database);
    },
  );

  // 3. integration_connections (channel connections: display_name)
  await paginateById(
    async (afterId) =>
      (
        await sql<{
          readonly id: string;
          readonly displayName: string;
          readonly provider: string;
        }>`
          select id, display_name as "displayName", provider
          from integration_connections
          where connection_kind = 'channel'
            and ${after(afterId)}
            and ${needsClean(sql`display_name`, 160)}
          order by id
          limit ${cleanBatchSize}
        `.execute(database)
      ).rows,
    async (rows) => {
      const ids: string[] = [];
      const displayNames: string[] = [];
      for (const row of rows) {
        const displayName =
          outsideName(row.displayName, 160) || outsideName(row.provider, 160) || "Channel";
        if (displayName === row.displayName) continue;
        ids.push(row.id);
        displayNames.push(displayName);
      }
      if (ids.length === 0) return;
      await sql`
        update integration_connections as t set display_name = u.display_name
        from unnest(${ids}::text[], ${displayNames}::text[]) as u(id, display_name)
        where t.id = u.id
      `.execute(database);
    },
  );

  // 4. channel_identities (display_name)
  await paginateById(
    async (afterId) =>
      (
        await sql<{
          readonly id: string;
          readonly displayName: string;
          readonly externalUserId: string;
        }>`
          select id, display_name as "displayName", external_user_id as "externalUserId"
          from channel_identities
          where ${after(afterId)} and ${needsClean(sql`display_name`, 160)}
          order by id
          limit ${cleanBatchSize}
        `.execute(database)
      ).rows,
    async (rows) => {
      const ids: string[] = [];
      const displayNames: string[] = [];
      for (const row of rows) {
        const displayName =
          outsideName(row.displayName, 160) || outsideName(row.externalUserId, 160) || "Someone";
        if (displayName === row.displayName) continue;
        ids.push(row.id);
        displayNames.push(displayName);
      }
      if (ids.length === 0) return;
      await sql`
        update channel_identities as t set display_name = u.display_name
        from unnest(${ids}::text[], ${displayNames}::text[]) as u(id, display_name)
        where t.id = u.id
      `.execute(database);
    },
  );

  // 5. principals (channel-identity: display_name)
  await paginateById(
    async (afterId) =>
      (
        await sql<{ readonly id: string; readonly displayName: string }>`
          select id, display_name as "displayName"
          from principals
          where kind = 'channel-identity'
            and ${after(afterId)}
            and ${needsClean(sql`display_name`, 160)}
          order by id
          limit ${cleanBatchSize}
        `.execute(database)
      ).rows,
    async (rows) => {
      const ids: string[] = [];
      const displayNames: string[] = [];
      for (const row of rows) {
        const displayName = outsideName(row.displayName, 160) || "Someone";
        if (displayName === row.displayName) continue;
        ids.push(row.id);
        displayNames.push(displayName);
      }
      if (ids.length === 0) return;
      await sql`
        update principals as t set display_name = u.display_name
        from unnest(${ids}::text[], ${displayNames}::text[]) as u(id, display_name)
        where t.id = u.id
      `.execute(database);
    },
  );

  // 6. bridge_conversations (display_name)
  await paginateById(
    async (afterId) =>
      (
        await sql<{ readonly id: string; readonly displayName: string | null }>`
          select id, display_name as "displayName"
          from bridge_conversations
          where ${after(afterId)} and ${needsClean(sql`display_name`, 240)}
          order by id
          limit ${cleanBatchSize}
        `.execute(database)
      ).rows,
    async (rows) => {
      const ids: string[] = [];
      const displayNames: (string | null)[] = [];
      for (const row of rows) {
        const displayName =
          row.displayName === null ? null : outsideName(row.displayName, 240) || null;
        if (displayName === row.displayName) continue;
        ids.push(row.id);
        displayNames.push(displayName);
      }
      if (ids.length === 0) return;
      await sql`
        update bridge_conversations as t set display_name = u.display_name
        from unnest(${ids}::text[], ${displayNames}::text[]) as u(id, display_name)
        where t.id = u.id
      `.execute(database);
    },
  );

  // 7. threads (title)
  await paginateById(
    async (afterId) =>
      (
        await sql<{ readonly id: string; readonly title: string }>`
          select id, title
          from threads
          where ${after(afterId)} and ${needsClean(sql`title`, 240)}
          order by id
          limit ${cleanBatchSize}
        `.execute(database)
      ).rows,
    async (rows) => {
      const ids: string[] = [];
      const titles: string[] = [];
      for (const row of rows) {
        const title = outsideName(row.title, 240) || "Task";
        if (title === row.title) continue;
        ids.push(row.id);
        titles.push(title);
      }
      if (ids.length === 0) return;
      await sql`
        update threads as t set title = u.title
        from unnest(${ids}::text[], ${titles}::text[]) as u(id, title)
        where t.id = u.id
      `.execute(database);
    },
  );

  // 8. apps (name)
  await paginateById(
    async (afterId) =>
      (
        await sql<{ readonly id: string; readonly name: string }>`
          select id, name
          from apps
          where ${after(afterId)} and ${needsClean(sql`name`, 160)}
          order by id
          limit ${cleanBatchSize}
        `.execute(database)
      ).rows,
    async (rows) => {
      const ids: string[] = [];
      const names: string[] = [];
      for (const row of rows) {
        const name = outsideName(row.name, 160) || "App";
        if (name === row.name) continue;
        ids.push(row.id);
        names.push(name);
      }
      if (ids.length === 0) return;
      await sql`
        update apps as t set name = u.name
        from unnest(${ids}::text[], ${names}::text[]) as u(id, name)
        where t.id = u.id
      `.execute(database);
    },
  );

  // 9. transcript_items (app cards: view->>'title')
  await paginateById(
    async (afterId) =>
      (
        await sql<{ readonly id: string; readonly title: string }>`
          select id, view->>'title' as title
          from transcript_items
          where kind = 'app'
            and view ? 'title'
            and ${after(afterId)}
            and ${needsClean(sql`view->>'title'`, 160)}
          order by id
          limit ${cleanBatchSize}
        `.execute(database)
      ).rows,
    async (rows) => {
      const ids: string[] = [];
      const titles: string[] = [];
      for (const row of rows) {
        const title = outsideName(row.title, 160) || "App";
        if (title === row.title) continue;
        ids.push(row.id);
        titles.push(title);
      }
      if (ids.length === 0) return;
      await sql`
        update transcript_items as t set
          view = jsonb_set(t.view, '{title}', to_jsonb(u.title))
        from unnest(${ids}::text[], ${titles}::text[]) as u(id, title)
        where t.id = u.id
      `.execute(database);
    },
  );

  // 10. triggers (name)
  await paginateById(
    async (afterId) =>
      (
        await sql<{ readonly id: string; readonly name: string }>`
          select id, name
          from triggers
          where ${after(afterId)} and ${needsClean(sql`name`, 160)}
          order by id
          limit ${cleanBatchSize}
        `.execute(database)
      ).rows,
    async (rows) => {
      const ids: string[] = [];
      const names: string[] = [];
      for (const row of rows) {
        const name = outsideName(row.name, 160) || "Automation";
        if (name === row.name) continue;
        ids.push(row.id);
        names.push(name);
      }
      if (ids.length === 0) return;
      await sql`
        update triggers as t set name = u.name
        from unnest(${ids}::text[], ${names}::text[]) as u(id, name)
        where t.id = u.id
      `.execute(database);
    },
  );

  // 11. browser_profiles (name)
  await paginateById(
    async (afterId) =>
      (
        await sql<{ readonly id: string; readonly name: string }>`
          select id, name
          from browser_profiles
          where ${after(afterId)} and ${needsClean(sql`name`, 120)}
          order by id
          limit ${cleanBatchSize}
        `.execute(database)
      ).rows,
    async (rows) => {
      const ids: string[] = [];
      const names: string[] = [];
      for (const row of rows) {
        const name = outsideName(row.name, 120) || "Profile";
        if (name === row.name) continue;
        ids.push(row.id);
        names.push(name);
      }
      if (ids.length === 0) return;
      await sql`
        update browser_profiles as t set name = u.name
        from unnest(${ids}::text[], ${names}::text[]) as u(id, name)
        where t.id = u.id
      `.execute(database);
    },
  );

  // 12. messages (author->>'displayName')
  await paginateById(
    async (afterId) =>
      (
        await sql<{ readonly id: string; readonly displayName: string }>`
          select id, author->>'displayName' as "displayName"
          from messages
          where author ? 'displayName'
            and ${after(afterId)}
            and ${needsClean(sql`author->>'displayName'`, 160)}
          order by id
          limit ${cleanBatchSize}
        `.execute(database)
      ).rows,
    async (rows) => {
      const ids: string[] = [];
      const displayNames: string[] = [];
      for (const row of rows) {
        const displayName = outsideName(row.displayName, 160) || "Someone";
        if (displayName === row.displayName) continue;
        ids.push(row.id);
        displayNames.push(displayName);
      }
      if (ids.length === 0) return;
      await sql`
        update messages as t set
          author = jsonb_set(t.author, '{displayName}', to_jsonb(u.display_name))
        from unnest(${ids}::text[], ${displayNames}::text[]) as u(id, display_name)
        where t.id = u.id
      `.execute(database);
    },
  );

  // 13. channel_ingress_events (event->'actor'->>'displayName', event->'conversation'->>'displayName')
  await paginateById(
    async (afterId) =>
      (
        await sql<{ readonly id: string; readonly event: unknown }>`
          select id, event
          from channel_ingress_events
          where ${after(afterId)}
            and (${needsClean(sql`event->'actor'->>'displayName'`, 160)}
              or ${needsClean(sql`event->'conversation'->>'displayName'`, 240)})
          order by id
          limit ${cleanBatchSize}
        `.execute(database)
      ).rows,
    async (rows) => {
      const ids: string[] = [];
      const events: string[] = [];
      for (const row of rows) {
        const cleaned = cleanIngressEvent(row.event);
        if (!cleaned.changed) continue;
        ids.push(row.id);
        events.push(JSON.stringify(cleaned.value));
      }
      if (ids.length === 0) return;
      await sql`
        update channel_ingress_events as t set event = u.event::jsonb
        from unnest(${ids}::text[], ${events}::text[]) as u(id, event)
        where t.id = u.id
      `.execute(database);
    },
  );
}

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

export async function applyChatRoutesEnd(database: Kysely<unknown>): Promise<void> {
  await sql`
    -- Work that ran without the person's personal context, and everything it reached: tasks
    -- ('thread') and automations ('trigger'), walked together.
    create temporary table chat_routes_reached on commit drop as
      with recursive tainted(kind, id) as (
        select 'thread', c.active_thread_id from channel_conversations c
        where c.active_thread_id is not null and not c.personal_context
        union
        select 'thread', i.thread_id from thread_inputs i
        left join channel_conversations c on c.id = i.authority_source->>'conversationId'
        left join channel_identities identity on identity.principal_id = i.actor_principal_id
        join threads t on t.id = i.thread_id
        where i.authority_source->>'kind' = 'channel-ingress' and i.state <> 'cancelled'
          and (c.id is null or c.conversation_type <> 'dm' or not c.personal_context
            or identity.status is distinct from 'linked'
            or identity.account_id is distinct from c.account_id
            or identity.linked_user_id is distinct from t.created_by
            or i.requested_by is distinct from t.created_by)
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

    -- Removing a connection hides it; it never stops or skips its Disconnect cleanup.
    alter table agent_connections drop constraint if exists agent_connections_cleanup;
    alter table agent_connections add constraint agent_connections_cleanup check (
      (cleanup_reason is null) = (cleanup_requested_at is null)
      and (cleanup_completed_at is null or cleanup_requested_at is not null)
      and ((cleanup_claim_token is null) = (cleanup_claim_expires_at is null))
      and (removed_at is null or cleanup_requested_at is not null));

    -- Its sender rule is "anyone": the same rule that keeps work from an "anyone" bridge out of
    -- the person's personal context keeps this work out of it, for ever. Ended and hidden
    -- (removed): no list draws it, and its cleanup stays open so the Home's ordinary Disconnect
    -- interrupts any active Run, ends sessions, and cancels pending Requests and waiting work.
    insert into agent_connections (
      id, user_id, label, client_name, access_mode, resource, token_hash, created_at,
      expires_at, revoked_at, removed_at, "grant", grant_revision, consent_version,
      cleanup_reason, cleanup_requested_at, cleanup_completed_at, bridge_senders)
    select legacy.id, legacy.user_id, 'Chats from before the update', 'Messaging',
      'approval-required', 'opensteer:bridge', null, now(), now(), now(), now(),
      '{"scope":"selected","tasks":true,"resources":[]}'::jsonb, 2, 2, 'revoked', now(), null,
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
    with rewritten_inputs as (
      update thread_inputs i set
        authority_source = jsonb_build_object('kind', 'user-session', 'userId', i.requested_by),
        reply_target = null
      where i.authority_source->>'kind' = 'channel-ingress'
      returning i.message_id
    )
    update runs r set reply_target = null
    from rewritten_inputs ri
    where r.seed_input_id = ri.message_id
      and r.status in ('queued', 'starting', 'running', 'waiting')
      and r.reply_target is not null;
    -- Every unfinished Run on a task tied to the ended row names that connection (whatever seeded
    -- it), and its open attempts do too, so ordinary Disconnect and command claim handle them.
    update runs r set connection_id = t.origin_connection_id
    from threads t
    where r.thread_id = t.id and r.connection_id is null
      and t.origin_connection_id in (select id from chat_routes_ended)
      and r.status in ('queued', 'starting', 'running', 'waiting');
    update run_attempts a set connection_id = r.connection_id
    from runs r
    where a.run_id = r.id and a.connection_id is null
      and a.terminal_evidence_at is null
      and r.connection_id in (select id from chat_routes_ended);
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
    drop table if exists channel_deliveries;
    drop table if exists channel_access_grants;
    drop table if exists channel_link_codes;
    alter table channel_ingress_events drop column if exists conversation_id;
    drop table if exists channel_conversations;
    drop table if exists channel_bindings;
  `.execute(database);
  await cleanStoredNames(database);
}
