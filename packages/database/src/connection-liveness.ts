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
    or (agent_connections.bridge_account_id is not null and exists (
      select 1 from channel_accounts bridge_account
      join integration_connections bridge_channel
        on bridge_channel.id = bridge_account.connection_id
      left join integration_connections bridge_source
        on bridge_source.id = bridge_channel.source_connection_id
      where bridge_account.id = agent_connections.bridge_account_id
        and bridge_account.status = 'connected'
        and bridge_channel.status in ('pending', 'connected', 'needs-attention')
        and (bridge_channel.transport_kind <> 'computer' or (
          bridge_source.status is not null and bridge_source.status <> 'revoked'
          and bridge_source.computer_access = 'read-write'))))))`;
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
