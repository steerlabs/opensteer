import { sql, type RawBuilder } from "kysely";
import type { BridgeEndedBy } from "./schema.js";
import { isWorkHomeDatabase } from "./work-home-context.js";

/**
 * Where a connection stands, from one statement, for every query that reads an
 * `agent_connections` row (the row is `agent_connections`, unaliased):
 *
 * - `ended`: it has no authority and never will again. A connected agent's credential is
 *   revoked, missing or expired. A chat is revoked; its grant holds no tasks; its chat account or
 *   channel is disconnected or gone, or belongs to someone else; a chat that runs on a computer
 *   lost that computer's Messages app at read and send, or the computer itself (its device or
 *   Runner removed, or its own driver detached); or the organization's work Home is no longer
 *   active.
 * - `waiting`: a chat that has not ended, whose account is paused (or needs attention) or whose
 *   channel is paused. It holds what it receives and makes, and acts on none of it, until it is
 *   back.
 * - `live`: otherwise.
 *
 * The organization's state is read only on a work Home: a personal Home runs no organization
 * query.
 */
export type ConnectionState = "live" | "waiting" | "ended";

/** The chat's grant still holds tasks: without them it can ask for nothing. */
const chatHoldsTasks = sql<boolean>`(agent_connections."grant"->>'scope' = 'everything'
  or coalesce((agent_connections."grant"->>'tasks')::boolean, false))`;

/** The organization's work Home is active (read only on a work Home). */
const workHomeActive = sql<boolean>`exists (select 1 from work_home_policy bridge_work
  where bridge_work.singleton and bridge_work.state = 'active')`;

/** The chat account and its channel are not gone, and they are the person's. */
const chatAccountHeld = sql<boolean>`exists (
  select 1 from channel_accounts bridge_account
  join integration_connections bridge_channel
    on bridge_channel.id = bridge_account.connection_id
  where bridge_account.id = agent_connections.bridge_account_id
    and bridge_account.status <> 'revoked'
    and bridge_channel.status <> 'revoked'
    and bridge_channel.owner_user_id = agent_connections.user_id)`;

/**
 * A chat that runs on a computer still has that computer's Messages app at read and send, and
 * the computer itself: its device not removed, its own driver attached, its Runner not revoked.
 */
const chatComputerHeld = sql<boolean>`exists (
  select 1 from channel_accounts bridge_account
  join integration_connections bridge_channel
    on bridge_channel.id = bridge_account.connection_id
  left join integration_connections bridge_source
    on bridge_source.id = bridge_channel.source_connection_id
  where bridge_account.id = agent_connections.bridge_account_id
    and (bridge_channel.transport_kind <> 'computer' or (
      bridge_source.status is not null and bridge_source.status <> 'revoked'
      and bridge_source.computer_access = 'read-write'
      and bridge_source.owner_user_id = bridge_channel.owner_user_id
      and exists (
        select 1 from device_drivers bridge_driver
        join devices bridge_device on bridge_device.id = bridge_driver.device_id
        join runners bridge_runner on bridge_runner.id = bridge_driver.runner_id
        where bridge_driver.device_id = coalesce(bridge_source.device_id, bridge_source.runner_id)
          and bridge_driver.role = 'self' and bridge_driver.detached_at is null
          and bridge_device.removed_at is null and bridge_runner.revoked_at is null
          and bridge_runner.id = bridge_channel.runner_id))))`;

export function connectionState(
  database: object,
  now: Date = new Date(),
): RawBuilder<ConnectionState> {
  const work = isWorkHomeDatabase(database);
  return sql<ConnectionState>`(case
    when agent_connections.revoked_at is not null then 'ended'
    when agent_connections.bridge_account_id is null then (case
      when agent_connections.token_hash is not null
        and agent_connections.expires_at > ${now}::timestamptz then 'live'
      else 'ended' end)
    when not ${chatHoldsTasks} then 'ended'
    ${work ? sql`when not ${workHomeActive} then 'ended'` : sql``}
    when not ${chatAccountHeld} or not ${chatComputerHeld} then 'ended'
    when exists (
      select 1 from channel_accounts bridge_account
      join integration_connections bridge_channel
        on bridge_channel.id = bridge_account.connection_id
      where bridge_account.id = agent_connections.bridge_account_id
        and bridge_account.status = 'connected'
        and bridge_channel.status in ('pending', 'connected', 'needs-attention')) then 'live'
    else 'waiting' end)`;
}

/**
 * Why a chat that is not live has ended, in the person's terms, from the same facts as its
 * state: the organization's work Home is closing; the organization took tasks away; its chat
 * account was disconnected; the computer it ran on lost Messages or was removed; otherwise the
 * person disconnected it.
 */
export function chatEndReason(database: object): RawBuilder<BridgeEndedBy> {
  const work = isWorkHomeDatabase(database);
  return sql<BridgeEndedBy>`(case
    ${work ? sql`when not ${workHomeActive} then 'work-home'` : sql``}
    when not ${chatHoldsTasks} then 'organization'
    when not ${chatAccountHeld} then 'account'
    when not ${chatComputerHeld} then 'computer'
    else 'you' end)`;
}

/** The connection carries authority now. */
export function liveConnection(database: object, now: Date = new Date()): RawBuilder<boolean> {
  return sql<boolean>`(${connectionState(database, now)} = 'live')`;
}

/** A chat that has not ended: it may take what it is sent, and hold it while it waits. */
export function chatNotEnded(database: object, now: Date = new Date()): RawBuilder<boolean> {
  return sql<boolean>`(${connectionState(database, now)} <> 'ended')`;
}

/** A chat that has ended and is not yet revoked: the Disconnect worker revokes it. */
export function chatEndedUnrevoked(database: object, now: Date = new Date()): RawBuilder<boolean> {
  return sql<boolean>`(agent_connections.bridge_account_id is not null
    and agent_connections.revoked_at is null and ${connectionState(database, now)} = 'ended')`;
}

/** An unexpired MCP connection, or any bridge: what expiry maintenance may look at. */
export const expiresByTime = sql<boolean>`agent_connections.bridge_account_id is null`;

/** The far-future instant a bridge stores where its row requires an expiry; never read. */
export const bridgeStoredExpiry = new Date(Date.UTC(9999, 11, 31));

/**
 * Whether a connected agent's row, read whole, is still active. Never used for a chat, whose
 * state needs the statement above.
 */
export function connectionActive(
  row: {
    readonly revokedAt: Date | null;
    readonly expiresAt: Date;
    readonly bridgeAccountId: string | null;
  },
  now: Date,
): boolean {
  return row.revokedAt === null && (row.bridgeAccountId !== null || row.expiresAt > now);
}
