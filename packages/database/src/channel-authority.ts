import {
  ChannelAccessGrantSchema,
  type ChannelAccessGrant,
  type ChannelBinding,
  type ChannelSenderPolicy,
  type ChannelIdentityId,
  type ChannelIngressId,
} from "@opensteer/channel-core";
import type { UserId } from "@opensteer/core";
import type { Selectable, Transaction } from "kysely";
import type { ChannelAccessGrantTable, DatabaseSchema } from "./schema.js";

type ChannelConversationType = "dm" | "group" | "channel";

export interface ResolvedChannelAuthority {
  readonly membershipGeneration: number;
  readonly source: Readonly<Record<string, unknown>>;
  readonly userId: UserId;
}

export interface ChannelIdentityAuthorityInput {
  readonly id: ChannelIdentityId;
  readonly externalUserId: string;
  readonly linkedUserId: UserId | null;
}

export function channelSenderPolicy(
  binding: ChannelBinding,
  conversation: {
    readonly externalConversationId: string;
    readonly type: ChannelConversationType;
  },
): ChannelSenderPolicy | null {
  if (conversation.type === "dm") return binding.accessPolicy.directMessages;
  const channels = binding.accessPolicy.channels;
  if (channels.scope === "off") return null;
  if (
    channels.scope === "selected" &&
    !channels.conversationIds.includes(conversation.externalConversationId)
  ) {
    return null;
  }
  return channels.sender;
}

/**
 * Ensure an approval-mode sender is represented before any Thread or Request
 * exists. A declined or revoked grant stays terminal until its owner reviews
 * it explicitly; another provider message cannot silently reopen access.
 */
export async function ensureChannelAccessGrant(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly binding: ChannelBinding;
    readonly displayName: string;
    readonly externalUserId: string;
    readonly ingressId: ChannelIngressId;
  },
): Promise<{ readonly created: boolean; readonly grant: ChannelAccessGrant }> {
  const existing = await transaction
    .selectFrom("channelAccessGrants")
    .selectAll()
    .where("bindingId", "=", input.binding.id)
    .where("externalUserId", "=", input.externalUserId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (existing) {
    const row = await transaction
      .updateTable("channelAccessGrants")
      .set({
        displayName: input.displayName,
        requestIngressId:
          existing.status === "pending" ? input.ingressId : existing.requestIngressId,
        updatedAt: new Date(),
      })
      .where("bindingId", "=", input.binding.id)
      .where("externalUserId", "=", input.externalUserId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return { created: false, grant: channelAccessGrantFromRow(row) };
  }
  const now = new Date();
  const row = await transaction
    .insertInto("channelAccessGrants")
    .values({
      accountId: input.binding.accountId,
      bindingId: input.binding.id,
      decidedAt: null,
      decidedBy: null,
      displayName: input.displayName,
      externalUserId: input.externalUserId,
      requestIngressId: input.ingressId,
      requestedAt: now,
      revision: 1,
      status: "pending",
      updatedAt: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return { created: true, grant: channelAccessGrantFromRow(row) };
}

/** Resolve current authority while the caller holds the Workspace fence (./lock-order.ts).
 * All membership writers take that fence, so membership reads need no additional row lock. */
export async function resolveChannelAuthority(
  transaction: Transaction<DatabaseSchema>,
  binding: ChannelBinding,
  identity: ChannelIdentityAuthorityInput,
  conversation: {
    readonly externalConversationId: string;
    readonly type: ChannelConversationType;
  },
): Promise<ResolvedChannelAuthority | null> {
  const sender = channelSenderPolicy(binding, conversation);
  if (!sender || sender.mode === "off") return null;
  if (
    sender.allowedExternalUserIds.length > 0 &&
    !sender.allowedExternalUserIds.includes(identity.externalUserId)
  ) {
    return null;
  }

  const linkedMembership = identity.linkedUserId
    ? await transaction
        .selectFrom("workspaceMemberships")
        .select(["generation", "state"])
        .where("workspaceId", "=", binding.workspaceId)
        .where("userId", "=", identity.linkedUserId)
        .executeTakeFirst()
    : null;
  const linked =
    linkedMembership?.state === "active" && identity.linkedUserId ? identity.linkedUserId : null;

  if (sender.mode === "linked-members") {
    return linked
      ? {
          membershipGeneration: Number(linkedMembership?.generation),
          source: {
            kind: "linked-membership",
            membershipGeneration: Number(linkedMembership?.generation),
          },
          userId: linked,
        }
      : null;
  }
  if (sender.mode === "owner" && identity.linkedUserId !== binding.createdBy) return null;
  let approvedGrantRevision: number | null = null;
  if (sender.mode === "approved" && identity.linkedUserId !== binding.createdBy) {
    const grant = await transaction
      .selectFrom("channelAccessGrants")
      .select(["revision", "status"])
      .where("bindingId", "=", binding.id)
      .where("externalUserId", "=", identity.externalUserId)
      .forShare()
      .executeTakeFirst();
    if (grant?.status !== "approved") return null;
    approvedGrantRevision = grant.revision;
  }

  const ownerMembership = await transaction
    .selectFrom("workspaceMemberships")
    .select(["generation", "state"])
    .where("workspaceId", "=", binding.workspaceId)
    .where("userId", "=", binding.createdBy)
    .executeTakeFirst();
  if (!ownerMembership || ownerMembership.state !== "active") return null;
  return {
    membershipGeneration: Number(ownerMembership.generation),
    source: {
      kind: "binding-owner",
      ...(approvedGrantRevision === null ? {} : { grantRevision: approvedGrantRevision }),
      membershipGeneration: Number(ownerMembership.generation),
      mode: sender.mode,
    },
    userId: binding.createdBy,
  };
}

export function channelAccessGrantFromRow(
  row: Selectable<ChannelAccessGrantTable>,
): ChannelAccessGrant {
  return ChannelAccessGrantSchema.parse({
    accountId: row.accountId,
    bindingId: row.bindingId,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedBy: row.decidedBy,
    displayName: row.displayName,
    externalUserId: row.externalUserId,
    requestedAt: row.requestedAt.toISOString(),
    revision: row.revision,
    status: row.status,
  });
}
