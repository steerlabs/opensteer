import { createId } from "@opensteer/core";
import { createChannelId } from "@opensteer/channel-core";
import { createIntegrationId } from "@opensteer/integration-core";
import { sql } from "kysely";
import { expect, it } from "vitest";
import { ChannelStore } from "./channel-store.js";
import { channelInputAuthorityIsCurrent } from "./channel-execution.js";
import { createDatabase } from "./connection.js";
import { seedPrivatePublisher } from "./private-publisher.test-support.js";
import { cloneTestDatabase } from "./test-database.test-support.js";

it("fences Messaging binding edits, idempotent ingress and queued replies to current sender consent", async () => {
  const clone = await cloneTestDatabase("host");
  const database = createDatabase({ connectionString: clone.url });
  try {
    const p = await seedPrivatePublisher(database);
    const connectionId = createIntegrationId("connection");
    const accountId = createChannelId("account");
    const conversationId = createChannelId("conversation");
    const identityId = createChannelId("identity");
    const principalId = createChannelId("principal");
    const store = new ChannelStore(database);
    await sql`insert into integration_connections(id,owner_user_id,connection_kind,provider,connection_method,status,display_name,capabilities,granted_scopes,runner_id,transport_kind) values(${connectionId},${p.userId},'channel','telegram','api-token','connected','Bot','[]','[]',${p.runnerId},'polling')`.execute(
      database,
    );
    await sql`insert into channel_accounts(id,connection_id,provider,external_account_id,display_name,routing_mode,status,metadata) values(${accountId},${connectionId},'telegram','bot','Bot','shared','connected','{}')`.execute(
      database,
    );
    const binding = await store.createBinding({
      accountId,
      createdBy: p.userId,
      selector: {},
      executionPolicy: { harness: "default", harnessInstanceId: null },
      accessPolicy: {
        directMessages: { mode: "approved" },
        channels: {
          scope: "all",
          conversationIds: [],
          sender: { mode: "approved" },
        },
      },
    });
    const event = {
      accountExternalId: "bot",
      actor: { displayName: "Guest", externalUserId: "guest" },
      content: [{ type: "text", text: "hello" }],
      conversation: {
        displayName: "Group",
        externalConversationId: "room",
        externalScopeId: null,
        externalThreadId: null,
        type: "group",
      },
      eventId: "event-1",
      occurredAt: new Date().toISOString(),
      provider: "telegram",
      providerMessageId: "message-1",
      trigger: "mention",
    };
    const ingress = await store.commitIngress(connectionId, event);
    expect(await store.commitIngress(connectionId, event)).toEqual({ ...ingress, duplicate: true });
    await sql`insert into principals(id,kind,display_name) values(${principalId},'channel-identity','Guest')`.execute(
      database,
    );
    await sql`insert into channel_identities(id,account_id,principal_id,external_user_id,display_name,status) values(${identityId},${accountId},${principalId},'guest','Guest','unlinked')`.execute(
      database,
    );
    await sql`insert into channel_conversations(id,account_id,provider,external_account_id,binding_id,binding_revision,external_conversation_id,conversation_type,active_thread_id,provider_state) values(${conversationId},${accountId},'telegram','bot',${binding.id},1,'room','group',${p.threadId},'{}')`.execute(
      database,
    );
    await sql`insert into channel_access_grants(account_id,binding_id,external_user_id,display_name,status,revision) values(${accountId},${binding.id},'guest','Guest','approved',1)`.execute(
      database,
    );
    const source = {
      kind: "channel-ingress",
      bindingId: binding.id,
      bindingRevision: 1,
      conversationId,
      access: { kind: "binding-owner", mode: "approved", grantRevision: 1 },
    };
    await sql`insert into thread_inputs(actor_principal_id,authority_source,causal_chain_id,idempotency_key,message_id,policy,queue_rank,request_fingerprint,requested_by,state,thread_id,run_id) values(${principalId},${JSON.stringify(source)}::jsonb,${p.causalChainId},'channel',${p.messageId},'queue',1,'test',${p.userId},'pending',${p.threadId},${p.runId})`.execute(
      database,
    );
    expect(
      await database.transaction().execute((tx) => channelInputAuthorityIsCurrent(tx, p.messageId)),
    ).toBe(true);
    const accessPolicy = binding.accessPolicy;
    const changed = await store.updateBinding({
      bindingId: binding.id,
      expectedRevision: 1,
      ownerUserId: p.userId,
      accessPolicy,
    });
    expect(changed.revision).toBe(2);
    await expect(
      store.updateBinding({
        bindingId: binding.id,
        expectedRevision: 1,
        ownerUserId: p.userId,
        accessPolicy,
      }),
    ).rejects.toThrow("changed");
    expect(
      (
        await database
          .selectFrom("threadInputs")
          .select("state")
          .where("messageId", "=", p.messageId)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe("cancelled");
    await database
      .updateTable("threadInputs")
      .set({ state: "claimed", authoritySource: { ...source, bindingRevision: 2 } })
      .where("messageId", "=", p.messageId)
      .execute();
    const replyId = createId("message");
    await sql`insert into messages(id,thread_id,run_id,sequence,kind,actor_principal_id,author,content) values(${replyId},${p.threadId},${p.runId},2,'output',${p.principalId},'{}','[]')`.execute(
      database,
    );
    const deliveryId = createChannelId("delivery");
    await sql`insert into channel_deliveries(id,account_id,conversation_id,message_id,audience,kind,content,status,part_count) values(${deliveryId},${accountId},${conversationId},${replyId},'conversation','reply','[{"type":"text","text":"reply"}]','pending',1)`.execute(
      database,
    );
    const claimed = await store.claimDelivery(p.runnerId);
    expect(claimed?.delivery.id).toBe(deliveryId);
    await store.reviewAccess({
      bindingId: binding.id,
      expectedRevision: 1,
      externalUserId: "guest",
      ownerUserId: p.userId,
      decision: "revoked",
    });
    expect(
      await database.transaction().execute((tx) => channelInputAuthorityIsCurrent(tx, p.messageId)),
    ).toBe(false);
    await expect(store.startDeliveryAttempt(deliveryId, claimed!.claimToken)).rejects.toThrow(
      "authority changed",
    );
    expect(
      (
        await database
          .selectFrom("channelDeliveries")
          .select("status")
          .where("id", "=", deliveryId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("dead");
    await expect(store.startDeliveryAttempt(deliveryId, claimed!.claimToken)).rejects.toThrow();
    await store.reviewAccess({
      bindingId: binding.id,
      expectedRevision: 2,
      externalUserId: "guest",
      ownerUserId: p.userId,
      decision: "approved",
    });
    await database
      .updateTable("threadInputs")
      .set({
        authoritySource: {
          ...source,
          bindingRevision: 2,
          access: { ...source.access, grantRevision: 3 },
        },
      })
      .where("messageId", "=", p.messageId)
      .execute();
    const allowedReplyId = createId("message");
    await sql`insert into messages(id,thread_id,run_id,sequence,kind,actor_principal_id,author,content)
      values(${allowedReplyId},${p.threadId},${p.runId},3,'output',${p.principalId},'{}','[]')`.execute(
      database,
    );
    const allowedDeliveryId = createChannelId("delivery");
    await sql`insert into channel_deliveries(id,account_id,conversation_id,message_id,audience,kind,content,status,part_count)
      values(${allowedDeliveryId},${accountId},${conversationId},${allowedReplyId},'conversation','reply','[{"type":"text","text":"reply"}]','pending',1)`.execute(
      database,
    );
    const allowed = await store.claimDelivery(p.runnerId);
    expect(allowed?.delivery.id).toBe(allowedDeliveryId);
    await store.startDeliveryAttempt(allowedDeliveryId, allowed!.claimToken);
    await store.finishDelivery({
      deliveryId: allowedDeliveryId,
      claimToken: allowed!.claimToken,
      outcome: "sent",
      receipt: { providerMessageId: "sent" },
    });
    expect(await store.claimDelivery(p.runnerId)).toBeNull();
    await expect(
      store.finishDelivery({
        deliveryId: allowedDeliveryId,
        claimToken: allowed!.claimToken,
        outcome: "sent",
      }),
    ).rejects.toThrow();
  } finally {
    await database.destroy();
    await clone.drop();
  }
});
