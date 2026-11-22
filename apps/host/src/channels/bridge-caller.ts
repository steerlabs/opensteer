import { OpensteerError, type UserId } from "@opensteer/core";
import type { BridgeChatSource, OpensteerStore } from "@opensteer/database";
import type { ConnectionCaller } from "../mcp/agent-caller.js";

/**
 * A messaging bridge calling the task tools from inside the Home. It has no bearer: each resolve
 * reads the bridge's live row (grant, mode, policy and who may speak, in one statement through
 * `admitExecution`), and refuses when the sender's rule no longer admits this message or the
 * revision moved since the message was admitted (any change of who may speak raises it).
 */
export async function resolveBridgeCaller(
  store: Pick<OpensteerStore, "admitExecution">,
  input: {
    readonly ownerUserId: UserId;
    readonly bridgeId: string;
    readonly chat: BridgeChatSource;
    readonly expectedRevision?: number;
  },
): Promise<ConnectionCaller> {
  const admitted = await store.admitExecution({
    ownerUserId: input.ownerUserId,
    subject: { kind: "connection", agentConnectionId: input.bridgeId },
  });
  const connection = admitted.agentConnection;
  if (
    !connection ||
    connection.bridgeSenders === undefined ||
    connection.bridgeSenders === null ||
    (!input.chat.sender.owner && connection.bridgeSenders !== "anyone") ||
    (input.expectedRevision !== undefined && connection.grantRevision !== input.expectedRevision)
  )
    throw new OpensteerError({
      code: "forbidden",
      message: "This chat may no longer ask your agents to work.",
    });
  return {
    kind: "connection",
    key: `connection:${connection.agentConnectionId}`,
    connectionId: connection.agentConnectionId,
    userId: input.ownerUserId,
    accessMode: admitted.mode,
    grant: connection.grant,
    grantRevision: connection.grantRevision,
    agentConnection: connection,
    chat: input.chat,
  };
}
