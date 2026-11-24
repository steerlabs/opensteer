// One Home cannot take the pool host's relay or agent port from the others: each source address
// has its own small share of connections, enforced before any TLS or request is read.
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { connect, createConnection, type AddressInfo, type Server, type Socket } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { limitConnectionsPerSource } from "./per-source.js";
import { createRelayAuthServer, relayConnectionsPerSource, createRelayServer } from "./relay.js";
import { homeConnectionsPerSource, createHomeServer } from "./server.js";

class FakeSocket extends EventEmitter {
  destroyed = false;
  readonly remoteAddress: string;
  constructor(remoteAddress: string) {
    super();
    this.remoteAddress = remoteAddress;
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  }
}

it("gives each source address its own share, and gives it back when a connection closes", () => {
  const server = new EventEmitter();
  limitConnectionsPerSource(server as never, 3);
  const open = (address: string) => {
    const socket = new FakeSocket(address);
    server.emit("connection", socket);
    return socket;
  };
  const a = [open("10.0.0.5"), open("10.0.0.5"), open("10.0.0.5")];
  expect(a.map((socket) => socket.destroyed)).toEqual([false, false, false]);
  // A fourth from the same Home is refused at once...
  expect(open("10.0.0.5").destroyed).toBe(true);
  // ...while another Home on the same host is not affected.
  const b = [open("10.0.0.6"), open("10.0.0.6"), open("10.0.0.6")];
  expect(b.map((socket) => socket.destroyed)).toEqual([false, false, false]);
  a[0]!.destroy();
  expect(open("10.0.0.5").destroyed).toBe(false);
  expect(open("10.0.0.5").destroyed).toBe(true);
  // A socket without an address is refused, never counted under a shared key.
  expect(open(undefined as never).destroyed).toBe(true);
});

const opened: Socket[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const socket of opened.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

/**
 * Opens `count` plain TCP connections one after another from the same address, waits for the
 * server to close the last one, and says how many of all of them it closed.
 */
async function closedOf(server: Server, count: number): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  const closed = new Set<Socket>();
  for (let index = 0; index < count; index += 1) {
    const socket = connect(port, "127.0.0.1");
    opened.push(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => closed.add(socket));
    await new Promise((resolve) => socket.once("connect", resolve));
  }
  const last = opened.at(-1)!;
  await vi.waitFor(() => expect(closed.has(last)).toBe(true));
  return closed.size;
}

it("limits the relay to its share per Home before the TLS handshake", async () => {
  const directory = mkdtempSync(join(tmpdir(), "relay-share-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ed25519",
      "-nodes",
      "-subj",
      "/CN=relay",
      "-days",
      "1",
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  const server = createRelayServer({
    key: readFileSync(join(directory, "key.pem"), "utf8"),
    certificate: readFileSync(join(directory, "cert.pem"), "utf8"),
    authorize: async () => ({ ok: false, code: "refused" }),
  });
  rmSync(directory, { recursive: true, force: true });
  expect(relayConnectionsPerSource).toBe(64);
  expect(await closedOf(server, relayConnectionsPerSource + 1)).toBe(1);
});

it("limits the agent port's unauthenticated requests to its share per Home", async () => {
  const server = createHomeServer({
    agent: {} as never,
    hostKey: generateKeyPairSync("ed25519").privateKey,
  });
  expect(homeConnectionsPerSource).toBe(16);
  expect(await closedOf(server, homeConnectionsPerSource + 1)).toBe(1);
});

it("keeps the relay's own question to the agent, over its Unix socket, out of any share", async () => {
  // A Unix socket's connections have no source address: a share would refuse every one, and
  // with it every relay hello.
  const directory = mkdtempSync(join(tmpdir(), "relay-auth-"));
  const path = join(directory, "auth.sock");
  const server = createRelayAuthServer(() => ({ ok: false, code: "parked" }));
  await new Promise<void>((resolve) => server.listen(path, resolve));
  servers.push(server);
  const socket = createConnection(path);
  opened.push(socket);
  const answer = new Promise<string>((resolve, reject) => {
    let text = "";
    socket.on("data", (chunk) => (text += String(chunk)));
    socket.once("close", () => resolve(text));
    socket.once("error", reject);
  });
  socket.write(
    `${JSON.stringify({ hello: { v: 1, slot: "bps_1", term: 1, nonce: "A".repeat(22) }, clientKey: "key" })}\n`,
  );
  expect(JSON.parse(await answer)).toEqual({ ok: false, code: "parked" });
  rmSync(directory, { recursive: true, force: true });
});

it("counts what each source's share refuses, in one line per source per minute at most", () => {
  const server = new EventEmitter();
  const lines: Record<string, unknown>[] = [];
  let clock = 0;
  limitConnectionsPerSource(server as never, 1, {
    listener: "relay",
    log: (line) => lines.push({ ...line }),
    now: () => clock,
  });
  const open = (address: string) => server.emit("connection", new FakeSocket(address));
  open("10.0.0.5");
  for (let index = 0; index < 5; index += 1) open("10.0.0.5"); // five refused
  open("10.0.0.6");
  open("10.0.0.6"); // one refused
  // The first refusal of each source is said at once; the rest of the minute only counted.
  expect(lines).toEqual([
    { event: "pool.share.refused", listener: "relay", source: "10.0.0.5", share: 1, refused: 1 },
    { event: "pool.share.refused", listener: "relay", source: "10.0.0.6", share: 1, refused: 1 },
  ]);
  clock = 60_000;
  open("10.0.0.5");
  expect(lines.at(-1)).toEqual({
    event: "pool.share.refused",
    listener: "relay",
    source: "10.0.0.5",
    share: 1,
    refused: 5,
  });
});
