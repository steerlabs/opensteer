/**
 * The pool relay (pool-runtime-in-guest.md, decisions 4 to 6). Its own process and user; one
 * TLS 1.3 listener. A Home presents a certificate for its relay key; the relay presents one for
 * the relay's own key, which is not the host's signing key. After the handshake the client names its slot and term, the agent decides
 * (live slot, same term, that key, guest running), and only then does the relay connect to the
 * slot's bridge port, answer with the agent's signed grant, and copy bytes. TLS ends here: from
 * here to the guest is the host's own veth, which only this user may use. The relay never wakes
 * a guest; it holds no slot key.
 */
import {
  connect as netConnect,
  createServer as createNetServer,
  type Server as NetServer,
  type Socket,
} from "node:net";
import { createServer as createTlsServer, type Server, type TLSSocket } from "node:tls";
import { limitConnectionsPerSource } from "./per-source.js";
import {
  readLine,
  type PoolRelayAnswer,
  type PoolRelayGrant,
  type PoolRelayHello,
} from "@opensteer/shared/poolRelay";

export type RelayDecision =
  | {
      readonly ok: true;
      readonly target: { readonly host: string; readonly port: number };
      readonly grant: PoolRelayGrant;
      readonly signature: string;
    }
  | { readonly ok: false; readonly code: "refused" | "parked" | "unavailable" };

export interface RelayServerOptions {
  /** The relay's own key (not the host's signing key) and a self-signed certificate for it. */
  readonly key: string;
  readonly certificate: string;
  /** The agent's decision for one hello and the client's key (SPKI DER, base64). */
  readonly authorize: (hello: PoolRelayHello, clientKey: string) => Promise<RelayDecision>;
  readonly connect?: (target: { host: string; port: number }) => Socket;
  readonly log?: (event: Readonly<Record<string, unknown>>) => void;
  readonly helloTimeoutMs?: number;
}

export const relayMaximumConnections = 1024;
/**
 * One Home's share of the relay. From the code, a Home holds one tunnel per open bridge stream
 * of its one browser (its runtime control channel, and one per attached page or CDP session);
 * 64 is room for that, and 16 Homes would be needed to take the whole relay.
 */
export const relayConnectionsPerSource = 64;

export function createRelayServer(options: RelayServerOptions): Server {
  const server = createTlsServer(
    {
      key: options.key,
      cert: options.certificate,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      requestCert: true,
      // No authority: the client's key is checked against the slot's, by the agent.
      rejectUnauthorized: false,
    },
    (socket) => void tunnel(socket, options),
  );
  server.maxConnections = relayMaximumConnections;
  limitConnectionsPerSource(
    server,
    relayConnectionsPerSource,
    options.log ? { listener: "relay", log: options.log } : undefined,
  );
  // A failed handshake is the client's; it never stops the listener.
  server.on("tlsClientError", () => undefined);
  return server;
}

async function tunnel(socket: TLSSocket, options: RelayServerOptions): Promise<void> {
  const answer = (value: PoolRelayAnswer): void => {
    socket.end(`${JSON.stringify(value)}\n`);
  };
  socket.on("error", () => socket.destroy());
  const peer = socket.getPeerX509Certificate();
  if (!peer) return void socket.destroy();
  const clientKey = peer.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const timer = setTimeout(() => socket.destroy(), options.helloTimeoutMs ?? 5_000);
  let hello: PoolRelayHello;
  try {
    hello = parseHello(await readLine(socket, 1024));
  } catch {
    clearTimeout(timer);
    return void socket.destroy();
  } finally {
    clearTimeout(timer);
  }
  let decision: RelayDecision;
  try {
    decision = await options.authorize(hello, clientKey);
  } catch {
    decision = { ok: false, code: "unavailable" };
  }
  options.log?.({
    event: "relay.hello",
    slotId: hello.slot,
    outcome: decision.ok ? "granted" : decision.code,
  });
  if (!decision.ok) return answer({ ok: false, code: decision.code });
  const upstream = (options.connect ?? ((target) => netConnect(target)))(decision.target);
  upstream.once("error", () => {
    if (!socket.writableEnded) answer({ ok: false, code: "unavailable" });
    socket.destroy();
  });
  upstream.once("connect", () => {
    upstream.removeAllListeners("error");
    upstream.on("error", () => socket.destroy());
    upstream.setNoDelay(true);
    socket.setNoDelay(true);
    socket.write(
      `${JSON.stringify({ ok: true, grant: decision.grant, signature: decision.signature })}\n`,
    );
    socket.pipe(upstream);
    upstream.pipe(socket);
    socket.resume();
    socket.once("close", () => upstream.destroy());
    upstream.once("close", () => socket.destroy());
  });
}

function parseHello(line: string): PoolRelayHello {
  const value = JSON.parse(line) as Partial<PoolRelayHello>;
  if (
    value.v !== 1 ||
    typeof value.slot !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(value.slot) ||
    !Number.isSafeInteger(value.term) ||
    (value.term ?? 0) < 1 ||
    typeof value.nonce !== "string" ||
    !/^[A-Za-z0-9_-]{22}$/u.test(value.nonce)
  )
    throw new Error("The relay hello is malformed.");
  return { v: 1, slot: value.slot, term: value.term!, nonce: value.nonce };
}

/**
 * The agent's side of the relay's question, on a Unix socket only the relay's user may open:
 * one JSON line in (the hello and the client's key), one decision out.
 */
export function createRelayAuthServer(
  authorize: (hello: PoolRelayHello, clientKey: string) => RelayDecision,
): NetServer {
  const server = createNetServer((socket) => {
    socket.on("error", () => socket.destroy());
    socket.setTimeout(5_000, () => socket.destroy());
    void readLine(socket, 4096).then(
      (line) => {
        let decision: RelayDecision;
        try {
          const { hello, clientKey } = JSON.parse(line) as {
            hello: unknown;
            clientKey: unknown;
          };
          if (typeof clientKey !== "string" || clientKey.length > 256)
            throw new Error("The client key is malformed.");
          decision = authorize(parseHello(JSON.stringify(hello)), clientKey);
        } catch {
          decision = { ok: false, code: "refused" };
        }
        socket.end(`${JSON.stringify(decision)}\n`);
      },
      () => socket.destroy(),
    );
  });
  server.maxConnections = relayMaximumConnections;
  return server;
}

/** The relay process asks the agent over its Unix socket. */
export function relayAuthClient(
  path: string,
): (hello: PoolRelayHello, clientKey: string) => Promise<RelayDecision> {
  return (hello, clientKey) =>
    new Promise<RelayDecision>((resolve, reject) => {
      const socket = netConnect(path);
      socket.setTimeout(5_000, () => socket.destroy(new Error("The agent did not answer.")));
      socket.once("error", reject);
      socket.once("connect", () => socket.write(`${JSON.stringify({ hello, clientKey })}\n`));
      readLine(socket, 16 * 1024).then((line) => {
        socket.destroy();
        resolve(JSON.parse(line) as RelayDecision);
      }, reject);
    });
}
