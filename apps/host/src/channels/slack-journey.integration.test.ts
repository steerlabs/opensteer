/**
 * Slack on bridges, end to end with every real part except Slack itself.
 *
 * The Host half is real: a PostgreSQL-backed `OpensteerStore`, `ChannelStore`, a real
 * `CredentialService`, a real `MessagingRelayHub`, a real `ChannelService`, and the task tools'
 * own entry points (`OpensteerMcpService`) that a bridge calls as itself. The messaging service
 * half is real too: the `MessagingFrameRouter`, `ChannelConnectionSupervisor`,
 * `ChannelDeliveryWorker`, `ChannelAdapterRegistry` and the Slack adapter. Only two things are
 * fakes: Slack (a `fetch` answering the Web API methods the adapter calls, and a Socket Mode
 * socket envelopes are pushed into) and the WebSocket under the module stream, replaced by an
 * in-memory wire that dispatches frames the way `apps/host/src/server.ts` does. Runs are played
 * the way a Runner reports them.
 *
 * Five parts, in order:
 *  1. "Me" is linked by a code sent from the person's own Slack account; their direct messages
 *     start a task, a long reply arrives as ordered parts, a follow-up goes to the same task, and
 *     "stop" stops its Run.
 *  2. A channel bridge for "only me" answers the person's mention in its thread, takes the
 *     thread's follow-ups, and ignores everyone else and the channel's chatter.
 *  3. A channel bridge for anyone there runs without the person's personal context, holds only
 *     its plugin, and a task made under its task inherits that.
 *  4. Delivery failures: a rate limit is retried after the delay Slack names; a timeout and a
 *     5xx are unknown and never posted again; Disconnect cancels the parts not sent and leaves
 *     the one in flight uncertain.
 *  5. A Request raised in a chat task posts only "This task needs you: <link>", and a "yes" in
 *     the chat is ordinary input, never an answer to it.
 */
import { randomBytes } from "node:crypto";
import { createId, RunnerIdSchema, type AgentGrant, type ThreadId } from "@opensteer/core";
import {
  slackChannelProviderManifest,
  type IntegrationConnectionId,
} from "@opensteer/channel-core";
import {
  HostToMessagingRelayMessageSchema,
  MessagingRelayToHostMessageSchema,
  RuntimeChannelRequestSchema,
  type HostToMessagingRelayMessage,
  type RuntimeChannelRequest,
} from "@opensteer/channel-protocol";
import {
  createSlackAdapter,
  type SlackWebSocket,
  type SlackWebSocketFactory,
} from "@opensteer/channel-slack";
import {
  admitExecution,
  AgentConnectionStore,
  authorizeTarget,
  ChannelStore,
  lineagePersonalContext,
  OpensteerStore,
  startBridgeOwnerLink,
} from "@opensteer/database";
import {
  createStoreFixture,
  pendingEvent,
  testContinuationIdentity,
  testModelSelection,
} from "@opensteer/database/test-support/store";
import {
  ChannelAdapterRegistry,
  ChannelConnectionSupervisor,
  ChannelDeliveryWorker,
  MessagingFrameRouter,
  RoutedChannelHostClient,
} from "@opensteer/messaging-module";
import type { RunnerAuxiliaryStream } from "@opensteer/orchestration";
import {
  RunnerAuxiliaryFrameFenceSchema,
  RunnerBootIdSchema,
  RunnerConnectionIdSchema,
  RunnerConnectionLeaseIdSchema,
} from "@opensteer/protocol";
import { OpensteerError } from "@opensteer/core";
import type { WebSocketFrame } from "@opensteer/shared/webSocketFrame";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CredentialService } from "../identity/credential-service.js";
import { lastService, serveMcp } from "../mcp/connection-caller.test-support.js";
import { ChannelService } from "./channel-service.js";
import { MessagingRelayHub, type MessagingRelayPeer } from "./messaging-relay-hub.js";

const messagingRunnerId = RunnerIdSchema.parse("rnr_00000000-0000-4000-8000-0000000000b1");
const slackEpoch = Math.floor(Date.now() / 1_000);
/** A Slack timestamp this many seconds into the test: a message sent now, never too old. */
const slackTs = (second: number) => `${slackEpoch + second}.000100`;
const botUserId = "U0BOT";
const humanUserId = "U-HUMAN";
const otherUserId = "U-OTHER";
const teamId = "T-JOURNEY";
const dmChannelId = "D-JOURNEY";
const roomChannelId = "C-ROOM";
const teamChannelId = "C-TEAM";
const tasksOnly: AgentGrant = { scope: "selected", tasks: true, resources: [] };
const teamPlugin = {
  kind: "plugin",
  target: { kind: "installed", pluginId: "plugin_team_notes" },
  access: "read-write",
} as const;

type Store = Awaited<ReturnType<typeof createStoreFixture>>;

describe("Slack on bridges, end to end", () => {
  const slack = new FakeSlack();
  let storeFixture: Store;
  /** The Home's store as a Home makes it: with its own origin, so links in chats are whole. */
  let store: OpensteerStore;
  let personal: Awaited<ReturnType<Store["createRunFixture"]>>;
  let service: ChannelService;
  let hub: MessagingRelayHub;
  let wire: MessagingWire;
  let supervisor: ChannelConnectionSupervisor;
  let worker: ChannelDeliveryWorker;
  let connections: AgentConnectionStore;
  let connectionId: IntegrationConnectionId;
  let accountId: string;
  let dmBridge: Awaited<ReturnType<AgentConnectionStore["createBridge"]>>;
  let roomBridge: Awaited<ReturnType<AgentConnectionStore["createBridge"]>>;
  let dmTask: ThreadId;
  const errors: unknown[] = [];

  beforeAll(async () => {
    storeFixture = await createStoreFixture();
    store = new OpensteerStore(storeFixture.database, {
      links: { threadUrl: (threadId) => `https://journey.invalid/tasks/${threadId}` },
    });
    personal = await storeFixture.createRunFixture("slack-journey");
    await storeFixture.enrollMessagingRunner(messagingRunnerId, "Journey messaging service");
    await serveMcp(storeFixture);
    connections = new AgentConnectionStore(storeFixture.database);
    const credentials = new CredentialService({ key: randomBytes(32), store });
    await credentials.initialize();
    hub = new MessagingRelayHub();
    service = new ChannelService({
      channels: new ChannelStore(storeFixture.database),
      credentials,
      relay: hub,
      store,
      bridgeTools: () => lastService!,
      onError: (error) => errors.push(error),
    });
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

    const created = await service.createConnection({
      credentials: { appToken: "xapp-journey-token", botToken: "xoxb-journey-token" },
      createdBy: personal.userId,
      provider: "slack",
      routingMode: "dedicated",
    });
    connectionId = created.connection.id;
    accountId = created.account.id;
    const socket = await vi.waitFor(() => {
      const first = slack.sockets[0];
      if (!first?.attached) throw new Error("The Slack adapter never opened a socket");
      return first;
    }, 20_000);
    socket.deliver({ connection_info: { app_id: "A1" }, num_connections: 1, type: "hello" });
    await vi.waitFor(async () => {
      expect(
        await storeFixture.database
          .selectFrom("integrationConnections")
          .select("status")
          .where("id", "=", connectionId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: "connected" });
    }, 20_000);
  }, 120_000);

  afterAll(async () => {
    await worker?.close();
    await supervisor?.close();
    await service?.close();
    hub?.close();
    wire?.close();
    await storeFixture?.close();
    expect(errors).toEqual([]);
  }, 60_000);

  it('1. links "me" by code, answers direct messages in ordered parts, follows up, and stops', async () => {
    // The person asks for a code and sends it from their own Slack account. Nothing is said.
    const { code } = await startBridgeOwnerLink(storeFixture.database, {
      userId: personal.userId,
      accountId: accountId as never,
    });
    slack.socket().deliver(dm("link", code, 1));
    await vi.waitFor(async () => {
      expect(
        await storeFixture.database
          .selectFrom("channelIdentities")
          .select(["externalUserId", "linkedUserId"])
          .where("accountId", "=", accountId as never)
          .where("status", "=", "linked")
          .execute(),
      ).toEqual([{ externalUserId: humanUserId, linkedUserId: personal.userId }]);
    }, 20_000);
    expect(slack.posted).toEqual([]);

    dmBridge = await connections.createBridge({
      userId: personal.userId,
      accountId: accountId as never,
      senders: "owner",
      accessMode: "approval-required",
      grant: tasksOnly,
    });
    slack.socket().deliver(dm("ask", "Summarize the deploy", 2));
    const first = await nextRun(dmBridge.id);
    dmTask = first.threadId;
    const emit = await beginRun(first);
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
    const replyId = createId("message");
    await emit("assistant.message", {
      content: [
        { text: longReply, type: "text" },
        { artifactId: "art_1", mediaType: "text/csv", name: "findings.csv", type: "artifact" },
      ],
      messageId: replyId,
    });
    await emit("run.completed", { status: "completed" });
    const parts = await sentParts(replyId);
    expect(parts.length).toBeGreaterThan(2);
    // In order, one Slack message per part, at the top of the direct message, never unfurled.
    expect(parts.every(({ channel, threadTs }) => channel === dmChannelId && !threadTs)).toBe(true);
    expect(parts.every(({ unfurlLinks }) => unfurlLinks === false)).toBe(true);
    const joined = parts.map(({ text }) => text).join("\n");
    expect(joined).toContain("*Findings*");
    expect(joined).toContain("A *bold* claim and a <https://example.com/docs|link>.");
    expect(joined).toContain('const keep = "**keep**";');
    expect(parts.at(-1)?.text).toContain(
      `findings.csv — <https://journey.invalid/tasks/${dmTask}|Open in Opensteer>`,
    );

    // The next message is a follow-up in the same task, answered the same way.
    slack.socket().deliver(dm("follow-up", "And the tests?", 3));
    const second = await nextRun(dmBridge.id);
    expect(second.threadId).toBe(dmTask);
    const emitSecond = await beginRun(second);
    const secondReply = createId("message");
    await emitSecond("assistant.message", {
      content: [{ text: "All 212 tests passed.", type: "text" }],
      messageId: secondReply,
    });
    await emitSecond("run.completed", { status: "completed" });
    expect((await sentParts(secondReply)).map(({ text }) => text)).toEqual([
      "All 212 tests passed.",
    ]);

    // "stop" stops the Run under way, and the chat is told in one line.
    slack.socket().deliver(dm("watch", "Watch the deploy", 4));
    const third = await nextRun(dmBridge.id);
    const emitThird = await beginRun(third);
    slack.socket().deliver(dm("stop", "stop", 5));
    await vi.waitFor(async () => {
      expect(
        await storeFixture.database
          .selectFrom("commands")
          .select("type")
          .where("runId", "=", third.id as never)
          .where("type", "=", "run.interrupt")
          .execute(),
      ).toEqual([{ type: "run.interrupt" }]);
    }, 20_000);
    await emitThird("run.interrupted", { status: "interrupted" });
    const stopped = await vi.waitFor(() => {
      const posted = slack.posted.find(({ text }) => text.startsWith("The agent was stopped."));
      if (!posted) throw new Error("The chat was not told the Run stopped");
      return posted;
    }, 20_000);
    expect(stopped).toMatchObject({ channel: dmChannelId, threadTs: null });
    expect(stopped.text).toContain(dmTask);
  }, 180_000);

  it("2. answers only the person in a channel, in the mention's thread, and stays out of chatter", async () => {
    roomBridge = await connections.createBridge({
      userId: personal.userId,
      accountId: accountId as never,
      conversation: { id: roomChannelId, name: "#room" },
      senders: "owner",
      accessMode: "approval-required",
      grant: tasksOnly,
    });
    const socket = slack.socket();
    socket.deliver(room("mention", `<@${botUserId}> hello`, 10));
    const run = await nextRun(roomBridge.id);
    const emit = await beginRun(run);
    const replyId = createId("message");
    await emit("assistant.message", {
      content: [{ text: "Here is what I found.", type: "text" }],
      messageId: replyId,
    });
    await emit("run.completed", { status: "completed" });
    expect(await sentParts(replyId)).toEqual([
      expect.objectContaining({ channel: roomChannelId, threadTs: slackTs(10) }),
    ]);

    // Someone else mentions the bot: nothing starts and nothing is said.
    const posted = slack.posted.length;
    socket.deliver(room("other", `<@${botUserId}> can you help me too`, 11, { user: otherUserId }));
    await ingressSettled("other", "ignored");
    // Chatter nobody addressed to the bot is never even taken.
    const acknowledged = socket.sent.length;
    socket.deliver(room("chatter", "unrelated standup chatter", 12));
    await vi.waitFor(() => expect(socket.sent).toHaveLength(acknowledged + 1), 10_000);
    expect(await ingressStatus("chatter")).toBeUndefined();
    // The person's follow-up in the thread, without a mention, goes to the same task; another
    // person's in the same thread does not.
    socket.deliver(room("thread", "and the second half?", 13, { threadTs: slackTs(10) }));
    const next = await nextRun(roomBridge.id);
    expect(next.threadId).toBe(run.threadId);
    socket.deliver(
      room("thread-other", "me too", 14, { threadTs: slackTs(10), user: otherUserId }),
    );
    await ingressSettled("thread-other", "ignored");
    expect(slack.posted).toHaveLength(posted);
    expect(await bridgeTasks(roomBridge.id)).toHaveLength(1);
    await finish(next, "Second half done.");
  }, 120_000);

  it("3. runs work from anyone in a channel without personal context, with only its plugin", async () => {
    const teamBridge = await connections.createBridge({
      userId: personal.userId,
      accountId: accountId as never,
      conversation: { id: teamChannelId, name: "#team" },
      senders: "anyone",
      accessMode: "approval-required",
      grant: { scope: "selected", tasks: true, resources: [teamPlugin] },
    });
    slack.socket().deliver(
      messageEnvelope({
        channel: teamChannelId,
        channelType: "channel",
        envelopeId: "env-team",
        eventId: "Ev-TEAM",
        text: `<@${botUserId}> draft the notes`,
        ts: slackTs(20),
        user: otherUserId,
      }),
    );
    const run = await nextRun(teamBridge.id);
    expect(await lineagePersonalContext(storeFixture.database, teamBridge.id)).toBe(false);
    expect(await sessionsOf(run.threadId)).toEqual([{ personalContext: false }]);
    const admitted = await admitExecution(storeFixture.database, {
      ownerUserId: personal.userId,
      subject: { kind: "binding", bindingId: `run:${run.id}` },
    });
    expect(
      authorizeTarget(admitted, {
        kind: "plugin",
        target: { kind: "installed", pluginId: teamPlugin.target.pluginId },
      } as never),
    ).not.toBeNull();
    for (const target of [
      { kind: "plugin", target: { kind: "installed", pluginId: "plugin_other" } },
      { kind: "browser-profile", profileId: createId("browserProfile") },
      { kind: "chrome-tabs", sourceId: createId("browserSource") },
    ] as const)
      expect(authorizeTarget(admitted, target as never)).toBeNull();
    // A task made under it is in its lineage, and so has no personal context either.
    const { thread: sub } = await storeFixture.store.createThread({
      createdBy: personal.userId,
      environmentId: personal.environmentId,
      harnessInstanceId: personal.harnessInstance.id,
      idempotencyKey: "team-sub-task",
      modelSelection: testModelSelection,
      parentThreadId: run.threadId,
      title: "Under #team",
    });
    expect(await sessionsOf(sub.id)).toEqual([{ personalContext: false }]);
    expect(
      await storeFixture.database
        .selectFrom("threads")
        .select("originConnectionId")
        .where("id", "=", sub.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ originConnectionId: teamBridge.id });
  }, 120_000);

  it('5. raises a Request in Opensteer and posts only its link; a chat "yes" is input', async () => {
    slack.socket().deliver(dm("needs-you", "Read my email", 30));
    // After the chat's "stop" the task's queue is paused, as Stop pauses it anywhere: the message
    // is taken and waits, and only the person resumes it, in Opensteer. A chat only reduces.
    await ingressSettled("needs-you", "adopted");
    expect(
      await storeFixture.database
        .selectFrom("threads")
        .select("inputQueuePaused")
        .where("id", "=", dmTask)
        .executeTakeFirstOrThrow(),
    ).toEqual({ inputQueuePaused: true });
    expect(
      await storeFixture.database
        .selectFrom("runs")
        .select("id")
        .where("threadId", "=", dmTask)
        .where("status", "=", "queued")
        .execute(),
    ).toEqual([]);
    await store.resumeThreadInputQueue({
      idempotencyKey: "journey-resume",
      requestedBy: personal.userId,
      threadId: dmTask,
    });
    const run = await nextRun(dmBridge.id);
    expect(run.threadId).toBe(dmTask);
    await beginRun(run);
    const { request } = await store.requests.create({
      callId: "needs-profile",
      kind: "browser.access",
      mode: "durable",
      originatingRunId: run.id as never,
      originatingThreadId: run.threadId,
      requestedBy: personal.userId,
      requiredActor: "requester",
      payload: {
        kind: "browser.access",
        reason: "Read email",
        suggestion: { kind: "user_choice" },
      },
      presentation: {
        kind: "external",
        title: "Choose a profile",
        subject: { kind: "task", id: run.threadId },
      },
    });
    const line = await vi.waitFor(() => {
      const posted = slack.posted.find(({ text }) => text.startsWith("This task needs you:"));
      if (!posted) throw new Error("The chat was not told the task needs the person");
      return posted;
    }, 20_000);
    expect(line.text).toMatch(/^This task needs you: \S+$/u);
    expect(line.text).toContain(run.threadId);
    expect(line).toMatchObject({ channel: dmChannelId, threadTs: null });
    // A "yes" in the chat is a message to the task, never an answer to what it asked.
    slack.socket().deliver(dm("yes", "yes, allow it", 31));
    await ingressSettled("yes", "adopted");
    expect(await storeFixture.store.requests.get(request.id)).toMatchObject({
      status: "pending",
    });
    expect(
      await storeFixture.database
        .selectFrom("threadInputs")
        .innerJoin("messages", "messages.id", "threadInputs.messageId")
        .select("messages.content")
        .where("threadInputs.threadId", "=", run.threadId)
        .orderBy("threadInputs.createdAt", "desc")
        .limit(1)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ content: [expect.objectContaining({ text: "yes, allow it" })] });
  }, 120_000);

  it("4. retries only a rate limit, never posts twice, and Disconnect leaves the uncertain uncertain", async () => {
    const socket = slack.socket();
    // A rate limit: retried, after at least the delay Slack named.
    socket.deliver(room("rate", "and the third half?", 40, { threadTs: slackTs(10) }));
    const rateRun = await nextRun(roomBridge.id);
    slack.failNextPostMessage("rate-limited");
    const rateReply = await finish(rateRun, "Rate limited on the first try.", false);
    const requeued = await vi.waitFor(async () => {
      const [row] = await deliveriesOf(rateReply);
      expect(row?.status).toBe("retryable-failed");
      return row!;
    }, 20_000);
    expect(requeued.lastError).toContain("ratelimited");
    expect(requeued.nextAttemptAt.getTime() - Date.now()).toBeGreaterThanOrEqual(1_000);
    await clearBackoff(requeued.id);
    worker.wake();
    expect(await sentParts(rateReply)).toHaveLength(1);
    expect(slack.attempts("Rate limited on the first try.")).toBe(2);

    // A timeout and a 5xx: Slack may have posted it, so it is unknown and never posted again.
    for (const [key, fault, second] of [
      ["timeout", "lost", 41],
      ["server", "server-error", 42],
    ] as const) {
      socket.deliver(room(key, `and ${key}?`, second, { threadTs: slackTs(10) }));
      const run = await nextRun(roomBridge.id);
      slack.failNextPostMessage(fault);
      const text = `Answer that met a ${key}.`;
      const reply = await finish(run, text, false);
      const unknown = await vi.waitFor(async () => {
        const [row] = await deliveriesOf(reply);
        expect(row?.status).toBe("unknown");
        return row!;
      }, 20_000);
      await clearBackoff(unknown.id);
      worker.wake();
      // Woken with nothing in its way, the worker still never asks Slack to post it again (the
      // next reply in this thread, below, is posted, so the lane did move on).
      expect(
        await storeFixture.store.database
          .selectFrom("bridgeDeliveries")
          .select("status")
          .where("id", "=", unknown.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: "unknown" });
      expect(slack.attempts(text), key).toBe(1);
    }

    // Disconnect while a part is mid-send: the parts not sent are cancelled, and the one in
    // flight, whose answer never comes, leaves the bridge's last action uncertain.
    socket.deliver(room("disconnect", "one more long one", 43, { threadTs: slackTs(10) }));
    const run = await nextRun(roomBridge.id);
    const hanging = slack.hangNextPostMessage();
    const longText = Array.from(
      { length: 3 },
      (_, index) =>
        `${index + 1}. ${"x".repeat(slackChannelProviderManifest.maxMessageChars - 10)}`,
    ).join("\n\n");
    const reply = await finish(run, longText, false);
    await hanging.started;
    expect((await deliveriesOf(reply)).map(({ status }) => status)).toEqual([
      "attempt-started",
      "pending",
      "pending",
    ]);
    expect(await connections.revoke(personal.userId, roomBridge.id)).toBe(true);
    await storeFixture.store.driveConnectionCleanups({ stopper: { stop: async () => undefined } });
    expect((await deliveriesOf(reply)).map(({ status }) => status)).toEqual([
      "attempt-started",
      "cancelled",
      "cancelled",
    ]);
    expect(await bridgeState(roomBridge.id)).toMatchObject({ state: "stopping" });
    hanging.lose();
    await vi.waitFor(async () => {
      expect((await deliveriesOf(reply))[0]?.status).toBe("unknown");
    }, 20_000);
    await storeFixture.store.driveConnectionCleanups({ stopper: { stop: async () => undefined } });
    expect(await bridgeState(roomBridge.id)).toMatchObject({ lastActionUncertain: true });
    // Nothing of it is posted after the Disconnect.
    expect(slack.posted.filter(({ text }) => text.includes("x".repeat(100)))).toEqual([]);
  }, 180_000);

  // ---- helpers ----

  function dm(key: string, text: string, second: number) {
    return messageEnvelope({
      channel: dmChannelId,
      channelType: "im",
      envelopeId: `env-${key}`,
      eventId: `Ev-${key}`,
      text,
      ts: slackTs(second),
    });
  }

  function room(
    key: string,
    text: string,
    second: number,
    extra: { readonly threadTs?: string; readonly user?: string } = {},
  ) {
    return messageEnvelope({
      channel: roomChannelId,
      channelType: "channel",
      envelopeId: `env-${key}`,
      eventId: `Ev-${key}`,
      text,
      ts: slackTs(second),
      ...extra,
    });
  }

  async function ingressStatus(key: string) {
    return (
      await storeFixture.database
        .selectFrom("channelIngressEvents")
        .select("status")
        .where("providerEventId", "=", `Ev-${key}`)
        .executeTakeFirst()
    )?.status;
  }

  async function ingressSettled(key: string, status: "adopted" | "ignored") {
    await vi.waitFor(async () => expect(await ingressStatus(key)).toBe(status), 20_000);
  }

  function bridgeTasks(bridgeId: string) {
    return storeFixture.database
      .selectFrom("threads")
      .select("id")
      .where("originConnectionId", "=", bridgeId)
      .execute();
  }

  function sessionsOf(threadId: ThreadId) {
    return storeFixture.database
      .selectFrom("providerSessions")
      .select("personalContext")
      .where("threadId", "=", threadId)
      .execute();
  }

  const started = new Set<string>();
  /** The next Run in the bridge's lineage that has not been started yet. */
  async function nextRun(bridgeId: string) {
    return vi.waitFor(async () => {
      const run = await storeFixture.database
        .selectFrom("runs")
        .select(["id", "threadId", "harnessInstanceId"])
        .where("connectionId", "=", bridgeId)
        .where("status", "=", "queued")
        .orderBy("createdAt")
        .execute();
      const next = run.find(({ id }) => !started.has(id));
      if (!next)
        throw new Error(
          "No new Run in the bridge's lineage: " +
            JSON.stringify({
              runs: await storeFixture.database
                .selectFrom("runs")
                .select(["id", "status", "threadId"])
                .where("connectionId", "=", bridgeId)
                .execute(),
              ingress: await storeFixture.database
                .selectFrom("channelIngressEvents")
                .select(["providerEventId", "status", "lastError"])
                .orderBy("createdAt", "desc")
                .limit(3)
                .execute(),
            }),
        );
      return next;
    }, 20_000);
  }

  /** A Run started on the person's computer, as a Runner starts it; `emit` reports on it. */
  async function beginRun(run: Awaited<ReturnType<typeof nextRun>>) {
    started.add(run.id);
    const { database } = storeFixture;
    const execute = await vi.waitFor(
      () =>
        database
          .selectFrom("commands")
          .select("id")
          .where("runId", "=", run.id)
          .where("type", "=", "run.execute")
          .executeTakeFirstOrThrow(),
      20_000,
    );
    await store.claimCommand(execute.id, `journey-${run.id}`);
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 300_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: run.harnessInstanceId,
      leaseTokenHash: `journey-lease-${run.id}`,
      runnerBootId: "journey-boot",
      runnerId: personal.runnerId,
      runId: run.id,
      threadId: run.threadId,
    });
    let ordinal = 0;
    const emit = (type: string, data: unknown) =>
      store.commitRunnerEvent({
        environmentId: personal.environmentId,
        runnerId: personal.runnerId,
        runnerBootId: "journey-boot",
        event: pendingEvent({
          bindingGeneration: binding.bindingGeneration,
          environmentId: personal.environmentId,
          runId: run.id,
          threadId: run.threadId,
          ordinal: ordinal++,
          type,
          data,
        } as never),
      });
    await emit("run.started", { status: "running" });
    const { providerSessionId } = await database
      .selectFrom("runs")
      .select("providerSessionId")
      .where("id", "=", run.id)
      .executeTakeFirstOrThrow();
    await store.bindProviderSession({
      bindingGeneration: binding.bindingGeneration,
      harnessInstanceId: run.harnessInstanceId,
      providerSessionId: providerSessionId!,
      providerSessionReference: `native-session-${run.threadId}`,
      runId: run.id,
      runnerBootId: "journey-boot",
      runnerId: personal.runnerId,
      threadId: run.threadId,
    });
    return emit;
  }

  /** Start a Run, reply with `text` and complete it; returns the reply's message id. */
  async function finish(run: Awaited<ReturnType<typeof nextRun>>, text: string, wait = true) {
    const emit = await beginRun(run);
    const replyId = createId("message");
    await emit("assistant.message", { content: [{ text, type: "text" }], messageId: replyId });
    await emit("run.completed", { status: "completed" });
    if (wait) await sentParts(replyId);
    return replyId;
  }

  function deliveriesOf(messageId: string) {
    return storeFixture.database
      .selectFrom("bridgeDeliveries")
      .select(["id", "status", "lastError", "nextAttemptAt", "receipt", "part"])
      .where("messageId", "=", messageId as never)
      .orderBy("part")
      .execute();
  }

  /** Every part of a reply, as Slack received it, in the order of its parts. */
  async function sentParts(messageId: string) {
    return vi.waitFor(async () => {
      const rows = await deliveriesOf(messageId);
      if (!rows.length || rows.some(({ status }) => status !== "sent"))
        throw new Error(`Not every part was sent: ${JSON.stringify(rows.map((r) => r.status))}`);
      return rows.map(({ receipt }) => {
        const ts = (receipt as { ts?: string } | null)?.ts;
        const posted = slack.posted.find((message) => message.ts === ts);
        if (!posted) throw new Error("A part's receipt names nothing Slack holds");
        return posted;
      });
    }, 30_000);
  }

  function clearBackoff(deliveryId: string) {
    return storeFixture.database
      .updateTable("bridgeDeliveries")
      .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
      .where("id", "=", deliveryId as never)
      .execute();
  }

  async function bridgeState(bridgeId: string) {
    return (await connections.list(personal.userId, { includeRevoked: true })).find(
      ({ id }) => id === bridgeId,
    );
  }
});

const slackCapability = {
  manifest: slackChannelProviderManifest,
  provider: "slack",
  transportKinds: ["socket" as const],
};

/**
 * The messaging module stream, dispatched the way `server.ts` does it: `runtime.response`
 * resolves a hub request, everything else is answered by `ChannelService.handleRuntimeRequest`
 * as a `host.response`.
 */
class MessagingWire {
  readonly peer: MessagingRelayPeer;
  readonly moduleStream: {
    readonly browserAttachPublicKeys: undefined;
    readonly fence: RunnerAuxiliaryStream["fence"];
    send(frame: Buffer | string, binary: boolean): Promise<void>;
  };
  readonly auxiliaryStream: RunnerAuxiliaryStream;
  readonly #stop = new AbortController();

  constructor(options: {
    readonly hub: MessagingRelayHub;
    readonly router: MessagingFrameRouter;
    readonly service: ChannelService;
  }) {
    this.auxiliaryStream = auxiliaryStream();
    const fence = this.auxiliaryStream.fence;
    this.peer = {
      close: () => undefined,
      id: "messaging-journey-peer",
      send: async (message: HostToMessagingRelayMessage) => {
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

  close(): void {
    this.#stop.abort();
  }

  async #answer(service: ChannelService, request: RuntimeChannelRequest): Promise<void> {
    try {
      const result = await service.handleRuntimeRequest(messagingRunnerId, request);
      await this.peer.send({
        ...this.auxiliaryStream.fence,
        ok: true,
        requestId: request.requestId,
        result,
        type: "host.response",
      } as HostToMessagingRelayMessage);
    } catch (error) {
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

interface PostedSlackMessage {
  readonly channel: string;
  readonly text: string;
  readonly threadTs: string | null;
  readonly ts: string;
  readonly unfurlLinks: unknown;
}

/** Slack, as far as this adapter can tell: the Web API methods it calls and one socket. */
class FakeSlack {
  /** What Slack shows: every message it took and answered for. */
  readonly posted: PostedSlackMessage[] = [];
  /** Every `chat.postMessage` call's text, including the ones that failed. */
  readonly #attempts: string[] = [];
  readonly sockets: FakeSlackSocket[] = [];
  #fault: "none" | "rate-limited" | "lost" | "server-error" | "hang" = "none";
  #hang: { started: () => void; wait: Promise<void> } | null = null;
  #ts = 1_786_500_000;

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("bots.info")) return json({ ok: true, bot: { app_id: "A1" } });
    if (url.includes("auth.test"))
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
    if (url.includes("apps.connections.open"))
      return json({ ok: true, url: "wss://fake.invalid/1" });
    if (url.includes("users.info"))
      return json({ ok: true, user: { id: humanUserId, profile: { display_name: "Ada" } } });
    if (url.includes("chat.postMessage")) return this.#postMessage(init);
    return json({ error: "unknown_method", ok: false });
  };

  readonly webSocket: SlackWebSocketFactory = () => {
    const socket = new FakeSlackSocket();
    this.sockets.push(socket);
    return socket;
  };

  socket(): FakeSlackSocket {
    const socket = this.sockets[0];
    if (!socket) throw new Error("The Slack adapter has not opened a socket");
    return socket;
  }

  /** How many times Slack was asked to post this text. */
  attempts(text: string): number {
    return this.#attempts.filter((attempt) => attempt === text).length;
  }

  failNextPostMessage(fault: "rate-limited" | "lost" | "server-error"): void {
    this.#fault = fault;
  }

  /** The next post never answers until `lose()`: then its connection closes unanswered. */
  hangNextPostMessage(): { readonly started: Promise<void>; lose(): void } {
    let started!: () => void;
    let lose!: () => void;
    const startedPromise = new Promise<void>((resolve) => (started = resolve));
    const wait = new Promise<void>((resolve) => (lose = resolve));
    this.#fault = "hang";
    this.#hang = { started, wait };
    return { started: startedPromise, lose };
  }

  async #postMessage(init: RequestInit | undefined): Promise<Response> {
    const body = parseBody(init);
    const text = String(body.text);
    this.#attempts.push(text);
    const fault = this.#fault;
    this.#fault = "none";
    if (fault === "rate-limited")
      // As Slack's proxy can answer it: no JSON, only the status and the delay.
      return new Response("", { headers: { "retry-after": "2" }, status: 429 });
    if (fault === "server-error") return json({ error: "internal_error", ok: false }, {}, 500);
    if (fault === "lost")
      // Slack took it, and this process never heard the answer.
      throw new Error("The connection closed before Slack answered chat.postMessage");
    if (fault === "hang" && this.#hang) {
      const hang = this.#hang;
      this.#hang = null;
      hang.started();
      await hang.wait;
      throw new Error("The connection closed before Slack answered chat.postMessage");
    }
    this.#ts += 1;
    const ts = `${this.#ts}.000100`;
    const channel = String(body.channel);
    this.posted.push({
      channel,
      text,
      threadTs: typeof body.thread_ts === "string" ? body.thread_ts : null,
      ts,
      unfurlLinks: body.unfurl_links,
    });
    return json({ channel, ok: true, ts });
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
    const frame = JSON.stringify(envelope);
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
      allowedModules: ["integrations", "messaging"],
      bootId,
      capabilities: [],
      connectionGeneration: 1,
      personalRemoteAccessGeneration: null,
      connectionId,
      connectionLeaseId,
      environmentIds: [],
      fence,
      modules: { messaging: { capabilities: [slackCapability] } },
      name: "Journey messaging service",
      runnerId: messagingRunnerId,
      runnerKind: "managed",
      runtimeVersion: "test",
    },
    streamLeaseExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
}
