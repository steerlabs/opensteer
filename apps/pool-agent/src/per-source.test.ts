// One Home cannot take the pool host's relay or agent port from the others: each source address
// has its own small share of connections, enforced before any TLS or request is read.
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { connect, type AddressInfo, type Server, type Socket } from "node:net";
import { afterEach, expect, it } from "vitest";
import { limitConnectionsPerSource } from "./per-source.js";
import { relayConnectionsPerSource, createRelayServer } from "./relay.js";
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

/** Opens `count` plain TCP connections and says which the server closed within half a second. */
async function closedOf(server: Server, count: number): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  const sockets = await Promise.all(
    Array.from({ length: count }, () => {
      const socket = connect(port, "127.0.0.1");
      opened.push(socket);
      socket.on("error", () => undefined);
      return new Promise<Socket>((resolve) => socket.once("connect", () => resolve(socket)));
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  return sockets.filter((socket) => socket.destroyed || socket.readyState !== "open").length;
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
}, 20_000);

it("limits the agent port's unauthenticated requests to its share per Home", async () => {
  const server = createHomeServer({
    agent: {} as never,
    hostKey: generateKeyPairSync("ed25519").privateKey,
  });
  expect(homeConnectionsPerSource).toBe(16);
  expect(await closedOf(server, homeConnectionsPerSource + 1)).toBe(1);
}, 20_000);
