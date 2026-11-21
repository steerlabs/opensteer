/**
 * The Home's real controller: the pool agent on the slot's pool host, over a signed request and
 * a signed reply. Used only for a managed pooled target; a Home without one never builds it.
 */
import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import {
  callBrowserPoolAgent,
  type BrowserPoolAgentRequest,
} from "@opensteer/browser-runtime-core/browser-pool-agent-wire";
import type {
  BrowserPoolControllerCall,
  BrowserPoolControllerResult,
  BrowserPoolPhysicalController,
  BrowserPoolPhysicalStatus,
} from "./browser-pool-controller.js";

/**
 * `BrowserPoolAgentSlotDeleted`: a signed answer that the slot was deleted (the guest ended,
 * its saved state erased); the coordinator can treat it as evidence of the end. Anything else
 * that fails is `BrowserPoolAgentUnavailable`: the outcome is not known.
 */
export {
  BrowserPoolAgentSlotDeleted,
  BrowserPoolAgentUnavailable,
} from "@opensteer/browser-runtime-core/browser-pool-agent-wire";

export interface BrowserPoolAgentClientOptions {
  /** The agent's Home interface, such as `http://10.128.0.7:7310`. */
  readonly url: string;
  /** The Home's Ed25519 private key for this slot. */
  readonly homeKey: KeyObject;
  /** The slot's control key (public): every reply must be signed by it, but one. */
  readonly agentKey: KeyObject;
  /**
   * The pool host's key (public). It alone signs the answer that the slot was deleted; without
   * it that answer reads as the agent being unavailable.
   */
  readonly hostKey?: KeyObject;
  /** One request's deadline; the journal above settles a call past it by its id. */
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export class BrowserPoolAgentClient implements BrowserPoolPhysicalController {
  readonly #options: BrowserPoolAgentClientOptions;

  constructor(options: BrowserPoolAgentClientOptions) {
    if (options.homeKey.type !== "private" || options.homeKey.asymmetricKeyType !== "ed25519")
      throw new TypeError("The Home key must be an Ed25519 private key.");
    if (options.agentKey.type !== "public" || options.agentKey.asymmetricKeyType !== "ed25519")
      throw new TypeError("The agent key must be an Ed25519 public key.");
    if (
      options.hostKey &&
      (options.hostKey.type !== "public" || options.hostKey.asymmetricKeyType !== "ed25519")
    )
      throw new TypeError("The host key must be an Ed25519 public key.");
    this.#options = options;
  }

  async status(slotId: string, term: number): Promise<BrowserPoolPhysicalStatus> {
    const reply = await this.#send(slotId, term, { op: "status" });
    if (reply.op !== "status") throw new Error(`The pool agent answered ${reply.op}.`);
    return reply.status;
  }

  async result(
    slotId: string,
    term: number,
    id: string,
  ): Promise<BrowserPoolControllerResult | null> {
    const reply = await this.#send(slotId, term, { op: "result", id });
    if (reply.op !== "result") throw new Error(`The pool agent answered ${reply.op}.`);
    return reply.result;
  }

  async apply(call: BrowserPoolControllerCall): Promise<BrowserPoolControllerResult> {
    const reply = await this.#send(call.slotId, call.term, { op: "apply", call });
    if (reply.op !== "apply") throw new Error(`The pool agent answered ${reply.op}.`);
    return reply.result;
  }

  #send(slotId: string, term: number, request: BrowserPoolAgentRequest) {
    return callBrowserPoolAgent(this.#options, slotId, term, request);
  }
}

/** How a Home is told about a managed pooled target; absent for every other Home. */
export interface ManagedBrowserPoolTarget {
  readonly kind: "managed-pool";
  readonly agentUrl: string;
  readonly slotId: string;
  readonly term: number;
  /** PKCS#8 DER, base64, of the Home's slot key. */
  readonly homeKey: string;
  /** SPKI DER, base64, of the slot's control key, as the provisioner received it. */
  readonly agentKey: string;
  /** SPKI DER, base64, of the pool host's key, which the provisioner pinned at enrolment. */
  readonly hostKey?: string;
}

/**
 * The controller for a target: the agent client only for a managed pooled target. Any other
 * target has no physical controller from here, so an ordinary Home builds nothing.
 */
export function managedBrowserPoolController(
  target: ManagedBrowserPoolTarget,
  options: Pick<BrowserPoolAgentClientOptions, "timeoutMs" | "fetch" | "now"> = {},
): BrowserPoolAgentClient {
  if (target.kind !== "managed-pool") throw new TypeError("Not a managed pooled target.");
  return new BrowserPoolAgentClient({
    url: target.agentUrl,
    homeKey: createPrivateKey({
      key: Buffer.from(target.homeKey, "base64"),
      format: "der",
      type: "pkcs8",
    }),
    agentKey: createPublicKey({
      key: Buffer.from(target.agentKey, "base64"),
      format: "der",
      type: "spki",
    }),
    ...(target.hostKey
      ? {
          hostKey: createPublicKey({
            key: Buffer.from(target.hostKey, "base64"),
            format: "der",
            type: "spki",
          }),
        }
      : {}),
    ...options,
  });
}
