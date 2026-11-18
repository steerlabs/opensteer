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
import { ScopedHostMessageSchema, type ScopedHostMessage } from "@opensteer/protocol/personal-sync";
import { withTimeout } from "@opensteer/shared/withTimeout";
import {
  claimPrivateMachineOwner,
  startPrivateMachineHost,
  type PrivateMachineHost,
} from "../integrations/personal-machine.test-support.js";

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
