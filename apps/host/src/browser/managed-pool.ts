/**
 * A managed pooled target's parts (pool-runtime-in-guest.md, "What to build" 5): the agent
 * client, the runtime's signed-control channel through the relay, and the bridge transport the
 * Runner's side uses. Selected only by a managed-pool target in configuration, which no
 * released Home has; nothing here runs for any other Home.
 */
import type {
  BrowserPoolControl,
  BrowserPoolEndAnswer,
  BrowserPoolRuntimeState,
} from "@opensteer/browser-runtime-core";
import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import type { Duplex } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import {
  PoolRelayRefused,
  poolRelayTransport,
  requestOverTunnel,
  type PoolRelayEndpoint,
} from "@opensteer/shared/poolRelay";
import {
  managedBrowserPoolController,
  type ManagedBrowserPoolTarget,
} from "./browser-pool-agent-client.js";
import type { BrowserPoolRuntimeChannel } from "./browser-pool-coordinator.js";
import type { BrowserPoolPhysicalStatus } from "./browser-pool-controller.js";

type Transport = ReturnType<typeof poolRelayTransport>;

/** What the agent's signed status says of the slot's guest, read now. */
type GuestStatus = (signal?: AbortSignal) => Promise<BrowserPoolPhysicalStatus>;

interface PooledControlTunnel {
  readonly agent: HttpAgent;
  readonly socket: Duplex;
  readonly bridgeToken: string;
  onIdleClose?: () => void;
}

function isReusableTunnelSocket(socket: Duplex): boolean {
  return socket.readable && socket.writable && !socket.destroyed;
}

function destroyPooledTunnel(tunnel: PooledControlTunnel): void {
  if (tunnel.onIdleClose) {
    tunnel.socket.off("close", tunnel.onIdleClose);
    delete tunnel.onIdleClose;
  }
  tunnel.agent.destroy();
  tunnel.socket.destroy();
}

function createPooledTunnel(socket: Duplex, bridgeToken: string): PooledControlTunnel {
  let handedOut = false;
  const agent = new HttpAgent({ keepAlive: true, maxSockets: 1 });
  // Node's `http.request({ agent: false })` destroys sockets on response end, so a single-socket
  // `HttpAgent` carries keep-alive while this channel owns checkout (never queuing a second call).
  // Defensively report any unexpected second socket ask via callback so `createConnection` never throws.
  agent.createConnection = ((
    _options: unknown,
    callback?: (error: Error | null, socket?: Duplex) => void,
  ) => {
    if (handedOut) {
      callback?.(new Error("The wake's control tunnel is closed."));
      return undefined;
    }
    handedOut = true;
    return socket;
  }) as unknown as typeof agent.createConnection;
  return { agent, socket, bridgeToken };
}

/**
 * The runtime's pool control in the guest, reached through the relay. Its state is read when
 * asked, never kept: the coordinator asks again on a later turn whenever it is not known.
 */
export class RelayBrowserPoolRuntimeChannel implements BrowserPoolRuntimeChannel {
  readonly #transport: Transport;
  readonly #guest: GuestStatus | undefined;
  readonly #controlTimeoutMs: number;
  #wakeDepth = 0;
  #openingPooled = false;
  #activePooled: PooledControlTunnel | undefined;
  #idlePooled: PooledControlTunnel | undefined;

  /**
   * `guest`: the agent's signed status, which says whether there is a runtime to ask.
   * `controlTimeoutMs`: the bound of a control's request on its tunnel (30 s): past it the
   * tunnel is ended, and the control's outcome is read with the state later.
   */
  constructor(
    transport: Transport,
    guest?: GuestStatus,
    options: { readonly controlTimeoutMs?: number } = {},
  ) {
    this.#transport = transport;
    this.#guest = guest;
    this.#controlTimeoutMs = options.controlTimeoutMs ?? 30_000;
  }

  /** Reuses one HTTP/1.1 keep-alive control tunnel across a wake; closes it when done. */
  beginWake(): () => void {
    this.#wakeDepth++;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.#wakeDepth--;
      if (this.#wakeDepth === 0) this.#dropPooled();
    };
  }

  #takeIdlePooled(): PooledControlTunnel | undefined {
    const current = this.#idlePooled;
    if (!current) return undefined;
    this.#idlePooled = undefined;
    if (current.onIdleClose) {
      current.socket.off("close", current.onIdleClose);
      delete current.onIdleClose;
    }
    if (!isReusableTunnelSocket(current.socket)) {
      destroyPooledTunnel(current);
      return undefined;
    }
    return current;
  }

  #parkIdlePooled(tunnel: PooledControlTunnel): void {
    if (this.#wakeDepth === 0 || this.#idlePooled || !isReusableTunnelSocket(tunnel.socket)) {
      destroyPooledTunnel(tunnel);
      return;
    }
    const onIdleClose = () => {
      if (this.#idlePooled === tunnel) this.#idlePooled = undefined;
      destroyPooledTunnel(tunnel);
    };
    tunnel.onIdleClose = onIdleClose;
    tunnel.socket.once("close", onIdleClose);
    this.#idlePooled = tunnel;
  }

  #dropPooled(): void {
    const idle = this.#idlePooled;
    const active = this.#activePooled;
    this.#idlePooled = undefined;
    this.#activePooled = undefined;
    if (idle) destroyPooledTunnel(idle);
    if (active && active !== idle) destroyPooledTunnel(active);
  }

  /**
   * The runtime's state, read through the relay now. `null` when there is no runtime to ask:
   * the relay says the guest is not running and the agent's signed status says it is stopped
   * or paused. Anything else that does not answer (the relay, a running guest with a step
   * still open, a lost reply, the caller's signal) throws: not known yet, asked again later.
   */
  async poolState(signal?: AbortSignal): Promise<BrowserPoolRuntimeState | null> {
    try {
      const answer = await this.#send("GET", "/v1/pool/state", undefined, signal);
      if (answer.status !== 200) throw new Error(`The runtime answered ${answer.status}.`);
      const state = (JSON.parse(answer.text) as { state?: BrowserPoolRuntimeState }).state;
      if (!state) throw new Error("The runtime answered without its state.");
      return state;
    } catch (error) {
      if (!(error instanceof PoolRelayRefused) || error.code !== "parked" || !this.#guest)
        throw error;
      const status = await this.#guest(signal);
      if (status.phase === "stopped" || status.phase === "paused") return null;
      throw error;
    }
  }

  async controlPool(
    control: BrowserPoolControl,
    signature: Uint8Array,
  ): Promise<BrowserPoolRuntimeState> {
    // A lost answer may or may not have applied: its outcome is read with the state later.
    const answer = await this.#send(
      "POST",
      "/v1/pool/control",
      JSON.stringify({ control, signature: Buffer.from(signature).toString("base64") }),
      AbortSignal.timeout(this.#controlTimeoutMs),
    );
    const body = JSON.parse(answer.text || "{}") as {
      state?: BrowserPoolRuntimeState;
      code?: string;
      message?: string;
      reason?: string;
    };
    if (answer.status !== 200 || !body.state)
      throw Object.assign(
        new Error(body.message ?? `The runtime refused the ${control.kind} control.`),
        body.reason ? { reason: body.reason } : {},
      );
    return body.state;
  }

  /**
   * The Home's request to end one session (P15). Not sent twice: an answer that did not come is
   * not knowing, and the end step asks again with a new ticket.
   */
  async endSession(ticket: string, signal?: AbortSignal): Promise<BrowserPoolEndAnswer> {
    const answer = await this.#send("POST", "/v1/pool/end", JSON.stringify({ ticket }), signal);
    const body = JSON.parse(answer.text || "{}") as Partial<BrowserPoolEndAnswer> & {
      message?: string;
    };
    if (answer.status !== 200 || !body.outcome || !body.state)
      throw new Error(body.message ?? `The runtime answered ${answer.status}.`);
    return { outcome: body.outcome, state: body.state };
  }

  /**
   * A tunnel the relay could not connect (`unavailable`: a runtime still starting, say) carried
   * nothing, so it is opened again for a while; anything sent is never sent twice.
   */
  async #open(signal?: AbortSignal) {
    const until = Date.now() + 30_000;
    for (let wait = 100; ; wait = Math.min(wait * 2, 2_000)) {
      try {
        return await this.#transport.open();
      } catch (error) {
        if (!(error instanceof PoolRelayRefused) || error.code !== "unavailable") throw error;
        if (Date.now() + wait > until || signal?.aborted) throw error;
        // The wait ends with the signal, and nothing is opened after it fired.
        await delay(wait, undefined, signal ? { signal } : {});
      }
    }
  }

  async #sendOneShot(method: "GET" | "POST", path: string, body?: string, signal?: AbortSignal) {
    const { socket, bridgeToken } = await this.#open(signal);
    if (signal?.aborted) {
      socket.destroy();
      throw signal.reason;
    }
    return requestOverTunnel(socket, {
      method,
      path,
      maximumBytes: 1024 * 1024,
      headers: {
        "x-opensteer-browser-bridge-token": bridgeToken,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body === undefined ? {} : { body }),
      ...(signal ? { signal } : {}),
    });
  }

  async #send(method: "GET" | "POST", path: string, body?: string, signal?: AbortSignal) {
    // The kept wake tunnel is an optimisation, never a constraint: if another call is opening or
    // holding it, open an independent one-shot tunnel instead of queuing behind a stalled request.
    if (this.#wakeDepth === 0 || this.#openingPooled || this.#activePooled) {
      return this.#sendOneShot(method, path, body, signal);
    }
    let current = this.#takeIdlePooled();
    if (!current) {
      this.#openingPooled = true;
      let opened: { readonly socket: Duplex; readonly bridgeToken: string };
      try {
        opened = await this.#open(signal);
      } finally {
        this.#openingPooled = false;
      }
      if (signal?.aborted) {
        opened.socket.destroy();
        throw signal.reason;
      }
      if (this.#wakeDepth === 0) {
        return requestOverTunnel(opened.socket, {
          method,
          path,
          maximumBytes: 1024 * 1024,
          headers: {
            "x-opensteer-browser-bridge-token": opened.bridgeToken,
            ...(body ? { "content-type": "application/json" } : {}),
          },
          ...(body === undefined ? {} : { body }),
          ...(signal ? { signal } : {}),
        });
      }
      current = createPooledTunnel(opened.socket, opened.bridgeToken);
    }
    this.#activePooled = current;
    let keep = false;
    try {
      // Never retry a request that failed after send (Rule 4): destroy the tunnel and rethrow so
      // the coordinator reads state on the next turn.
      const answer = await new Promise<{
        readonly status: number;
        readonly text: string;
        readonly keepAlive: boolean;
      }>((resolve, reject) => {
        let settled = false;
        let gotResponse = false;
        const finish = (
          error: unknown,
          result?: { readonly status: number; readonly text: string; readonly keepAlive: boolean },
        ) => {
          if (settled) return;
          settled = true;
          if (error !== null) reject(error);
          else resolve(result!);
        };
        const req = httpRequest(
          {
            agent: current.agent,
            method,
            path,
            host: "pool-guest",
            headers: {
              "x-opensteer-browser-bridge-token": current.bridgeToken,
              connection: "keep-alive",
              ...(body === undefined
                ? {}
                : {
                    "content-type": "application/json",
                    "content-length": String(Buffer.byteLength(body)),
                  }),
            },
            ...(signal ? { signal } : {}),
          },
          (response) => {
            gotResponse = true;
            const chunks: Buffer[] = [];
            let size = 0;
            response.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > 1024 * 1024) {
                response.destroy(new Error("The bridge answer exceeds its limit."));
                return;
              }
              chunks.push(chunk);
            });
            response.once("end", () =>
              finish(null, {
                status: response.statusCode ?? 0,
                text: Buffer.concat(chunks).toString("utf8"),
                keepAlive: response.headers.connection?.toLowerCase() !== "close",
              }),
            );
            response.once("error", (error) => finish(error));
            response.once("close", () => {
              if (!response.complete) finish(new Error("The bridge answer ended early."));
            });
          },
        );
        req.once("error", (error) => finish(error));
        req.once("close", () => {
          if (!gotResponse) finish(new Error("The wake's control tunnel closed."));
        });
        req.end(body);
        // `openPoolRelay` leaves the tunnel paused after reading its grant line; resume it for HTTP.
        current.socket.resume();
      });
      keep =
        this.#wakeDepth > 0 &&
        this.#activePooled === current &&
        answer.keepAlive &&
        isReusableTunnelSocket(current.socket);
      return { status: answer.status, text: answer.text };
    } finally {
      if (this.#activePooled === current) this.#activePooled = undefined;
      if (keep) this.#parkIdlePooled(current);
      else destroyPooledTunnel(current);
    }
  }
}

/** A managed pooled target's relay, as the provisioner hands it to the Home: public only. */
export interface ManagedBrowserPoolRelay {
  readonly host: string;
  readonly port: number;
  /** SPKI DER, base64, of the relay's own TLS key, pinned at enrolment (not the host key). */
  readonly relayHostKey: string;
}

/**
 * The Home's own keys for one slot (round D, D2): generated on the Home, they never leave it.
 * The provisioner receives only their public halves (`managedBrowserPoolRegistration`).
 */
export interface ManagedBrowserPoolHomeKeys {
  /** Signs the Home's calls to the agent. */
  readonly homeKey: KeyObject;
  /** Opens the relay's tunnels: the key (PKCS#8 PEM) and a self-signed certificate for it. */
  readonly relayKey: string;
  readonly relayCertificate: string;
  /** Signs the Home's attach tickets, which the guest's runtime alone trusts. */
  readonly ticketKey: { readonly keyId: string; readonly key: KeyObject };
}

/** What the Home hands the provisioner for a slot: the public halves of its three keys. */
export function managedBrowserPoolRegistration(keys: ManagedBrowserPoolHomeKeys): {
  readonly homeKey: string;
  readonly relayKey: string;
  readonly ticketKey: { readonly keyId: string; readonly spki: string };
} {
  const spkiOf = (key: KeyObject | string) =>
    (typeof key === "string" ? createPublicKey(createPrivateKey(key)) : createPublicKey(key))
      .export({ format: "der", type: "spki" })
      .toString("base64");
  return {
    homeKey: spkiOf(keys.homeKey),
    relayKey: spkiOf(keys.relayKey),
    ticketKey: { keyId: keys.ticketKey.keyId, spki: spkiOf(keys.ticketKey.key) },
  };
}

/**
 * A managed pooled target's parts, from what the provisioner handed the Home (public only) and
 * the Home's own keys.
 */
export function managedBrowserPool(
  target: ManagedBrowserPoolTarget & {
    readonly hostKey: string;
    readonly relay: ManagedBrowserPoolRelay;
  },
  keys: ManagedBrowserPoolHomeKeys,
  options: { readonly onTunnelOpen?: (ms: number) => void } = {},
) {
  const spki = (value: string) =>
    createPublicKey({ key: Buffer.from(value, "base64"), format: "der", type: "spki" });
  const endpoint: PoolRelayEndpoint = {
    host: target.relay.host,
    port: target.relay.port,
    relayHostKey: spki(target.relay.relayHostKey),
    controlKey: spki(target.agentKey),
    relayKey: keys.relayKey,
    relayCertificate: keys.relayCertificate,
    slot: target.slotId,
    term: target.term,
  };
  const rawTransport = poolRelayTransport(endpoint);
  const transport = options.onTunnelOpen
    ? {
        open: async () => {
          const startedAt = performance.now();
          const tunnel = await rawTransport.open();
          options.onTunnelOpen!(Math.round((performance.now() - startedAt) * 10) / 10);
          return tunnel;
        },
      }
    : rawTransport;
  const controller = managedBrowserPoolController(target, keys.homeKey);
  return {
    controller,
    runtime: new RelayBrowserPoolRuntimeChannel(transport, (signal) =>
      abortable(controller.status(target.slotId, target.term), signal),
    ),
    /** For the Runner's `LocalBrowserRuntimeBridge` (`transport`). */
    transport,
  };
}

/** Stops waiting for `work` when `signal` aborts (the work itself has its own deadline). */
function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
