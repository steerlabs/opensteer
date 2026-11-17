import { expect, it } from "vitest";
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
    const first = await connect(runtime.origin, runtime.ownerHeaders.cookie);
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
