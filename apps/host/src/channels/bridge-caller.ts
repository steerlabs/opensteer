import { OpensteerError, type UserId } from "@opensteer/core";
import { admitBridgeSender, type BridgeChatSource, type OpensteerStore } from "@opensteer/database";
import type { ConnectionCaller } from "../mcp/agent-caller.js";

/**
 * A messaging bridge calling the task tools from inside the Home. It has no bearer: each
 * resolve asks the one bridge admission (the live row with grant, mode, policy and sender rule
 * in one statement, then who wrote), under the revision the message was admitted under.
 */
export async function resolveBridgeCaller(
  store: Pick<OpensteerStore, "database">,
  input: {
    readonly ownerUserId: UserId;
    readonly bridgeId: string;
    readonly chat: BridgeChatSource;
  },
): Promise<ConnectionCaller> {
  const admitted = await admitBridgeSender(store.database, {
    ownerUserId: input.ownerUserId,
    bridgeId: input.bridgeId,
    externalUserId: input.chat.sender.externalUserId,
    expectedRevision: input.chat.revision,
  });
  if (admitted.kind === "refused")
    throw new OpensteerError({
      code: "forbidden",
      message: "This chat may no longer ask your agents to work.",
    });
  const connection = admitted.connection;
  return {
    kind: "connection",
    key: `connection:${connection.agentConnectionId}`,
    connectionId: connection.agentConnectionId,
    userId: input.ownerUserId,
    accessMode: connection.accessMode,
    grant: connection.grant,
    grantRevision: connection.grantRevision,
    agentConnection: connection,
    chat: input.chat,
  };
}
