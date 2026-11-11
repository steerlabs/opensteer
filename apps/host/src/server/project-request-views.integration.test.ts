import { NotificationDispatcher } from "../notifications/notification-dispatcher.js";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuthenticatedSessionSchema,
  createId,
  ProjectEngineRequestSchema,
  zeroSequence,
  type Sequence,
  type UserId,
} from "@opensteer/core";
import { OpensteerStore } from "@opensteer/database";
import { projectRequestFixture } from "@opensteer/database/test-support/project-requests";
import { describeStore, testRunnerDescriptor } from "@opensteer/database/test-support/store";
import { IdentityService } from "@opensteer/identity";
import { RealtimeHub, type RunnerIdentity } from "@opensteer/orchestration";
import { hostApiVersion } from "@opensteer/deployment-authority";
import {
  HostToClientMessageSchema,
  hostApi,
  RunnerConnectionFenceSchema,
  type HostToClientMessage,
} from "@opensteer/protocol";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { expect, onTestFinished, vi } from "vitest";
import WebSocket from "ws";
import { HostAuthenticator } from "../identity/auth.js";
import { SignedTokenService, signHostDiscovery } from "../identity/host-keys.js";
import { createExecutionRuntime } from "../runtime/execution-runtime.js";
import { createHostServer } from "../server.js";
import { hostServerTestDependencies } from "./host-server-test-harness.js";
import { injectRpcRequest } from "./test-host-api-request.js";

// Real Host routes, socket encoding, replay, runtime, and PostgreSQL; only sign-in is preauthenticated.
describeStore("Project Request views", (it) => {
  it("shares task cards and wait/outcome facts while keeping answers, counts and notifications with the audience", async ({
    storeFixture,
  }) => {
    const { database } = storeFixture;
    const fixture = await projectRequestFixture(storeFixture, "privacy");
    // The Request store fixture binds directly; a running Host must also see the input claimed.
    await database
      .updateTable("threadInputs")
      .set({ runId: fixture.run.id, state: "claimed" })
      .where("messageId", "=", fixture.run.seedInputId)
      .execute();
    await database
      .updateTable("commands")
      .set({ status: "succeeded" })
      .where("runId", "=", fixture.run.id)
      .where("type", "=", "run.execute.project")
      .execute();
    const member = await storeFixture.store.createUser("Project member");
    const outsider = await storeFixture.store.createUser("Outside Project");
    await database
      .updateTable("users")
      .set({ admittedAt: new Date() })
      .where("id", "in", [member, outsider])
      .execute();
    await database
      .insertInto("workspaceMemberships")
      .values({
        id: createId("workspaceMembership"),
        workspaceId: fixture.workspace.id,
        userId: member,
        role: "collaborator",
        state: "active",
        generation: 1,
        invitedBy: fixture.userId,
        joinedAt: new Date(),
        revokedAt: null,
        revokedBy: null,
        updatedAt: new Date(),
      })
      .execute();
    const memberSession = createId("authSession");
    const outsiderSession = createId("authSession");
    const originalSession = await database
      .selectFrom("authSessions")
      .selectAll()
      .where("id", "=", fixture.sessionId)
      .executeTakeFirstOrThrow();
    await database
      .insertInto("authSessions")
      .values([
        { ...originalSession, id: memberSession, userId: member, token: "member-session" },
        { ...originalSession, id: outsiderSession, userId: outsider, token: "outsider-session" },
      ])
      .execute();
    const deployment = await storeFixture.store.getDeployment();
    if (!deployment) throw new Error("Cold identity missing");
    const store = new OpensteerStore(database);
    const realtime = new RealtimeHub({ store });
    const fence = RunnerConnectionFenceSchema.parse({
      runnerId: fixture.runnerId,
      bootId: fixture.binding.runnerBootId,
      connectionId: `rcn_${randomUUID()}`,
      connectionLeaseId: `rls_${randomUUID()}`,
      connectionGeneration: 1,
    });
    const identity: RunnerIdentity = {
      ...testRunnerDescriptor({
        runnerId: fixture.runnerId,
        environmentId: fixture.environmentId,
        name: "Team computer",
        runnerKind: "local",
      }),
      device: { platform: "linux", form: "server" },
      bootId: fence.bootId,
      capabilities: ["project-authority-v1"],
      allowedModules: ["agents", "shell"],
      personalRemoteAccessGeneration: null,
      connectionGeneration: 1,
      connectionId: fence.connectionId,
      connectionLeaseId: fence.connectionLeaseId,
      environmentIds: [fixture.environmentId],
      fence,
    };
    const directory = await mkdtemp(join(tmpdir(), "project-privacy-"));
    const keys = generateKeyPairSync("ed25519");
    const errors: unknown[] = [];
    const notified: UserId[] = [];
    let notifications: NotificationDispatcher | undefined;
    const runtime = await createExecutionRuntime(
      database,
      deployment,
      {},
      {
        transport: {
          current: (id) => (id === fixture.environmentId ? identity : null),
          identityForRunner: (id) => (id === fixture.runnerId ? identity : undefined),
          isCurrent: (peer) =>
            peer.connectionId === fence.connectionId &&
            peer.runnerId === fence.runnerId &&
            peer.bootId === fence.bootId,
          sendCommand: async () => undefined,
          sendFrame: async () => undefined,
        },
        tokens: new SignedTokenService(keys, {
          deploymentId: deployment.id,
          hostInstanceId: deployment.activeHostInstanceId,
        }),
        workspaceAccess: {
          planProject: async () => {
            throw new Error("This bound Run needs no new access plan");
          },
        },
        dataDirectory: directory,
        agentToolsUrl: "https://team.test/agent-tools",
        egress: {
          relayUrl: "https://team.test/egress",
          maxRequestBytes: 1024,
          maxResponseBytes: 1024,
        },
        dispatcherId: "privacy",
        executionLeaseMs: 60_000,
        publish: (events) =>
          events.forEach((event) => {
            realtime.publish(event);
            notifications?.dispatch(event);
          }),
        live: () => undefined,
        collectAccessEvents: () => undefined,
        onQueueWake: () => () => undefined,
        onRunnerWake: () => () => undefined,
        onError: (error) => errors.push(error),
        clock: { schedule: () => () => undefined },
      },
    );
    if (runtime.kind !== "project") throw new Error("Stored authority must select Project runtime");
    notifications = new NotificationDispatcher({
      store: runtime.project.notifications,
      ready: Promise.resolve(),
      onLive: ({ userId, view }) => {
        notified.push(userId);
        realtime.sendToUsers([userId], { type: "host.notification", notification: view });
      },
      onError: (failure) => errors.push(failure),
      onWarning: (failure) => errors.push(failure),
    });
    onTestFinished(() => notifications?.close());
    onTestFinished(async () => {
      await runtime.project.close();
      await rm(directory, { recursive: true, force: true });
    });
    const origin = "http://127.0.0.1:4310";
    const auth = new IdentityService(database, {
      deployment: { kind: "self-hosted", name: null },
      localPasswordEnabled: true,
      oidcProviders: [],
      publicOrigin: new URL(origin),
      secret: "privacy-fixture-secret-at-least-thirty-two",
      exposure: "networked",
      signupPolicy: "open",
    });
    vi.spyOn(auth, "requireSession").mockImplementation(async (headers) => {
      const viewer = headers.get("cookie");
      const userId =
        viewer === "viewer=member"
          ? member
          : viewer === "viewer=outsider"
            ? outsider
            : fixture.userId;
      return AuthenticatedSessionSchema.parse({
        id:
          userId === member
            ? memberSession
            : userId === outsider
              ? outsiderSession
              : fixture.sessionId,
        absoluteExpiresAt: originalSession.absoluteExpiresAt.toISOString(),
        createdAt: originalSession.createdAt.toISOString(),
        expiresAt: originalSession.expiresAt.toISOString(),
        user: await auth.userSessionProfile(userId),
      });
    });
    const app = await createHostServer(
      hostServerTestDependencies({
        store,
        realtime,
        executionRuntime: runtime,
        authenticator: new HostAuthenticator({ identity: auth, publicUrl: new URL(origin) }),
        discovery: signHostDiscovery(keys, {
          canonicalOrigin: origin,
          deploymentId: deployment.id,
          hostInstanceId: deployment.activeHostInstanceId,
          hostKey: { algorithm: "Ed25519" },
          deploymentShape: deployment.deploymentShape,
        }),
      }),
    );
    onTestFinished(() => app.close());
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const sockets: WebSocket[] = [];
    onTestFinished(async () => {
      await Promise.all(
        sockets.map(async (socket) => {
          if (socket.readyState === socket.CLOSED) return;
          const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
          socket.close();
          await withTimeout(closed, 3000, {
            timeoutError: () => new Error("Viewer socket did not close"),
          });
        }),
      );
    });
    const connect = async (
      viewer: "member" | "responder" | "outsider",
      afterSequence: Sequence,
    ) => {
      const socket = new WebSocket(address.replace("http:", "ws:") + "/v1/realtime", {
        headers: { origin, cookie: `viewer=${viewer}` },
      });
      sockets.push(socket);
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          socket.once("open", resolve);
          socket.once("error", reject);
        }),
        3000,
        { timeoutError: () => new Error("Viewer socket did not open") },
      );
      const messages: HostToClientMessage[] = [];
      const waiters = new Set<() => void>();
      socket.on("message", (raw) => {
        messages.push(HostToClientMessageSchema.parse(JSON.parse(raw.toString())));
        for (const waiter of waiters) waiter();
      });
      const until = (predicate: (messages: readonly HostToClientMessage[]) => boolean) => {
        if (predicate(messages)) return Promise.resolve();
        let listener: () => void;
        const ready = new Promise<void>((resolve) => {
          listener = () => {
            if (predicate(messages)) resolve();
          };
          waiters.add(listener);
        });
        return withTimeout(ready, 4000, {
          timeoutError: () =>
            new Error(`Missing ${viewer} Request projection: ${JSON.stringify(messages)}`),
        }).finally(() => waiters.delete(listener));
      };
      const refused =
        viewer === "outsider"
          ? new Promise<number>((resolve) => socket.once("close", resolve))
          : null;
      socket.send(
        JSON.stringify({
          type: "client.subscribe",
          apiVersion: hostApiVersion,
          threadId: fixture.thread.id,
          workspaceId: fixture.workspace.id,
          afterSequence,
        }),
      );
      if (refused)
        expect(
          await withTimeout(refused, 4000, {
            timeoutError: () => new Error("Non-member subscription was not closed"),
          }),
        ).toBe(4003);
      else await until((frames) => frames.some((message) => message.type === "host.synchronized"));
      return { socket, messages, until };
    };
    const responder = await connect("responder", zeroSequence);
    const reader = await connect("member", zeroSequence);
    const stranger = await connect("outsider", zeroSequence);
    const denied = await injectRpcRequest(
      app,
      "thread.events.list",
      { threadId: fixture.thread.id },
      { cookie: "viewer=outsider", origin },
    );
    expect(denied.statusCode, denied.body).toBe(404);
    expect(
      stranger.messages.every(
        (frame) => frame.type !== "host.events" && frame.type !== "host.snapshot",
      ),
    ).toBe(true);
    const events = (messages: readonly HostToClientMessage[]) =>
      messages.flatMap((message) => (message.type === "host.events" ? message.events : []));
    const threadEvents = (messages: readonly HostToClientMessage[]) =>
      events(messages).flatMap((event) =>
        event.type === "thread.execution-updated" ? [event.data.thread] : [],
      );
    const propose = async (callId: string, ordinal: number) => {
      const request = ProjectEngineRequestSchema.parse({
        id: createId("request"),
        callId,
        createdAt: new Date().toISOString(),
        mode: "live",
        kind: "harness.input",
        requestClass: "question",
        payload: { kind: "harness.input" },
        presentation:
          callId === "second"
            ? {
                kind: "form",
                title: `PRIVATE_PROMPT_${callId}`,
                fields: [
                  { id: "field", prompt: "PRIVATE_FORM_PROMPT", label: "PRIVATE_FORM_LABEL" },
                ],
              }
            : {
                kind: "choice",
                title: `PRIVATE_PROMPT_${callId}`,
                options: [{ id: "yes", hint: "other", label: "PRIVATE_OPTION" }],
              },
      });
      await runtime.project.frames.handle(fence, {
        ...fence,
        type: "runner.project.event",
        event: {
          type: "request.proposed.project",
          ordinal,
          binding: fixture.binding,
          emittedAt: new Date().toISOString(),
          data: { request },
        },
      });
      return request;
    };
    const first = await propose("first", 0);
    await reader.until((frames) =>
      threadEvents(frames).some((thread) =>
        thread.requestWaits?.items.some((item) => item.requestId === first.id),
      ),
    );
    await responder.until((frames) =>
      events(frames).some(
        (event) => event.type === "request.opened" && event.data.request.id === first.id,
      ),
    );
    const pendingReader = await connect("member", zeroSequence);
    const pendingSnapshot = pendingReader.messages.find((frame) => frame.type === "host.snapshot");
    expect(pendingSnapshot).toMatchObject({
      type: "host.snapshot",
      snapshot: {
        pendingRequests: [
          expect.objectContaining({
            id: first.id,
            answer: { allowed: false, reason: "requester-only" },
          }),
        ],
        threads: [
          expect.objectContaining({
            requestWaits: {
              total: 1,
              items: [expect.objectContaining({ requestId: first.id, class: "question" })],
            },
          }),
        ],
      },
    });
    let statements = 0;
    const counted = new OpensteerStore(
      database.withPlugin({
        transformQuery({ node }) {
          return node;
        },
        async transformResult({ result }) {
          statements++;
          return result;
        },
      }),
    );
    await counted.workspaceSnapshot(fixture.workspace.id, { viewerId: member });
    expect(statements).toBe(13);
    statements = 0;
    await counted.workspaceSnapshot(fixture.workspace.id, { viewerId: fixture.userId });
    expect(statements).toBe(13);
    const snapshotResponse = await injectRpcRequest(
      app,
      "thread.events.list",
      { threadId: fixture.thread.id },
      { cookie: "viewer=member", origin },
    );
    expect(snapshotResponse.statusCode, snapshotResponse.body).toBe(200);
    expect(snapshotResponse.json().data.thread.requestWaits.items).toEqual([
      expect.objectContaining({
        requestId: first.id,
        class: "question",
        waitingOn: { kind: "person", name: "Alex" },
      }),
    ]);
    const memberList = await injectRpcRequest(
      app,
      "requests.list",
      {},
      { cookie: "viewer=member", origin },
    );
    expect(memberList.statusCode, memberList.body).toBe(200);
    expect(memberList.json().data.requests).toEqual([]);
    expect(memberList.json().data.window.totalItems).toBe(0);
    await reader.until((frames) =>
      events(frames).some(
        (event) =>
          event.type === "request.opened" &&
          event.data.request.id === first.id &&
          event.data.request.answer?.allowed === false,
      ),
    );
    const sharedCard = await injectRpcRequest(
      app,
      "thread.requests.list",
      { threadId: fixture.thread.id },
      { cookie: "viewer=member", origin },
    );
    expect(sharedCard.statusCode, sharedCard.body).toBe(200);
    expect(sharedCard.json().data.requests[0]).toMatchObject({
      id: first.id,
      presentation: { title: "PRIVATE_PROMPT_first" },
      answer: { allowed: false, reason: "requester-only" },
    });
    const refused = await injectRpcRequest(
      app,
      "commands.dispatch",
      {
        type: "request.respond",
        requestId: first.id,
        idempotencyKey: "member-cannot-answer",
        response: { kind: "choice", optionId: "yes" },
      },
      { cookie: "viewer=member", origin },
    );
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json().error.reason).toBe("requester-only");
    await notifications.drain();
    await responder.until((frames) =>
      frames.some(
        (frame) => frame.type === "host.notification" && frame.notification.requestId === first.id,
      ),
    );
    expect(notified).toEqual([fixture.userId]);
    expect(reader.messages.some((frame) => frame.type === "host.notification")).toBe(false);

    const card = await injectRpcRequest(
      app,
      "thread.requests.list",
      { threadId: fixture.thread.id },
      { cookie: "viewer=responder", origin },
    );
    expect(card.statusCode, card.body).toBe(200);
    expect(card.json().data.requests[0]).toMatchObject({ id: first.id, answer: { allowed: true } });
    const cursor = events(reader.messages).at(-1)?.sequence;
    if (!cursor) throw new Error("No durable wait cursor");
    const answer = await injectRpcRequest(
      app,
      "commands.dispatch",
      {
        type: "request.respond",
        requestId: first.id,
        idempotencyKey: "answer-first",
        response: { kind: "choice", optionId: "yes", text: "PRIVATE_ANSWER" },
      },
      { cookie: "viewer=responder", origin },
    );
    expect(answer.statusCode, answer.body).toBe(200);
    await reader.until((frames) =>
      threadEvents(frames).some(
        (thread) =>
          thread.requestWaits?.total === 0 &&
          thread.requestOutcomes?.some(
            (item) => item.requestId === first.id && item.status === "fulfilled",
          ),
      ),
    );
    const conflict = await injectRpcRequest(
      app,
      "commands.dispatch",
      {
        type: "request.respond",
        requestId: first.id,
        idempotencyKey: "different-settled-answer",
        response: { kind: "choice", optionId: "yes", text: "A different answer" },
      },
      { cookie: "viewer=responder", origin },
    );
    expect(conflict.statusCode, conflict.body).toBe(409);
    expect(conflict.json().error.reason).toBe("request-already-settled");
    const second = await propose("second", 1);
    await reader.until((frames) =>
      threadEvents(frames).some((thread) =>
        thread.requestWaits?.items.some((item) => item.requestId === second.id),
      ),
    );
    await runtime.project.frames.handle(fence, {
      ...fence,
      type: "runner.project.event",
      event: {
        type: "request.cancelled",
        ordinal: 2,
        binding: fixture.binding,
        emittedAt: new Date().toISOString(),
        data: { requestId: second.id, reason: "run-ended" },
      },
    });
    await reader.until((frames) =>
      threadEvents(frames).some(
        (thread) =>
          thread.requestWaits?.total === 0 &&
          thread.requestOutcomes?.some(
            (item) => item.requestId === second.id && item.status === "cancelled",
          ),
      ),
    );
    const replay = await connect("member", cursor);
    expect(threadEvents(replay.messages).at(-1)).toMatchObject({
      requestWaits: { total: 0, items: [] },
      requestOutcomes: expect.arrayContaining([
        expect.objectContaining({
          requestId: first.id,
          class: "question",
          status: "fulfilled",
          resolvedByName: "Alex",
        }),
        expect.objectContaining({ requestId: second.id, class: "question", status: "cancelled" }),
      ]),
    });
    const history = await injectRpcRequest(
      app,
      "thread.events.list",
      { threadId: fixture.thread.id },
      { cookie: "viewer=member", origin },
    );
    const memberMessages = [...reader.messages, ...pendingReader.messages, ...replay.messages];
    const historyPage = hostApi["thread.events.list"].success.parse(history.json().data);
    const requestFrames = [...events(memberMessages), ...historyPage.events].filter((event) =>
      event.type.startsWith("request."),
    );
    expect(
      requestFrames.some(
        (frame) =>
          frame.type === "request.resolved" &&
          frame.data.request.response?.kind === "choice" &&
          frame.data.request.response.text === "PRIVATE_ANSWER",
      ),
    ).toBe(true);
    expect(
      stranger.messages.every(
        (frame) =>
          frame.type !== "host.events" &&
          frame.type !== "host.snapshot" &&
          frame.type !== "host.notification",
      ),
    ).toBe(true);
    const threadFacts = [historyPage.thread, ...threadEvents(memberMessages)].map((thread) => ({
      requestWaits: thread.requestWaits,
      requestOutcomes: thread.requestOutcomes,
    }));
    const factsJson = JSON.stringify(threadFacts);
    for (const field of ['"presentation"', '"payload"', '"response"'])
      expect(factsJson).not.toContain(field);
    expect(JSON.stringify(responder.messages)).toContain("PRIVATE_PROMPT_first");
    expect(errors).toEqual([]);
  });
});
