import { sql, type RawBuilder } from "kysely";
import type { BridgeEndedBy } from "./schema.js";

/**
 * Where a connection stands, from one statement, for every query that reads an
 * `agent_connections` row (the row is `agent_connections`, unaliased):
 *
 * - `ended`: it has no authority and never will again. A connected agent's credential is
 *   revoked, missing or expired. A chat is revoked; its grant holds no tasks; its chat account or
 *   channel is disconnected or gone, or belongs to someone else; a chat that runs on a computer
 *   lost that computer's Messages app at read and send, or the computer itself (its device or
 *   Runner removed, or its own driver detached).
 * - `waiting`: a chat that has not ended, whose account is paused (or needs attention) or whose
 *   channel is paused. It holds what it receives and makes, and acts on none of it, until it is
 *   back.
 * - `live`: otherwise.
 */
export type ConnectionState = "live" | "waiting" | "ended";

/** The chat's grant still holds tasks: without them it can ask for nothing. */
const chatHoldsTasks = sql<boolean>`(agent_connections."grant"->>'scope' = 'everything'
  or coalesce((agent_connections."grant"->>'tasks')::boolean, false))`;

/** The chat account and its channel are not gone. */
function accountHeld(account: RawBuilder<unknown>) {
  return sql<boolean>`exists (
    select 1 from channel_accounts bridge_account
    join integration_connections bridge_channel
      on bridge_channel.id = bridge_account.connection_id
    where bridge_account.id = ${account}
      and bridge_account.status <> 'revoked'
      and bridge_channel.status <> 'revoked')`;
}

/** The chat's account and its channel belong to the person the chat works for. */
const chatOwnerHolds = sql<boolean>`exists (
  select 1 from channel_accounts bridge_account
  join integration_connections bridge_channel
    on bridge_channel.id = bridge_account.connection_id
  where bridge_account.id = agent_connections.bridge_account_id
    and bridge_channel.owner_user_id = agent_connections.user_id)`;

/**
 * An account that runs on a computer still has that computer's Messages app at read and send,
 * and the computer itself: its device not removed, its own driver attached, its Runner not
 * revoked.
 */
function computerHeld(account: RawBuilder<unknown>) {
  return sql<boolean>`exists (
    select 1 from channel_accounts bridge_account
    join integration_connections bridge_channel
      on bridge_channel.id = bridge_account.connection_id
    left join integration_connections bridge_source
      on bridge_source.id = bridge_channel.source_connection_id
    where bridge_account.id = ${account}
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
}

/** The account is connected and its channel is on. */
function accountOn(account: RawBuilder<unknown>) {
  return sql<boolean>`exists (
    select 1 from channel_accounts bridge_account
    join integration_connections bridge_channel
      on bridge_channel.id = bridge_account.connection_id
    where bridge_account.id = ${account}
      and bridge_account.status = 'connected'
      and bridge_channel.status in ('pending', 'connected', 'needs-attention'))`;
}

/**
 * Where a chat account stands, the account's part of every chat's state: `ended` when it or its
 * channel is gone or its computer is; `waiting` while it is paused or needs attention, or its
 * channel is paused; `live` otherwise. A chat's state is this, unless the chat itself ended.
 */
export function chatAccountState(account: RawBuilder<unknown>): RawBuilder<ConnectionState> {
  return sql<ConnectionState>`(case
    when not ${accountHeld(account)} or not ${computerHeld(account)} then 'ended'
    when ${accountOn(account)} then 'live'
    else 'waiting' end)`;
}

const chatAccount = sql.ref("agent_connections.bridge_account_id");

export function connectionState(now: Date = new Date()): RawBuilder<ConnectionState> {
  return sql<ConnectionState>`(case
    when agent_connections.revoked_at is not null then 'ended'
    when agent_connections.bridge_account_id is null then (case
      when agent_connections.token_hash is not null
        and agent_connections.expires_at > ${now}::timestamptz then 'live'
      else 'ended' end)
    when not ${chatHoldsTasks} then 'ended'
    when not ${chatOwnerHolds} then 'ended'
    else ${chatAccountState(chatAccount)} end)`;
}

/**
 * Why an unrevoked chat that is not live has ended, in the person's terms, from the same facts as
 * its state: its chat account was disconnected; the computer it ran on lost Messages or was
 * removed; otherwise no reason is given (null, read as ended — a chat the person disconnected
 * writes `'you'` when revoked, and one ended without a reason never falls back to `'you'`).
 */
export function chatEndReason(): RawBuilder<BridgeEndedBy | null> {
  return sql<BridgeEndedBy | null>`(case
    when not ${chatHoldsTasks} then null
    when not ${accountHeld(chatAccount)} or not ${chatOwnerHolds} then 'account'
    when not ${computerHeld(chatAccount)} then 'computer'
    else null end)`;
}

/** The connection carries authority now. */
export function liveConnection(now: Date = new Date()): RawBuilder<boolean> {
  return sql<boolean>`(${connectionState(now)} = 'live')`;
}

/** A chat that has not ended: it may take what it is sent, and hold it while it waits. */
export function chatNotEnded(now: Date = new Date()): RawBuilder<boolean> {
  return sql<boolean>`(${connectionState(now)} <> 'ended')`;
}

/** A chat that has ended and is not yet revoked: the Disconnect worker revokes it. */
export function chatEndedUnrevoked(now: Date = new Date()): RawBuilder<boolean> {
  return sql<boolean>`(agent_connections.bridge_account_id is not null
    and agent_connections.revoked_at is null and ${connectionState(now)} = 'ended')`;
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
