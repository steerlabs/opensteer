/**
 * The Home's real controller: the pool agent on the slot's pool host, over a signed request and
 * a signed reply. Used only for a managed pooled target; a Home without one never builds it.
 */
import { createPrivateKey, createPublicKey, randomUUID, type KeyObject } from "node:crypto";
import {
  browserPoolAgentReplyBytes,
  browserPoolAgentRequestBytes,
  browserPoolAgentSignatureHeader,
  signBrowserPoolAgentBytes,
  verifyBrowserPoolAgentBytes,
  type BrowserPoolAgentEnvelope,
  type BrowserPoolAgentReply,
  type BrowserPoolAgentRequest,
} from "@opensteer/browser-runtime-core/browser-pool-agent-wire";
import type {
  BrowserPoolControllerCall,
  BrowserPoolControllerResult,
  BrowserPoolPhysicalController,
  BrowserPoolPhysicalStatus,
} from "./browser-pool-controller.js";

export interface BrowserPoolAgentClientOptions {
  /** The agent's Home interface, such as `http://10.128.0.7:7310`. */
  readonly url: string;
  /** The Home's Ed25519 private key for this slot. */
  readonly homeKey: KeyObject;
  /** The slot's control key (public): every reply must be signed by it. */
  readonly agentKey: KeyObject;
  /** One request's deadline; the journal above settles a call past it by its id. */
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export class BrowserPoolAgentUnavailable extends Error {
  override readonly name = "BrowserPoolAgentUnavailable";
}

export class BrowserPoolAgentClient implements BrowserPoolPhysicalController {
  readonly #options: BrowserPoolAgentClientOptions;
  readonly #endpoint: string;

  constructor(options: BrowserPoolAgentClientOptions) {
    if (options.homeKey.type !== "private" || options.homeKey.asymmetricKeyType !== "ed25519")
      throw new TypeError("The Home key must be an Ed25519 private key.");
    if (options.agentKey.type !== "public" || options.agentKey.asymmetricKeyType !== "ed25519")
      throw new TypeError("The agent key must be an Ed25519 public key.");
    this.#options = options;
    this.#endpoint = new URL("/v1", options.url).toString();
  }

  async status(slotId: string, term: number): Promise<BrowserPoolPhysicalStatus> {
    const reply = await this.#send(slotId, term, { op: "status" });
    if (reply.op !== "status") throw unexpected(reply);
    return reply.status;
  }

  async result(
    slotId: string,
    term: number,
    id: string,
  ): Promise<BrowserPoolControllerResult | null> {
    const reply = await this.#send(slotId, term, { op: "result", id });
    if (reply.op !== "result") throw unexpected(reply);
    return reply.result;
  }

  async apply(call: BrowserPoolControllerCall): Promise<BrowserPoolControllerResult> {
    const reply = await this.#send(call.slotId, call.term, { op: "apply", call });
    if (reply.op !== "apply") throw unexpected(reply);
    return reply.result;
  }

  async #send(
    slotId: string,
    term: number,
    request: BrowserPoolAgentRequest,
  ): Promise<BrowserPoolAgentReply> {
    const envelope: BrowserPoolAgentEnvelope = {
      v: 1,
      slotId,
      term,
      issuedAt: new Date((this.#options.now ?? Date.now)()).toISOString(),
      nonce: randomUUID(),
      request,
    };
    const bytes = browserPoolAgentRequestBytes(envelope);
    const response = await (this.#options.fetch ?? fetch)(this.#endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [browserPoolAgentSignatureHeader]: signBrowserPoolAgentBytes(bytes, this.#options.homeKey),
      },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(this.#options.timeoutMs ?? 60_000),
      redirect: "error",
    });
    const text = await response.text();
    let parsed: { reply?: BrowserPoolAgentReply; signature?: string };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      throw new BrowserPoolAgentUnavailable(
        `The pool agent answered ${response.status} without a reply.`,
      );
    }
    const reply = parsed.reply;
    if (!reply) throw new BrowserPoolAgentUnavailable("The pool agent answered without a reply.");
    // An unsigned answer is never trusted, whatever it says; a refusal of the request is one.
    if (
      !parsed.signature ||
      !verifyBrowserPoolAgentBytes(
        browserPoolAgentReplyBytes(bytes, reply),
        this.#options.agentKey,
        parsed.signature,
      )
    ) {
      const message = reply.op === "refused" ? `: ${reply.message}` : "";
      throw new BrowserPoolAgentUnavailable(
        `The pool agent's reply is not signed by the slot${message}`,
      );
    }
    if (reply.op === "refused") throw new BrowserPoolAgentUnavailable(reply.message);
    return reply;
  }
}

function unexpected(reply: BrowserPoolAgentReply): Error {
  return new BrowserPoolAgentUnavailable(`The pool agent answered ${reply.op}.`);
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
    ...options,
  });
}
