import { sql, type RawBuilder } from "kysely";

/**
 * The one test of whether an `agent_connections` row still carries authority, for every query
 * that reads one (the row is `agent_connections`, unaliased). An MCP connection is live while
 * its credential is issued, unexpired and not revoked. A bridge has no credential and no expiry:
 * it is live until it is revoked, or while the provider account it speaks through is connected
 * and, for a transport that runs on a computer, the app connection it is a use of still allows
 * reading and sending. Losing either ends its authority in this same statement.
 */
export function liveConnection(now: Date = new Date()): RawBuilder<boolean> {
  return sql<boolean>`(agent_connections.revoked_at is null and (
    (agent_connections.bridge_account_id is null
      and agent_connections.token_hash is not null
      and agent_connections.expires_at > ${now}::timestamptz)
    or (agent_connections.bridge_account_id is not null
      -- A bridge can only ask your agents to work: without tasks it is not live.
      and (agent_connections."grant"->>'scope' = 'everything'
        or coalesce((agent_connections."grant"->>'tasks')::boolean, false))
      and exists (
      select 1 from channel_accounts bridge_account
      join integration_connections bridge_channel
        on bridge_channel.id = bridge_account.connection_id
      left join integration_connections bridge_source
        on bridge_source.id = bridge_channel.source_connection_id
      where bridge_account.id = agent_connections.bridge_account_id
        and bridge_account.status = 'connected'
        and bridge_channel.status in ('pending', 'connected', 'needs-attention')
        and bridge_channel.owner_user_id = agent_connections.user_id
        and (bridge_channel.transport_kind <> 'computer' or (
          bridge_source.status is not null and bridge_source.status <> 'revoked'
          and bridge_source.computer_access = 'read-write'
          and bridge_source.owner_user_id = bridge_channel.owner_user_id
          -- The app connection's Mac is the computer the transport runs on.
          and exists (
            select 1 from device_drivers bridge_driver
            join devices bridge_device on bridge_device.id = bridge_driver.device_id
            join runners bridge_runner on bridge_runner.id = bridge_driver.runner_id
            where bridge_driver.device_id = coalesce(bridge_source.device_id, bridge_source.runner_id)
              and bridge_driver.role = 'self' and bridge_driver.detached_at is null
              and bridge_device.removed_at is null and bridge_runner.revoked_at is null
              and bridge_runner.id = bridge_channel.runner_id)))))))`;
}

/** An unexpired MCP connection, or any bridge: what expiry maintenance may look at. */
export const expiresByTime = sql<boolean>`agent_connections.bridge_account_id is null`;

/** The far-future instant a bridge stores where its row requires an expiry; never read. */
export const bridgeStoredExpiry = new Date(Date.UTC(9999, 11, 31));

/** Whether a row, read whole, is still an active connection (no expiry for a bridge). */
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

/**
 * A bridge whose provider account was removed, or whose computer app connection no longer
 * allows reading and sending: it has ended, and the Disconnect worker revokes it. A paused
 * account only suspends it (it has no authority while paused) and is not an end.
 */
export const bridgeAccountEnded = sql<boolean>`(agent_connections.bridge_account_id is not null
  and agent_connections.revoked_at is null and (
    -- A grant (or an organization's policy) that took tasks away ends it, with evidence.
    not (agent_connections."grant"->>'scope' = 'everything'
      or coalesce((agent_connections."grant"->>'tasks')::boolean, false))
    or not exists (
    select 1 from channel_accounts bridge_account
    join integration_connections bridge_channel
      on bridge_channel.id = bridge_account.connection_id
    left join integration_connections bridge_source
      on bridge_source.id = bridge_channel.source_connection_id
    where bridge_account.id = agent_connections.bridge_account_id
      and bridge_account.status <> 'revoked'
      and bridge_channel.status <> 'revoked'
      and (bridge_channel.transport_kind <> 'computer' or (
        bridge_source.status is not null and bridge_source.status <> 'revoked'
        and bridge_source.computer_access = 'read-write')))))`;
