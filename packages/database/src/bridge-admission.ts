import { AgentGrantSchema, OpensteerError, type UserId } from "@opensteer/core";
import type { ChannelAccountId } from "@opensteer/channel-core";
import type { Kysely } from "kysely";
import { readConnectionRowStanding, type AgentConnectionAuthority } from "./resource-access.js";
import type { BridgeSenders, DatabaseSchema } from "./schema.js";

export type BridgeSenderAdmission =
  | { readonly kind: "refused"; readonly reason: string }
  /** The chat has not ended but is paused: nothing it receives is acted on until it is back. */
  | { readonly kind: "waiting" }
  | {
      readonly kind: "admitted";
      readonly connection: AgentConnectionAuthority & {
        readonly label: string;
        readonly bridgeSenders: BridgeSenders;
        readonly bridgeAccountId: ChannelAccountId;
      };
      /** The sender is the person's own linked account on this provider account. */
      readonly owner: boolean;
    };

/**
 * The one answer to "is this bridge live, and may this sender speak to it": read through the
 * connection's live row (grant, mode, revision and, on a work Home, the organization's policy,
 * in one statement), then who wrote, from the identities linked on its account. The ingress,
 * the bridge's caller and the inbox all ask it; none keeps a query of its own. A message
 * admitted under one revision is refused under another.
 */
/**
 * Why a chat's queued Run ended when its message's sender stopped being "me" before it was
 * claimed. The person reads it in Opensteer; the chat hears nothing (run-finalization).
 */
export const senderUnlinkedFailure =
  "Its message came from an account that is no longer linked as you.";
/**
 * Said by every layer that finds a chat paused while it handles a message: the message is given
 * back to wait, never dropped. Only the Home's own chat calls ever hear it.
 */
export const chatPausedMessage = "This chat is paused: its message waits until it is back.";
export function chatWaitingError(): OpensteerError {
  return new OpensteerError({ code: "conflict", message: chatPausedMessage, retryable: true });
}
export function isChatWaiting(error: unknown): boolean {
  return (
    error instanceof OpensteerError &&
    error.code === "conflict" &&
    error.message === chatPausedMessage
  );
}
export async function admitBridgeSender(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly ownerUserId: UserId;
    readonly bridgeId: string;
    readonly externalUserId: string;
    readonly expectedRevision?: number | undefined;
    /** Hold the bridge row for share, as an admission that hands work off does. */
    readonly lock?: boolean;
  },
): Promise<BridgeSenderAdmission> {
  let read: Awaited<ReturnType<typeof readConnectionRowStanding>>;
  try {
    read = await readConnectionRowStanding(
      database,
      input.ownerUserId,
      input.bridgeId,
      input.lock ?? false,
    );
  } catch (error) {
    if (error instanceof OpensteerError && error.code === "forbidden")
      return { kind: "refused", reason: error.message };
    throw error;
  }
  const row = read.row;
  // Not live: only a chat that is paused, rather than ended, keeps what it was sent; the same
  // read says which.
  if (!row)
    return read.waiting
      ? { kind: "waiting" }
      : { kind: "refused", reason: "No bridge covers this conversation" };
  if (row.bridgeAccountId === null || row.bridgeSenders === null)
    return { kind: "refused", reason: "No bridge covers this conversation" };
  if (input.expectedRevision !== undefined && row.grantRevision !== input.expectedRevision)
    return { kind: "refused", reason: "The bridge changed since this message was admitted" };
  const identity = await database
    .selectFrom("channelIdentities")
    .select("id")
    .where("accountId", "=", row.bridgeAccountId)
    .where("externalUserId", "=", input.externalUserId)
    .where("status", "=", "linked")
    .where("linkedUserId", "=", input.ownerUserId)
    .executeTakeFirst();
  const owner = identity !== undefined;
  if (!owner && row.bridgeSenders !== "anyone")
    return { kind: "refused", reason: "Only the person may message this bridge" };
  return {
    kind: "admitted",
    owner,
    connection: {
      agentConnectionId: row.id,
      label: row.label,
      grant: AgentGrantSchema.parse(row.grant),
      grantRevision: row.grantRevision,
      consentVersion: row.consentVersion,
      accessMode: row.accessMode,
      bridgeSenders: row.bridgeSenders,
      bridgeAccountId: row.bridgeAccountId,
    },
  };
}
