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

  /** `guest`: the agent's signed status, which says whether there is a runtime to ask. */
  constructor(transport: Transport, guest?: GuestStatus) {
    this.#transport = transport;
    this.#guest = guest;
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
    );
    const body = JSON.parse(answer.text || "{}") as {
      state?: BrowserPoolRuntimeState;
      code?: string;
      message?: string;
    };
    if (answer.status !== 200 || !body.state)
      throw new Error(body.message ?? `The runtime refused the ${control.kind} control.`);
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
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }

  async #send(method: "GET" | "POST", path: string, body?: string, signal?: AbortSignal) {
    const { socket, bridgeToken } = await this.#open(signal);
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
  const transport = poolRelayTransport(endpoint);
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
