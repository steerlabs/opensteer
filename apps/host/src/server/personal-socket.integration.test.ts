import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import WebSocket from "ws";
import { createId } from "@opensteer/core";
import { apiVersionHeaders } from "@opensteer/deployment-authority";
import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
} from "@opensteer/database/test-support/database";
import { ScopedHostMessageSchema, type ScopedHostMessage } from "@opensteer/protocol/personal-sync";
import { withTimeout } from "@opensteer/shared/withTimeout";
import {
  startPersonalRuntime,
  type PersonalRuntime,
} from "../runtime/personal-startup.test-support.js";

function deadline<T>(work: Promise<T>, purpose: string) {
  return withTimeout(work, 5_000, { timeoutError: () => new Error(purpose) });
}

async function connect(runtime: PersonalRuntime, cookie: string) {
  const url = new URL("/v1/realtime", runtime.hostOrigin);
  url.protocol = "ws:";
  const socket = new WebSocket(url, {
    headers: { ...apiVersionHeaders("personal"), cookie, origin: runtime.hostOrigin.origin },
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
  const home = await mkdtemp(join(tmpdir(), "opensteer-scoped-socket-"));
  let runtime: PersonalRuntime | undefined;
  const sockets: WebSocket[] = [];
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const replacing = Promise.withResolvers<void>();
  const releaseReplacement = Promise.withResolvers<void>();
  let cuts = 0;
  try {
    const owned = await ownTestDatabaseProducer(database.url, async () => {
      const runtime = await startPersonalRuntime({
        databaseUrl: database.url,
        agentHome: { computerId: createId("runner"), path: home },
        hostLog: (line) => {
          if (line.includes("Personal scope read failed")) console.error(line);
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
      return { runtime, close: () => runtime.close() };
    });
    runtime = owned.runtime;
    const model = runtime.initialCatalog.models[0]!;
    const created = await runtime.api["commands.dispatch"]({
      type: "thread.create",
      idempotencyKey: crypto.randomUUID(),
      environmentId: runtime.environmentId,
      harnessInstanceId: runtime.harnessInstanceId,
      modelSelection: { providerId: model.providerId, modelId: model.modelId, options: {} },
      title: "Scoped socket task",
    });
    if (!created.ok || created.data.type !== "thread.create") throw new Error("Task setup failed");
    const threadId = created.data.thread.id;
    const first = await connect(runtime, runtime.sessionCookie);
    sockets.push(first.socket);
    const selected = {
      subscriptionId: "detail:0",
      generation: 1,
      scope: { kind: "thread", threadId },
    };
    const attach = {
      type: "client.attach",
      apiVersion: 62,
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
    expect(first.frames.map(({ type }) => type)).toContain("host.synchronized");
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

    const second = await connect(runtime, runtime.sessionCookie);
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
    await rm(home, { recursive: true, force: true });
  }
});
