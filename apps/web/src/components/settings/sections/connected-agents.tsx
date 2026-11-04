import type { HostClient } from "@opensteer/client/host";
import { connectionAccessLabel, connectionReachLabel } from "@opensteer/client/host";
import { useConnectedAgents } from "@opensteer/client/react";
import { SettingsError, SettingsGroup, SettingsRow, formatWhen } from "../primitives.js";

export function ConnectedAgentsSection({ client }: { readonly client: HostClient }) {
  const agents = useConnectedAgents(client);
  return (
    <SettingsGroup
      heading="Connected agents"
      headingId="connected-agents"
      note="External agents you allowed to use this Opensteer. Revoking stops their next request, including in an open session."
    >
      {agents.connections?.map((connection) => (
        <SettingsRow
          key={connection.id}
          icon="plug"
          title={connection.label}
          detail={`${connection.clientName} · ${connectionAccessLabel(connection.accessMode)} · ${connectionReachLabel(connection, client.getSnapshot().workspaces)} · Connected ${formatWhen(connection.createdAt)} · ${connection.lastUsedAt ? `Last used ${formatWhen(connection.lastUsedAt)}` : "Never used"} · Expires ${formatWhen(connection.expiresAt)}`}
          action={
            <button
              className="btn btn--small"
              type="button"
              disabled={agents.pending !== null}
              onClick={() => void agents.revoke?.(connection.id)}
            >
              {agents.pending === connection.id ? "Revoking…" : `Revoke ${connection.label}`}
            </button>
          }
        />
      ))}
      {agents.connections === null && !agents.error ? (
        <p role="status">Loading connected agents…</p>
      ) : agents.connections?.length === 0 ? (
        <p className="card__empty">No connected agents.</p>
      ) : null}
      <SettingsError message={agents.error} />
      <button className="btn btn--small" type="button" onClick={() => void agents.refresh?.()}>
        Refresh connected agents
      </button>
    </SettingsGroup>
  );
}
