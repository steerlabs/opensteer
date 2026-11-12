import {
  createChannelId,
  slackChannelProviderManifest,
  type ChannelAccessPolicy,
} from "@opensteer/channel-core";
import { createId, HarnessIdSchema, type UserId } from "@opensteer/core";
import { expect } from "vitest";
import { sql } from "kysely";
import { ChannelStore } from "./channel-store.js";
import { runAllowsPersonalContext } from "./run-personal-context.js";
import { startPersonalQueuedRunFixture } from "./personal-run-fixture.test-support.js";
import {
  describeStore,
  pendingEvent,
  type StoreFixture,
} from "./store.integration.test-support.js";

function accessPolicy(mode: "anyone" | "owner"): ChannelAccessPolicy {
  const sender = { allowedExternalUserIds: [], mode };
  return { directMessages: sender, channels: { conversationIds: [], scope: "all", sender } };
}
const notices = {
  approvalPending: "Your access request is waiting for approval.",
  linkByDirectMessage: "Send me a direct message to link your account.",
  linkCode: (code: string) => `Enter the code **${code}** to link your account.`,
  noRoute: "This conversation has no Messaging route.",
};

async function setup(f: StoreFixture, suffix: string) {
  const personal = await f.createRunFixture(suffix);
  await f.database
    .updateTable("runners")
    .set({
      allowedModules: sql`'["agents","messaging"]'::jsonb`,
      moduleDescriptors: {
        messaging: {
          capabilities: [
            {
              manifest: slackChannelProviderManifest,
              provider: "slack",
              transportKinds: ["socket"],
            },
          ],
        },
      },
    })
    .where("id", "=", personal.runnerId)
    .execute();
  const channels = new ChannelStore(f.database);
  const configured = await channels.createConnection({
    folder: personal.agentHome,
    accessPolicy: accessPolicy("anyone"),
    account: { displayName: suffix, externalAccountId: suffix, routingMode: "dedicated" },
    connection: {
      connectionMethod: "bring-your-own",
      displayName: suffix,
      externalIdentityId: `bot-${suffix}`,
      externalTenantId: suffix,
      provider: "slack",
      runnerId: personal.runnerId,
      transportKind: "socket",
    },
    createdBy: personal.userId,
    credential: {
      encryptedPayload: Buffer.from("encrypted-fixture"),
      encryptionKeyVersion: 1,
      id: createId("credential"),
      name: suffix,
      ownerId: personal.userId,
      provider: "channel:slack",
    },
    executionPolicy: { harness: "specific", harnessInstanceId: personal.harnessInstance.id },
    selector: { conversationId: null, conversationType: null, scopeId: null, threadId: null },
  });
  await channels.setRuntimeConnectionHealth({
    connectionId: configured.connection.id,
    detail: null,
    reason: null,
    runnerId: personal.runnerId,
    status: "connected",
  });
  async function link(externalUserId: string, userId: UserId) {
    const principalId = createChannelId("principal");
    await f.database
      .insertInto("principals")
      .values({ id: principalId, kind: "channel-identity", displayName: externalUserId })
      .execute();
    await f.database
      .insertInto("channelIdentities")
      .values({
        accountId: configured.account.id,
        id: createChannelId("identity"),
        principalId,
        externalUserId,
        linkedUserId: userId,
        displayName: externalUserId,
        status: "linked",
      })
      .execute();
  }
  async function adopt(
    eventId: string,
    externalUserId: string,
    type: "dm" | "group" | "channel" = "channel",
  ) {
    const event = {
      accountExternalId: suffix,
      actor: { displayName: externalUserId, externalUserId },
      content: [{ text: eventId, type: "text" as const }],
      conversation: {
        displayName: suffix,
        externalConversationId: `${suffix}-${type}`,
        externalScopeId: suffix,
        externalThreadId: "1786320000.000100",
        type,
      },
      eventId,
      occurredAt: new Date().toISOString(),
      provider: "slack" as const,
      providerMessageId: eventId,
      trigger: "mention" as const,
    };
    const committed = await channels.commitIngress(configured.connection.id, event);
    expect(await channels.commitIngress(configured.connection.id, event)).toEqual({
      ...committed,
      duplicate: true,
    });
    const claimed = await channels.claimIngress(`worker-${eventId}`);
    if (!claimed) throw new Error("Committed Messaging ingress was not claimable");
    expect(claimed.id).toBe(committed.ingressId);
    const result = await channels.adoptIngress({
      claimToken: claimed.claimToken,
      ingressId: claimed.id,
      notices,
      availableEngines: [
        { environmentId: personal.environmentId, driverKinds: [HarnessIdSchema.parse("native")] },
      ],
    });
    if (result.kind !== "adopted") throw new Error(`Messaging ingress was ${result.kind}`);
    const input = await f.database
      .selectFrom("channelIngressEvents")
      .innerJoin("threadInputs", "threadInputs.messageId", "channelIngressEvents.messageId")
      .select([
        "threadInputs.threadId",
        "threadInputs.messageId",
        "threadInputs.requestedBy",
        "threadInputs.replyTarget",
        "threadInputs.policy",
        "threadInputs.state",
      ])
      .where("channelIngressEvents.id", "=", claimed.id)
      .executeTakeFirstOrThrow();
    expect(input.policy).toBe("queue");
    expect(input.requestedBy).toBe(personal.userId);
    return { ...result, input };
  }
  return { ...personal, ...configured, channels, link, adopt };
}

describeStore("personal Messaging conversation contexts", (it) => {
  it("shares one owner-authorized root across linked and unlinked senders", async ({
    storeFixture: f,
  }) => {
    const p = await setup(f, "shared");
    await p.link("owner", p.userId);
    const first = await p.adopt("owner-message", "owner");
    const guest = await p.adopt("guest-message", "guest");
    expect(guest.run).toBeNull();
    expect(guest.input.threadId).toBe(first.input.threadId);
    expect(await f.store.getThreadForOwner(first.input.threadId, p.userId)).toMatchObject({
      createdBy: p.userId,
      parentThreadId: null,
      folder: p.agentHome,
    });
    expect(
      await f.database
        .selectFrom("channelConversations")
        .select("activeThreadId")
        .where("accountId", "=", p.account.id)
        .execute(),
    ).toEqual([{ activeThreadId: first.input.threadId }]);
  });

  it("requires the personal owner to resume a paused queue", async ({ storeFixture: f }) => {
    const p = await setup(f, "resume");
    const first = await p.adopt("initial", "guest");
    if (!first.run) throw new Error("Initial message did not reserve a Run");
    await f.store.enqueueRunnerControl({
      idempotencyKey: "pause",
      requestedBy: p.userId,
      runId: first.run.id,
      threadId: first.run.threadId,
      type: "run.interrupt",
    });
    const waiting = await f.store.enqueueThreadInput({
      content: [{ type: "text", text: "Queued while paused" }],
      idempotencyKey: "waiting",
      policy: "queue",
      requestedBy: p.userId,
      source: { kind: "human" },
      threadId: first.run.threadId,
    });
    expect(waiting.run).toBeNull();
    const other = await f.store.createUser("Other person");
    await expect(
      f.store.resumeThreadInputQueue({
        idempotencyKey: "denied",
        requestedBy: other,
        threadId: first.run.threadId,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const resumed = await f.store.resumeThreadInputQueue({
      idempotencyKey: "resume",
      requestedBy: p.userId,
      threadId: first.run.threadId,
    });
    expect(resumed.thread.inputQueuePaused).toBe(false);
    expect(
      await f.database
        .selectFrom("runs")
        .select("requestedBy")
        .where("seedInputId", "=", waiting.message.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ requestedBy: p.userId });
  });

  it("rotates changed bindings to an independent root and allows Done only on the historical task", async ({
    storeFixture: f,
  }) => {
    const p = await setup(f, "rotation");
    await p.link("owner", p.userId);
    const first = await p.adopt("first", "owner");
    await expect(
      f.store.setThreadDone({
        done: true,
        threadId: first.input.threadId,
        requestedBy: p.userId,
        idempotencyKey: "active-done",
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    const updated = await p.channels.updateBinding({
      accessPolicy: accessPolicy("owner"),
      bindingId: p.binding.id,
      expectedRevision: p.binding.revision,
      ownerUserId: p.userId,
    });
    const second = await p.adopt("second", "owner");
    expect(second.input.threadId).not.toBe(first.input.threadId);
    expect(await f.store.getThreadForOwner(second.input.threadId, p.userId)).toMatchObject({
      lineageRootThreadId: second.input.threadId,
      parentThreadId: null,
      folder: p.agentHome,
    });
    expect(
      await f.database
        .selectFrom("channelConversations")
        .select(["activeThreadId", "bindingRevision"])
        .where("accountId", "=", p.account.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ activeThreadId: second.input.threadId, bindingRevision: updated.revision });
    expect(
      (
        await f.store.setThreadDone({
          done: true,
          threadId: first.input.threadId,
          requestedBy: p.userId,
          idempotencyKey: "historical-done",
        })
      ).thread.doneAt,
    ).not.toBeNull();
  });

  it("rechecks every represented sender after an audience or identity change", async ({
    storeFixture: f,
  }) => {
    const p = await setup(f, "privacy");
    await p.link("owner", p.userId);
    const first = await p.adopt("private-owner", "owner", "dm");
    if (!first.run) throw new Error("Owner DM did not reserve a Run");
    expect(await runAllowsPersonalContext(f.database, first.run.id)).toBe(true);
    const running = await startPersonalQueuedRunFixture(f.store, first.run.id);
    await f.store.commitRunnerEvent({
      environmentId: p.environmentId,
      runnerId: p.runnerId,
      runnerBootId: running.runnerBootId,
      event: pendingEvent({
        type: "run.completed",
        environmentId: p.environmentId,
        threadId: first.run.threadId,
        runId: first.run.id,
        bindingGeneration: running.bindingGeneration,
        ordinal: 1,
        data: { status: "completed" },
      }),
    });
    const guest = await p.adopt("unlinked-guest", "guest", "dm");
    if (!guest.run) throw new Error("Guest message did not reserve a Run");
    expect(guest.input.threadId).toBe(first.input.threadId);
    expect(guest.run.providerSessionId).not.toBe(first.run.providerSessionId);
    expect(
      await f.database
        .selectFrom("providerSessions")
        .select(["personalContext", "providerSessionReference"])
        .where("id", "=", guest.run.providerSessionId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ personalContext: false, providerSessionReference: null });
    expect(await runAllowsPersonalContext(f.database, guest.run.id)).toBe(false);
    const group = await p.adopt("owner-in-group", "owner", "group");
    if (!group.run) throw new Error("Group message did not reserve a Run");
    expect(await runAllowsPersonalContext(f.database, group.run.id)).toBe(false);
    await f.database
      .updateTable("channelIdentities")
      .set({ status: "unlinked", linkedUserId: null })
      .where("accountId", "=", p.account.id)
      .where("externalUserId", "=", "owner")
      .execute();
    expect(await runAllowsPersonalContext(f.database, first.run.id)).toBe(false);
  });
});
