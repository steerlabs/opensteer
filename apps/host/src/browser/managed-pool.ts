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

/**
 * The runtime's pool control in the guest, reached through the relay. Its state is read when
 * asked, never kept: the coordinator asks again on a later turn whenever it is not known.
 */
export class RelayBrowserPoolRuntimeChannel implements BrowserPoolRuntimeChannel {
  readonly #transport: Transport;
  readonly #guest: GuestStatus | undefined;
  readonly #controlTimeoutMs: number;
  #wakeDepth = 0;
  #pooled: { readonly agent: HttpAgent; readonly socket: Duplex; readonly bridgeToken: string } | undefined;

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

  #dropPooled(): void {
    const current = this.#pooled;
    if (!current) return;
    this.#pooled = undefined;
    current.agent.destroy();
    current.socket.destroy();
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

  async #send(method: "GET" | "POST", path: string, body?: string, signal?: AbortSignal) {
    if (this.#wakeDepth === 0) {
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
    let pooled = this.#pooled;
    if (!pooled || !pooled.socket.readable || !pooled.socket.writable || pooled.socket.destroyed) {
      this.#dropPooled();
      const { socket, bridgeToken } = await this.#open(signal);
      if (signal?.aborted) {
        socket.destroy();
        throw signal.reason;
      }
      let handedOut = false;
      const agent = new HttpAgent({ keepAlive: true, maxSockets: 1 });
      agent.createConnection = () => {
        if (handedOut) throw new Error("Pooled keep-alive tunnel already in use.");
        handedOut = true;
        return socket as never;
      };
      socket.once("close", () => {
        if (this.#pooled?.socket === socket) this.#dropPooled();
      });
      pooled = { agent, socket, bridgeToken };
      this.#pooled = pooled;
    }
    const current = pooled;
    // Never retry a request that failed after send (Rule 4): drop the socket and rethrow so the
    // coordinator reads state on the next turn.
    return new Promise<{ readonly status: number; readonly text: string }>((resolve, reject) => {
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
          response.once("end", () => {
            if (response.headers.connection?.toLowerCase() === "close") this.#dropPooled();
            resolve({
              status: response.statusCode ?? 0,
              text: Buffer.concat(chunks).toString("utf8"),
            });
          });
          response.once("error", (error) => {
            this.#dropPooled();
            reject(error);
          });
        },
      );
      req.once("error", (error) => {
        this.#dropPooled();
        reject(error);
      });
      req.end(body);
    });
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
