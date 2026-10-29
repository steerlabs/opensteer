/*
 * The shell relay outlives a Run when its engine does, so it carries one Run's
 * authority at a time. Every way that could go wrong, written before the relay
 * was:
 *
 *  1. A relay no Run holds — never bound, or suspended between a warm engine's
 *     Runs — opens a Host connection.
 *  2. A connection accepted under Run A finishes its request line after A let
 *     go and proceeds.
 *  3. A connection whose request line was read under A opens its Host
 *     connection after A was suspended and B bound, presenting B's token. The
 *     window is the await between reading the line and opening the WebSocket
 *     (reading the control CA), which no end-to-end test can hold open.
 *  4. Binding the same Run again (A, suspend, A) revives a connection accepted
 *     under the first binding.
 *  5. A Host handshake still pending at suspend completes and carries bytes.
 *  6. A session established under A survives A's suspend.
 *  7. `suspend()` resolves while a connection it ended is still open, so a
 *     `close()` removes the launch directory under live sockets.
 *  8. The relay forwards a computer the bound Run's note does not list.
 *  9. The setup probe's target stays answerable after setup.
 * 10. A connection presents the token current at bind, not the refreshed one.
 * 11. A closed relay can be bound again.
 *
 * End-to-end journeys (machine-access-warm.integration.test.ts) prove 1, 2, 5,
 * 6, 8 and 10 through OpenSSH, the helper, a Host and a Runner; this file holds
 * the interleavings only an isolated relay can stage, and the rest once each.
 */
import { createId } from "@opensteer/core";
import { runnerWebSocketTransport } from "@opensteer/runner-client";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createConnection, type AddressInfo, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { ShellRelay } from "./shell-relay.js";

vi.mock("@opensteer/runner-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@opensteer/runner-client")>();
  return { ...actual, runnerWebSocketTransport: vi.fn(actual.runnerWebSocketTransport) };
});

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("shell relay lifecycle", () => {
  it("refuses every connection while no Run holds it", async () => {
    const host = await fakeHost();
    const target = createId("runner");
    const relay = await startRelay(host.url);
    expect(await exchange(relay.socketPath, target)).toMatchObject({ ok: false });
    relay.relay.bind(binding("token-a", [target]));
    expect(await exchange(relay.socketPath, target)).toMatchObject({ ok: true });
    await relay.relay.suspend();
    expect(await exchange(relay.socketPath, target)).toMatchObject({ ok: false });
    // Only the one bound connection ever reached the Host.
    expect(host.authorizations()).toEqual(["Bearer token-a"]);
  });

  it("never opens a Host connection for a request read under a Run that has let go", async () => {
    const host = await fakeHost();
    const target = createId("runner");
    const relay = await startRelay(host.url);
    const first = binding("token-a", [target]);
    // The next Run, and the same Run bound a second time.
    for (const next of [binding("token-b", [target]), first]) {
      relay.relay.bind(first);
      const held = holdNextTransport();
      const client = connectClient(relay.socketPath, target);
      await held.reached;
      // The Run lets go and the next takes the relay while the request is
      // between reading its line and opening its Host connection, and the
      // wait outlasts everything the suspend closed.
      const suspended = relay.relay.suspend();
      relay.relay.bind(next);
      await suspended;
      expect(await client.result).not.toMatchObject({ ok: true });
      held.release();
      // Long enough for a Host connection the relay wrongly opened to arrive.
      await held.returned;
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(host.upgrades()).toBe(0);
      await relay.relay.suspend();
    }
  });

  it("ends pending handshakes and live sessions when suspended", async () => {
    const host = await fakeHost({ holdUpgrades: true });
    const target = createId("runner");
    const relay = await startRelay(host.url);
    relay.relay.bind(binding("token-a", [target]));
    const pending = connectClient(relay.socketPath, target);
    await host.upgradeSeen(1);
    host.holdUpgrades(false);
    const live = connectClient(relay.socketPath, target);
    expect(await live.result).toMatchObject({ ok: true });
    await relay.relay.suspend();
    await Promise.all([pending.ended, live.ended, host.waitForNoConnections()]);
    // The handshake the Host had not answered yet is never completed.
    host.releaseUpgrades();
    expect(await pending.result).not.toMatchObject({ ok: true });
    expect(host.authorizations()).toEqual(["Bearer token-a"]);
  });

  it("refuses computers the bound Run does not list and its own setup target afterwards", async () => {
    const host = await fakeHost();
    const listed = createId("runner");
    const validationTarget = createId("runner");
    const relay = await startRelay(host.url, validationTarget);
    expect(await exchange(relay.socketPath, validationTarget)).toEqual({ ok: true });
    expect(relay.relay.validationAnswered).toBe(true);
    relay.relay.bind(binding("token-a", [listed]));
    expect(await exchange(relay.socketPath, createId("runner"))).toMatchObject({ ok: false });
    expect(await exchange(relay.socketPath, validationTarget)).toMatchObject({ ok: false });
    expect(host.authorizations()).toEqual([]);
  });

  it("presents the token current when each connection opens", async () => {
    const host = await fakeHost();
    const target = createId("runner");
    const relay = await startRelay(host.url);
    const credentials = { agentControl: "token-1" };
    relay.relay.bind({ credentials, runId: createId("run"), targets: [target] });
    expect(await exchange(relay.socketPath, target)).toEqual({ ok: true });
    credentials.agentControl = "token-2";
    expect(await exchange(relay.socketPath, target)).toEqual({ ok: true });
    expect(host.authorizations()).toEqual(["Bearer token-1", "Bearer token-2"]);
  });

  it("cannot carry a Run once closed", async () => {
    const host = await fakeHost();
    const relay = await startRelay(host.url);
    await relay.relay.close();
    expect(() => relay.relay.bind(binding("token-a", [createId("runner")]))).toThrow();
  });
});

function binding(token: string, targets: readonly string[]) {
  return { credentials: { agentControl: token }, runId: createId("run"), targets };
}

async function startRelay(hostUrl: URL, validationTarget?: string) {
  const directory = await mkdtemp(join("/tmp", "osrelay-"));
  const socketPath = join(directory, "relay.sock");
  const relay = new ShellRelay({
    socketPath,
    transport: { controlCaPath: undefined, hostUrl, mode: "development" },
    validationTarget,
  });
  await relay.start();
  cleanups.push(async () => {
    await relay.close();
    await rm(directory, { force: true, recursive: true });
  });
  return { relay, socketPath };
}

/** The next relay connection waits after reading its line until released. */
function holdNextTransport() {
  let reached!: () => void;
  let release!: () => void;
  let returned!: () => void;
  const reachedPromise = new Promise<void>((resolve) => (reached = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  const returnedPromise = new Promise<void>((resolve) => (returned = resolve));
  const original = vi.mocked(runnerWebSocketTransport).getMockImplementation();
  vi.mocked(runnerWebSocketTransport).mockImplementationOnce(async (policy, path) => {
    reached();
    await released;
    if (!original) throw new Error("The transport has no implementation");
    const transport = await original(policy, path);
    returned();
    return transport;
  });
  return { reached: reachedPromise, release, returned: returnedPromise };
}

/** A Host shell endpoint that records who connected and echoes bytes. */
async function fakeHost(options: { readonly holdUpgrades?: boolean } = {}) {
  const server: Server = createServer();
  const webSockets = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const authorizations: string[] = [];
  const held: (() => void)[] = [];
  const sockets = new Set<Socket>();
  let holding = options.holdUpgrades ?? false;
  let upgrades = 0;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request: IncomingMessage, socket, head) => {
    upgrades += 1;
    const accept = () => {
      if (socket.destroyed) return;
      authorizations.push(request.headers.authorization ?? "");
      webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        webSocket.on("message", (raw) => webSocket.send(raw, { binary: true }));
      });
    };
    if (!holding) {
      accept();
      return;
    }
    held.push(accept);
    // A held handshake still notices its client going away.
    socket.on("end", () => socket.destroy());
    socket.resume();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    for (const client of webSockets.clients) client.terminate();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const { port } = server.address() as AddressInfo;
  return {
    authorizations: () => [...authorizations],
    holdUpgrades: (hold: boolean) => (holding = hold),
    releaseUpgrades: () => {
      for (const accept of held.splice(0)) accept();
    },
    upgrades: () => upgrades,
    upgradeSeen: async (count: number) => {
      while (upgrades < count) await new Promise((resolve) => setTimeout(resolve, 5));
    },
    url: new URL(`http://127.0.0.1:${port}`),
    waitForNoConnections: async () => {
      while (sockets.size > 0 || webSockets.clients.size > 0) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
  };
}

/** One relay connection: its first response line, or why there was none. */
function connectClient(socketPath: string, target: string) {
  const socket = createConnection(socketPath);
  let output = "";
  const ended = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  const result = new Promise<unknown>((resolve) => {
    socket.once("connect", () => socket.write(`${JSON.stringify({ target })}\n`));
    socket.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const newline = output.indexOf("\n");
      if (newline !== -1) resolve(JSON.parse(output.slice(0, newline)) as unknown);
    });
    void ended.then(() => resolve({ closed: true }));
    socket.once("error", () => undefined);
  });
  cleanups.push(async () => {
    socket.destroy();
  });
  return { ended, result };
}

async function exchange(socketPath: string, target: string): Promise<unknown> {
  const client = connectClient(socketPath, target);
  return client.result;
}
