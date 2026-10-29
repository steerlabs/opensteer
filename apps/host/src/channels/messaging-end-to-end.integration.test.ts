/**
 * The whole messaging path with every real component except Slack itself.
 *
 * The Host half is real: a PostgreSQL-backed `OpensteerStore` and
 * `ChannelStore`, a real `CredentialService`, a real `MessagingRelayHub` and a
 * real `ChannelService`. The messaging service half is real too: the
 * `MessagingFrameRouter` that `RunnerMessagingConnection` wraps, the real
 * `ChannelConnectionSupervisor`, the real `ChannelDeliveryWorker`, the real
 * `ChannelAdapterRegistry`, and the real Slack adapter from
 * `@opensteer/channel-slack`. Only two things are fakes: Slack (a `fetch` that
 * answers the six Web API methods this adapter calls and a Socket Mode socket
 * envelopes are pushed into) and the WebSocket underneath the module stream,
 * which is replaced by an in-memory wire that dispatches frames exactly the way
 * `apps/host/src/server.ts` does — `runtime.response` to the hub, everything
 * else to `ChannelService.handleRuntimeRequest`, answered as `host.response`.
 * The transport handshake itself is covered by the process-level smoke test and
 * by `apps/host/src/runtime/runtime.integration.test.ts`.
 *
 * Requires OPENSTEER_TEST_DATABASE_URL; it skips without one.
 */
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import {
  ChannelAdapterRegistry,
  ChannelConnectionSupervisor,
  ChannelDeliveryWorker,
  MessagingFrameRouter,
  RoutedChannelHostClient,
} from "@opensteer/messaging-module";
import {
  createSlackAdapter,
  slackDeliveryMetadataEventType,
  type SlackWebSocket,
  type SlackWebSocketFactory,
} from "@opensteer/channel-slack";
import {
  slackChannelProviderManifest,
  type ChannelDeliveryId,
  type IntegrationConnectionId,
} from "@opensteer/channel-core";
import {
  HostToMessagingRelayMessageSchema,
  MessagingRelayToHostMessageSchema,
  RuntimeChannelRequestSchema,
  type HostToMessagingRelayMessage,
  type RuntimeChannelRequest,
} from "@opensteer/channel-protocol";
import { ChannelStore, OpensteerStore, createDatabase, migrateToLatest } from "@opensteer/database";
import {
  HarnessIdSchema,
  OpensteerError,
  RunnerIdSchema,
  ThreadAccessModeSchema,
  createId,
  type MessageId,
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
import type { WebSocketFrame } from "@opensteer/shared/webSocketFrame";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ChannelService } from "./channel-service.js";
import { MessagingRelayHub, type MessagingRelayPeer } from "./messaging-relay-hub.js";
import { CredentialService } from "../identity/credential-service.js";

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

const messagingRunnerId = RunnerIdSchema.parse("rnr_00000000-0000-4000-8000-0000000000b1");
const canonicalOrigin = "https://messaging-e2e.invalid";

/**
 * A Slack message timestamp this many seconds into the test. Messages carry
 * the time they were sent, and one sent long ago is too old to run, so the
 * conversation happens now.
 */
const slackEpoch = Math.floor(Date.now() / 1_000);
function slackTs(second: number): string {
  return `${slackEpoch + second}.000100`;
}
const threadUrl = (threadId: ThreadId) => `${canonicalOrigin}/threads/${threadId}`;
const botUserId = "U0BOT";
const humanUserId = "U-HUMAN";
const teamId = "T-E2E";
const dmChannelId = "D-E2E";
const roomChannelId = "C-E2E";

integration("messaging end to end", () => {
  const database = createDatabase({
    applicationName: "opensteer-messaging-end-to-end",
    connectionString: databaseUrl ?? "postgres://unconfigured",
    maxConnections: 6,
  });
  const store = new OpensteerStore(database, { links: { threadUrl } });
  const channels = new ChannelStore(database);
  const slack = new FakeSlack();

  let credentials: CredentialService;
  let environmentId: ReturnType<typeof createId<"environment">>;
  let agentsRunnerId: RunnerId;
  let ownerUserId: UserId;
  let workspaceId: WorkspaceId;
  let service: ChannelService;
  let hub: MessagingRelayHub;
  let wire: MessagingWire;
  let supervisor: ChannelConnectionSupervisor;
  let worker: ChannelDeliveryWorker;
  let connectionId: IntegrationConnectionId;
  let linkCode = "";
  let dmRun: AdoptedRun;
  let roomRun: AdoptedRun;
  // The room's follow-up waits behind the Run still answering, then is the next one.
  let roomFollowUpMessageId: MessageId;

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
    ownerUserId = await store.createUser("End to end owner");
    environmentId = createId("environment");
    agentsRunnerId = createId("runner");
    await enrollAgentsRunner();
    await enrollMessagingRunner();
    const workspace = await store.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: "wsp_messaging_e2e",
      },
      capacityPolicy: {
        blockHardLimitBytes: 10_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota",
      },
      createdBy: ownerUserId,
      idempotencyKey: "workspace-messaging-e2e",
      name: "Messaging end to end",
      status: "ready",
    });
    workspaceId = workspace.id;
    const harness = await store.createHarnessInstance({
      config: { model: "test" },
      driverKind: HarnessIdSchema.parse("native"),
      environmentId,
      name: "Messaging end to end engine",
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
      environmentId,
      expectedRevisions: new Map([[harness.id, harness.runtimeRevision]]),
    });

    hub = new MessagingRelayHub();
    service = new ChannelService({
      canonicalOrigin,
      channels,
      credentials,
      onExecutionQueued: () => undefined,
      onWorkspaceEvent: () => undefined,
      relay: hub,
      runners: {
        canRunHarness: (candidate: string) => candidate === environmentId,
        isAvailable: (candidate: string) => candidate === environmentId,
      } as never,
      store,
    });

    // The messaging service, composed the way `apps/channel-runtime/src/main.ts`
    // composes it through `MessagingModule`: one registry, one frame router, one
    // supervisor, one worker.
    const adapters = new ChannelAdapterRegistry([
      createSlackAdapter({ fetch: slack.fetch, webSocket: slack.webSocket }),
    ]);
    const router = new MessagingFrameRouter();
    const hostClient = new RoutedChannelHostClient(router);
    supervisor = new ChannelConnectionSupervisor(hostClient, adapters);
    worker = new ChannelDeliveryWorker(hostClient, adapters);
    router.setHandler((request, context) => supervisor.handle(request, context));
    wire = new MessagingWire({ hub, router, service });
    hub.attach(wire.peer, wire.auxiliaryStream);
    await supervisor.opened(router.attach(wire.moduleStream));
    worker.resume();
    worker.start();
    service.start();
  });

  afterAll(async () => {
    await worker?.close();
    await supervisor?.close();
    await service?.close();
    hub?.close();
    wire?.close();
    await database.destroy();
  });

  it("enrolls, synchronizes without deadlock, and reaches a connected Slack socket", async () => {
    const created = await service.createConnection({
      accessPolicy: {
        channels: {
          scope: "all",
          conversationIds: [],
          sender: { mode: "linked-members", allowedExternalUserIds: [] },
        },
        directMessages: { mode: "linked-members", allowedExternalUserIds: [] },
      },
      createdBy: ownerUserId,
      credentials: { appToken: "xapp-e2e-token", botToken: "xoxb-e2e-token" },
      provider: "slack",
      routingMode: "dedicated",
      workspaceId,
    });
    connectionId = created.connection.id;
    // `connection.inspect` and `connections.sync` both completed, so the sync
    // handler that issues its own `runtime.request` never waited behind itself.
    expect(wire.relayRequests).toEqual(["connection.inspect", "connections.sync"]);
    expect(created.account.externalAccountId).toBe(teamId);

    const socket = await vi.waitFor(() => {
      const first = slack.sockets[0];
      if (!first?.attached) throw new Error("The Slack adapter never opened a socket");
      return first;
    }, 10_000);
    socket.deliver({ connection_info: { app_id: "A1" }, num_connections: 1, type: "hello" });
    await vi.waitFor(async () => {
      const row = await database
        .selectFrom("integrationConnections")
        .select("status")
        .where("id", "=", connectionId)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ status: "connected" });
    }, 10_000);
    // One `auth.test` and one `apps.connections.open` per connect attempt, plus
    // the pair `connection.inspect` made: never two sockets for one session.
    expect(slack.sockets).toHaveLength(1);
    expect(slack.calls.filter((url) => url.includes("apps.connections.open"))).toHaveLength(2);

    // A second `connections.sync` while a session is ready makes the supervisor
    // await `reportSteadyState`, which issues `connection.health` as a `runtime.request`
    // from inside a `host.request` handler. It answers, so responses are not
    // queued behind the request that is waiting for them.
    const beforeRelay = wire.relayRequests.length;
    const beforeHost = wire.hostRequests.length;
    await service.runtimeConnected(messagingRunnerId);
    expect(wire.relayRequests.slice(beforeRelay)).toEqual(["connections.sync"]);
    expect(wire.hostRequests.slice(beforeHost).map(({ operation }) => operation)).toContain(
      "connection.health",
    );
  }, 60_000);

  it("sends private verification codes and replaces an unused code on a new request", async () => {
    const socket = slack.socket();
    wire.holdNext("ingress.commit");
    socket.deliver(
      messageEnvelope({
        channel: dmChannelId,
        channelType: "im",
        envelopeId: "env-dm-1",
        eventId: "Ev-DM-1",
        text: "Can you look at the deploy?",
        ts: slackTs(1),
      }),
    );
    // The Host has not answered yet, so Slack has not been told the message was
    // taken: nothing is acknowledged before the ingress row exists.
    await vi.waitFor(() => expect(wire.held).toBe(true), 5_000);
    expect(socket.sent).toHaveLength(0);
    await expect(
      database
        .selectFrom("channelIngressEvents")
        .select("id")
        .where("providerEventId", "=", "Ev-DM-1")
        .executeTakeFirst(),
    ).resolves.toBeUndefined();
    wire.release();
    await vi.waitFor(() => expect(socket.sent).toEqual(['{"envelope_id":"env-dm-1"}']), 10_000);
    // Slack's acknowledgement proves durable receipt; draining the leased
    // ingress into an ignored, unlinked-sender result happens afterward.
    await vi.waitFor(async () => {
      await expect(
        database
          .selectFrom("channelIngressEvents")
          .select("status")
          .where("providerEventId", "=", "Ev-DM-1")
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ status: "ignored" });
    }, 10_000);

    // The unlinked sender is answered privately, through the same real worker
    // and adapter that carry replies: a DM is a plain message, not an ephemeral.
    const invitation = await vi.waitFor(() => {
      const posted = slack.posted.find(({ channel }) => channel === dmChannelId);
      if (!posted) throw new Error("No link-code message reached the direct message");
      return posted;
    }, 15_000);
    expect(slack.ephemeral).toHaveLength(0);
    expect(invitation.threadTs).toBeNull();
    expect(invitation.deliveryId).not.toBeNull();
    expect(invitation.text).toContain(`${canonicalOrigin}/settings/apps/messaging`);
    const code = /\*([A-HJ-NP-Z2-9]{8})\*/u.exec(invitation.text)?.[1];
    expect(code).toBeDefined();
    linkCode = code ?? "";
    const status = await database
      .selectFrom("channelDeliveries")
      .select(["audience", "conversationId", "ingressId", "kind", "status"])
      .where("kind", "=", "status")
      .executeTakeFirstOrThrow();
    expect(status).toMatchObject({ audience: "actor", conversationId: null, kind: "status" });
    expect(status.ingressId).not.toBeNull();

    // A new explicit request replaces the unused code; retries of an event do not.
    socket.deliver(
      messageEnvelope({
        channel: dmChannelId,
        channelType: "im",
        envelopeId: "env-dm-2",
        eventId: "Ev-DM-2",
        text: "Still waiting",
        ts: slackTs(2),
      }),
    );
    await vi.waitFor(async () => {
      const row = await database
        .selectFrom("channelIngressEvents")
        .select("status")
        .where("providerEventId", "=", "Ev-DM-2")
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ status: "ignored" });
    }, 15_000);
    await expect(
      database
        .selectFrom("channelLinkCodes")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: "1" });
    const replacement = await vi.waitFor(() => {
      const invitations = slack.posted.filter(({ channel }) => channel === dmChannelId);
      expect(invitations).toHaveLength(2);
      return invitations[1]!;
    }, 15_000);
    const replacementCode = /\*([A-HJ-NP-Z2-9]{8})\*/u.exec(replacement.text)?.[1];
    expect(replacementCode).toBeDefined();
    expect(replacementCode).not.toBe(linkCode);
    await expect(service.linkIdentity(linkCode, ownerUserId)).rejects.toMatchObject({
      code: "not_found",
    });
    linkCode = replacementCode ?? "";
  }, 60_000);

  it("runs the next direct message once the code is redeemed and posts ordered mrkdwn parts", async () => {
    await expect(service.linkIdentity(linkCode, ownerUserId)).resolves.toMatchObject({
      identity: { externalUserId: humanUserId },
    });
    slack.socket().deliver(
      messageEnvelope({
        channel: dmChannelId,
        channelType: "im",
        envelopeId: "env-dm-3",
        eventId: "Ev-DM-3",
        text: "Summarize the deploy",
        ts: slackTs(3),
      }),
    );
    dmRun = await adoptedRun("Ev-DM-3");

    const binding = await beginRun(dmRun);
    const replyMessageId = createId("message");
    const paragraph = "The pipeline carried this message end to end. ".repeat(6).trim();
    const longReply = [
      "# Findings",
      "",
      "A **bold** claim and a [link](https://example.com/docs).",
      "",
      "```ts",
      'const keep = "**keep**";',
      "```",
      "",
      Array.from({ length: 40 }, (_, index) => `${index + 1}. ${paragraph}`).join("\n\n"),
    ].join("\n");
    expect(longReply.length).toBeGreaterThan(2 * slackChannelProviderManifest.maxMessageChars);
    await emit(binding, dmRun, 1, "assistant.message", {
      content: [
        { text: longReply, type: "text" },
        { artifactId: "art_1", mediaType: "text/csv", name: "findings.csv", type: "artifact" },
      ],
      messageId: replyMessageId,
    });
    // Nothing reaches Slack until the Run completes; then its reply does.
    await expect(
      database
        .selectFrom("channelDeliveries")
        .select("id")
        .where("messageId", "=", replyMessageId)
        .execute(),
    ).resolves.toEqual([]);
    await emit(binding, dmRun, 2, "run.completed", { status: "completed" });
    const parts = await database
      .selectFrom("channelDeliveries")
      .select(["id", "part", "partCount"])
      .where("messageId", "=", replyMessageId)
      .orderBy("part", "asc")
      .execute();
    expect(parts.length).toBeGreaterThan(2);

    const delivered = await vi.waitFor(() => {
      const posted = slack.posted.filter(({ deliveryId }) =>
        parts.some((part) => part.id === deliveryId),
      );
      if (posted.length !== parts.length) {
        throw new Error(`Slack has ${posted.length} of ${parts.length} reply parts`);
      }
      return posted;
    }, 20_000);
    // Ordered, one Slack message per part, and never a thread in a DM.
    expect(delivered.map(({ deliveryId }) => deliveryId)).toEqual(parts.map(({ id }) => id));
    expect(delivered.every(({ threadTs }) => threadTs === null)).toBe(true);
    expect(delivered.every(({ unfurlLinks }) => unfurlLinks === false)).toBe(true);
    expect(delivered.every(({ channel }) => channel === dmChannelId)).toBe(true);
    const joined = delivered.map(({ text }) => text).join("\n");
    expect(joined).toContain("*Findings*");
    expect(joined).toContain("A *bold* claim and a <https://example.com/docs|link>.");
    // A fenced block is passed through untouched, so Markdown inside it stays.
    expect(joined).toContain('const keep = "**keep**";');
    // The artifact rides the last part as a line naming the Thread.
    expect(delivered.at(-1)?.text).toContain(
      `findings.csv — <${threadUrl(dmRun.threadId)}|Open in Opensteer>`,
    );
    await vi.waitFor(async () => {
      const unfinished = await database
        .selectFrom("channelDeliveries")
        .select(["status"])
        .where("messageId", "=", replyMessageId)
        .where("status", "!=", "sent")
        .execute();
      expect(unfinished).toEqual([]);
    }, 10_000);
  }, 90_000);

  it("posts each turn's reply when the turn ends in the background, and never twice", async () => {
    slack.socket().deliver(
      messageEnvelope({
        channel: dmChannelId,
        channelType: "im",
        envelopeId: "env-dm-background",
        eventId: "Ev-DM-BACKGROUND",
        text: "Watch the deploy",
        ts: slackTs(15),
      }),
    );
    const run = await adoptedRun("Ev-DM-BACKGROUND");
    const binding = await beginRun(run);
    const deliveries = (messageId: MessageId) =>
      database
        .selectFrom("channelDeliveries")
        .select("id")
        .where("messageId", "=", messageId)
        .execute();
    const watching = createId("message");
    await emit(binding, run, 1, "assistant.message", {
      content: [{ text: "Watching the deploy in the background.", type: "text" }],
      messageId: watching,
    });
    // The turn ended with work still running: its channel hears it now.
    await emit(binding, run, 2, "run.phase", { phase: "background" });
    const [delivery] = await deliveries(watching);
    if (!delivery) throw new Error("The turn's reply was not queued for Slack");
    await vi.waitFor(() => {
      if (!slack.posted.some(({ deliveryId }) => deliveryId === delivery.id)) {
        throw new Error("Slack has not been sent the turn's reply");
      }
    }, 20_000);

    await emit(binding, run, 3, "run.phase", { phase: "turn" });
    const finished = createId("message");
    await emit(binding, run, 4, "assistant.message", {
      content: [{ text: "The deploy finished.", type: "text" }],
      messageId: finished,
    });
    await emit(binding, run, 5, "run.completed", { status: "completed" });
    await expect(deliveries(finished)).resolves.toHaveLength(1);
    // Each reply goes out once.
    await expect(deliveries(watching)).resolves.toHaveLength(1);
  }, 90_000);

  it("joins the owner's next direct message into the reply under way, and never an in-app one", async () => {
    slack.socket().deliver(
      messageEnvelope({
        channel: dmChannelId,
        channelType: "im",
        envelopeId: "env-dm-join-1",
        eventId: "Ev-DM-JOIN-1",
        text: "Draft the release note",
        ts: slackTs(20),
      }),
    );
    const run = await adoptedRun("Ev-DM-JOIN-1");
    const binding = await beginRun(run);
    // While the reply is under way, the owner writes again in the same DM.
    slack.socket().deliver(
      messageEnvelope({
        channel: dmChannelId,
        channelType: "im",
        envelopeId: "env-dm-join-2",
        eventId: "Ev-DM-JOIN-2",
        text: "Mention the date too",
        ts: slackTs(21),
      }),
    );
    const joined = await vi.waitFor(async () => {
      const row = await database
        .selectFrom("channelIngressEvents")
        .select(["messageId", "runId", "status"])
        .where("providerEventId", "=", "Ev-DM-JOIN-2")
        .executeTakeFirstOrThrow();
      expect(row.status).toBe("adopted");
      if (!row.messageId) throw new Error("The follow-up named no message");
      return { messageId: row.messageId, runId: row.runId };
    }, 20_000);
    expect(joined.runId).toBe(run.id);
    const followUp = await database
      .selectFrom("threadInputs")
      .innerJoin("commands", "commands.id", "threadInputs.steerCommandId")
      .select([
        "commands.type",
        "threadInputs.authoritySource",
        "threadInputs.runId",
        "threadInputs.state",
      ])
      .where("threadInputs.messageId", "=", joined.messageId)
      .executeTakeFirstOrThrow();
    expect(followUp).toMatchObject({
      authoritySource: { kind: "channel-ingress" },
      runId: run.id,
      state: "claimed",
      type: "run.steer",
    });
    // The owner writing in the app does not join a reply that answers Slack.
    const inApp = await store.enqueueThreadInput({
      content: [{ text: "From the app: keep it short", type: "text" }],
      idempotencyKey: "dm-in-app-while-replying",
      policy: "queue",
      requestedBy: ownerUserId,
      source: { kind: "human" },
      threadId: run.threadId,
    });
    expect(inApp).toMatchObject({ disposition: "pending", run: null });

    await emit(binding, run, 1, "message.injected", { messageId: joined.messageId });
    const reply = createId("message");
    await emit(binding, run, 2, "assistant.message", {
      content: [{ text: "Release note drafted, dated today.", type: "text" }],
      messageId: reply,
    });
    await emit(binding, run, 3, "run.completed", { status: "completed" });
    await expect(
      database
        .selectFrom("threadInputs")
        .select("state")
        .where("messageId", "=", joined.messageId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ state: "delivered" });
    // One reply answers both Slack messages, sent once.
    await expect(
      database
        .selectFrom("channelDeliveries")
        .select("id")
        .where("messageId", "=", reply)
        .execute(),
    ).resolves.toHaveLength(1);
    // The in-app message is answered next, by a reply that stays in the app.
    const next = await database
      .selectFrom("runs")
      .select(["id", "replyTarget", "seedInputId", "status"])
      .where("threadId", "=", run.threadId)
      .where("seedInputId", "=", inApp.message.id)
      .executeTakeFirstOrThrow();
    expect(next).toMatchObject({ replyTarget: null, status: "queued" });
    const inAppRun = { ...run, bindingGeneration: 0, id: next.id };
    const inAppBinding = await beginRun(inAppRun);
    await emit(inAppBinding, inAppRun, 1, "assistant.message", {
      content: [{ text: "Kept short.", type: "text" }],
      messageId: createId("message"),
    });
    await emit(inAppBinding, inAppRun, 2, "run.completed", { status: "completed" });
  }, 90_000);

  it("keeps a channel mention and its thread in one conversation and stays out of chatter", async () => {
    const socket = slack.socket();
    socket.deliver(
      messageEnvelope({
        channel: roomChannelId,
        channelType: "channel",
        envelopeId: "env-room-1",
        eventId: "Ev-ROOM-1",
        text: `<@${botUserId}> hello`,
        ts: slackTs(10),
      }),
    );
    roomRun = await adoptedRun("Ev-ROOM-1");
    const conversation = await database
      .selectFrom("channelConversations")
      .select(["id", "conversationType", "externalThreadId"])
      .where("externalConversationId", "=", roomChannelId)
      .executeTakeFirstOrThrow();
    expect(conversation).toMatchObject({
      conversationType: "channel",
      externalThreadId: slackTs(10),
    });

    const binding = await beginRun(roomRun);
    const replyMessageId = createId("message");
    await emit(binding, roomRun, 1, "assistant.message", {
      content: [{ text: "Here is what I found.", type: "text" }],
      messageId: replyMessageId,
    });

    // A threaded follow-up with no mention joins the same conversation, and
    // waits behind the Run still answering.
    socket.deliver(
      messageEnvelope({
        channel: roomChannelId,
        channelType: "channel",
        envelopeId: "env-room-2",
        eventId: "Ev-ROOM-2",
        text: "and the second half?",
        threadTs: slackTs(10),
        ts: slackTs(11),
      }),
    );
    const followUp = await vi.waitFor(async () => {
      const row = await database
        .selectFrom("channelIngressEvents")
        .select(["conversationId", "messageId", "runId", "status"])
        .where("providerEventId", "=", "Ev-ROOM-2")
        .executeTakeFirstOrThrow();
      expect(row.status).toBe("adopted");
      return row;
    }, 20_000);
    expect(followUp.conversationId).toBe(conversation.id);
    const followUpThread = await database
      .selectFrom("threadInputs")
      .select(["threadId", "policy", "state"])
      .where("messageId", "=", followUp.messageId)
      .executeTakeFirstOrThrow();
    expect(followUpThread).toEqual({
      threadId: roomRun.threadId,
      policy: "queue",
      state: "pending",
    });
    expect(followUp.runId).toBeNull();
    if (!followUp.messageId) throw new Error("The follow-up was adopted without its message");
    roomFollowUpMessageId = followUp.messageId;

    // The Run's reply lands in the Slack thread the mention started, not at the top.
    await emit(binding, roomRun, 2, "run.completed", { status: "completed" });
    const reply = await vi.waitFor(async () => {
      const row = await database
        .selectFrom("channelDeliveries")
        .select(["id"])
        .where("messageId", "=", replyMessageId)
        .executeTakeFirstOrThrow();
      const posted = slack.posted.find(({ deliveryId }) => deliveryId === row.id);
      if (!posted) throw new Error("The channel reply never reached Slack");
      return posted;
    }, 20_000);
    expect(reply).toMatchObject({ channel: roomChannelId, threadTs: slackTs(10) });

    // Ambient chatter is dropped by the adapter: acknowledged, never committed.
    const acknowledged = socket.sent.length;
    socket.deliver(
      messageEnvelope({
        channel: roomChannelId,
        channelType: "channel",
        envelopeId: "env-room-3",
        eventId: "Ev-ROOM-3",
        text: "unrelated standup chatter",
        ts: slackTs(12),
      }),
    );
    await vi.waitFor(() => expect(socket.sent).toHaveLength(acknowledged + 1), 10_000);
    await expect(
      database
        .selectFrom("channelIngressEvents")
        .select("id")
        .where("providerEventId", "=", "Ev-ROOM-3")
        .executeTakeFirst(),
    ).resolves.toBeUndefined();
  }, 90_000);

  it("answers a second unlinked person in a channel privately, as an ephemeral", async () => {
    slack.socket().deliver(
      messageEnvelope({
        channel: roomChannelId,
        channelType: "channel",
        envelopeId: "env-room-4",
        eventId: "Ev-ROOM-4",
        text: `<@${botUserId}> can you help me too`,
        ts: slackTs(13),
        user: "U-OTHER",
      }),
    );
    const ephemeral = await vi.waitFor(() => {
      const posted = slack.ephemeral.find(({ user }) => user === "U-OTHER");
      if (!posted) throw new Error("The second person was told nothing");
      return posted;
    }, 20_000);
    // A channel is other people's room, so the invitation is visible only to
    // the person who asked — an ephemeral message, never a post in the channel.
    // That the code can travel at all here is what the manifest's
    // `actorDelivery` says; a provider that could not whisper would have been
    // sent to a direct message instead.
    expect(slackChannelProviderManifest.actorDelivery).toBe("in-conversation");
    expect(ephemeral.channel).toBe(roomChannelId);
    expect(ephemeral.text).toContain(`${canonicalOrigin}/settings/apps/messaging`);
    expect(/\*[A-HJ-NP-Z2-9]{8}\*/u.test(ephemeral.text)).toBe(true);
    expect(slack.posted.filter(({ channel }) => channel === roomChannelId)).toEqual(
      slack.posted.filter(
        ({ channel, text }) => channel === roomChannelId && !text.includes("link this Slack"),
      ),
    );
    await expect(
      database
        .selectFrom("channelIngressEvents")
        .select("status")
        .where("providerEventId", "=", "Ev-ROOM-4")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "ignored" });
    await expect(
      database
        .selectFrom("channelLinkCodes")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: "2" });
  }, 60_000);

  it("backs off a rate limit, reconciles an answer it never heard, and reports a failed Run", async () => {
    // 1. Slack answers 429 once. The part is requeued, not lost. It is the
    //    reply to the room's follow-up, whose own Run started once the first
    //    one completed.
    const followUpRun = await seededRun(roomFollowUpMessageId);
    const followUpBinding = await beginRun(followUpRun);
    slack.failNextPostMessage("rate-limited");
    const rateLimited = createId("message");
    await emit(followUpBinding, followUpRun, 1, "assistant.message", {
      content: [{ text: "Rate limited on the first try.", type: "text" }],
      messageId: rateLimited,
    });
    await emit(followUpBinding, followUpRun, 2, "run.completed", { status: "completed" });
    const requeued = await vi.waitFor(async () => {
      const row = await database
        .selectFrom("channelDeliveries")
        .select(["attempts", "id", "lastError", "nextAttemptAt", "status"])
        .where("messageId", "=", rateLimited)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe("retryable-failed");
      return row;
    }, 20_000);
    expect(requeued.lastError).toContain("ratelimited");
    // The provider asked for two seconds; the queue's own first-attempt floor
    // is longer, so the wait is at least what Slack asked for.
    expect(requeued.nextAttemptAt.getTime() - Date.now()).toBeGreaterThanOrEqual(2_000);
    expect(slack.postAttempts.filter((id) => id === requeued.id)).toHaveLength(1);
    expect(slack.posted.filter(({ deliveryId }) => deliveryId === requeued.id)).toHaveLength(0);
    await clearBackoff(requeued.id);
    worker.wake();
    await vi.waitFor(async () => {
      const row = await database
        .selectFrom("channelDeliveries")
        .select("status")
        .where("id", "=", requeued.id)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ status: "sent" });
    }, 20_000);
    expect(slack.posted.filter(({ deliveryId }) => deliveryId === requeued.id)).toHaveLength(1);

    // 2. Slack takes a message but the answer never arrives. The row is
    //    `unknown`, and the next claim reconciles instead of posting twice.
    slack.socket().deliver(
      messageEnvelope({
        channel: roomChannelId,
        channelType: "channel",
        envelopeId: "env-room-5",
        eventId: "Ev-ROOM-5",
        text: "and one more thing",
        threadTs: slackTs(10),
        ts: slackTs(14),
      }),
    );
    const lostRun = await adoptedRun("Ev-ROOM-5");
    const lostBinding = await beginRun(lostRun);
    slack.failNextPostMessage("lost");
    const lost = createId("message");
    await emit(lostBinding, lostRun, 1, "assistant.message", {
      content: [{ text: "This one was delivered but never acknowledged.", type: "text" }],
      messageId: lost,
    });
    await emit(lostBinding, lostRun, 2, "run.completed", { status: "completed" });
    const unknown = await vi.waitFor(async () => {
      const row = await database
        .selectFrom("channelDeliveries")
        .select(["id", "status"])
        .where("messageId", "=", lost)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe("unknown");
      return row;
    }, 20_000);
    // Slack was asked once and holds the message; this process just never
    // learned that, so nothing was posted as far as the runtime can tell.
    expect(slack.postAttempts.filter((id) => id === unknown.id)).toHaveLength(1);
    expect(slack.posted.filter(({ deliveryId }) => deliveryId === unknown.id)).toHaveLength(0);
    const repliesCalls = slack.calls.filter((url) => url.includes("conversations.replies")).length;
    await clearBackoff(unknown.id);
    worker.wake();
    const finished = await vi.waitFor(async () => {
      const row = await database
        .selectFrom("channelDeliveries")
        .select(["receipt", "status"])
        .where("id", "=", unknown.id)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe("sent");
      return row;
    }, 20_000);
    // It finished by looking the delivery id up in the thread, not by posting
    // the same message to the channel a second time.
    expect(
      slack.calls.filter((url) => url.includes("conversations.replies")).length,
    ).toBeGreaterThan(repliesCalls);
    expect(slack.postAttempts.filter((id) => id === unknown.id)).toHaveLength(1);
    expect(JSON.stringify(finished.receipt)).toContain(roomChannelId);

    // 3. A Run that fails says so where the person is, with a link to the
    //    Thread — and that notice is the one whose answer is lost, so the
    //    conversation-level reconcile path (`conversations.history`, because a
    //    DM carries no thread) is exercised too.
    slack.socket().deliver(
      messageEnvelope({
        channel: dmChannelId,
        channelType: "im",
        envelopeId: "env-dm-5",
        eventId: "Ev-DM-5",
        text: "Check the deploy again",
        ts: slackTs(20),
      }),
    );
    const failingRun = await adoptedRun("Ev-DM-5");
    const failingBinding = await beginRun(failingRun);
    slack.failNextPostMessage("lost");
    await emit(failingBinding, failingRun, 1, "run.failed", {
      code: "harness_unavailable",
      message: "The AI engine stopped responding",
      retryable: false,
      status: "failed",
    });
    const notice = await vi.waitFor(() => {
      const stored = slack
        .stored(dmChannelId)
        .find(({ text }) => text.includes("Something went wrong"));
      if (!stored) throw new Error("The failed Run said nothing in the direct message");
      return stored;
    }, 20_000);
    expect(notice.text).toContain("The AI engine stopped responding");
    expect(notice.text).toContain(threadUrl(failingRun.threadId));
    expect(notice.threadTs).toBeNull();
    const noticeDeliveryId = notice.deliveryId ?? "";
    const historyCalls = slack.calls.filter((url) => url.includes("conversations.history")).length;
    await vi.waitFor(async () => {
      const row = await database
        .selectFrom("channelDeliveries")
        .select("status")
        .where("id", "=", noticeDeliveryId as ChannelDeliveryId)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ status: "unknown" });
    }, 20_000);
    await clearBackoff(noticeDeliveryId as ChannelDeliveryId);
    worker.wake();
    await vi.waitFor(async () => {
      const row = await database
        .selectFrom("channelDeliveries")
        .select("status")
        .where("id", "=", noticeDeliveryId as ChannelDeliveryId)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ status: "sent" });
    }, 20_000);
    expect(
      slack.calls.filter((url) => url.includes("conversations.history")).length,
    ).toBeGreaterThan(historyCalls);
    expect(slack.postAttempts.filter((id) => id === noticeDeliveryId)).toHaveLength(1);
  }, 120_000);

  it("survives envelopes it cannot read and a Host that refuses one commit", async () => {
    const socket = slack.socket();
    const acknowledged = socket.sent.length;
    socket.deliver({ envelope_id: "env-junk-1", payload: { nonsense: true }, type: "events_api" });
    socket.deliver({ envelope_id: "env-junk-2", payload: {}, type: "app_rate_limited" });
    await vi.waitFor(() => expect(socket.sent).toHaveLength(acknowledged + 2), 10_000);
    expect(socket.sent.slice(acknowledged)).toEqual([
      '{"envelope_id":"env-junk-1"}',
      '{"envelope_id":"env-junk-2"}',
    ]);
    // A frame that is not even JSON carries no envelope id to acknowledge, so
    // it is dropped in silence; the socket stays open either way.
    socket.deliverRaw("not json at all");
    expect(socket.readyState).toBe(1);

    // A commit the Host refuses leaves the envelope unacknowledged, so Slack
    // redelivers it; the socket is not dropped with it.
    wire.failNext("ingress.commit");
    socket.deliver(
      messageEnvelope({
        channel: dmChannelId,
        channelType: "im",
        envelopeId: "env-dm-4",
        eventId: "Ev-DM-4",
        text: "Retry me",
        ts: slackTs(20),
      }),
    );
    await vi.waitFor(() => expect(wire.failures("ingress.commit")).toBe(1), 10_000);
    expect(socket.sent).toHaveLength(acknowledged + 2);
    expect(socket.readyState).toBe(1);
    await expect(
      database
        .selectFrom("channelIngressEvents")
        .select("id")
        .where("providerEventId", "=", "Ev-DM-4")
        .executeTakeFirst(),
    ).resolves.toBeUndefined();

    // The redelivery, same envelope and same event id, commits exactly once.
    socket.deliver(
      messageEnvelope({
        channel: dmChannelId,
        channelType: "im",
        envelopeId: "env-dm-4",
        eventId: "Ev-DM-4",
        text: "Retry me",
        ts: slackTs(20),
      }),
    );
    await vi.waitFor(() => expect(socket.sent).toHaveLength(acknowledged + 3), 10_000);
    socket.deliver(
      messageEnvelope({
        channel: dmChannelId,
        channelType: "im",
        envelopeId: "env-dm-4",
        eventId: "Ev-DM-4",
        text: "Retry me",
        ts: slackTs(20),
      }),
    );
    await vi.waitFor(() => expect(socket.sent).toHaveLength(acknowledged + 4), 10_000);
    expect(wire.commits("Ev-DM-4")).toEqual([false, true]);
    await expect(
      database
        .selectFrom("channelIngressEvents")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("providerEventId", "=", "Ev-DM-4")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: "1" });
  }, 60_000);

  // Last: it pauses the Slack connection the earlier journeys share.
  it("leaves out of a reply's first turn an owner's message whose messaging access ended", async () => {
    const pausedDm = "D-E2E-PAUSE";
    slack.socket().deliver(
      messageEnvelope({
        channel: pausedDm,
        channelType: "im",
        envelopeId: "env-pause-1",
        eventId: "Ev-PAUSE-1",
        text: "Look into the outage",
        ts: slackTs(40),
      }),
    );
    const first = await adoptedRun("Ev-PAUSE-1");
    const binding = await beginRun(first);
    await emit(binding, first, 1, "assistant.message", {
      content: [{ text: "Started a task for it.", type: "text" }],
      messageId: createId("message"),
    });
    await emit(binding, first, 2, "run.completed", { status: "completed" });
    // The task's result comes back to this conversation and starts its next reply.
    const result = await store.enqueueThreadInput({
      content: [{ text: "Task result: the outage was DNS", type: "text" }],
      idempotencyKey: "pause-task-result",
      policy: "queue",
      requestedBy: ownerUserId,
      source: {
        cause: "request-resolved",
        kind: "platform",
        referenceId: "req_pause_task",
        sourceRunId: first.id,
      },
      threadId: first.threadId,
    });
    expect(result).toMatchObject({ disposition: "run-queued" });
    if (!result.command || !result.run) throw new Error("The task result did not start a reply");
    // Before that reply is sent to a Runner, the owner writes again.
    slack.socket().deliver(
      messageEnvelope({
        channel: pausedDm,
        channelType: "im",
        envelopeId: "env-pause-2",
        eventId: "Ev-PAUSE-2",
        text: "Also check the CDN",
        ts: slackTs(41),
      }),
    );
    const waiting = await vi.waitFor(async () => {
      const row = await database
        .selectFrom("channelIngressEvents")
        .select(["messageId", "status"])
        .where("providerEventId", "=", "Ev-PAUSE-2")
        .executeTakeFirstOrThrow();
      expect(row.status).toBe("adopted");
      if (!row.messageId) throw new Error("The message named no input");
      return row.messageId;
    }, 20_000);
    const inputOf = () =>
      database
        .selectFrom("threadInputs")
        .select(["cancelReason", "runId", "state"])
        .where("messageId", "=", waiting)
        .executeTakeFirstOrThrow();
    await expect(inputOf()).resolves.toMatchObject({ state: "pending" });
    // The owner pauses messaging; nothing cancels the waiting message yet.
    await channels.setConnectionStatus(connectionId, ownerUserId, "paused");
    await expect(inputOf()).resolves.toMatchObject({ state: "pending" });
    // Dispatching the reply re-checks each message it would take along.
    const claimed = await store.claimCommand(result.command.id, "e2e-command-worker");
    expect(claimed?.terminalFailure).toBeUndefined();
    await expect(inputOf()).resolves.toEqual({
      cancelReason: "channel-authority-unavailable",
      runId: null,
      state: "cancelled",
    });
    const context = await store.loadRunDispatchContext(result.command.id);
    expect(context.inputs.map(({ id }) => id)).toEqual([result.message.id]);
  }, 90_000);

  /** The Run a queued input started once the Run ahead of it ended. */
  async function seededRun(messageId: MessageId): Promise<AdoptedRun> {
    const run = await vi.waitFor(
      () =>
        database
          .selectFrom("runs")
          .innerJoin("threads", "threads.id", "runs.threadId")
          .select(["runs.id", "runs.threadId"])
          .where("runs.seedInputId", "=", messageId)
          .executeTakeFirstOrThrow(),
      20_000,
    );
    return { bindingGeneration: 0, id: run.id, threadId: run.threadId, workspaceId: workspaceId };
  }

  async function adoptedRun(providerEventId: string): Promise<AdoptedRun> {
    const runId = await vi.waitFor(async () => {
      const row = await database
        .selectFrom("channelIngressEvents")
        .select(["runId", "status"])
        .where("providerEventId", "=", providerEventId)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe("adopted");
      if (!row.runId) throw new Error("The adopted ingress named no Run");
      return row.runId;
    }, 20_000);
    const run = await database
      .selectFrom("runs")
      .innerJoin("threads", "threads.id", "runs.threadId")
      .select(["runs.id", "runs.threadId", "threads.workspaceId"])
      .where("runs.id", "=", runId)
      .executeTakeFirstOrThrow();
    return { bindingGeneration: 0, id: run.id, threadId: run.threadId, workspaceId: workspaceId };
  }

  async function beginRun(run: AdoptedRun) {
    const command = await vi.waitFor(async () => {
      const next = await store.claimNextCommand(environmentId, "e2e-command-worker");
      if (next?.command.runId !== run.id) throw new Error("The Run's command is not ready");
      return next;
    }, 20_000);
    expect(command.command.runId).toBe(run.id);
    const harnesses = await store.listHarnessInstances();
    const harness = harnesses.find((candidate) => candidate.enabled);
    if (!harness) throw new Error("No AI engine is available");
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 300_000),
      continuationIdentity: {
        continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
        driverKind: HarnessIdSchema.parse("native"),
      },
      harnessInstanceId: harness.id,
      leaseTokenHash: `e2e-run-lease-${run.id}`,
      membershipGeneration: 1,
      runnerBootId: "e2e-run-boot",
      runnerId: agentsRunnerId,
      runId: run.id,
      threadId: run.threadId,
    });
    run.bindingGeneration = binding.bindingGeneration;
    await emit(binding, run, 0, "run.started", { status: "running" });
    // As an engine does once it holds a native session, so the conversation's
    // next Run can continue it.
    const { providerSessionId } = await database
      .selectFrom("runs")
      .select("providerSessionId")
      .where("id", "=", run.id)
      .executeTakeFirstOrThrow();
    if (!providerSessionId) throw new Error("The Run has no provider session");
    await store.bindProviderSession({
      bindingGeneration: binding.bindingGeneration,
      harnessInstanceId: harness.id,
      providerSessionId,
      providerSessionReference: `native-session-${run.threadId}`,
      runId: run.id,
      runnerBootId: "e2e-run-boot",
      runnerId: agentsRunnerId,
      threadId: run.threadId,
    });
    return binding;
  }

  async function emit(
    binding: { readonly bindingGeneration: number },
    run: AdoptedRun,
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
      runnerBootId: "e2e-run-boot",
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
    const tokenHash = `sha256:e2e-messaging-${messagingRunnerId}`;
    await store.createRunnerEnrollment({
      allowedModules: ["messaging"],
      createdBy: null,
      expiresAt: new Date(Date.now() + 600_000),
      id: `ren_${randomUUID()}`,
      idempotencyKey: `e2e-messaging-${messagingRunnerId}`,
      name: "End to end messaging service",
      requestFingerprint: `sha256:e2e-messaging-${messagingRunnerId}`,
      runnerKind: "managed",
      tokenHash,
    });
    await store.enrollRunnerConnection({
      descriptor: {
        bootId: `rbt_${randomUUID()}` as RunnerDescriptor["bootId"],
        capabilities: [],
        modules: { messaging: { capabilities: [slackCapability] } },
        name: "End to end messaging service",
        runnerId: messagingRunnerId,
        runnerKind: "managed",
        runtimeVersion: "test",
      },
      enrollmentTokenHash: tokenHash,
      publicKeyFingerprint: "sha256:e2e-messaging-key",
      publicKeyPem: "-----BEGIN PUBLIC KEY-----\ne2e\n-----END PUBLIC KEY-----\n",
    });
  }

  async function enrollAgentsRunner(): Promise<void> {
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
      .update("e2e-agents-runner", "utf8")
      .digest("base64url")}`;
    await store.createRunnerEnrollment({
      allowedModules: ["agents"],
      createdBy: ownerUserId,
      expiresAt: new Date(Date.now() + 600_000),
      id: `ren_${randomUUID()}`,
      idempotencyKey: "e2e-agents-runner",
      mainEnrollmentPurpose: "initial",
      name: "End to end main runner",
      requestFingerprint: "sha256:e2e-agents-runner",
      runnerKind: "main",
      tokenHash: enrollmentTokenHash,
    });
    await store.enrollRunnerConnection({
      descriptor: {
        bootId: `rbt_${randomUUID()}` as RunnerDescriptor["bootId"],
        capabilities: ["filesystem", "steer-answer-v1"],
        modules: {
          agents: {
            environmentIds: [environmentId],
            harnessDrivers: [
              {
                accessModes: [...ThreadAccessModeSchema.options],
                driverKind: HarnessIdSchema.parse("native"),
                readiness: "configured",
                steering: true,
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
        name: "End to end main runner",
        runnerId: agentsRunnerId,
        runnerKind: "main",
        runtimeVersion: "test",
      },
      enrollmentTokenHash,
      publicKeyFingerprint: `sha256:${createHash("sha256").update(publicKeyDer).digest("base64url")}`,
      publicKeyPem,
    });
  }
});

interface AdoptedRun {
  bindingGeneration: number;
  readonly id: RunId;
  readonly threadId: ThreadId;
  readonly workspaceId: WorkspaceId;
}

const slackCapability = {
  manifest: slackChannelProviderManifest,
  provider: "slack",
  transportKinds: ["socket" as const],
};

/**
 * The messaging module stream, dispatched exactly the way `server.ts` does it:
 * `runtime.response` resolves a hub request, everything else is answered by
 * `ChannelService.handleRuntimeRequest` as a `host.response`. The hooks exist so
 * a test can hold or refuse one operation without touching either real half.
 */
class MessagingWire {
  /** What the messaging service asked the Host, in arrival order. */
  readonly hostRequests: { readonly operation: string; readonly ok: boolean }[] = [];
  /** What the Host asked the messaging service, in arrival order. */
  readonly relayRequests: string[] = [];
  readonly peer: MessagingRelayPeer;
  readonly moduleStream: {
    readonly browserAttachPublicKeys: undefined;
    readonly fence: RunnerAuxiliaryStream["fence"];
    send(frame: Buffer | string, binary: boolean): Promise<void>;
  };
  readonly auxiliaryStream: RunnerAuxiliaryStream;
  held = false;
  readonly #commits = new Map<string, boolean[]>();
  readonly #failures = new Map<string, number>();
  readonly #observedFailures = new Map<string, number>();
  readonly #stop = new AbortController();
  #release: (() => void) | null = null;
  #hold: Promise<void> | null = null;
  #holdOperation: string | null = null;

  constructor(options: {
    readonly hub: MessagingRelayHub;
    readonly router: MessagingFrameRouter;
    readonly service: ChannelService;
  }) {
    this.auxiliaryStream = auxiliaryStream();
    const fence = this.auxiliaryStream.fence;
    this.peer = {
      close: () => undefined,
      id: "messaging-e2e-peer",
      send: async (message: HostToMessagingRelayMessage) => {
        if ("operation" in message) this.relayRequests.push(message.operation);
        const frame = Buffer.from(
          JSON.stringify(HostToMessagingRelayMessageSchema.parse(message)),
          "utf8",
        );
        queueMicrotask(() => {
          void options.router.handleFrame(frame, false, this.#stop.signal).catch(() => undefined);
        });
      },
    };
    this.moduleStream = {
      browserAttachPublicKeys: undefined,
      fence,
      send: async (frame: Buffer | string) => {
        const message = MessagingRelayToHostMessageSchema.parse(
          JSON.parse(typeof frame === "string" ? frame : frame.toString("utf8")),
        );
        queueMicrotask(() => {
          void (async () => {
            if (message.type === "runtime.response") {
              options.hub.handleResponse(messagingRunnerId, message);
              return;
            }
            await this.#answer(options.service, RuntimeChannelRequestSchema.parse(message));
          })().catch(() => undefined);
        });
      },
    };
  }

  holdNext(operation: string): void {
    this.#holdOperation = operation;
    this.#hold = new Promise<void>((resolve) => {
      this.#release = resolve;
    });
  }

  release(): void {
    this.#release?.();
    this.#release = null;
    this.#hold = null;
    this.#holdOperation = null;
    this.held = false;
  }

  failNext(operation: string): void {
    this.#failures.set(operation, (this.#failures.get(operation) ?? 0) + 1);
  }

  failures(operation: string): number {
    return this.#observedFailures.get(operation) ?? 0;
  }

  commits(providerEventId: string): readonly boolean[] {
    return this.#commits.get(providerEventId) ?? [];
  }

  close(): void {
    this.#stop.abort();
  }

  async #answer(service: ChannelService, request: RuntimeChannelRequest): Promise<void> {
    try {
      if (this.#holdOperation === request.operation && this.#hold) {
        this.held = true;
        await this.#hold;
      }
      const pending = this.#failures.get(request.operation) ?? 0;
      if (pending > 0) {
        this.#failures.set(request.operation, pending - 1);
        this.#observedFailures.set(
          request.operation,
          (this.#observedFailures.get(request.operation) ?? 0) + 1,
        );
        throw new OpensteerError({ code: "internal", message: "The Host refused this request" });
      }
      const result = await service.handleRuntimeRequest(messagingRunnerId, request);
      this.hostRequests.push({ ok: true, operation: request.operation });
      if (request.operation === "ingress.commit") {
        const eventId = String((request.payload.event as { eventId?: unknown }).eventId);
        const duplicate = (result as { duplicate: boolean }).duplicate;
        this.#commits.set(eventId, [...(this.#commits.get(eventId) ?? []), duplicate]);
      }
      await this.peer.send({
        ...this.auxiliaryStream.fence,
        ok: true,
        requestId: request.requestId,
        result,
        type: "host.response",
      } as HostToMessagingRelayMessage);
    } catch (error) {
      this.hostRequests.push({ ok: false, operation: request.operation });
      const opensteer = error instanceof OpensteerError ? error : null;
      await this.peer.send({
        ...this.auxiliaryStream.fence,
        error: {
          code: opensteer?.code ?? "internal",
          message: error instanceof Error ? error.message.slice(0, 500) : "Host request failed",
          retryable: opensteer?.retryable ?? false,
        },
        ok: false,
        requestId: request.requestId,
        type: "host.response",
      } as HostToMessagingRelayMessage);
    }
  }
}

interface StoredSlackMessage {
  readonly botId: string;
  readonly channel: string;
  readonly deliveryId: string | null;
  readonly text: string;
  readonly threadTs: string | null;
  readonly ts: string;
}

interface PostedSlackMessage {
  readonly channel: string;
  readonly deliveryId: string | null;
  readonly text: string;
  readonly threadTs: string | null;
  readonly ts: string;
  readonly unfurlLinks: unknown;
}

/**
 * Slack, as far as this adapter can tell: the six Web API methods it calls and
 * one Socket Mode socket envelopes are pushed into.
 */
class FakeSlack {
  readonly calls: string[] = [];
  readonly ephemeral: { readonly channel: string; readonly text: string; readonly user: string }[] =
    [];
  readonly posted: PostedSlackMessage[] = [];
  /** Every `chat.postMessage` call, including the ones that failed. */
  readonly postAttempts: (string | null)[] = [];
  readonly sockets: FakeSlackSocket[] = [];
  readonly #stored: StoredSlackMessage[] = [];
  #fault: "none" | "rate-limited" | "lost" = "none";
  #ts = 1_786_500_000;

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    this.calls.push(url);
    if (url.includes("bots.info")) return Response.json({ ok: true, bot: { app_id: "A1" } });
    if (url.includes("auth.test")) return this.#authTest();
    if (url.includes("apps.connections.open"))
      return json({ ok: true, url: "wss://fake.invalid/1" });
    if (url.includes("users.info")) {
      return json({
        ok: true,
        user: { id: humanUserId, profile: { display_name: "Ada Lovelace" } },
      });
    }
    if (url.includes("chat.postMessage")) return this.#postMessage(init);
    if (url.includes("chat.postEphemeral")) return this.#postEphemeral(init);
    if (url.includes("conversations.replies") || url.includes("conversations.history")) {
      return this.#history(new URL(url));
    }
    return json({ error: "unknown_method", ok: false });
  };

  readonly webSocket: SlackWebSocketFactory = () => {
    const socket = new FakeSlackSocket();
    this.sockets.push(socket);
    return socket;
  };

  /** What Slack actually holds, including messages whose answer was lost. */
  stored(channel: string): readonly StoredSlackMessage[] {
    return this.#stored.filter((message) => message.channel === channel);
  }

  socket(): FakeSlackSocket {
    const socket = this.sockets[0];
    if (!socket) throw new Error("The Slack adapter has not opened a socket");
    return socket;
  }

  failNextPostMessage(fault: "rate-limited" | "lost"): void {
    this.#fault = fault;
  }

  #authTest(): Response {
    return json(
      {
        bot_id: "B1",
        ok: true,
        team: "Acme",
        team_id: teamId,
        user: "opensteer",
        user_id: botUserId,
      },
      {
        "x-oauth-scopes":
          "channels:history,chat:write,groups:history,im:history,mpim:history,users:read",
      },
    );
  }

  #postMessage(init: RequestInit | undefined): Response {
    const body = parseBody(init);
    const metadata = body.metadata as
      { readonly event_payload?: { readonly delivery_id?: string } } | undefined;
    const deliveryId = metadata?.event_payload?.delivery_id ?? null;
    this.postAttempts.push(deliveryId);
    const channel = String(body.channel);
    const fault = this.#fault;
    this.#fault = "none";
    if (fault === "rate-limited") {
      return json({ error: "ratelimited", ok: false }, { "retry-after": "2" }, 429);
    }
    this.#ts += 1;
    const ts = `${this.#ts}.000100`;
    const threadTs = typeof body.thread_ts === "string" ? body.thread_ts : null;
    const text = String(body.text);
    this.#stored.push({ botId: "B1", channel, deliveryId, text, threadTs, ts });
    if (fault === "lost") {
      // Slack accepted the message and this process never heard the answer:
      // `callSlackApi` treats a thrown fetch exactly as it treats the abort of
      // its fifteen-second timeout, so the delivery ends `unknown` either way.
      throw new Error("The connection closed before Slack answered chat.postMessage");
    }
    this.posted.push({
      channel,
      deliveryId,
      text,
      threadTs,
      ts,
      unfurlLinks: body.unfurl_links,
    });
    return json({ channel, ok: true, ts });
  }

  #postEphemeral(init: RequestInit | undefined): Response {
    const body = parseBody(init);
    this.#ts += 1;
    this.ephemeral.push({
      channel: String(body.channel),
      text: String(body.text),
      user: String(body.user),
    });
    return json({ message_ts: `${this.#ts}.000100`, ok: true });
  }

  #history(url: URL): Response {
    const channel = url.searchParams.get("channel");
    const thread = url.searchParams.get("ts");
    const messages = this.#stored
      .filter((message) => message.channel === channel)
      .filter((message) => (thread ? message.threadTs === thread : message.threadTs === null))
      .map((message) => ({
        bot_id: message.botId,
        ...(message.deliveryId
          ? {
              metadata: {
                event_payload: { delivery_id: message.deliveryId },
                event_type: slackDeliveryMetadataEventType,
              },
            }
          : {}),
        text: message.text,
        ts: message.ts,
      }));
    return json({ messages, ok: true });
  }
}

class FakeSlackSocket implements SlackWebSocket {
  readonly sent: string[] = [];
  readyState = 1;
  #closed = false;
  readonly #messageListeners: ((data: WebSocketFrame, isBinary: boolean) => void)[] = [];
  readonly #once = new Map<string, (argument?: unknown) => void>();
  #tail = Promise.resolve();

  on(event: "message", listener: (data: WebSocketFrame, isBinary: boolean) => void): unknown {
    if (event === "message") this.#messageListeners.push(listener);
    return this;
  }

  once(event: "open" | "close" | "error", listener: (error: Error) => void): unknown {
    this.#once.set(event, listener as (argument?: unknown) => void);
    return this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.readyState = 3;
    this.#tail = this.#tail.then(() => this.#once.get("close")?.());
  }

  deliver(envelope: Readonly<Record<string, unknown>>): void {
    this.deliverRaw(JSON.stringify(envelope));
  }

  deliverRaw(frame: string): void {
    for (const listener of this.#messageListeners) listener(Buffer.from(frame, "utf8"), false);
  }

  get attached(): boolean {
    return this.#messageListeners.length > 0;
  }
}

function messageEnvelope(input: {
  readonly channel: string;
  readonly channelType: "channel" | "im" | "mpim";
  readonly envelopeId: string;
  readonly eventId: string;
  readonly text: string;
  readonly threadTs?: string;
  readonly ts: string;
  readonly user?: string;
}): Readonly<Record<string, unknown>> {
  return {
    accepts_response_payload: false,
    envelope_id: input.envelopeId,
    payload: {
      event: {
        channel: input.channel,
        channel_type: input.channelType,
        text: input.text,
        ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
        ts: input.ts,
        type: "message",
        user: input.user ?? humanUserId,
      },
      event_id: input.eventId,
      event_time: Math.floor(Number(input.ts)),
      team_id: teamId,
      type: "event_callback",
    },
    type: "events_api",
  };
}

function parseBody(init: RequestInit | undefined): Readonly<Record<string, unknown>> {
  const body = init?.body;
  if (typeof body !== "string") return {};
  const parsed: unknown = JSON.parse(body);
  return typeof parsed === "object" && parsed !== null
    ? (parsed as Readonly<Record<string, unknown>>)
    : {};
}

function json(
  payload: unknown,
  headers: Readonly<Record<string, string>> = {},
  status = 200,
): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });
}

function pendingEvent<T extends PendingAgentEvent>(input: Record<string, unknown>): T {
  return { ...input, emittedAt: new Date().toISOString() } as T;
}

function auxiliaryStream(): RunnerAuxiliaryStream {
  const bootId = RunnerBootIdSchema.parse("rbt_00000000-0000-4000-8000-0000000000b1");
  const connectionId = RunnerConnectionIdSchema.parse("rcn_00000000-0000-4000-8000-0000000000b1");
  const connectionLeaseId = RunnerConnectionLeaseIdSchema.parse(
    "rls_00000000-0000-4000-8000-0000000000b1",
  );
  const fence = RunnerAuxiliaryFrameFenceSchema.parse({
    auxiliaryStreamId: "rax_00000000-0000-4000-8000-0000000000b1",
    bootId,
    connectionGeneration: 1,
    connectionId,
    connectionLeaseId,
    module: "messaging",
    runnerId: messagingRunnerId,
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
      name: "End to end messaging service",
      runnerId: messagingRunnerId,
      runnerKind: "managed",
      runtimeVersion: "test",
    },
    streamLeaseExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
}
