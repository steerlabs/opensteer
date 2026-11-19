import {
  expectedMutationSessionHeader,
  HostToRunnerMessageSchema,
  PendingAgentEventV2Schema,
} from "@opensteer/protocol";
import { sql, type KyselyPlugin } from "kysely";
import { createId, threadInputEditLeaseMs } from "@opensteer/core";
import { OpensteerStore } from "@opensteer/database";
import { PersonalSyncSocket, RealtimeHub } from "@opensteer/orchestration";
import {
  commitPersonalMutation,
  installPersonalMutationHooks,
} from "@opensteer/database/personal-mutation";
import type { HostServerDependencies } from "../server.js";
import { createPersonalReads } from "./personal-reads.js";
import type { PersonalResources } from "./personal-resources.js";
import { hostApiVersion } from "@opensteer/deployment-authority";
import { HttpHostClient, type WebSocketClient } from "@opensteer/client/host";
import { createDatabase } from "@opensteer/database";
import { preparePersonalConversion } from "@opensteer/database/test-support/personal-state";
import { createHostRuntime, type PersonalHostRuntime } from "../runtime/runtime.js";
import { expect, it, vi } from "vitest";
import WebSocket from "ws";
import { apiVersionHeaders } from "@opensteer/deployment-authority";
import { cloneTestDatabase } from "@opensteer/database/test-support/database";
import { createPersonalRunFixturePort } from "@opensteer/database/test-support/personal-run";
import {
  personalClientFrameMaxBytes,
  ScopedHostMessageSchema,
  type ScopedHostMessage,
  type ScopedClientMessage,
} from "@opensteer/protocol/personal-sync";
import { ManualClock } from "@opensteer/shared/test-support/clock";
import { withTimeout } from "@opensteer/shared/withTimeout";
import {
  claimPrivateMachineOwner,
  connectCallerMachine,
  dispatchCallerRun,
  stopRun,
  startPrivateMachineHost,
  type PrivateMachineHost,
} from "../runtime/private-machine-host.test-support.js";

function deadline<T>(work: Promise<T>, purpose: string) {
  return withTimeout(work, 5_000, { timeoutError: () => new Error(purpose) });
}

async function connect(origin: URL, cookie: string) {
  const url = new URL("/v1/realtime", origin);
  url.protocol = "ws:";
  const socket = new WebSocket(url, {
    headers: { ...apiVersionHeaders("personal"), cookie, origin: origin.origin },
  });
  const frames: ScopedHostMessage[] = [];
  let terminal: Error | undefined;
  socket.on("close", (code, reason) => {
    terminal = new Error(`Personal socket closed ${code} ${reason.toString()}`);
    message.resolve();
  });
  let message = Promise.withResolvers<void>();
  socket.on("message", (raw) => {
    const result = ScopedHostMessageSchema.safeParse(JSON.parse(raw.toString()));
    if (result.success) frames.push(result.data);
    message.resolve();
  });
  const opened = Promise.withResolvers<void>();
  socket.once("open", opened.resolve);
  socket.on("error", opened.reject);
  try {
    await deadline(opened.promise, "Personal socket did not open");
  } catch (error) {
    socket.terminate();
    throw error;
  }
  return {
    socket,
    frames,
    send: (frame: object) => socket.send(JSON.stringify(frame)),
    read: (predicate: (frame: ScopedHostMessage) => boolean, purpose: string) =>
      deadline(
        (async () => {
          for (;;) {
            if (terminal) throw terminal;
            const found = frames.find(predicate);
            if (found) return found;
            const wait = message.promise;
            await wait;
            message = Promise.withResolvers<void>();
          }
        })(),
        purpose,
      ),
  };
}

it("delivers a bound send key only to the sending login in live and retained views", async () => {
  const database = await cloneTestDatabase("host");
  const sockets: WebSocket[] = [];
  let runtime: PrivateMachineHost | undefined;
  let caller: Awaited<ReturnType<typeof connectCallerMachine>> | undefined;
  try {
    const host = (runtime = await startPrivateMachineHost(database.url));
    caller = await connectCallerMachine(host, {
      name: "Sender",
      token: host.hostingRunnerEnrollmentToken,
    });
    const opened = await host.api["commands.dispatch"]({
      type: "thread.create",
      environmentId: caller.environmentId,
      harnessInstanceId: caller.harnessInstanceId,
      idempotencyKey: "sender-private-task",
      modelSelection: { modelId: "gpt-5.6-sol", providerId: "openai", options: { effort: "low" } },
      title: "Sender scope",
    });
    if (!opened.ok || opened.data.type !== "thread.create") throw new Error("Task creation failed");
    const threadId = opened.data.thread.id;
    const recipient = await claimPrivateMachineOwner(host.runtime, host.config);
    const scope = { kind: "thread", threadId };
    const attach = async (
      cookie: string,
      resume?: Pick<
        Extract<ScopedClientMessage, { type: "client.attach" }>,
        "cursor" | "expectedSessionId"
      >,
    ) => {
      const peer = await connect(host.origin, cookie);
      sockets.push(peer.socket);
      peer.send({
        type: "client.attach",
        apiVersion: hostApiVersion,
        generation: 1,
        interests: [],
        installed: {},
        selected: { subscriptionId: "detail:0", generation: 1, scope },
        ...resume,
      });
      await peer.read(
        (frame) => frame.type === "host.synchronized" && frame.scope.kind === "thread",
        "The sender test detail did not synchronize",
      );
      return peer;
    };
    const sender = await attach(host.ownerHeaders.cookie!);
    const shell = sender.frames.find(
      (frame) => frame.type === "host.snapshot" && frame.scope.kind === "shell",
    );
    if (
      shell?.type !== "host.snapshot" ||
      !("session" in shell.snapshot) ||
      !shell.snapshot.session
    )
      throw new Error("The sender session was absent");
    const { deploymentId, viewerId, epoch, session } = shell.snapshot;
    const login = session.sessionId;
    const viewer = await attach(recipient.cookie, {
      cursor: {
        deploymentId,
        viewerId,
        epoch,
        scopeKey: "shell",
        afterSequence: shell.throughSequence,
      },
      expectedSessionId: login,
    });
    const replacementShell = viewer.frames.find(
      (frame) => frame.type === "host.snapshot" && frame.scope.kind === "shell",
    );
    expect(replacementShell).toMatchObject({
      snapshot: { session: { sessionId: expect.any(String) } },
    });
    expect(replacementShell).not.toMatchObject({ snapshot: { session: { sessionId: login } } });
    const key = "private-client-send-key";
    const payload = {
      type: "thread.sendMessage",
      threadId,
      content: [{ type: "text", text: "Keep this message" }],
      idempotencyKey: key,
    };
    const stale = await host.runtime.app.inject({
      method: "POST",
      url: "/v1/rpc/commands.dispatch",
      headers: { ...recipient, [expectedMutationSessionHeader]: login },
      payload,
    });
    expect(stale.statusCode).toBe(403);
    expect(stale.json()).toMatchObject({ error: { reason: "session-changed" } });
    const sent = await host.runtime.app.inject({
      method: "POST",
      url: "/v1/rpc/commands.dispatch",
      headers: { ...host.ownerHeaders, [expectedMutationSessionHeader]: login },
      payload,
    });
    expect(sent.statusCode, sent.body).toBe(200);
    const id = sent.json<{ data: { message: { id: string } } }>().data.message.id;
    const live = async (peer: Awaited<ReturnType<typeof attach>>) => {
      const cut = await peer.read(
        (frame) =>
          "scope" in frame &&
          frame.scope.kind === "thread" &&
          ((frame.type === "host.snapshot" &&
            "items" in frame.snapshot &&
            frame.snapshot.items.some((item) => item.id === id)) ||
            (frame.type === "host.changes" &&
              frame.changes.some(
                (change) => change.entityKind === "item" && change.entityId === id,
              ))),
        "The committed message was absent from the viewer's synchronized detail",
      );
      if (cut.type === "host.snapshot" && "items" in cut.snapshot)
        return cut.snapshot.items.find((item) => item.id === id);
      if (cut.type !== "host.changes") throw new Error("The message was not upserted");
      const row = cut.changes.find(
        (change) => change.entityKind === "item" && change.entityId === id,
      );
      if (row?.operation === "upsert" && row.entityKind === "item") return row.value;
      throw new Error("The message was not upserted");
    };
    const items = await host.store.database
      .selectFrom("clientChanges")
      .select("payload")
      .where("entityId", "=", id)
      .execute();
    expect(items.length).toBeGreaterThan(0);
    expect(JSON.stringify(items)).not.toContain(key);
    const [sentItem, viewerItem] = await Promise.all([live(sender), live(viewer)]);
    expect(sentItem).toMatchObject({ id, clientSendKey: key });
    expect(viewerItem).toMatchObject({ id });
    expect(viewerItem).not.toHaveProperty("clientSendKey");
    const page = (headers: Readonly<Record<string, string>>) =>
      host.runtime.app.inject({
        method: "GET",
        url: "/v1/rpc/thread.items.page",
        headers,
        query: { input: JSON.stringify({ threadId }) },
      });
    const [senderPage, viewerPage] = await Promise.all([page(host.ownerHeaders), page(recipient)]);
    expect(senderPage.statusCode, senderPage.body).toBe(200);
    expect(senderPage.json()).toMatchObject({
      data: {
        items: expect.arrayContaining([expect.objectContaining({ id, clientSendKey: key })]),
      },
    });
    expect(viewerPage.statusCode, viewerPage.body).toBe(200);
    expect(viewerPage.json()).toMatchObject({
      data: { items: expect.arrayContaining([expect.objectContaining({ id })]) },
    });
    expect(viewerPage.body).not.toContain(key);
  } finally {
    for (const socket of sockets) socket.terminate();
    try {
      await caller?.close();
      await runtime?.close();
    } finally {
      await database.drop();
    }
  }
});

it("delivers an overlapping commit and replaces a held detail generation on a real Host socket", async () => {
  const database = await cloneTestDatabase("host");
  let runtime: PrivateMachineHost | undefined;
  const sockets: WebSocket[] = [];
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const replacing = Promise.withResolvers<void>();
  const releaseReplacement = Promise.withResolvers<void>();
  let cuts = 0;
  try {
    runtime = await startPrivateMachineHost(database.url, {
      logger: {
        level: "warn",
        stream: new Writable({
          write(chunk: Buffer, _encoding, done) {
            const entry = JSON.parse(chunk.toString());
            if (entry.msg === "Personal scope read failed")
              console.error(entry.msg, { code: entry.code, issuePaths: entry.issuePaths });
            done();
          },
        }),
      },
      onPersonalScopeCut: async (scope) => {
        if (scope.kind !== "thread") return;
        switch (++cuts) {
          case 1:
            held.resolve();
            await deadline(release.promise, "Test did not release the first Host cut");
            break;
          case 3:
            replacing.resolve();
            await deadline(releaseReplacement.promise, "Test did not release the replaced cut");
            break;
        }
      },
    });
    const { threadId } = await createPersonalRunFixturePort(runtime.store).createTask({
      ownerId: runtime.ownerId,
      suffix: "scoped-socket",
    });
    const first = await connect(runtime.origin, runtime.ownerHeaders.cookie!);
    sockets.push(first.socket);
    const selected = {
      subscriptionId: "detail:0",
      generation: 1,
      scope: { kind: "thread", threadId },
    };
    const attach = {
      type: "client.attach",
      apiVersion: hostApiVersion,
      generation: 1,
      interests: [],
      installed: {},
      selected,
    };
    first.send(attach);
    await deadline(
      Promise.race([
        held.promise,
        new Promise<never>((_, reject) =>
          first.socket.once("close", (code, reason) =>
            reject(new Error(`Host closed before its detail cut: ${code} ${reason.toString()}`)),
          ),
        ),
      ]),
      "Host did not register the selected scope",
    );
    await first.read(
      (frame) => frame.type === "host.synchronized" && frame.scope.kind === "shell",
      "The shell did not synchronize before the first detail cut",
    );
    const changed = await runtime.api["commands.dispatch"]({
      type: "thread.done.set",
      threadId,
      done: true,
      idempotencyKey: crypto.randomUUID(),
    });
    if (!changed.ok) throw new Error("Task change failed");
    release.resolve();
    const overlap = await first.read(
      (frame) => frame.type === "host.changes" && frame.subscriptionId === "detail:0",
      "The scoped mutation during the cut was lost",
    );
    expect(overlap).toMatchObject({ generation: 1, scope: selected.scope });

    const secondOwner = await claimPrivateMachineOwner(runtime.runtime, runtime.config);
    expect(secondOwner.cookie === runtime.ownerHeaders.cookie).toBe(false);
    const second = await connect(runtime.origin, secondOwner.cookie);
    sockets.push(second.socket);
    second.send(attach);
    await deadline(replacing.promise, "The second socket did not enter its initial detail cut");
    second.send({ type: "client.subscribe", ...selected, generation: 2 });
    const replacement = await second.read(
      (frame) => frame.type === "host.snapshot" && frame.generation === 2,
      "The replacement waited for an obsolete generation",
    );
    expect(replacement).toMatchObject({ scope: selected.scope });
    releaseReplacement.resolve();
    await second.read(
      (frame) => frame.type === "host.synchronized" && frame.generation === 2,
      "The replacement did not synchronize",
    );
    expect(
      second.frames
        .filter((frame) => frame.subscriptionId === "detail:0")
        .map(({ generation }) => generation),
    ).toEqual([2, 2]);
    expect(
      first.frames
        .filter((frame) => frame.subscriptionId === "detail:0")
        .every(({ generation }) => generation === 1),
    ).toBe(true);
  } finally {
    release.resolve();
    releaseReplacement.resolve();
    for (const socket of sockets) socket.terminate();
    await runtime?.close();
    await database.drop();
  }
});
import { Writable } from "node:stream";

it("sends the public Request decision without its settlement session", async () => {
  const database = await cloneTestDatabase("host");
  let host: PrivateMachineHost | undefined;
  let socket: WebSocket | undefined;
  try {
    host = await startPrivateMachineHost(database.url);
    const tasks = createPersonalRunFixturePort(host.store);
    const { threadId } = await tasks.createTask({
      ownerId: host.ownerId,
      suffix: "request-receipt",
    });
    const { runId } = await tasks.startTask(threadId, "Choose browser access");
    const shell = await host.api["personal.shell.get"]({});
    if (!shell.ok) throw new Error(shell.error.message);
    const sessionId = shell.data.session.sessionId;
    await host.store.database
      .updateTable("authSessions")
      .set({ deviceLabel: "iPhone", userAgent: null })
      .where("id", "=", sessionId)
      .executeTakeFirstOrThrow();
    const { request } = await host.store.requests.create({
      callId: "receipt-browser-access",
      kind: "browser.access",
      mode: "durable",
      originatingRunId: runId,
      originatingThreadId: threadId,
      requestedBy: host.ownerId,
      requiredActor: "requester",
      payload: {
        kind: "browser.access",
        reason: "Choose browser access",
        suggestion: { kind: "user_choice" },
      },
      presentation: {
        kind: "external",
        title: "Browser access",
        subject: { kind: "thread", id: threadId },
      },
    });
    const revision = await host.store.requests.revision(request.id);
    if (!revision) throw new Error("Request revision is missing");
    const peer = await connect(host.origin, host.ownerHeaders.cookie!);
    socket = peer.socket;
    peer.send({
      type: "client.attach",
      apiVersion: hostApiVersion,
      generation: 1,
      interests: [],
      installed: {},
      selected: { subscriptionId: "detail:0", generation: 1, scope: { kind: "thread", threadId } },
    });
    await peer.read(
      (frame) => frame.type === "host.synchronized" && frame.subscriptionId === "detail:0",
      "The task subscription did not synchronize before Request settlement",
    );
    const settled = await host.store.requests.resolveBrowserRequest({
      requestId: request.id,
      expectedRevision: revision,
      resolvedBy: host.ownerId,
      settlementSessionId: sessionId,
      response: { kind: "external", value: { decision: "declined" } },
    });
    expect(settled.request.settlementProvenance).toMatchObject({
      sessionId,
      deviceLabel: "iPhone",
    });
    const update = await peer.read(
      (frame) =>
        frame.type === "host.changes" &&
        frame.changes.some(
          (change) =>
            change.entityKind === "item" &&
            change.operation === "upsert" &&
            change.value.kind === "request" &&
            change.value.requestId === request.id,
        ),
      "The settled Request receipt never arrived on the task subscription",
    );
    expect(JSON.stringify(update)).not.toContain(sessionId);
    expect(update).toMatchObject({
      changes: expect.arrayContaining([
        expect.objectContaining({
          entityKind: "item",
          value: expect.objectContaining({
            requestId: request.id,
            view: expect.objectContaining({ preview: "Declined on iPhone" }),
          }),
        }),
      ]),
    });
  } finally {
    socket?.terminate();
    await host?.close();
    await database.drop();
  }
});

it.each(["fresh", "converted"] as const)(
  "synchronizes a task through the shared Node client on a %s Host",
  async (lineage) => {
    const database = await cloneTestDatabase("host");
    let host: PrivateMachineHost | undefined;
    let restarted: PersonalHostRuntime | undefined;
    let client: HttpHostClient | undefined;
    try {
      host = await startPrivateMachineHost(database.url, { logger: false });
      const task = await createPersonalRunFixturePort(host.store).createTask({
        ownerId: host.ownerId,
        suffix: `${lineage}-node-client`,
      });
      if (lineage === "converted") {
        await host.runtime.close();
        const source = createDatabase({ connectionString: database.url });
        try {
          await preparePersonalConversion(source);
        } finally {
          await source.destroy();
        }
        const runtime = await createHostRuntime(host.config, { logger: false });
        if (runtime.kind !== "personal") {
          await runtime.close();
          throw new Error("Expected a personal Host");
        }
        restarted = runtime;
        await restarted.listen();
      }
      const { origin, ownerHeaders } = host;
      const nodeClient = new HttpHostClient({
        baseUrl: origin,
        fetch: (url, init) =>
          fetch(url, {
            ...init,
            headers: { ...Object.fromEntries(new Headers(init?.headers)), ...ownerHeaders },
          }),
        webSocketFactory: (url) =>
          new WebSocket(url, { headers: ownerHeaders }) as unknown as WebSocketClient,
      });
      client = nodeClient;
      nodeClient.activateThread(task.threadId);
      await nodeClient.load();
      await vi.waitFor(
        () => {
          expect(
            nodeClient.deploymentPosition(),
            "The client did not install the shell cut",
          ).not.toBeNull();
          expect(nodeClient.getSnapshot().threads, "The task did not appear in the shell").toEqual(
            expect.arrayContaining([
              expect.objectContaining({ id: task.threadId, title: task.thread.title }),
            ]),
          );
          expect(
            nodeClient.getThreadTranscript(task.threadId)?.getSnapshot().synchronized,
            "The client did not install the task detail cut",
          ).toBe(true);
        },
        { timeout: 5_000 },
      );
    } finally {
      client?.dispose();
      await restarted?.close();
      await host?.close();
      await database.drop();
    }
  },
);

it("closes an over-limit fragmented Personal frame before receiving the final fragment", async () => {
  const database = await cloneTestDatabase("host");
  let host: PrivateMachineHost | undefined;
  let socket: WebSocket | undefined;
  try {
    host = await startPrivateMachineHost(database.url, { logger: false });
    const peer = await connect(host.origin, host.ownerHeaders.cookie!);
    socket = peer.socket;
    const closed = new Promise<number>((resolve) => socket!.once("close", resolve));
    socket.send(" ".repeat(personalClientFrameMaxBytes), { fin: false });
    socket.send(" ", { fin: false });
    expect(await deadline(closed, "The WebSocket receiver buffered an oversized message")).toBe(
      1009,
    );
  } finally {
    socket?.terminate();
    await host?.close();
    await database.drop();
  }
});

it("retries a failed Host-owned finish without blocking another intent or bypassing backoff", async () => {
  const database = await cloneTestDatabase("host");
  const clock = new ManualClock();
  let retryScheduled = Promise.withResolvers<void>();
  const finished = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  let host: PrivateMachineHost | undefined;
  try {
    host = await startPrivateMachineHost(database.url, {
      logger: false,
      executionClock: {
        now: clock.now,
        schedule(callback, delay) {
          const cancel = clock.schedule(callback, delay);
          if (delay === 5_000) retryScheduled.resolve();
          return cancel;
        },
      },
      onPersonalReaction: (notice) => {
        if (notice.type === "runFinished") finished.get(notice.runId)?.resolve();
      },
    });
    const tasks = createPersonalRunFixturePort(host.store);
    const first = await tasks.createTask({ ownerId: host.ownerId, suffix: "host-retry-finish" });
    const second = await tasks.createTask({ ownerId: host.ownerId, suffix: "host-other-finish" });
    const taskRuns = [
      { ...first, ...(await tasks.startTask(first.threadId, "Finish after a failed batch.")) },
      {
        ...second,
        ...(await tasks.startTask(second.threadId, "Finish while another intent retries.")),
      },
    ].sort((left, right) => left.runId.localeCompare(right.runId));
    const [failing, healthy] = taskRuns as [(typeof taskRuns)[number], (typeof taskRuns)[number]];
    for (const task of taskRuns) finished.set(task.runId, Promise.withResolvers<void>());
    const db = host.store.database;
    await sql`
      create sequence fixture_finish_attempt;
      create function fail_poison_finish_batch() returns trigger language plpgsql as $$
      begin
        if old.id like 'poison-finish-%' then
          perform nextval('fixture_finish_attempt');
          raise exception 'fixture batch failed';
        end if;
        return new;
      end;
      $$;
      create trigger fixture_fail_finish before update of status on tool_calls
        for each row execute function fail_poison_finish_batch();
    `.execute(db);
    for (const { threadId, runId } of taskRuns) {
      const prefix = runId === failing.runId ? "poison-finish-" : "healthy-finish-";
      await sql`
        insert into tool_calls(id,thread_id,run_id,call_id,origin,tool,arguments,status,started_at)
        select ${prefix}||n,${threadId},${runId},'fixture-call-'||n,'host-harness',
          '{"name":"read","namespace":"harness"}','{}','open',clock_timestamp()
        from generate_series(1,130) n
      `.execute(db);
    }
    const finish = async ({ thread, bindingGeneration, runnerBootId, runId }: typeof failing) => {
      const environment = await host!.store.getEnvironment(thread.environmentId);
      await host!.store.failRunForRefusedRunnerEvent({
        bindingGeneration,
        runId,
        runnerBootId,
        runnerId: environment!.runnerId!,
        message: "Fixture Host-owned failure",
      });
    };
    const read = (runId: typeof failing.runId) =>
      db
        .selectFrom("runs")
        .select(["finishIntent", "status"])
        .where("id", "=", runId)
        .executeTakeFirstOrThrow();
    const attempts = async () =>
      (await sql<{ lastValue: string }>`select last_value from fixture_finish_attempt`.execute(db))
        .rows[0]!.lastValue;
    await finish(failing);
    await deadline(retryScheduled.promise, "Failed finish batch did not arm a retry");
    expect(await read(failing.runId)).toMatchObject({
      finishIntent: { mode: "host" },
      status: "running",
    });
    expect(await attempts()).toBe("1");
    retryScheduled = Promise.withResolvers<void>();
    await finish(healthy);
    await deadline(
      finished.get(healthy.runId)!.promise,
      "Another intent was blocked by the failed Run",
    );
    await deadline(retryScheduled.promise, "The later finish lost the first Run's retry");
    expect(await read(healthy.runId)).toEqual({ finishIntent: null, status: "failed" });
    expect(await attempts()).toBe("1");
    await db
      .updateTable("providerSessions")
      .set({ leaseExpiresAt: new Date(clock.now() - 1) })
      .where("active", "=", true)
      .execute();
    expect(await host.store.nextExecutionDeadline()).toBeNull();
    retryScheduled = Promise.withResolvers<void>();
    clock.advanceBy(5_000);
    await deadline(retryScheduled.promise, "A repeated failure did not re-arm its retry");
    expect(await attempts()).toBe("2");
    await sql`drop trigger fixture_fail_finish on tool_calls`.execute(db);
    clock.advanceBy(5_000);
    await deadline(finished.get(failing.runId)!.promise, "Finish retry did not settle the Run");
    expect(await read(failing.runId)).toEqual({ finishIntent: null, status: "failed" });
    expect(
      await db
        .selectFrom("toolCalls")
        .select("id")
        .where(
          "runId",
          "in",
          taskRuns.map(({ runId }) => runId),
        )
        .where("status", "=", "open")
        .execute(),
    ).toEqual([]);
  } finally {
    await host?.close();
    await database.drop();
  }
});

it("publishes count-only approval changes to the subscribed task and shell", async () => {
  const database = await cloneTestDatabase("host");
  let host: PrivateMachineHost | undefined;
  let socket: WebSocket | undefined;
  try {
    host = await startPrivateMachineHost(database.url, { logger: false });
    const tasks = createPersonalRunFixturePort(host.store);
    const { threadId } = await tasks.createTask({
      ownerId: host.ownerId,
      suffix: "approval-count",
    });
    await tasks.startTask(threadId, "Keep the task running");
    const input = await host.store.enqueueThreadInput({
      requestedBy: host.ownerId,
      threadId,
      content: [{ type: "text", text: "Approval-gated follow-up" }],
      source: { kind: "human" },
      policy: "queue",
      idempotencyKey: "approval-follow-up",
    });
    const db = host.store.database;
    const changeApproval = (state: "awaiting-approval" | "cancelled") =>
      commitPersonalMutation(db, async (tx) => {
        await tx
          .selectFrom("threads")
          .select("id")
          .where("id", "=", input.message.threadId)
          .forNoKeyUpdate()
          .executeTakeFirstOrThrow();
        await tx
          .updateTable("threadInputs")
          .set({
            state,
            ...(state === "cancelled" ? { cancelReason: "team-request-cancelled" } : {}),
          })
          .where("messageId", "=", input.message.id)
          .execute();
      });
    await changeApproval("awaiting-approval");
    const reader = await connect(host.origin, host.ownerHeaders.cookie!);
    socket = reader.socket;
    reader.send({
      type: "client.attach",
      apiVersion: hostApiVersion,
      generation: 1,
      interests: [],
      installed: {},
      selected: { subscriptionId: "detail:0", generation: 1, scope: { kind: "thread", threadId } },
    });
    for (const scope of ["shell", "thread"])
      await reader.read(
        (frame) => frame.type === "host.synchronized" && frame.scope.kind === scope,
        `The ${scope} did not synchronize`,
      );
    expect(await host.store.getThreadForOwner(threadId, host.ownerId)).toMatchObject({
      pendingRequests: 1,
      status: "running",
    });
    await changeApproval("cancelled");
    const current = await host.store.getThreadForOwner(threadId, host.ownerId);
    expect(current).toMatchObject({
      pendingRequests: 0,
      status: "running",
    });
    const { revision } = await db
      .selectFrom("threads")
      .select("revision")
      .where("id", "=", threadId)
      .executeTakeFirstOrThrow();
    for (const entityKind of ["thread", "task"] as const) {
      const frame = await reader.read(
        (frame) =>
          frame.type === "host.changes" &&
          frame.changes.some(
            (change) => change.entityKind === entityKind && change.entityId === threadId,
          ),
        `The ${entityKind} retained its old approval count`,
      );
      expect(frame).toMatchObject({
        throughSequence: revision,
        changes: expect.arrayContaining([
          expect.objectContaining({
            entityKind,
            entityId: threadId,
            value: expect.objectContaining({ pendingRequestCount: 0, status: "running" }),
          }),
        ]),
      });
    }
  } finally {
    socket?.terminate();
    await host?.close();
    await database.drop();
  }
});

it("rejects moves of the task that owns a Request or waiting input", async () => {
  const database = await cloneTestDatabase("host");
  let host: PrivateMachineHost | undefined;
  let runner: Awaited<ReturnType<typeof connectCallerMachine>> | undefined;
  try {
    host = await startPrivateMachineHost(database.url, { logger: false });
    runner = await connectCallerMachine(host, {
      name: "Count owner",
      token: host.hostingRunnerEnrollmentToken,
    });
    const run = await dispatchCallerRun(host, runner, { key: "count-owner", title: "Count owner" });
    const requestId = await run.openLiveRequest("harness.approval");
    const target = await createPersonalRunFixturePort(host.store).createTask({
      ownerId: host.ownerId,
      suffix: "new-count-owner",
    });
    const db = host.store.database;
    await expect(
      db
        .updateTable("requests")
        .set({ originatingThreadId: target.threadId })
        .where("id", "=", requestId)
        .execute(),
    ).rejects.toMatchObject({ code: "23514", message: "Request task cannot change" });
    const original = await db
      .selectFrom("runs")
      .select("seedInputId")
      .where("id", "=", run.runId)
      .executeTakeFirstOrThrow();
    await expect(
      db
        .updateTable("threadInputs")
        .set({ threadId: target.threadId })
        .where("messageId", "=", original.seedInputId!)
        .execute(),
    ).rejects.toMatchObject({ code: "23514", message: "Input task cannot change" });
  } finally {
    await runner?.close();
    await host?.close();
    await database.drop();
  }
});

it("arms an idle deadline owner for the edit lease holding a queued follow-up", async () => {
  const database = await cloneTestDatabase("host");
  const clock = new ManualClock();
  let leaseAlarm = Promise.withResolvers<void>();
  let advanced: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  let host: PrivateMachineHost | undefined;
  try {
    host = await startPrivateMachineHost(database.url, {
      logger: false,
      executionClock: {
        now: clock.now,
        schedule(callback, delay) {
          const cancel = clock.schedule(callback, delay);
          if (delay === threadInputEditLeaseMs) leaseAlarm.resolve();
          return cancel;
        },
      },
      onPersonalReaction(notice) {
        if (notice.type === "executionCommandsChanged") advanced?.resolve();
      },
    });
    const tasks = createPersonalRunFixturePort(host.store);
    const { thread } = await tasks.createTask({
      ownerId: host.ownerId,
      suffix: "edit-lease-expiry",
    });
    const predecessor = await tasks.startTask(thread.id, "Finish while the edit is held");
    const queued = await host.store.enqueueThreadInput({
      requestedBy: host.ownerId,
      threadId: thread.id,
      content: [{ type: "text", text: "The queued follow-up" }],
      source: { kind: "human" },
      policy: "queue",
      idempotencyKey: "edit-lease-follow-up",
    });
    expect(queued.run).toBeNull();
    expect(await host.store.requests.nextDeadline()).toBeNull();
    const edit = {
      threadId: thread.id,
      messageId: queued.message.id,
      leaseId: crypto.randomUUID(),
    };
    expect(
      await host.api["commands.dispatch"]({
        ...edit,
        type: "thread.input.lease.take",
        takeOver: false,
      }),
    ).toMatchObject({ ok: true });
    await deadline(leaseAlarm.promise, "Taking a lease did not arm the idle deadline owner");
    clock.advanceBy(10_000);
    leaseAlarm = Promise.withResolvers<void>();
    expect(
      await host.api["commands.dispatch"]({
        ...edit,
        type: "thread.input.lease.renew",
      }),
    ).toMatchObject({ ok: true });
    await deadline(leaseAlarm.promise, "Renewing the lease did not move its alarm");
    const environment = await host.store.getEnvironment(thread.environmentId);
    await host.store.commitRunnerEvent({
      environmentId: thread.environmentId,
      runnerId: environment!.runnerId!,
      runnerBootId: predecessor.runnerBootId,
      event: PendingAgentEventV2Schema.parse({
        type: "run.completed",
        data: { status: "completed" },
        bindingGeneration: predecessor.bindingGeneration,
        environmentId: thread.environmentId,
        emittedAt: new Date(clock.now()).toISOString(),
        ordinal: 1,
        runId: predecessor.runId,
        threadId: thread.id,
      }),
    });
    const read = () =>
      host!.store.database
        .selectFrom("runs")
        .select(["seedInputId", "status"])
        .where("threadId", "=", thread.id)
        .orderBy("runOrdinal")
        .execute();
    expect(await read()).toEqual([
      { seedInputId: predecessor.turn.message.id, status: "completed" },
    ]);
    clock.advanceBy(threadInputEditLeaseMs - 10_000);
    expect(await read()).toHaveLength(1);
    advanced = Promise.withResolvers<void>();
    clock.advanceBy(10_000);
    await deadline(advanced.promise, "The renewed edit lease did not release the follow-up");
    expect(await read()).toEqual([
      { seedInputId: predecessor.turn.message.id, status: "completed" },
      { seedInputId: queued.message.id, status: "queued" },
    ]);
  } finally {
    await host?.close();
    await database.drop();
  }
});

it("reads fifty tasks with their continuation and return details within a fixed query and byte budget", async () => {
  const database = await cloneTestDatabase("host");
  let host: PrivateMachineHost | undefined;
  try {
    host = await startPrivateMachineHost(database.url, { logger: false });
    const { thread } = await createPersonalRunFixturePort(host.store).createTask({
      ownerId: host.ownerId,
      suffix: "full-task-page",
    });
    let pageTask = thread;
    for (let index = 0; index < 50; index++) {
      ({ thread: pageTask } = await host.store.createThread({
        createdBy: host.ownerId,
        environmentId: thread.environmentId,
        harnessInstanceId: thread.harnessInstanceId,
        modelSelection: thread.modelSelection,
        idempotencyKey: `page-seed:${index}`,
        title: `Task number ${index}`,
      }));
    }
    const started = await createPersonalRunFixturePort(host.store).startTask(
      pageTask.id,
      "Open a session",
    );
    await host.store.database
      .updateTable("providerSessions")
      .set({
        contextSnapshot: {
          bindingGeneration: started.bindingGeneration,
          measuredAt: Date.now(),
          ordinal: 0,
          promptCacheTtlMs: null,
          requestStartedAt: null,
          sourceRunId: started.runId,
          usedTokens: 200_000,
        },
      })
      .where("id", "=", started.run.providerSessionId!)
      .execute();
    const selected = await host.store.getThreadForOwner(pageTask.id, host.ownerId);
    expect(selected).toMatchObject({
      providerSessionId: started.run.providerSessionId,
      continuationIdentity: expect.any(Object),
      returnHint: { sourceRunId: started.runId },
    });
    const statements: string[] = [];
    const plugin: KyselyPlugin = {
      transformQuery({ node }) {
        statements.push(node.kind);
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    };
    const store = new OpensteerStore(host.store.database.withPlugin(plugin));
    const { handlers } = createPersonalReads(
      { store } as HostServerDependencies,
      {} as PersonalResources,
    );
    const page = await handlers["tasks.page"]({ limit: 50 }, {
      session: { user: { id: host.ownerId } },
    } as Parameters<(typeof handlers)["tasks.page"]>[1]);
    expect(page.ok).toBe(true);
    if (!page.ok) throw new Error("Task page did not succeed");
    expect(page.data.tasks).toHaveLength(50);
    expect(page.data.window).toMatchObject({ hasMore: true, nextBefore: expect.any(String) });
    expect(page.data.tasks.find(({ thread }) => thread.id === pageTask.id)?.thread).toMatchObject({
      providerSessionId: selected!.providerSessionId,
      continuationIdentity: selected!.continuationIdentity,
      returnHint: selected!.returnHint,
    });
    expect(statements).toEqual(Array.from({ length: 4 }, () => "SelectQueryNode"));
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(64 * 1024);
  } finally {
    await host?.close();
    await database.drop();
  }
});

it("shows Runner progress in the shared node view and clears it on completion", async () => {
  const database = await cloneTestDatabase("host");
  const placed = Promise.withResolvers<void>();
  let host: PrivateMachineHost | undefined;
  let runner: Awaited<ReturnType<typeof connectCallerMachine>> | undefined;
  let client: HttpHostClient | undefined;
  let watched: ReturnType<HttpHostClient["watchNode"]> | undefined;
  try {
    host = await startPrivateMachineHost(database.url, {
      logger: false,
      onPersonalReaction: (notice) => {
        if (notice.type === "nodeProgressPlacement" && notice.active) placed.resolve();
      },
    });
    runner = await connectCallerMachine(host, {
      name: "Node progress fixture",
      token: host.hostingRunnerEnrollmentToken,
    });
    const { runId, threadId, attempt } = await dispatchCallerRun(host, runner, {
      key: "node-progress",
      title: "Node progress",
    });
    const nodeId = createId("executionNode");
    const { socket, fence } = runner.primary;
    const base = {
      runId,
      threadId,
      environmentId: runner.environmentId,
      bindingGeneration: attempt.bindingGeneration,
    };
    const event = (type: string, ordinal: number, data: object) =>
      socket.send(
        JSON.stringify({
          ...fence,
          type: "runner.event",
          event: { ...base, ordinal, type, data, emittedAt: new Date().toISOString() },
        }),
      );
    event("node.started", attempt.nextOrdinal, {
      nodeId,
      kind: "subagent",
      nativeRef: "progress-fixture",
      title: "Progress fixture",
      model: null,
      originCallId: null,
      parentNodeId: null,
      prompt: null,
      sessionRef: null,
    });
    await deadline(placed.promise, "Runner did not report a durable node");
    const { origin, ownerHeaders } = host;
    const nodeClient = new HttpHostClient({
      baseUrl: origin,
      fetch: (url, init) =>
        fetch(url, {
          ...init,
          headers: { ...Object.fromEntries(new Headers(init?.headers)), ...ownerHeaders },
        }),
      webSocketFactory: (url) =>
        new WebSocket(url, { headers: ownerHeaders }) as unknown as WebSocketClient,
    });
    client = nodeClient;
    nodeClient.activateThread(threadId);
    await nodeClient.load();
    const node = nodeClient.watchNode(threadId, nodeId);
    watched = node;
    const reader = nodeClient.getThreadTranscript(threadId)!;
    const waitForNode = (predicate: () => boolean, message: string) => {
      const ready = Promise.withResolvers<void>();
      const check = () => {
        if (predicate()) ready.resolve();
      };
      const unsubscribeNode = node.subscribe(check);
      const unsubscribeThread = reader.subscribe(check);
      check();
      return deadline(ready.promise, message).finally(() => {
        unsubscribeNode();
        unsubscribeThread();
      });
    };
    const parentProgress = () => {
      const entry = reader.getSnapshot().entries.find((item) => item.id === `node:${nodeId}`);
      return entry?.kind === "node" ? entry.progress : undefined;
    };
    await waitForNode(
      () => node.getSnapshot().node?.status === "running",
      "Node slot did not synchronize",
    );
    const progress = (text: string) =>
      socket.send(
        JSON.stringify({
          ...fence,
          environmentId: base.environmentId,
          bindingGeneration: base.bindingGeneration,
          type: "runner.live",
          progress: {
            runId,
            threadId,
            items: [{ stream: "node", nodeId, op: "replace", length: text.length, text }],
          },
        }),
      );
    progress("Checking the source files");
    await waitForNode(
      () =>
        node.getSnapshot().node?.progress === "Checking the source files" &&
        parentProgress() === "Checking the source files",
      "Runner progress did not reach the scoped client",
    );
    progress("Done soon");
    await waitForNode(
      () => node.getSnapshot().node?.progress === "Done soon",
      "A shorter replacement did not reach the scoped client",
    );
    event("node.completed", attempt.nextOrdinal + 1, {
      nodeId,
      status: "completed",
      result: "Finished.",
      usage: null,
    });
    await waitForNode(
      () => node.getSnapshot().node?.status === "completed" && parentProgress() === null,
      "Node completion did not reach the scoped client",
    );
    expect(node.getSnapshot().node).toMatchObject({ progress: null, result: "Finished." });
  } finally {
    watched?.release();
    client?.dispose();
    await runner?.close();
    await host?.close();
    await database.drop();
  }
});

it("keeps an idle detail and shell at zero statements and bytes during unrelated commits", async () => {
  const database = await cloneTestDatabase("host");
  let host: PrivateMachineHost | undefined;
  try {
    host = await startPrivateMachineHost(database.url, { logger: false });
    const tasks = createPersonalRunFixturePort(host.store);
    const { threadId } = await tasks.createTask({ ownerId: host.ownerId, suffix: "idle-viewer" });
    const { threadId: busyId } = await tasks.createTask({
      ownerId: host.ownerId,
      suffix: "busy-task",
    });
    const shell = await host.api["personal.shell.get"]({});
    if (!shell.ok) throw new Error(shell.error.message);
    const { session } = shell.data;
    const authenticated = {
      id: session.sessionId,
      user: session.user,
    } as Parameters<ReturnType<typeof createPersonalReads>["readCut"]>[0];
    let statements = 0;
    const plugin: KyselyPlugin = {
      transformQuery({ node }) {
        statements++;
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    };
    const db = createDatabase({ connectionString: database.url });
    const idleDb = db.withPlugin(plugin);
    const store = new OpensteerStore(idleDb);
    const resources = { initial: async () => [] } as unknown as PersonalResources;
    const { readCut } = createPersonalReads({ store } as HostServerDependencies, resources);
    const attached = Promise.withResolvers<void>();
    const repaired = Promise.withResolvers<void>();
    let synchronized = false;
    let wireBytes = 0;
    const realtime = new RealtimeHub();
    const sync = new PersonalSyncSocket({
      read: (scope, cursor) => readCut(authenticated, session.sessionSurface, scope, cursor),
      async send(data, guard) {
        if (!guard()) return false;
        wireBytes += Buffer.byteLength(data);
        const frame = ScopedHostMessageSchema.parse(JSON.parse(data));
        if (frame.type === "host.synchronized" && frame.subscriptionId === "detail:0")
          attached.resolve();
        if (
          frame.type === "host.snapshot" &&
          frame.subscriptionId === "detail:0" &&
          frame.generation === 1 &&
          synchronized
        )
          repaired.resolve();
        if (frame.type === "host.synchronized" && frame.subscriptionId === "detail:0")
          synchronized = true;
        if (frame.type === "host.snapshot" || frame.type === "host.changes") sync.ack(frame);
        return true;
      },
      close() {},
    });
    const unregister = realtime.registerConnection({
      sync,
      userId: host.ownerId,
      sessionId: session.sessionId,
      sink: { id: "idle-viewer", send: async () => {}, close() {} },
    });
    const unhook = installPersonalMutationHooks(db, {
      wake: ({ head, changedScopes }) => realtime.wake(head, changedScopes),
      onFailure: (error) => {
        throw error;
      },
    });
    try {
      sync.attach({
        type: "client.attach",
        apiVersion: hostApiVersion,
        generation: 1,
        interests: [],
        installed: {},
        selected: {
          generation: 1,
          subscriptionId: "detail:0",
          scope: { kind: "thread", threadId },
        },
      });
      await deadline(attached.promise, "The idle scope did not synchronize");
      expect(statements).toBeGreaterThan(0);
      expect(wireBytes).toBeGreaterThan(0);
      statements = wireBytes = 0;
      const write = (id: typeof threadId) =>
        commitPersonalMutation(db, async (_tx, mutation) => {
          mutation.resetScope(`thread:${id}`);
        });
      for (let i = 0; i < 25; i++) await write(busyId);
      // Each completed source transaction has already published its wake.
      expect({ statements, wireBytes }).toEqual({ statements: 0, wireBytes: 0 });
      await db
        .updateTable("clientSyncState")
        .set((eb) => ({
          prunedThroughSequence: eb.ref("sequence"),
        }))
        .execute();
      await write(threadId);
      await deadline(
        repaired.promise,
        "A relevant commit beyond the feed floor was not repaired inline",
      );
      expect(statements).toBeGreaterThan(0);
      expect(wireBytes).toBeGreaterThan(0);
    } finally {
      unregister();
      sync.close("Fixture complete");
      unhook();
      await db.destroy();
    }
  } finally {
    await host?.close();
    await database.drop();
  }
});

it("does not deliver a prepared Request response to its Runner after Stop commits", async () => {
  const database = await cloneTestDatabase("host");
  const prepared = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const refused = Promise.withResolvers<unknown>();
  let host: PrivateMachineHost | undefined;
  let runner: Awaited<ReturnType<typeof connectCallerMachine>> | undefined;
  try {
    host = await startPrivateMachineHost(database.url, { logger: false });
    runner = await connectCallerMachine(host, {
      name: "Request race fixture",
      token: host.hostingRunnerEnrollmentToken,
    });
    const run = await dispatchCallerRun(host, runner, {
      key: "request-send-fence",
      title: "Request race",
    });
    const requestId = await run.openLiveRequest("harness.approval");
    const reviewed = await host.store.requests.get(requestId);
    const revision = await host.store.requests.revision(requestId);
    if (!reviewed || !revision || reviewed.presentation.kind !== "choice")
      throw new Error("The Runner did not open a choice Request");
    const received: string[] = [];
    const interrupt = Promise.withResolvers<void>();
    runner.primary.socket.on("message", (raw) => {
      const message = HostToRunnerMessageSchema.parse(JSON.parse(raw.toString()));
      if (message.type !== "host.command") return;
      if (message.command.type === "request.resolve") received.push(message.command.requestId);
      if (message.command.type === "run.interrupt") interrupt.resolve();
    });
    const dispatch = host.store.dispatchRequestResponse.bind(host.store);
    vi.spyOn(host.store, "dispatchRequestResponse").mockImplementation((id, send) =>
      dispatch(id, (ack, fence, generation) =>
        send(
          ack,
          async (enqueue) => {
            prepared.resolve();
            await deadline(release.promise, "Fixture did not release the prepared Request frame");
            try {
              await fence(enqueue);
            } catch (error) {
              refused.resolve(error);
              throw error;
            }
          },
          generation,
        ),
      ),
    );
    const response = await host.api["commands.dispatch"]({
      type: "request.respond",
      idempotencyKey: "response-race",
      requestId,
      expectedRevision: revision,
      response: { kind: "choice", optionId: reviewed.presentation.options[0]!.id },
    });
    expect(response.ok).toBe(true);
    await deadline(prepared.promise, "The response was never prepared for the Runner");
    await stopRun(host, run, "stop-before-response-enqueue");
    expect((await host.store.requests.get(requestId))?.status).toBe("cancelled");
    release.resolve();
    expect(
      await deadline(refused.promise, "The Request send guard did not reject the frame"),
    ).toMatchObject({ code: "conflict" });
    await deadline(interrupt.promise, "The Runner did not receive Stop");
    expect(received).toEqual([]);
  } finally {
    release.resolve();
    await runner?.close();
    await host?.close();
    await database.drop();
  }
});
