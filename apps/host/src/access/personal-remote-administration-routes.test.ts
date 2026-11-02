import Fastify from "fastify";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
import { once } from "node:events";
import { hostApiVersion } from "@opensteer/deployment-authority";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { expect, it, vi } from "vitest";
import { LocalBootstrapService } from "../runtime/local-bootstrap.js";
import type { PersonalRemoteAdministration } from "./personal-remote-administration.js";
import { registerPersonalRemoteExecutor } from "./personal-remote-administration-routes.js";

const capability = "local-process-capability".padEnd(43, "x");
function supervisor() {
  return new LocalBootstrapService({
    publicUrl: new URL("http://127.0.0.1:4310"),
    requireSetupCredential: true,
    setupToken: capability,
    store: {} as never,
    runners: {} as never,
  });
}

it("orders executor delivery so a delayed older intent cannot overtake Off", async () => {
  const app = Fastify();
  await app.register(websocket);
  const oldId = crypto.randomUUID();
  const newId = crypto.randomUUID();
  const older = {
    id: oldId,
    executionId: oldId,
    state: "pending",
    detail: null,
    intent: { action: "rotate" },
  };
  const off = {
    id: newId,
    executionId: newId,
    state: "pending",
    detail: null,
    intent: { action: "configure", mode: "off", privateOrigin: null },
  };
  let publish!: () => void;
  let releaseRead!: (operation: typeof older) => void;
  const delayed = new Promise<typeof older>((resolve) => {
    releaseRead = resolve;
  });
  const next = vi
    .fn()
    .mockResolvedValueOnce(null)
    .mockReturnValueOnce(delayed)
    .mockResolvedValue(off);
  let probe!: () => void;
  const probed = new Promise<void>((resolve) => {
    probe = resolve;
  });
  const administration = {
    close: () => {},
    attachExecutor: () => () => {},
    subscribe: (callback: () => void) => {
      publish = callback;
      return () => {};
    },
    next,
    progress: async () => {
      probe();
    },
  } as unknown as PersonalRemoteAdministration;
  registerPersonalRemoteExecutor(app, supervisor(), administration);
  let socket: WebSocket | undefined;
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    socket = new WebSocket(
      `${address.replace("http:", "ws:")}/v1/personal-remote-access/executor?apiVersion=${hostApiVersion}`,
      { headers: { authorization: `Bearer ${capability}` } },
    );
    await withTimeout(once(socket, "open"), 1000, {
      timeoutError: () => new Error("Executor never opened"),
    });
    const received: string[] = [];
    socket.on("message", (data) => {
      received.push((JSON.parse(data.toString()) as { id: string }).id);
    });
    await vi.waitFor(() => expect(next).toHaveBeenCalledOnce(), { timeout: 1000 });
    publish();
    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(2), { timeout: 1000 });
    publish();
    socket.send(JSON.stringify({ operationId: oldId, state: "running", detail: null }));
    await withTimeout(probed, 1000, {
      timeoutError: () => new Error("Executor progress probe never arrived"),
    });
    expect(next).toHaveBeenCalledTimes(2);
    releaseRead(older);
    await vi.waitFor(() => expect(received).toEqual([oldId, newId]), { timeout: 1000 });
  } finally {
    releaseRead(older);
    socket?.terminate();
    await app.close();
  }
});

it.each(["PersonalRemote stolen-owner-session", `Bearer ${"owner-session".padEnd(43, "x")}`])(
  "refuses an ordinary owner session as the private desktop executor (%s)",
  async (authorization) => {
    const app = Fastify();
    await app.register(websocket);
    const next = vi.fn(async () => null);
    const administration = {
      close: () => {},
      attachExecutor: () => () => {},
      subscribe: () => () => {},
      next,
    } as unknown as PersonalRemoteAdministration;
    registerPersonalRemoteExecutor(app, supervisor(), administration);
    let socket: WebSocket | undefined;
    try {
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      socket = new WebSocket(
        `${address.replace("http:", "ws:")}/v1/personal-remote-access/executor?apiVersion=${hostApiVersion}`,
        { headers: { authorization } },
      );
      const closed = withTimeout(once(socket, "close"), 1000, {
        timeoutError: () =>
          new Error("An ordinary owner session was admitted as the desktop executor"),
      });
      expect((await closed)[0]).toBe(1008);
      expect(next).not.toHaveBeenCalled();
    } finally {
      socket?.terminate();
      await app.close();
    }
  },
);
