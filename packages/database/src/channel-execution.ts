import { isDeepStrictEqual } from "node:util";
import {
  ChannelBindingIdSchema,
  type ChannelBindingId,
  type ChannelIdentityId,
  ChannelBindingSchema,
  ChannelConversationIdSchema,
} from "@opensteer/channel-core";
import type { MessageId, RunId, ThreadId } from "@opensteer/core";
import { sql, type Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { resolveChannelAuthority } from "./channel-authority.js";

/** Callers own the complete Workspace set; pending input identities are stable under it.
 * Fence all queued channel authority before Thread/projection rows (./lock-order.ts).
 */
export async function lockThreadChannelAuthorities(
  transaction: Transaction<DatabaseSchema>,
  threadIds: readonly ThreadId[],
  mutation?: { readonly bindingId: ChannelBindingId; readonly identityId?: ChannelIdentityId },
): Promise<void> {
  if (!threadIds.length && !mutation) return;
  const sources = threadIds.length
    ? await transaction
        .selectFrom("threadInputs")
        .innerJoin("channelBindings", (join) =>
          join.on(sql<boolean>`thread_inputs.authority_source->>'bindingId' = channel_bindings.id`),
        )
        .innerJoin("channelAccounts", "channelAccounts.id", "channelBindings.accountId")
        .select([
          "channelBindings.id as bindingId",
          "channelBindings.accountId",
          "channelAccounts.connectionId",
          "threadInputs.actorPrincipalId",
        ])
        .where("threadInputs.threadId", "in", [...threadIds])
        .where("threadInputs.state", "in", ["pending", "claimed", "unknown"])
        .where(sql<string>`thread_inputs.authority_source->>'kind'`, "=", "channel-ingress")
        .execute()
    : [];
  const bindingIds = [
    ...new Set([
      ...sources.map((source) => source.bindingId),
      ...(mutation ? [mutation.bindingId] : []),
    ]),
  ];
  if (!bindingIds.length) return;
  const accounts = await transaction
    .selectFrom("channelAccounts")
    .innerJoin(
      "integrationConnections",
      "integrationConnections.id",
      "channelAccounts.connectionId",
    )
    .select([
      "channelAccounts.id",
      "channelAccounts.connectionId",
      "integrationConnections.sourceConnectionId",
    ])
    .where("channelAccounts.id", "in", (eb) =>
      eb.selectFrom("channelBindings").select("accountId").where("id", "in", bindingIds),
    )
    .execute();
  const connectionIds = [
    ...new Set(
      accounts.flatMap((account) => [
        account.connectionId,
        ...(account.sourceConnectionId ? [account.sourceConnectionId] : []),
      ]),
    ),
  ];
  if (connectionIds.length)
    await transaction
      .selectFrom("integrationConnections")
      .select("id")
      .where("id", "in", connectionIds)
      .orderBy("id", "asc")
      .forShare()
      .execute();
  if (accounts.length)
    await transaction
      .selectFrom("channelAccounts")
      .select("id")
      .where(
        "id",
        "in",
        accounts.map(({ id }) => id),
      )
      .orderBy("id", "asc")
      .forShare()
      .execute();
  await transaction
    .selectFrom("channelBindings")
    .select("id")
    .where("id", "in", bindingIds)
    .orderBy("id", "asc")
    .$call((query) => (mutation ? query.forNoKeyUpdate() : query.forShare()))
    .execute();
  if (sources.length || mutation?.identityId)
    await transaction
      .selectFrom("channelIdentities")
      .select("id")
      .where((eb) =>
        eb.or([
          ...sources.map((source) =>
            eb.and([
              eb("accountId", "=", source.accountId),
              eb("principalId", "=", source.actorPrincipalId),
            ]),
          ),
          ...(mutation?.identityId ? [eb("id", "=", mutation.identityId)] : []),
        ]),
      )
      .orderBy("id", "asc")
      .$call((query) => (mutation ? query.forNoKeyUpdate() : query.forShare()))
      .execute();
  await transaction
    .selectFrom("channelAccessGrants")
    .select("bindingId")
    .where("bindingId", "in", bindingIds)
    .orderBy("bindingId", "asc")
    .orderBy("externalUserId", "asc")
    .$call((query) => (mutation ? query.forNoKeyUpdate() : query.forShare()))
    .execute();
}

/**
 * Admission may precede execution by hours. Re-read external authority at both
 * command claim and Runner binding; an accepted message is not a lasting grant.
 * Callers acquire the authority prefix in ./lock-order.ts.
 */
export async function channelInputAuthorityIsCurrent(
  transaction: Transaction<DatabaseSchema>,
  messageId: MessageId,
): Promise<boolean> {
  const input = await transaction
    .selectFrom("threadInputs")
    .selectAll()
    .where("messageId", "=", messageId)
    .executeTakeFirst();
  if (!input || input.authoritySource.kind !== "channel-ingress") return true;
  if (input.state === "cancelled") return false;
  const source = input.authoritySource;
  const bindingId = ChannelBindingIdSchema.safeParse(source.bindingId);
  const conversationId = ChannelConversationIdSchema.safeParse(source.conversationId);
  if (!bindingId.success || !conversationId.success) return false;
  // Reserve the complete prefix in ./lock-order.ts before individual checks;
  // dispatch's later Thread fence must not discover an earlier channel parent.
  await lockThreadChannelAuthorities(transaction, [input.threadId]);
  const observed = await transaction
    .selectFrom("channelBindings")
    .innerJoin("channelAccounts", "channelAccounts.id", "channelBindings.accountId")
    .select("channelAccounts.connectionId")
    .where("channelBindings.id", "=", bindingId.data)
    .executeTakeFirst();
  if (!observed) return false;
  const connection = await transaction
    .selectFrom("integrationConnections")
    .select("status")
    .where("id", "=", observed.connectionId)
    .forShare()
    .executeTakeFirst();
  if (!connection || connection.status === "paused" || connection.status === "revoked")
    return false;
  const row = await transaction
    .selectFrom("channelBindings")
    .selectAll()
    .where("id", "=", bindingId.data)
    .forShare()
    .executeTakeFirst();
  if (!row || row.status !== "active" || row.revision !== source.bindingRevision) return false;
  const binding = ChannelBindingSchema.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
  const identity = await transaction
    .selectFrom("channelIdentities")
    .select(["id", "externalUserId", "linkedUserId"])
    .where("accountId", "=", binding.accountId)
    .where("principalId", "=", input.actorPrincipalId)
    .forShare()
    .executeTakeFirst();
  const conversation = await transaction
    .selectFrom("channelConversations")
    .select(["bindingId", "conversationType", "externalConversationId"])
    .where("id", "=", conversationId.data)
    .executeTakeFirst();
  if (!identity || !conversation || conversation.bindingId !== binding.id) return false;
  const authority = await resolveChannelAuthority(transaction, binding, identity, {
    externalConversationId: conversation.externalConversationId,
    type: conversation.conversationType,
  });
  return (
    authority !== null &&
    authority.userId === input.requestedBy &&
    authority.membershipGeneration === Number(input.membershipGeneration) &&
    isDeepStrictEqual(authority.source, source.access)
  );
}

export async function channelRunAuthorityIsCurrent(
  transaction: Transaction<DatabaseSchema>,
  runId: RunId,
): Promise<boolean> {
  const run = await transaction
    .selectFrom("runs")
    .select("seedInputId")
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  if (run.seedInputId && !(await channelInputAuthorityIsCurrent(transaction, run.seedInputId)))
    return false;
  const batch = await transaction
    .selectFrom("threadInputs")
    .select("messageId")
    .where("runId", "=", runId)
    .where("state", "=", "claimed")
    .execute();
  for (const input of batch) {
    if (
      input.messageId !== run.seedInputId &&
      !(await channelInputAuthorityIsCurrent(transaction, input.messageId))
    )
      return false;
  }
  return true;
}
