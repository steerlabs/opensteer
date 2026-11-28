/**
 * The pool relay (pool-runtime-in-guest.md, decisions 4 to 6): mutual TLS 1.3 with pinned keys
 * and nothing else. Each side presents a certificate for its own long-lived Ed25519 key and
 * checks the other's public key against the one it was given; no certificate authority. After
 * the handshake the client names its slot and term; the pool host answers, signed by the slot's
 * control key, with the instance it reaches and that instance's bridge token, and from then on
 * the connection carries the bridge protocol unchanged.
 */
import { randomBytes, verify, type KeyObject } from "node:crypto";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import type { Duplex } from "node:stream";

const maximumLineBytes = 4096;

/** What the client sends first, after the handshake. */
export interface PoolRelayHello {
  readonly v: 1;
  readonly slot: string;
  readonly term: number;
  /** 16 random bytes, base64url: the grant is signed for this connection alone. */
  readonly nonce: string;
}

/** The instance a tunnel reaches, and its bridge token. */
export interface PoolRelayGrant {
  readonly slot: string;
  readonly term: number;
  readonly instance: string;
  readonly epoch: number;
  readonly token: string;
}

export type PoolRelayAnswer =
  | { readonly ok: true; readonly grant: PoolRelayGrant; readonly signature: string }
  /**
   * `parked`: the slot's own Home asked while its guest is not running; it wakes it through
   * the agent. `refused`: anything else (an unknown slot, another key, another term), alike.
   */
  | { readonly ok: false; readonly code: "refused" | "parked" | "unavailable" };

export function poolRelayGrantBytes(nonce: string, grant: PoolRelayGrant): Buffer {
  return Buffer.from(
    JSON.stringify([
      "opensteer/browser-pool-relay/v1",
      nonce,
      grant.slot,
      grant.term,
      grant.instance,
      grant.epoch,
      grant.token,
    ]),
  );
}

export class PoolRelayRefused extends Error {
  override readonly name = "PoolRelayRefused";
  readonly code: "refused" | "parked" | "unavailable" | "relay-key" | "grant";

  constructor(code: PoolRelayRefused["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface PoolRelayEndpoint {
  readonly host: string;
  readonly port: number;
  /**
   * The relay's own public key, pinned: its certificate must be for it. It is not the host's
   * signing key, which only the agent holds (a compromised relay cannot forge an answer).
   */
  readonly relayHostKey: KeyObject;
  /** The slot's control key (public): it signs the grant. */
  readonly controlKey: KeyObject;
  /** This Home's relay key for the slot, and a certificate for it (PEM). */
  readonly relayKey: string;
  readonly relayCertificate: string;
  readonly slot: string;
  readonly term: number;
  readonly timeoutMs?: number;
}

/** A tunnel to the slot's bridge, with the token its grant carried. */
export interface PoolRelayTunnel {
  readonly socket: TLSSocket;
  readonly grant: PoolRelayGrant;
}

/** Opens one tunnel. Nothing is sent before the relay proved the pinned host key. */
export function openPoolRelay(endpoint: PoolRelayEndpoint): Promise<PoolRelayTunnel> {
  const nonce = randomBytes(16).toString("base64url");
  return new Promise<PoolRelayTunnel>((resolve, reject) => {
    const socket = tlsConnect({
      host: endpoint.host,
      port: endpoint.port,
      key: endpoint.relayKey,
      cert: endpoint.relayCertificate,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      // The pin decides, below; there is no authority and no name to check.
      rejectUnauthorized: false,
      ...(isIpAddress(endpoint.host) ? {} : { servername: endpoint.host }),
    });
    const timer = setTimeout(
      () => fail(new PoolRelayRefused("unavailable", "The pool relay did not answer in time.")),
      endpoint.timeoutMs ?? 10_000,
    );
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    const closed = () => fail(new PoolRelayRefused("unavailable", "The relay closed."));
    socket.once("error", fail);
    socket.once("close", closed);
    socket.once("secureConnect", () => {
      const peer = socket.getPeerX509Certificate();
      if (!peer || !peer.publicKey.equals(endpoint.relayHostKey))
        return fail(new PoolRelayRefused("relay-key", "The relay is not the pinned pool relay."));
      const hello: PoolRelayHello = { v: 1, slot: endpoint.slot, term: endpoint.term, nonce };
      socket.write(`${JSON.stringify(hello)}\n`);
      readLine(socket).then((line) => {
        const answer = JSON.parse(line) as PoolRelayAnswer;
        if (!answer.ok)
          return fail(new PoolRelayRefused(answer.code, `The pool relay answered ${answer.code}.`));
        const grant = answer.grant;
        if (
          grant.slot !== endpoint.slot ||
          grant.term !== endpoint.term ||
          !/^[0-9a-f]{64}$/u.test(grant.token) ||
          !verify(
            null,
            poolRelayGrantBytes(nonce, grant),
            endpoint.controlKey,
            Buffer.from(answer.signature, "base64"),
          )
        )
          return fail(new PoolRelayRefused("grant", "The relay's grant is not the slot's."));
        settled = true;
        clearTimeout(timer);
        socket.removeListener("error", fail);
        socket.removeListener("close", closed);
        resolve({ socket, grant });
      }, fail);
    });
  });
}

/**
 * Reads one line, then puts back whatever followed it for the next reader. The socket is left
 * paused: its next reader resumes it.
 */
export function readLine(socket: Duplex, maximumBytes = maximumLineBytes): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf(0x0a);
      if (end < 0) {
        if (buffered.length > maximumBytes) done(new Error("The relay line is too long."));
        return;
      }
      socket.removeListener("data", onData);
      socket.pause();
      const rest = buffered.subarray(end + 1);
      if (rest.length) socket.unshift(rest);
      resolve(buffered.subarray(0, end).toString("utf8"));
    };
    const done = (error: Error) => {
      socket.removeListener("data", onData);
      reject(error);
    };
    socket.on("data", onData);
    socket.once("error", done);
  });
}

/** One HTTP request over a tunnel the caller opened; the tunnel is closed afterwards. */
export function requestOverTunnel(
  socket: Duplex,
  input: {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly maximumBytes: number;
    readonly signal?: AbortSignal;
  },
): Promise<{
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly text: string;
}> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        method: input.method,
        path: input.path,
        host: "pool-guest",
        headers: {
          ...input.headers,
          connection: "close",
          ...(input.body === undefined
            ? {}
            : { "content-length": String(Buffer.byteLength(input.body)) }),
        },
        createConnection: () => socket as never,
        ...(input.signal ? { signal: input.signal } : {}),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > input.maximumBytes) {
            response.destroy(new Error("The bridge answer exceeds its limit."));
            return;
          }
          chunks.push(chunk);
        });
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        response.once("error", reject);
      },
    );
    request.once("error", reject);
    request.once("close", () => socket.destroy());
    request.end(input.body);
    socket.resume();
  });
}

function isIpAddress(host: string): boolean {
  return /^[0-9.]+$/u.test(host) || host.includes(":");
}

/** A bridge transport: each `open` is a fresh tunnel, with its grant's token. */
export function poolRelayTransport(endpoint: PoolRelayEndpoint): {
  open(): Promise<{
    readonly socket: TLSSocket;
    readonly bridgeToken: string;
    readonly grant: PoolRelayGrant;
  }>;
} {
  return {
    open: async () => {
      const tunnel = await openPoolRelay(endpoint);
      return { socket: tunnel.socket, bridgeToken: tunnel.grant.token, grant: tunnel.grant };
    },
  };
}
