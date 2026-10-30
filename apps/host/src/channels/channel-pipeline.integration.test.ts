/**
 * The messaging pipeline, end to end, through the Host's real ChannelService,
 * real MessagingRelayHub and a real PostgreSQL-backed ChannelStore and
 * OpensteerStore, over the exact rpc paths a channel-runtime uses:
 * `connection.inspect` / `connections.sync` over the relay, then
 * `ingress.commit`, `delivery.claim`, `delivery.start` and `delivery.finish`
 * through `ChannelService.handleRuntimeRequest`.
 *
 * Requires OPENSTEER_TEST_DATABASE_URL; it skips without one.
 */
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { slackChannelProviderManifest, type ChannelDeliveryId } from "@opensteer/channel-core";
import {
  RuntimeChannelRequestSchema,
  type RuntimeChannelRequest,
} from "@opensteer/channel-protocol";
import { ChannelStore, OpensteerStore, createDatabase, migrateToLatest } from "@opensteer/database";
import {
  HarnessIdSchema,
  MessageContentSchema,
  RunnerIdSchema,
  ThreadAccessModeSchema,
  createId,
  type RunId,
  type RunnerId,
  type ThreadId,
  type UserId,
  type WorkspaceId,
} from "@opensteer/core";
import type { RunnerAuxiliaryStream } from "@opensteer/orchestration";
import {
  HarnessInstanceCatalogSchema,
  RunnerAuxiliaryFrameFenceSchema,
  RunnerBootIdSchema,
  RunnerConnectionIdSchema,
  RunnerConnectionLeaseIdSchema,
  type PendingAgentEvent,
  type RunnerDescriptor,
} from "@opensteer/protocol";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ChannelService } from "./channel-service.js";
import { MessagingRelayHub, type MessagingRelayPeer } from "./messaging-relay-hub.js";
import { CredentialService } from "../identity/credential-service.js";

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

const messagingRunnerId = RunnerIdSchema.parse("rnr_00000000-0000-4000-8000-0000000000a1");
const canonicalOrigin = "https://pipeline-host.invalid";
const threadUrl = (threadId: ThreadId) => `${canonicalOrigin}/threads/${threadId}`;

integration("messaging pipeline", () => {
  const database = createDatabase({
    applicationName: "opensteer-messaging-pipeline",
    connectionString: databaseUrl ?? "postgres://unconfigured",
    maxConnections: 4,
  });
  const store = new OpensteerStore(database, { links: { threadUrl } });
  const channels = new ChannelStore(database);
  let credentials: CredentialService;
  let environmentId: ReturnType<typeof createId<"environment">>;
  let agentsRunnerId: RunnerId;
  let ownerUserId: UserId;

  beforeAll(async () => {
    await migrateToLatest(database);
    await sql`
      truncate table
        credential_vault_canaries,
        credential_access_audit,
        request_continuations,
        integration_request_details,
        requests,
        credentials,
        workspace_events,
        commands,
        provider_sessions,
        messages,
        runs,
        threads,
        harness_catalogs,
        harness_instances,
        workspaces,
        execution_environments,
        runners,
        deployments,
        users
      restart identity cascade
    `.execute(database);
    await sql`
      insert into principals(id, kind, user_id, display_name)
      values ('pri_00000000-0000-4000-8000-000000000001', 'system', null, 'Opensteer')
      on conflict (id) do nothing
    `.execute(database);
    credentials = new CredentialService({ key: randomBytes(32), store });
    await credentials.initialize();
    ownerUserId = await store.createUser("Pipeline owner");
    environmentId = createId("environment");
    agentsRunnerId = createId("runner");
    await enrollAgentsRunner({ createdBy: ownerUserId, environmentId, runnerId: agentsRunnerId });
    await enrollMessagingRunner();
  });

  afterAll(async () => {
    await database.destroy();
  });

  it("carries a channel message from ingress.commit to a sent delivery", async () => {
    const fixture = await pipelineFixture({ accessMode: "anyone", suffix: "REPLY" });
    const { hub, relayRequests, service } = fixture;
    expect(relayRequests.map(({ operation }) => operation)).toEqual([
      "connection.inspect",
      "connections.sync",
    ]);
    expect(relayRequests[1]?.payload).toMatchObject({
      connections: [
        { connectionId: fixture.created.connection.id, provider: "slack", transportKind: "socket" },
      ],
    });

    // 1. ingress.commit through the real service, then the identical replay.
    const event = channelEvent({ scope: "REPLY", text: "Investigate the pipeline" });
    const first = await service.handleRuntimeRequest(
      messagingRunnerId,
      runtimeRequest("ingress.commit", { connectionId: fixture.created.connection.id, event }),
    );
    const second = await service.handleRuntimeRequest(
      messagingRunnerId,
      runtimeRequest("ingress.commit", { connectionId: fixture.created.connection.id, event }),
    );
    expect(first).toMatchObject({ duplicate: false });
    expect(second).toMatchObject({
      duplicate: true,
      ingressId: (first as { ingressId: string }).ingressId,
    });
    // `accepted` was always true and told a caller nothing; it is gone.
    expect(first).not.toHaveProperty("accepted");

    // 2. The service's own drain adopts the ingress into a Thread and a Run.
    const run = await waitForRun(fixture.workspaceId);
    expect(run).toMatchObject({ status: "queued" });
    expect(run.replyTarget).not.toBeNull();
    expect(fixture.queued).toEqual([environmentId]);

    // 3. What the agent writes on the way stays in the Thread. When the Run
    //    completes its reply is sent, and a reply longer than Slack accepts
    //    becomes ordered parts of one message.
    const seed = await database
      .selectFrom("messages")
      .innerJoin("runs", "runs.seedInputId", "messages.id")
      .select(["messages.author", "runs.createdAt"])
      .where("runs.id", "=", run.id)
      .executeTakeFirstOrThrow();
    const binding = await beginRun(run);
    const narrationId = createId("message");
    await emit(binding, run, 1, "assistant.message", {
      content: [{ text: "I'll read the pipeline logs first.", type: "text" }],
      messageId: narrationId,
    });
    const replyMessageId = createId("message");
    const paragraph = `${"pipeline ".repeat(30)}`.trim();
    const longReply = Array.from({ length: 60 }, (_, index) => `${index}. ${paragraph}`).join(
      "\n\n",
    );
    expect(longReply.length).toBeGreaterThan(3 * slackChannelProviderManifest.maxMessageChars);
    await emit(binding, run, 2, "assistant.message", {
      content: [
        { text: longReply, type: "text" },
        { artifactId: "art_1", mediaType: "text/csv", name: "findings.csv", type: "artifact" },
      ],
      messageId: replyMessageId,
    });
    const sentFor = (messageId: typeof replyMessageId) =>
      database
        .selectFrom("channelDeliveries")
        .select("id")
        .where("messageId", "=", messageId)
        .execute();
    await expect(sentFor(replyMessageId)).resolves.toEqual([]);
    // An engine can end on an empty result; it says nothing, so it is not the reply.
    const blankId = createId("message");
    await emit(binding, run, 3, "assistant.message", {
      content: [{ text: " ", type: "text" }],
      messageId: blankId,
    });
    await emit(binding, run, 4, "run.completed", { status: "completed" });
    await expect(sentFor(narrationId)).resolves.toEqual([]);
    await expect(sentFor(blankId)).resolves.toEqual([]);
    // The Host names the reply where every client reads how the Run ended.
    await expect(
      database
        .selectFrom("workspaceEvents")
        .select("data")
        .where("runId", "=", run.id)
        .where("type", "=", "run.completed")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      data: {
        replyMessageId,
        startedBy: seed.author,
        startedAt: seed.createdAt.toISOString(),
        personWaiting: seed.author.kind === "human",
        status: "completed",
      },
    });
    const parts = await database
      .selectFrom("channelDeliveries")
      .select(["part", "partCount", "status"])
      .where("messageId", "=", replyMessageId)
      .orderBy("part", "asc")
      .execute();
    expect(parts.length).toBeGreaterThan(3);
    expect(parts.map(({ part }) => part)).toEqual(parts.map((_, index) => index));
    expect(new Set(parts.map(({ partCount }) => partCount))).toEqual(new Set([parts.length]));
    // The artifact is a line of text pointing at the Thread, not a second
    // delivery channel of its own.
    const lastPart = await database
      .selectFrom("channelDeliveries")
      .select("content")
      .where("messageId", "=", replyMessageId)
      .where("part", "=", parts.length - 1)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(lastPart.content)).toContain(
      `findings.csv — [Open in Opensteer](${threadUrl(run.threadId)})`,
    );

    // 4. The parts claim in order, and the lane never has two in flight.
    const partZero = claimResult(await claimDelivery(service));
    expect(partZero.delivery).toMatchObject({
      audience: "conversation",
      kind: "reply",
      messageId: replyMessageId,
      status: "leased",
    });
    expect(partZero.destination).toEqual({
      externalConversationId: "C-REPLY",
      externalScopeId: "T-REPLY",
      externalThreadId: "1786320000.000100",
      externalUserId: null,
    });
    expect(partZero.mayHaveBeenSent).toBe(false);
    expect(partZero.lease).toMatchObject({
      purpose: "delivery",
      secrets: { botToken: expect.any(String) },
    });
    expect(Object.keys(partZero.lease.secrets)).toEqual(["botToken"]);
    await expect(claimDelivery(service)).resolves.toEqual({ claimed: null });

    // 5. A wrong claim token is refused at start and at finish.
    await expect(
      service.handleRuntimeRequest(
        messagingRunnerId,
        runtimeRequest("delivery.start", {
          claimToken: "z".repeat(43),
          deliveryId: partZero.delivery.id,
        }),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await startDelivery(service, partZero);
    await expect(
      service.handleRuntimeRequest(
        messagingRunnerId,
        runtimeRequest("delivery.finish", {
          claimToken: "z".repeat(43),
          deliveryId: partZero.delivery.id,
          outcome: "sent",
          receipt: { providerMessageId: "forged" },
        }),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await finishDelivery(service, partZero, {
      outcome: "sent",
      receipt: { providerMessageId: "1786320100.000200" },
    });
    const partOne = claimResult(await claimDelivery(service));
    expect(partOne.delivery.id).not.toBe(partZero.delivery.id);

    // 6. An outcome that never arrived leaves the row claimable, and the next
    //    claim says the provider may already hold it.
    await startDelivery(service, partOne);
    await finishDelivery(service, partOne, { error: "Slack never answered", outcome: "unknown" });
    await expect(
      database
        .selectFrom("channelDeliveries")
        .select("status")
        .where("id", "=", partOne.delivery.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "unknown" });
    await clearBackoff(partOne.delivery.id);
    const reconciling = claimResult(await claimDelivery(service));
    expect(reconciling.delivery.id).toBe(partOne.delivery.id);
    expect(reconciling.mayHaveBeenSent).toBe(true);

    // 7. Retry-After is clamped by the Host as well as bounded on the wire.
    await startDelivery(service, reconciling);
    await finishDelivery(service, reconciling, {
      error: "Slack answered 429",
      outcome: "retryable-failed",
      retryAfterSeconds: 86_400,
    });
    const requeued = await database
      .selectFrom("channelDeliveries")
      .select(["attempts", "lastError", "nextAttemptAt", "status"])
      .where("id", "=", reconciling.delivery.id)
      .executeTakeFirstOrThrow();
    expect(requeued).toMatchObject({ lastError: "Slack answered 429", status: "retryable-failed" });
    // Jitter is ±20%, so a day's Retry-After lands inside a day and a bit and
    // never becomes the many-day delay an unclamped header would have asked for.
    expect(requeued.nextAttemptAt.getTime() - Date.now()).toBeGreaterThan(86_400 * 800);
    expect(requeued.nextAttemptAt.getTime() - Date.now()).toBeLessThan(86_400 * 1_250);
    // The frame a runtime could send is bounded by the same number, so a
    // provider header beyond it can never reach the queue at all.
    expect(() =>
      runtimeRequest("delivery.finish", {
        claimToken: reconciling.claimToken,
        deliveryId: reconciling.delivery.id,
        error: "Slack answered 429",
        outcome: "retryable-failed",
        retryAfterSeconds: 100_000,
      }),
    ).toThrow();
    // Nothing else in the lane moves while that part is waiting.
    await expect(claimDelivery(service)).resolves.toEqual({ claimed: null });

    // 8. Terminal rows age out; live ones stay.
    await database
      .updateTable("channelDeliveries")
      .set({ updatedAt: daysAgo(8) })
      .where("id", "=", partZero.delivery.id)
      .execute();
    await database
      .updateTable("channelIngressEvents")
      .set({ processedAt: daysAgo(8) })
      .where("status", "=", "adopted")
      .execute();
    const pruned = await channels.pruneHistory(new Date());
    expect(pruned).toEqual({ deliveries: 1, ingressEvents: 1 });
    await expect(
      database
        .selectFrom("channelDeliveries")
        .select("id")
        .where("id", "=", partZero.delivery.id)
        .executeTakeFirst(),
    ).resolves.toBeUndefined();
    await expect(
      database
        .selectFrom("channelDeliveries")
        .select("id")
        .where("id", "=", reconciling.delivery.id)
        .executeTakeFirst(),
    ).resolves.toMatchObject({ id: reconciling.delivery.id });

    await service.close();
    hub.close();
  }, 60_000);

  it("tells the person a Run failed, and sends nothing it wrote on the way", async () => {
    const fixture = await pipelineFixture({ accessMode: "anyone", suffix: "FAILED" });
    const { hub, service } = fixture;
    const event = channelEvent({ scope: "FAILED", text: "Check the release" });
    await service.handleRuntimeRequest(
      messagingRunnerId,
      runtimeRequest("ingress.commit", { connectionId: fixture.created.connection.id, event }),
    );
    const run = await waitForRun(fixture.workspaceId);
    const binding = await beginRun(run);
    const narrationId = createId("message");
    await emit(binding, run, 1, "assistant.message", {
      content: [{ text: "I'll open the release checklist.", type: "text" }],
      messageId: narrationId,
    });
    await emit(binding, run, 2, "run.failed", {
      code: "harness_unavailable",
      message: "The AI engine stopped responding",
      retryable: false,
      status: "failed",
    });
    const deliveries = await database
      .selectFrom("channelDeliveries")
      .select(["audience", "content", "kind", "messageId"])
      .where("accountId", "=", fixture.created.account.id)
      .execute();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      audience: "conversation",
      kind: "status",
      messageId: null,
    });
    expect(JSON.stringify(deliveries[0]?.content)).toContain(
      "Something went wrong and the agent could not finish. The AI engine stopped responding.",
    );
    expect(JSON.stringify(deliveries[0]?.content)).toContain(threadUrl(run.threadId));
    const notice = claimResult(await claimDelivery(service));
    expect(notice.delivery).toMatchObject({ kind: "status", status: "leased" });
    await startDelivery(service, notice);
    await finishDelivery(service, notice, {
      outcome: "sent",
      receipt: { providerMessageId: "1786320200.000300" },
    });

    await service.close();
    hub.close();
  }, 60_000);

  it("hands an unlinked sender a code, and runs their next message once it is redeemed", async () => {
    const fixture = await pipelineFixture({ accessMode: "linked-members", suffix: "LINK" });
    const { hub, service } = fixture;
    const direct = {
      ...channelEvent({ scope: "LINK", text: "Please look at this" }),
      conversation: {
        displayName: null,
        externalConversationId: "D-LINK",
        externalScopeId: "T-LINK",
        externalThreadId: null,
        type: "dm" as const,
      },
      trigger: "direct-message" as const,
    };
    await service.handleRuntimeRequest(
      messagingRunnerId,
      runtimeRequest("ingress.commit", {
        connectionId: fixture.created.connection.id,
        event: direct,
      }),
    );

    // 1. Nobody is linked, so the message becomes a private invitation rather
    //    than silence — and the code reaches only the person who wrote.
    const claimed = await vi.waitFor(async () => {
      const result = await claimDelivery(service);
      const value = (result as { claimed: unknown }).claimed;
      if (!value) throw new Error("No status delivery was enqueued for the unlinked sender");
      return value as ClaimedShape;
    }, 10_000);
    expect(claimed.delivery).toMatchObject({
      audience: "actor",
      conversationId: null,
      kind: "status",
      messageId: null,
    });
    expect(claimed.destination).toEqual({
      externalConversationId: "D-LINK",
      externalScopeId: "T-LINK",
      externalThreadId: null,
      externalUserId: "U-EXTERNAL",
    });
    const text = statusText(claimed);
    expect(text).toContain(`${canonicalOrigin}/settings/apps/messaging`);
    expect(text).toContain("expires in 1 hour");
    const code = /\*\*([A-HJ-NP-Z2-9]{8})\*\*/u.exec(text)?.[1];
    expect(code).toBeDefined();
    await expect(
      database
        .selectFrom("channelIngressEvents")
        .select("status")
        .where("providerEventId", "=", direct.eventId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "ignored" });

    await startDelivery(service, claimed);
    await finishDelivery(service, claimed, {
      outcome: "sent",
      receipt: { providerMessageId: "1786320000.000150" },
    });

    // 2. A second explicit request gets a fresh code, invalidating the lost one.
    await service.handleRuntimeRequest(
      messagingRunnerId,
      runtimeRequest("ingress.commit", {
        connectionId: fixture.created.connection.id,
        event: { ...direct, eventId: "Ev-LINK-2", providerMessageId: "1786320000.000101" },
      }),
    );
    await vi.waitFor(async () => {
      const ignored = await database
        .selectFrom("channelIngressEvents")
        .select("status")
        .where("providerEventId", "=", "Ev-LINK-2")
        .executeTakeFirstOrThrow();
      expect(ignored).toEqual({ status: "ignored" });
    }, 10_000);
    await expect(
      database
        .selectFrom("channelDeliveries")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("accountId", "=", fixture.created.account.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: "2" });
    const newestDelivery = await database
      .selectFrom("channelDeliveries")
      .innerJoin("channelIngressEvents", "channelIngressEvents.id", "channelDeliveries.ingressId")
      .select("channelDeliveries.content")
      .where("channelIngressEvents.providerEventId", "=", "Ev-LINK-2")
      .executeTakeFirstOrThrow();
    const newestText = MessageContentSchema.parse(newestDelivery.content)
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
    const newestCode = /\*\*([A-HJ-NP-Z2-9]{8})\*\*/u.exec(newestText)?.[1];
    expect(newestCode).toBeDefined();
    await expect(service.linkIdentity(code ?? "", ownerUserId)).rejects.toMatchObject({
      code: "not_found",
    });

    const replacement = claimResult(await claimDelivery(service));
    expect(statusText(replacement)).toBe(newestText);
    await startDelivery(service, replacement);
    await finishDelivery(service, replacement, {
      outcome: "sent",
      receipt: { providerMessageId: "1786320000.000151" },
    });

    // 3. Redeeming the latest code as the signed-in person links the identity.
    const linked = await service.linkIdentity(newestCode ?? "", ownerUserId);
    const confirmation = claimResult(await claimDelivery(service));
    expect(statusText(confirmation)).toContain("Your messaging identity is linked");
    await acknowledgeDelivery(service, confirmation);
    expect(linked).toMatchObject({
      account: { id: fixture.created.account.id },
      identity: { displayName: "External operator", externalUserId: "U-EXTERNAL" },
    });
    await expect(service.linkIdentity(newestCode ?? "", ownerUserId)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(service.linkIdentity("AAAAAAAA", ownerUserId)).rejects.toMatchObject({
      code: "not_found",
    });

    // 4. The next message from that person runs.
    await service.handleRuntimeRequest(
      messagingRunnerId,
      runtimeRequest("ingress.commit", {
        connectionId: fixture.created.connection.id,
        event: { ...direct, eventId: "Ev-LINK-3", providerMessageId: "1786320000.000102" },
      }),
    );
    const run = await waitForRun(fixture.workspaceId);
    expect(run).toMatchObject({ status: "queued" });

    await service.close();
    hub.close();
  }, 60_000);

  it("waits for a computer without spending attempts, links meanwhile, and gives up aloud", async () => {
    const fixture = await pipelineFixture({
      accessMode: "linked-members",
      computerOnline: false,
      suffix: "DEFER",
    });
    const { hub, service } = fixture;
    service.start();
    const direct = (eventId: string, providerMessageId: string) => ({
      ...channelEvent({ scope: "DEFER", text: "Anyone there?" }),
      conversation: {
        displayName: null,
        externalConversationId: "D-DEFER",
        externalScopeId: "T-DEFER",
        externalThreadId: null,
        type: "dm" as const,
      },
      eventId,
      providerMessageId,
      trigger: "direct-message" as const,
    });
    const commit = (eventId: string, providerMessageId: string) =>
      service.handleRuntimeRequest(
        messagingRunnerId,
        runtimeRequest("ingress.commit", {
          connectionId: fixture.created.connection.id,
          event: direct(eventId, providerMessageId),
        }),
      );
    const ingress = (eventId: string) =>
      database
        .selectFrom("channelIngressEvents")
        .select(["attempts", "id", "lastError", "nextAttemptAt", "status"])
        .where("providerEventId", "=", eventId)
        .executeTakeFirstOrThrow();

    // 1. No computer is online, but linking needs none: the code still goes out.
    await commit("Ev-DEFER-1", "1786320000.000201");
    const claimed = await vi.waitFor(async () => {
      const value = claimResult(await claimDelivery(service)) as ClaimedShape | null;
      if (!value) throw new Error("No link code was enqueued while the computer was offline");
      return value;
    }, 10_000);
    const code = /\*\*([A-HJ-NP-Z2-9]{8})\*\*/u.exec(statusText(claimed))?.[1];
    expect(code).toBeDefined();
    await acknowledgeDelivery(service, claimed);
    await service.linkIdentity(code ?? "", ownerUserId);
    const confirmation = claimResult(await claimDelivery(service));
    expect(statusText(confirmation)).toContain("Your messaging identity is linked");
    await acknowledgeDelivery(service, confirmation);

    // 2. A linked person's message waits: pending, retried soon, no attempt spent.
    await commit("Ev-DEFER-2", "1786320000.000202");
    const waiting = await vi.waitFor(async () => {
      const row = await ingress("Ev-DEFER-2");
      if (row.lastError === null) throw new Error("Not yet deferred");
      return row;
    }, 10_000);
    expect(waiting).toMatchObject({ attempts: 0, status: "pending" });
    expect(waiting.lastError).toContain("No work location is available");
    expect(waiting.nextAttemptAt.getTime() - Date.now()).toBeLessThanOrEqual(5_500);

    // 3. An hour after it was sent the message is dropped, and the person is
    //    told. It reached Opensteer as it was sent and has waited here since.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1_000);
    await database
      .updateTable("channelIngressEvents")
      .set({
        event: sql`jsonb_set(event, '{occurredAt}', to_jsonb(${twoHoursAgo.toISOString()}::text))`,
        nextAttemptAt: new Date(),
        receivedAt: twoHoursAgo,
      })
      .where("id", "=", waiting.id)
      .execute();
    service.wake();
    await vi.waitFor(async () => {
      expect((await ingress("Ev-DEFER-2")).status).toBe("ignored");
    }, 10_000);
    const dropped = await vi.waitFor(async () => {
      const value = claimResult(await claimDelivery(service)) as ClaimedShape | null;
      if (!value) throw new Error("No notice was enqueued for the dropped message");
      return value;
    }, 10_000);
    expect(dropped.delivery).toMatchObject({ audience: "actor", kind: "status" });
    expect(statusText(dropped)).toContain("No computer was available");
    await acknowledgeDelivery(service, dropped);

    // 4. A computer coming online picks up a message that is still waiting.
    await commit("Ev-DEFER-3", "1786320000.000203");
    const parked = await vi.waitFor(async () => {
      const row = await ingress("Ev-DEFER-3");
      if (row.lastError === null) throw new Error("Not yet deferred");
      return row;
    }, 10_000);
    fixture.computer.online = true;
    await database
      .updateTable("channelIngressEvents")
      .set({ nextAttemptAt: new Date() })
      .where("id", "=", parked.id)
      .execute();
    service.wake();
    const run = await waitForRun(fixture.workspaceId);
    expect(run).toMatchObject({ status: "queued" });

    await service.close();
    hub.close();
  }, 60_000);

  it("does not run a message that reached Opensteer more than an hour after it was sent", async () => {
    const fixture = await pipelineFixture({ accessMode: "anyone", suffix: "LATE" });
    const { hub, service } = fixture;
    // A transport that was offline — a Mac asleep with its Messages, a socket
    // that missed a window — hands over yesterday's message as if it were new.
    const event = {
      ...channelEvent({ scope: "LATE", text: "Send the report before the meeting" }),
      occurredAt: new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString(),
    };
    await service.handleRuntimeRequest(
      messagingRunnerId,
      runtimeRequest("ingress.commit", { connectionId: fixture.created.connection.id, event }),
    );
    await vi.waitFor(async () => {
      const row = await database
        .selectFrom("channelIngressEvents")
        .select("status")
        .where("providerEventId", "=", event.eventId)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe("ignored");
    }, 10_000);
    const notice = claimResult(await claimDelivery(service)) as ClaimedShape | null;
    expect(notice?.delivery).toMatchObject({ audience: "actor", kind: "status" });
    expect(notice ? statusText(notice) : "").toBe(
      "This message reached Opensteer more than an hour after it was sent, so it was not run. Send it again if you still need it.",
    );
    await expect(
      database
        .selectFrom("runs")
        .innerJoin("threads", "threads.id", "runs.threadId")
        .select("runs.id")
        .where("threads.workspaceId", "=", fixture.workspaceId)
        .execute(),
    ).resolves.toEqual([]);

    await service.close();
    hub.close();
  }, 60_000);

  it("lets a channel route win over the wizard's catch-all, and answers when it is retired", async () => {
    const fixture = await pipelineFixture({
      accessMode: "anyone",
      routingMode: "shared",
      suffix: "ROUTE",
    });
    const { hub, service } = fixture;
    // The wizard's own route is the catch-all. Scoping it to the account would
    // make it exactly as specific as the per-conversation route added next, and
    // two routes of equal specificity refuse to resolve at all.
    expect(fixture.created.binding.selector).toEqual({
      conversationId: null,
      conversationType: null,
      scopeId: null,
      threadId: null,
    });

    const roomWorkspace = await store.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: "wsp_pipeline_route_room",
      },
      capacityPolicy: {
        blockHardLimitBytes: 10_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota",
      },
      createdBy: ownerUserId,
      idempotencyKey: "workspace-pipeline-ROUTE-room",
      name: "Pipeline ROUTE room",
      status: "ready",
    });
    const roomBinding = await service.createBinding({
      accessPolicy: {
        channels: {
          scope: "all",
          conversationIds: [],
          sender: { mode: "anyone", allowedExternalUserIds: [] },
        },
        directMessages: { mode: "anyone", allowedExternalUserIds: [] },
      },
      accountId: fixture.created.account.id,
      createdBy: ownerUserId,
      executionPolicy: { harness: "default", harnessInstanceId: null },
      selector: {
        conversationId: "C-ROUTE",
        conversationType: null,
        scopeId: null,
        threadId: null,
      },
      workspaceId: roomWorkspace.id,
    });

    // 1. The named conversation takes the route made for it.
    await service.handleRuntimeRequest(
      messagingRunnerId,
      runtimeRequest("ingress.commit", {
        connectionId: fixture.created.connection.id,
        event: channelEvent({ scope: "ROUTE", text: "Investigate the room" }),
      }),
    );
    const roomRun = await waitForRun(roomWorkspace.id);
    expect(roomRun).toMatchObject({ status: "queued" });

    // 2. A direct message nothing names still falls through to the catch-all.
    await service.handleRuntimeRequest(
      messagingRunnerId,
      runtimeRequest("ingress.commit", {
        connectionId: fixture.created.connection.id,
        event: {
          ...channelEvent({ scope: "ROUTE", text: "And the rest" }),
          conversation: {
            displayName: null,
            externalConversationId: "D-ROUTE",
            externalScopeId: "T-ROUTE",
            externalThreadId: null,
            type: "dm" as const,
          },
          eventId: "Ev-ROUTE-DM",
          providerMessageId: "1786320000.000110",
          trigger: "direct-message" as const,
        },
      }),
    );
    await waitForRun(fixture.workspaceId);

    // 3. Retiring the route leaves its conversation unrouted, and the next
    //    message there says so rather than disappearing.
    await service.revokeBinding(roomBinding.id, ownerUserId);
    await service.handleRuntimeRequest(
      messagingRunnerId,
      runtimeRequest("ingress.commit", {
        connectionId: fixture.created.connection.id,
        event: {
          ...channelEvent({ scope: "ROUTE", text: "Anyone still there?" }),
          eventId: "Ev-ROUTE-AFTER-REVOKE",
          providerMessageId: "1786320000.000120",
        },
      }),
    );
    await vi.waitFor(async () => {
      const row = await database
        .selectFrom("channelIngressEvents")
        .select(["lastError", "status"])
        .where("providerEventId", "=", "Ev-ROUTE-AFTER-REVOKE")
        .executeTakeFirstOrThrow();
      expect(row.status).toBe("ignored");
      expect(row.lastError).toContain("No channel route matched");
    }, 10_000);
    const told = await vi.waitFor(async () => {
      const value = claimResult(await claimDelivery(service)) as ClaimedShape | null;
      if (!value) throw new Error("Nothing was said about the unrouted conversation");
      return value;
    }, 10_000);
    expect(told.delivery).toMatchObject({ audience: "actor", kind: "status" });
    expect(statusText(told)).toContain("not routed to an Opensteer Workspace");
    await acknowledgeDelivery(service, told);

    await service.close();
    hub.close();
  }, 60_000);

  it("shares selected channels and independently approves, fences, and revokes DM access", async () => {
    const fixture = await pipelineFixture({ accessMode: "anyone", suffix: "ACCESS" });
    const { service, hub, created } = fixture;
    try {
      const accessPolicy = {
        channels: {
          scope: "selected" as const,
          conversationIds: ["C-ACCESS"],
          sender: { mode: "anyone" as const, allowedExternalUserIds: [] },
        },
        directMessages: { mode: "approved" as const, allowedExternalUserIds: [] },
      };
      const updated = await service.updateBinding({
        accessPolicy,
        bindingId: created.binding.id,
        expectedRevision: created.binding.revision,
        ownerUserId,
      });
      expect(updated.revision).toBe(created.binding.revision + 1);
      await expect(
        service.updateBinding({
          accessPolicy,
          bindingId: created.binding.id,
          expectedRevision: created.binding.revision,
          ownerUserId,
        }),
      ).rejects.toMatchObject({ code: "conflict" });

      async function deliver(event: ReturnType<typeof channelEvent> | typeof direct) {
        const committed = await service.commitIngress(
          messagingRunnerId,
          created.connection.id,
          event,
        );
        await vi.waitFor(async () => {
          const ingress = await database
            .selectFrom("channelIngressEvents")
            .select("status")
            .where("id", "=", committed.ingressId)
            .executeTakeFirstOrThrow();
          expect(["adopted", "ignored"]).toContain(ingress.status);
        }, 10_000);
      }
      const mention = channelEvent({ scope: "ACCESS", text: "Hello from the team" });
      await deliver(mention);
      const sharedRun = await waitForRun(fixture.workspaceId);
      const thread = await database
        .selectFrom("threads")
        .selectAll()
        .where("id", "=", sharedRun.threadId)
        .executeTakeFirstOrThrow();
      expect(thread).toMatchObject({
        createdBy: ownerUserId,
        capabilityProfileId: "workspace",
        parentThreadId: null,
      });
      const direct = {
        ...mention,
        eventId: "Ev-ACCESS-DM-1",
        trigger: "direct-message" as const,
        conversation: {
          ...mention.conversation,
          type: "dm" as const,
          externalConversationId: "D-ACCESS",
          externalThreadId: null,
        },
      };
      await deliver(direct);
      let dashboard = await service.dashboard(ownerUserId);
      const pending = dashboard.accessGrants.find((grant) => grant.bindingId === updated.id);
      expect(pending).toMatchObject({ status: "pending", externalUserId: "U-EXTERNAL" });
      if (!pending) throw new Error("Expected a durable access request");
      await deliver({ ...direct, eventId: "Ev-ACCESS-DM-2" });
      dashboard = await service.dashboard(ownerUserId);
      expect(dashboard.accessGrants.filter((grant) => grant.bindingId === updated.id)).toHaveLength(
        1,
      );
      expect(
        await database
          .selectFrom("threads")
          .select("id")
          .where("workspaceId", "=", fixture.workspaceId)
          .execute(),
      ).toHaveLength(1);
      const intruder = await store.createUser("Unrelated operator");
      await expect(
        service.reviewAccess({
          bindingId: updated.id,
          externalUserId: pending.externalUserId,
          expectedRevision: pending.revision,
          decision: "approved",
          ownerUserId: intruder,
        }),
      ).rejects.toMatchObject({ code: "not_found" });
      const approved = await service.reviewAccess({
        bindingId: updated.id,
        externalUserId: pending.externalUserId,
        expectedRevision: pending.revision,
        decision: "approved",
        ownerUserId,
      });
      expect(approved.status).toBe("approved");
      // Approval grants future admission; it never executes the stale request message.
      expect(
        await database
          .selectFrom("threads")
          .select("id")
          .where("workspaceId", "=", fixture.workspaceId)
          .execute(),
      ).toHaveLength(1);
      await expect(
        service.reviewAccess({
          bindingId: updated.id,
          externalUserId: pending.externalUserId,
          expectedRevision: pending.revision,
          decision: "declined",
          ownerUserId,
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      await deliver({ ...direct, eventId: "Ev-ACCESS-DM-3" });
      expect(
        await database
          .selectFrom("threads")
          .select("id")
          .where("workspaceId", "=", fixture.workspaceId)
          .execute(),
      ).toHaveLength(2);
      await service.reviewAccess({
        bindingId: updated.id,
        externalUserId: pending.externalUserId,
        expectedRevision: approved.revision,
        decision: "revoked",
        ownerUserId,
      });
      const dmCommand = await database
        .selectFrom("commands")
        .innerJoin("runs", "runs.id", "commands.runId")
        .innerJoin("threads", "threads.id", "runs.threadId")
        .select(["commands.id", "runs.id as runId"])
        .where("threads.workspaceId", "=", fixture.workspaceId)
        .where("threads.id", "!=", sharedRun.threadId)
        .where("commands.type", "=", "run.execute")
        .executeTakeFirstOrThrow();
      const blocked = await store.claimCommand(dmCommand.id, "revoked-dm-test");
      expect(blocked).toMatchObject({
        terminalFailureInput: "seed-input",
        terminalFailure: expect.stringContaining("Messaging access changed"),
      });
      await store.failCommand(
        dmCommand.id,
        blocked?.terminalFailure ?? "Unexpected missing failure",
        "seed-input",
      );
      const channelCommand = await database
        .selectFrom("commands")
        .select("id")
        .where("runId", "=", sharedRun.id)
        .where("type", "=", "run.execute")
        .executeTakeFirstOrThrow();
      const unrelated = await store.claimCommand(channelCommand.id, "shared-channel-test");
      expect(unrelated?.terminalFailure).toBeUndefined();
      expect(unrelated?.command.status).toBe("dispatched");
      await deliver({ ...direct, eventId: "Ev-ACCESS-DM-4" });
      await deliver({
        ...mention,
        eventId: "Ev-ACCESS-OUTSIDE",
        conversation: {
          ...mention.conversation,
          externalConversationId: "C-NOT-SELECTED",
        },
      });
      const denied = await database
        .selectFrom("channelIngressEvents")
        .select(["providerEventId", "status"])
        .where("providerEventId", "in", ["Ev-ACCESS-DM-4", "Ev-ACCESS-OUTSIDE"])
        .execute();
      expect(denied).toHaveLength(2);
      expect(denied.every((row) => row.status === "ignored")).toBe(true);
      expect(
        (await service.dashboard(ownerUserId)).accessGrants.find(
          (grant) => grant.bindingId === updated.id,
        )?.status,
      ).toBe("revoked");
      // The send boundary holds admission until the Runner accepts the command.
      let entered!: () => void;
      let allowAcceptance!: () => void;
      const atSend = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const receipt = new Promise<void>((resolve) => {
        allowAcceptance = resolve;
      });
      const handoff = store.dispatchChannelCommand(channelCommand.id, async (beforeAck) => {
        entered();
        await receipt;
        await beforeAck();
      });
      await atSend;
      let policyChanged = false;
      const changePolicy = service
        .updateBinding({
          bindingId: updated.id,
          ownerUserId,
          expectedRevision: updated.revision,
          accessPolicy: { ...accessPolicy, channels: { ...accessPolicy.channels, scope: "off" } },
        })
        .then(() => {
          policyChanged = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(policyChanged).toBe(false);
      allowAcceptance();
      await Promise.all([handoff, changePolicy]);
      expect(policyChanged).toBe(true);
      const neverSend = vi.fn(async (beforeAck: () => Promise<void>) => beforeAck());
      await expect(
        store.dispatchChannelCommand(channelCommand.id, neverSend),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(neverSend).not.toHaveBeenCalled();
      // A policy change after planning is fenced again when the Runner asks to bind.
      await expect(
        store.acquireExecutionBinding({
          bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
          continuationIdentity: {
            continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
            driverKind: HarnessIdSchema.parse("native"),
          },
          harnessInstanceId: thread.harnessInstanceId,
          leaseTokenHash: "policy-handoff-lease",
          membershipGeneration: 1,
          runnerBootId: "policy-handoff-boot",
          runnerId: agentsRunnerId,
          runId: sharedRun.id,
          threadId: sharedRun.threadId,
        }),
      ).rejects.toMatchObject({
        code: "forbidden",
        message: expect.stringContaining("Messaging access changed"),
      });
    } finally {
      await service.close();
      hub.close();
    }
  }, 60_000);

  it("runs the owner's own direct messages as their Home agent and everyone else below Main", async () => {
    const mainWorkspaceId = await ownersMainWorkspace();
    const fixture = await pipelineFixture({
      accessMode: "anyone",
      suffix: "HOME",
      workspaceId: mainWorkspaceId,
    });
    const { hub, service } = fixture;
    const direct = (eventId: string, providerMessageId: string) => ({
      ...channelEvent({ scope: "HOME", text: "What is on my calendar?" }),
      conversation: {
        displayName: null,
        externalConversationId: "D-HOME",
        externalScopeId: "T-HOME",
        externalThreadId: null,
        type: "dm" as const,
      },
      eventId,
      providerMessageId,
      trigger: "direct-message" as const,
    });
    const deliver = async (event: ReturnType<typeof channelEvent> | ReturnType<typeof direct>) => {
      await service.handleRuntimeRequest(
        messagingRunnerId,
        runtimeRequest("ingress.commit", { connectionId: fixture.created.connection.id, event }),
      );
      return vi.waitFor(async () => {
        const row = await database
          .selectFrom("channelIngressEvents")
          .select("status")
          .where("providerEventId", "=", event.eventId)
          .executeTakeFirstOrThrow();
        if (row.status !== "adopted") throw new Error(`Ingress is ${row.status}`);
        const context = await database
          .selectFrom("channelConversationContexts")
          .innerJoin(
            "channelConversations",
            "channelConversations.id",
            "channelConversationContexts.conversationId",
          )
          .innerJoin("threads", "threads.id", "channelConversationContexts.activeThreadId")
          .select(["threads.id", "threads.capabilityProfileId"])
          .where(
            "channelConversations.externalConversationId",
            "=",
            event.conversation.externalConversationId,
          )
          .executeTakeFirstOrThrow();
        return context;
      }, 10_000);
    };

    // 1. Anyone may write under this route, and runs as its creator without
    //    being them: below Main even though it lands in their Main.
    const stranger = await deliver(direct("Ev-HOME-1", "1786320000.000201"));
    expect(stranger.capabilityProfileId).toBe("workspace");

    // 2. The same direct message from the owner's own linked identity is the
    //    owner speaking for themself, so it is their Home agent — in a fresh
    //    root, never the Thread a stranger's message started.
    await database
      .updateTable("channelIdentities")
      .set({ linkedUserId: ownerUserId, status: "linked" })
      .where("accountId", "=", fixture.created.account.id)
      .where("externalUserId", "=", "U-EXTERNAL")
      .execute();
    const owner = await deliver(direct("Ev-HOME-2", "1786320000.000202"));
    expect(owner.capabilityProfileId).toBe("main");
    expect(owner.id).not.toBe(stranger.id);

    // 3. A channel is shared with whoever else is in it, so even the owner's
    //    own message there stays below Main.
    const shared = await deliver({
      ...channelEvent({ scope: "HOME", text: "Summarize this thread" }),
      eventId: "Ev-HOME-3",
      providerMessageId: "1786320000.000203",
    });
    expect(shared.capabilityProfileId).toBe("workspace");

    await service.close();
    hub.close();
  }, 60_000);

  it("runs a channel message on the owner's own desktop-added Mac when it is the only computer online", async () => {
    const localEnvironmentId = createId("environment");
    await enrollAgentsRunner({
      createdBy: ownerUserId,
      environmentId: localEnvironmentId,
      runnerId: createId("runner"),
      runnerKind: "local",
    });
    const fixture = await pipelineFixture({
      accessMode: "anyone",
      environmentId: localEnvironmentId,
      suffix: "LOCAL",
    });
    const { hub, service } = fixture;
    await service.handleRuntimeRequest(
      messagingRunnerId,
      runtimeRequest("ingress.commit", {
        connectionId: fixture.created.connection.id,
        event: channelEvent({ scope: "LOCAL", text: "Run this on my Mac" }),
      }),
    );
    const run = await waitForRun(fixture.workspaceId);
    const thread = await database
      .selectFrom("threads")
      .select("environmentId")
      .where("id", "=", run.threadId)
      .executeTakeFirstOrThrow();
    expect(thread.environmentId).toBe(localEnvironmentId);
    expect(fixture.queued).toEqual([localEnvironmentId]);

    await service.close();
    hub.close();
  }, 60_000);

  async function ownersMainWorkspace(): Promise<WorkspaceId> {
    const existing = await database
      .selectFrom("workspaces")
      .select("id")
      .where("createdBy", "=", ownerUserId)
      .where("kind", "=", "main")
      .executeTakeFirst();
    if (existing) return existing.id;
    const created = await store.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: "wsp_pipeline_home",
      },
      capacityPolicy: {
        blockHardLimitBytes: 10_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota",
      },
      createdBy: ownerUserId,
      idempotencyKey: "workspace-pipeline-home",
      kind: "main",
      name: "Home",
      status: "ready",
    });
    return created.id;
  }

  async function pipelineFixture(input: {
    readonly accessMode: "anyone" | "linked-members";
    readonly computerOnline?: boolean;
    readonly routingMode?: "dedicated" | "shared";
    readonly suffix: string;
    /** The one work location online, instead of the shared Main Runner's. */
    readonly environmentId?: ReturnType<typeof createId<"environment">>;
    /** Routes to this Workspace instead of a new one of its own. */
    readonly workspaceId?: WorkspaceId;
  }) {
    const onlineEnvironmentId = input.environmentId ?? environmentId;
    const queued: string[] = [];
    const computer = { online: input.computerOnline ?? true };
    const hub = new MessagingRelayHub();
    const relayRequests: { operation: string; payload: unknown }[] = [];
    const peer: MessagingRelayPeer = {
      close: () => undefined,
      id: `pipeline-peer-${input.suffix}`,
      send: async (message) => {
        if (!("operation" in message)) return;
        relayRequests.push({ operation: message.operation, payload: message.payload });
        const result =
          message.operation === "connection.inspect"
            ? inspection(input.suffix)
            : { synchronized: true };
        queueMicrotask(() =>
          hub.handleResponse(messagingRunnerId, {
            ...stream().fence,
            ok: true,
            requestId: message.requestId,
            result,
            type: "runtime.response",
          }),
        );
      },
    };
    hub.attach(peer, stream());
    const workspace = input.workspaceId
      ? { id: input.workspaceId }
      : await store.createWorkspace({
          backing: {
            generation: 1,
            kind: "portablefs",
            serviceId: "test-portablefs",
            volumeId: `wsp_pipeline_${input.suffix.toLowerCase()}`,
          },
          capacityPolicy: {
            blockHardLimitBytes: 10_000_000,
            inodeHardLimit: 10_000,
            kind: "hard-quota",
          },
          createdBy: ownerUserId,
          idempotencyKey: `workspace-pipeline-${input.suffix}`,
          name: `Pipeline ${input.suffix}`,
          status: "ready",
        });
    const harness = await store.createHarnessInstance({
      config: { model: "test" },
      driverKind: HarnessIdSchema.parse("native"),
      environmentId: onlineEnvironmentId,
      name: `Pipeline harness ${input.suffix}`,
      stateKind: "isolated",
    });
    // A channel Thread takes its model from what the Runner reported for the
    // account, so the fixture has to have reported something.
    await store.recordHarnessCatalogs({
      catalogs: [
        HarnessInstanceCatalogSchema.parse({
          continuationIdentity: {
            continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
            driverKind: "native",
          },
          driverKind: "native",
          harnessInstanceId: harness.id,
          models: [
            {
              displayName: "GPT-5.6 Sol",
              isDefault: true,
              modelId: "gpt-5.6-sol",
              options: [],
              providerId: "openai",
            },
          ],
          status: "ready",
        }),
      ],
      environmentId: onlineEnvironmentId,
      expectedRevisions: new Map([[harness.id, harness.runtimeRevision]]),
    });
    const service = new ChannelService({
      canonicalOrigin,
      channels,
      credentials,
      onExecutionQueued: (id) => queued.push(id),
      onWorkspaceEvent: () => undefined,
      relay: hub,
      runners: {
        canRunHarness: (candidate: string) => candidate === onlineEnvironmentId,
        isAvailable: (candidate: string) => computer.online && candidate === onlineEnvironmentId,
      } as never,
      store,
    });
    const created = await service.createConnection({
      accessPolicy: {
        channels: {
          scope: "all",
          conversationIds: [],
          sender: { mode: input.accessMode, allowedExternalUserIds: [] },
        },
        directMessages: { mode: input.accessMode, allowedExternalUserIds: [] },
      },
      createdBy: ownerUserId,
      credentials: {
        appToken: `xapp-${input.suffix}-token`,
        botToken: `xoxb-${input.suffix}-token`,
      },
      provider: "slack",
      routingMode: input.routingMode ?? "dedicated",
      workspaceId: workspace.id,
    });
    await service.handleRuntimeRequest(
      messagingRunnerId,
      runtimeRequest("connection.health", {
        connectionId: created.connection.id,
        detail: null,
        reason: null,
        status: "connected",
      }),
    );
    return {
      computer,
      created,
      hub,
      queued,
      relayRequests,
      service,
      workspaceId: workspace.id,
    };
  }

  async function waitForRun(workspaceId: WorkspaceId) {
    return vi.waitFor(async () => {
      const row = await database
        .selectFrom("runs")
        .innerJoin("threads", "threads.id", "runs.threadId")
        .select([
          "runs.id",
          "runs.replyTarget",
          "runs.seedInputId",
          "runs.status",
          "runs.threadId",
          "threads.workspaceId",
        ])
        .where("threads.workspaceId", "=", workspaceId)
        .executeTakeFirst();
      if (!row) throw new Error("No Run was created from the channel ingress");
      return row;
    }, 10_000);
  }

  async function beginRun(run: {
    readonly id: RunId;
    readonly threadId: ThreadId;
    readonly workspaceId: WorkspaceId;
  }) {
    const command = await store.claimNextCommand(environmentId, "pipeline-command-worker");
    expect(command?.command.runId).toBe(run.id);
    const harnesses = await store.listHarnessInstances();
    const harness = harnesses.find((candidate) => candidate.enabled);
    if (!harness) throw new Error("No AI engine is available for the pipeline Run");
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: {
        continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
        driverKind: HarnessIdSchema.parse("native"),
      },
      harnessInstanceId: harness.id,
      leaseTokenHash: `pipeline-run-lease-${run.id}`,
      membershipGeneration: 1,
      runnerBootId: "pipeline-run-boot",
      runnerId: agentsRunnerId,
      runId: run.id,
      threadId: run.threadId,
    });
    await emit(binding, run, 0, "run.started", { status: "running" });
    return binding;
  }

  async function emit(
    binding: { readonly bindingGeneration: number },
    run: { readonly id: RunId; readonly threadId: ThreadId; readonly workspaceId: WorkspaceId },
    ordinal: number,
    type: string,
    data: unknown,
  ): Promise<void> {
    await store.commitRunnerEvent({
      environmentId,
      event: pendingEvent({
        bindingGeneration: binding.bindingGeneration,
        data,
        environmentId,
        ordinal,
        runId: run.id,
        threadId: run.threadId,
        type,
        workspaceId: run.workspaceId,
      }),
      runnerBootId: "pipeline-run-boot",
      runnerId: agentsRunnerId,
    });
  }

  function clearBackoff(deliveryId: ChannelDeliveryId) {
    return database
      .updateTable("channelDeliveries")
      .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
      .where("id", "=", deliveryId)
      .execute();
  }

  async function enrollMessagingRunner(): Promise<void> {
    const tokenHash = `sha256:pipeline-messaging-${messagingRunnerId}`;
    await store.createRunnerEnrollment({
      allowedModules: ["messaging"],
      createdBy: null,
      expiresAt: new Date(Date.now() + 60_000),
      id: `ren_${randomUUID()}`,
      idempotencyKey: `pipeline-messaging-${messagingRunnerId}`,
      name: "Pipeline messaging service",
      requestFingerprint: `sha256:pipeline-messaging-${messagingRunnerId}`,
      runnerKind: "managed",
      tokenHash,
    });
    await store.enrollRunnerConnection({
      descriptor: {
        bootId: `rbt_${randomUUID()}` as RunnerDescriptor["bootId"],
        capabilities: [],
        modules: { messaging: { capabilities: [slackCapability] } },
        name: "Pipeline messaging service",
        runnerId: messagingRunnerId,
        runnerKind: "managed",
        runtimeVersion: "test",
      },
      enrollmentTokenHash: tokenHash,
      publicKeyFingerprint: `sha256:pipeline-messaging-key`,
      publicKeyPem: `-----BEGIN PUBLIC KEY-----\npipeline\n-----END PUBLIC KEY-----\n`,
    });
  }

  async function enrollAgentsRunner(input: {
    readonly createdBy: UserId;
    readonly environmentId: ReturnType<typeof createId<"environment">>;
    readonly runnerId: RunnerId;
    /** A desktop-added Mac is `local` and belongs to the person who added it. */
    readonly runnerKind?: "local" | "main";
  }): Promise<void> {
    const runnerKind = input.runnerKind ?? "main";
    if (!(await store.getDeployment())) {
      await store.ensureDeployment({
        canonicalOrigin,
        hostInstanceId: createId("hostInstance"),
        deploymentShape: { defaultWorkspaceBacking: "portablefs", kind: "server" },
      });
    }
    const pair = generateKeyPairSync("ed25519");
    const publicKeyPem = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
    const publicKeyDer = pair.publicKey.export({ format: "der", type: "spki" });
    const enrollmentTokenHash = `sha256:${createHash("sha256")
      .update(`pipeline-agents-runner-${runnerKind}`, "utf8")
      .digest("base64url")}`;
    await store.createRunnerEnrollment({
      allowedModules: ["agents"],
      createdBy: input.createdBy,
      expiresAt: new Date(Date.now() + 60_000),
      id: `ren_${randomUUID()}`,
      idempotencyKey: `pipeline-agents-runner-${runnerKind}`,
      ...(runnerKind === "main" ? { mainEnrollmentPurpose: "initial" as const } : {}),
      name: `Pipeline ${runnerKind} runner`,
      requestFingerprint: `sha256:pipeline-agents-runner-${runnerKind}`,
      runnerKind,
      tokenHash: enrollmentTokenHash,
    });
    await store.enrollRunnerConnection({
      descriptor: {
        bootId: `rbt_${randomUUID()}` as RunnerDescriptor["bootId"],
        capabilities: ["filesystem"],
        modules: {
          agents: {
            environmentIds: [input.environmentId],
            harnessDrivers: [
              {
                accessModes: [...ThreadAccessModeSchema.options],
                driverKind: HarnessIdSchema.parse("native"),
                readiness: "configured",
                sources: [
                  {
                    fields: [],
                    kind: "first-party",
                    label: "Native",
                    quota: "none",
                    sourceId: "native",
                    stateKinds: ["isolated"],
                  },
                ],
              },
            ],
            localStorage: null,
            maxConcurrentRuns: 4,
            providerStateModes: ["isolated"],
            workspaceBackings: ["portablefs"],
            workspaceMounts: [],
          },
        },
        name: `Pipeline ${runnerKind} runner`,
        runnerId: input.runnerId,
        runnerKind,
        runtimeVersion: "test",
      },
      enrollmentTokenHash,
      publicKeyFingerprint: `sha256:${createHash("sha256").update(publicKeyDer).digest("base64url")}`,
      publicKeyPem,
    });
  }
});

const slackCapability = {
  manifest: slackChannelProviderManifest,
  provider: "slack",
  transportKinds: ["socket" as const],
};

interface ClaimedShape {
  readonly claimToken: string;
  readonly delivery: {
    readonly content: unknown;
    readonly id: ChannelDeliveryId;
    readonly status: string;
  };
  readonly destination: Readonly<Record<string, unknown>>;
  readonly lease: { readonly secrets: Readonly<Record<string, string>> };
  readonly mayHaveBeenSent: boolean;
}

function inspection(suffix: string) {
  return {
    capabilities: ["messages", "threads"],
    identity: {
      accountDisplayName: `Acme ${suffix}`,
      connectionDisplayName: `Acme ${suffix} · Slack`,
      externalAccountId: `T-${suffix}`,
      externalIdentityId: `U-BOT-${suffix}`,
      handle: "@opensteer",
      metadata: {},
    },
    issues: [],
    ready: true,
  } as const;
}

function channelEvent(input: { readonly scope: string; readonly text: string }) {
  return {
    accountExternalId: `T-${input.scope}`,
    actor: { displayName: "External operator", externalUserId: "U-EXTERNAL" },
    content: [{ text: input.text, type: "text" as const }],
    conversation: {
      displayName: input.scope.toLowerCase(),
      externalConversationId: `C-${input.scope}`,
      externalScopeId: `T-${input.scope}`,
      externalThreadId: "1786320000.000100",
      type: "channel" as const,
    },
    eventId: `Ev-${input.scope}-1`,
    occurredAt: new Date().toISOString(),
    provider: "slack",
    providerMessageId: "1786320000.000100",
    trigger: "mention" as const,
  };
}

function claimDelivery(service: ChannelService) {
  return service.handleRuntimeRequest(
    messagingRunnerId,
    runtimeRequest("delivery.claim", { leaseSeconds: 30 }),
  );
}

function startDelivery(service: ChannelService, claimed: ClaimedShape) {
  return service.handleRuntimeRequest(
    messagingRunnerId,
    runtimeRequest("delivery.start", {
      claimToken: claimed.claimToken,
      deliveryId: claimed.delivery.id,
    }),
  );
}

function finishDelivery(
  service: ChannelService,
  claimed: ClaimedShape,
  outcome: Readonly<Record<string, unknown>>,
) {
  return service.handleRuntimeRequest(
    messagingRunnerId,
    runtimeRequest("delivery.finish", {
      claimToken: claimed.claimToken,
      deliveryId: claimed.delivery.id,
      ...outcome,
    }),
  );
}

async function acknowledgeDelivery(service: ChannelService, claimed: ClaimedShape) {
  await startDelivery(service, claimed);
  await finishDelivery(service, claimed, {
    outcome: "sent",
    receipt: { providerMessageId: `sent-${claimed.delivery.id}` },
  });
}

function statusText(claimed: ClaimedShape): string {
  const content = claimed.delivery.content as readonly { readonly text?: string }[];
  return content.map((part) => part.text ?? "").join("");
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1_000);
}

function claimResult(result: unknown): ClaimedShape {
  const claimed = (result as { claimed: ClaimedShape | null }).claimed;
  if (!claimed) throw new Error("Expected a claimed delivery");
  return claimed;
}

function runtimeRequest(operation: string, payload: unknown): RuntimeChannelRequest {
  return RuntimeChannelRequestSchema.parse({
    ...stream().fence,
    operation,
    payload,
    requestId: `crq_${randomBytes(24).toString("base64url")}`,
    type: "runtime.request",
  });
}

function pendingEvent<T extends PendingAgentEvent>(input: Record<string, unknown>): T {
  return { ...input, emittedAt: new Date().toISOString() } as T;
}

function stream(): RunnerAuxiliaryStream {
  const runnerId: RunnerId = messagingRunnerId;
  const bootId = RunnerBootIdSchema.parse("rbt_00000000-0000-4000-8000-0000000000a1");
  const connectionId = RunnerConnectionIdSchema.parse("rcn_00000000-0000-4000-8000-0000000000a1");
  const connectionLeaseId = RunnerConnectionLeaseIdSchema.parse(
    "rls_00000000-0000-4000-8000-0000000000a1",
  );
  const fence = RunnerAuxiliaryFrameFenceSchema.parse({
    auxiliaryStreamId: "rax_00000000-0000-4000-8000-0000000000a1",
    bootId,
    connectionGeneration: 1,
    connectionId,
    connectionLeaseId,
    module: "messaging",
    runnerId,
  });
  return {
    auxiliaryStreamId: fence.auxiliaryStreamId,
    fence,
    identity: {
      allowedModules: ["messaging"],
      bootId,
      capabilities: [],
      connectionGeneration: 1,
      personalRemoteAccessGeneration: null,
      connectionId,
      connectionLeaseId,
      environmentIds: [],
      fence,
      modules: { messaging: { capabilities: [slackCapability] } },
      name: "Pipeline messaging service",
      runnerId,
      runnerKind: "managed",
      runtimeVersion: "test",
    },
    streamLeaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
  };
}
