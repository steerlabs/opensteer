import type { ConnectionCaller } from "../apps/host/src/mcp/agent-caller.js";
import type { AgentConnection } from "../packages/protocol/src/index.js";

export function fixtureConnectionCaller(connection: AgentConnection): ConnectionCaller {
  const { id, userId, accessMode, grant, grantRevision, consentVersion } = connection;
  if (!grant || grantRevision === undefined)
    throw new Error("A connection fixture needs its saved grant and grant revision.");
  return {
    kind: "connection",
    key: `connection:${id}`,
    connectionId: id,
    userId,
    accessMode,
    grant,
    grantRevision,
    // As the authenticator gives every connection: its row, with the consent it gave.
    agentConnection: {
      agentConnectionId: id,
      grant,
      grantRevision,
      consentVersion: consentVersion ?? 1,
      accessMode,
      bridgeSenders: null,
    },
  };
}
