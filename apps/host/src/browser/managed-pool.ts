/**
 * A managed pooled target's parts (pool-runtime-in-guest.md, "What to build" 5): the agent
 * client, the runtime's signed-control channel through the relay, and the bridge transport the
 * Runner's side uses. Selected only by a managed-pool target in configuration, which no
 * released Home has; nothing here runs for any other Home.
 */
import type { BrowserPoolControl, BrowserPoolRuntimeState } from "@opensteer/browser-runtime-core";
import { createPublicKey } from "node:crypto";
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

type Transport = ReturnType<typeof poolRelayTransport>;

/**
 * The runtime's pool control in the guest, reached through the relay. The coordinator reads its
 * state synchronously, so this keeps the last state the runtime itself answered; a control whose
 * answer was lost makes it unknown (undefined) until the runtime is read again, and it is read
 * again at once, so a stale state is never acted on.
 */
export class RelayBrowserPoolRuntimeChannel implements BrowserPoolRuntimeChannel {
  readonly #transport: Transport;
  #state: BrowserPoolRuntimeState | undefined;

  constructor(transport: Transport) {
    this.#transport = transport;
  }

  poolState(): BrowserPoolRuntimeState | undefined {
    return this.#state;
  }

  /** Reads the runtime's state now. */
  async refresh(signal?: AbortSignal): Promise<BrowserPoolRuntimeState | undefined> {
    try {
      const answer = await this.#send("GET", "/v1/pool/state", undefined, signal);
      if (answer.status !== 200) throw new Error(`The runtime answered ${answer.status}.`);
      this.#state = (JSON.parse(answer.text) as { state?: BrowserPoolRuntimeState }).state;
    } catch (error) {
      this.#state = undefined;
      throw error;
    }
    return this.#state;
  }

  async controlPool(
    control: BrowserPoolControl,
    signature: Uint8Array,
  ): Promise<BrowserPoolRuntimeState> {
    let answer: Awaited<ReturnType<typeof requestOverTunnel>>;
    try {
      answer = await this.#send(
        "POST",
        "/v1/pool/control",
        JSON.stringify({ control, signature: Buffer.from(signature).toString("base64") }),
      );
    } catch (error) {
      // The control may or may not have applied: the state is unknown until read.
      this.#state = undefined;
      await this.refresh(AbortSignal.timeout(5_000)).catch(() => undefined);
      throw error;
    }
    const body = JSON.parse(answer.text || "{}") as {
      state?: BrowserPoolRuntimeState;
      code?: string;
      message?: string;
    };
    this.#state = body.state;
    if (answer.status !== 200 || !body.state)
      throw new Error(body.message ?? `The runtime refused the ${control.kind} control.`);
    return body.state;
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

/** A managed pooled target's relay, as the provisioner hands it to the Home. */
export interface ManagedBrowserPoolRelay {
  readonly host: string;
  readonly port: number;
  /** PKCS#8 PEM of this Home's relay key for the slot, and a certificate for it. */
  readonly relayKey: string;
  readonly relayCertificate: string;
}

export function managedBrowserPool(
  target: ManagedBrowserPoolTarget & {
    readonly hostKey: string;
    readonly relay: ManagedBrowserPoolRelay;
  },
) {
  const spki = (value: string) =>
    createPublicKey({ key: Buffer.from(value, "base64"), format: "der", type: "spki" });
  const endpoint: PoolRelayEndpoint = {
    host: target.relay.host,
    port: target.relay.port,
    hostKey: spki(target.hostKey),
    controlKey: spki(target.agentKey),
    relayKey: target.relay.relayKey,
    relayCertificate: target.relay.relayCertificate,
    slot: target.slotId,
    term: target.term,
  };
  const transport = poolRelayTransport(endpoint);
  return {
    controller: managedBrowserPoolController(target),
    runtime: new RelayBrowserPoolRuntimeChannel(transport),
    /** For the Runner's `LocalBrowserRuntimeBridge` (`transport`). */
    transport,
  };
}
