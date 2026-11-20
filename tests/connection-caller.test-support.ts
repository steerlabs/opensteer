import type { ConnectionCaller } from "../apps/host/src/mcp/agent-caller.js";
import type { AgentConnection } from "../packages/protocol/src/index.js";

export function fixtureConnectionCaller(connection: AgentConnection): ConnectionCaller {
  const { id, userId, accessMode, grant, grantRevision } = connection;
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
  };
}
