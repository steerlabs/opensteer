/**
 * The wire between a Home and the pool agent that owns its browser's micro-VM, and between the
 * provisioner and that agent. Both directions are signed with Ed25519: a request by the slot's
 * Home (or by the provisioner, for slot administration), a reply by the slot's control key, so a
 * party on the path can neither act for the Home nor answer for the agent.
 */
import { createHash, randomUUID, sign, verify, type KeyObject } from "node:crypto";
import { canonicalJson } from "@opensteer/shared/canonicalJson";
import type { BrowserPoolControl, BrowserPoolIntent } from "./browser-pool.js";

export const browserPoolAgentWireVersion = 1;

/** A request older or newer than this is refused before anything else reads it. */
export const browserPoolAgentRequestWindowMs = 5 * 60_000;

export type BrowserPoolAgentPhase = "running" | "paused" | "stopped";

export interface BrowserPoolAgentSavedState {
  readonly id: string;
  readonly discardAt: string;
}

export interface BrowserPoolAgentStatus {
  readonly slotId: string;
  readonly term: number;
  readonly instance: string | null;
  readonly epoch: number | null;
  readonly phase: BrowserPoolAgentPhase;
  readonly savedState: BrowserPoolAgentSavedState | null;
}

export type BrowserPoolAgentKind = "start" | "pause" | "resume" | "stop" | "sign";

export interface BrowserPoolAgentExpectation {
  readonly instance: string | null;
  readonly epoch: number | null;
  readonly phase: BrowserPoolAgentPhase;
  readonly savedStateId: string | null;
}

/**
 * A call's id makes it idempotent while the agent keeps its answer: 24 hours, and never evicted
 * while younger than twice the request window. After that the id is unknown to the agent, and
 * what refuses a late repeat is the call's expected predecessor, which every call but `sign`
 * changes; a late `sign` of an unchanged guest would be signed again.
 */
export interface BrowserPoolAgentCall {
  readonly id: string;
  readonly slotId: string;
  readonly term: number;
  readonly kind: BrowserPoolAgentKind;
  readonly expect: BrowserPoolAgentExpectation;
  readonly control?: Omit<BrowserPoolControl, "sequence" | "expect">;
  readonly intent?: BrowserPoolIntent;
}

export interface BrowserPoolAgentResult {
  readonly id: string;
  readonly applied: boolean;
  readonly reason?: string;
  readonly status: BrowserPoolAgentStatus;
  readonly savedState?: BrowserPoolAgentSavedState;
  readonly control?: BrowserPoolControl;
  readonly signature?: string;
}

export type BrowserPoolAgentRequest =
  | { readonly op: "status" }
  | { readonly op: "result"; readonly id: string }
  | { readonly op: "apply"; readonly call: BrowserPoolAgentCall };

/** What a Home signs. `nonce` makes every envelope distinct; `issuedAt` bounds its life. */
export interface BrowserPoolAgentEnvelope {
  readonly v: typeof browserPoolAgentWireVersion;
  readonly slotId: string;
  readonly term: number;
  readonly issuedAt: string;
  readonly nonce: string;
  readonly request: BrowserPoolAgentRequest;
}

export type BrowserPoolAgentReply =
  | { readonly op: "status"; readonly status: BrowserPoolAgentStatus }
  | { readonly op: "result"; readonly result: BrowserPoolAgentResult | null }
  | { readonly op: "apply"; readonly result: BrowserPoolAgentResult }
  | { readonly op: "refused"; readonly code: BrowserPoolAgentRefusal; readonly message: string };

/**
 * A refusal of the request itself; nothing happened. `unauthenticated` (unsigned, 401) is also
 * the answer for a slot this agent never had, so nobody learns which slots exist.
 * `unknown-slot` is only ever sent signed, to the slot's own Home: the slot was deleted, its
 * guest ended and its saved state erased.
 */
export type BrowserPoolAgentRefusal =
  "unauthenticated" | "unknown-slot" | "stale-request" | "bad-request" | "unavailable";

/** The slot administration interface, for the provisioner only. */
export type BrowserPoolAgentAdminRequest =
  | {
      readonly op: "create";
      readonly slotId: string;
      readonly term: number;
      /** SPKI DER, base64, of the Home's Ed25519 key. */
      readonly homeKey: string;
      readonly guest: BrowserPoolAgentGuestSpec;
    }
  | {
      readonly op: "replace-key";
      readonly slotId: string;
      /** Must be above the slot's current term: the previous Home is fenced from here on. */
      readonly term: number;
      readonly homeKey: string;
    }
  | { readonly op: "delete"; readonly slotId: string }
  | { readonly op: "list" };

export interface BrowserPoolAgentGuestSpec {
  readonly vcpus: number;
  readonly memoryMib: number;
  /** The slot's durable profile disk on the host (a file or a block device). */
  readonly profilePath: string;
  /**
   * The upstream HTTPS proxy of the slot's host-side egress proxy, with root-only files on the
   * host holding its credentials; absent means direct public egress from the pool host.
   */
  readonly egress?: {
    readonly upstreamUrl: string;
    readonly usernameFile: string;
    readonly passwordFile: string;
    readonly caFile?: string;
  };
}

export interface BrowserPoolAgentAdminEnvelope {
  readonly v: typeof browserPoolAgentWireVersion;
  readonly issuedAt: string;
  readonly nonce: string;
  readonly request: BrowserPoolAgentAdminRequest;
}

export interface BrowserPoolAgentSlotSummary {
  readonly slotId: string;
  readonly term: number;
  /** SPKI DER, base64, of the slot's control key: the runtime and the Home verify with it. */
  readonly controlKey: string;
  readonly status: BrowserPoolAgentStatus;
  /** For the provisioner only: where a parked guest is, and how long its save took. */
  readonly parked?: { readonly tier: "memory" | "disk"; readonly writeMs?: number };
}

export type BrowserPoolAgentAdminReply =
  | { readonly op: "create" | "replace-key"; readonly slot: BrowserPoolAgentSlotSummary }
  | { readonly op: "delete"; readonly slotId: string; readonly erased: boolean }
  | { readonly op: "list"; readonly slots: readonly BrowserPoolAgentSlotSummary[] }
  | {
      readonly op: "refused";
      readonly code: BrowserPoolAgentRefusal | "conflict";
      readonly message: string;
    };

const requestDomain = "opensteer/browser-pool-agent/request/v1\n";
const replyDomain = "opensteer/browser-pool-agent/reply/v1\n";
const adminDomain = "opensteer/browser-pool-agent/admin/v1\n";

/** The exact bytes a signature covers. Canonical JSON makes them independent of key order. */
export function browserPoolAgentRequestBytes(envelope: BrowserPoolAgentEnvelope): Buffer {
  return Buffer.from(requestDomain + canonicalJson(envelope));
}

export function browserPoolAgentAdminBytes(envelope: BrowserPoolAgentAdminEnvelope): Buffer {
  return Buffer.from(adminDomain + canonicalJson(envelope));
}

/** A reply is bound to the one request it answers. */
export function browserPoolAgentReplyBytes(requestBytes: Uint8Array, reply: unknown): Buffer {
  const digest = createHash("sha256").update(requestBytes).digest("hex");
  return Buffer.from(`${replyDomain}${digest}\n${canonicalJson(reply)}`);
}

export function signBrowserPoolAgentBytes(bytes: Uint8Array, key: KeyObject): string {
  return sign(null, bytes, key).toString("base64");
}

export function verifyBrowserPoolAgentBytes(
  bytes: Uint8Array,
  key: KeyObject,
  signature: string,
): boolean {
  if (!/^[A-Za-z0-9+/]{86}==$/u.test(signature)) return false;
  return verify(null, bytes, key, Buffer.from(signature, "base64"));
}

/** The header that carries a signature; the body is the envelope itself. */
export const browserPoolAgentSignatureHeader = "x-opensteer-pool-signature";

export class BrowserPoolAgentUnavailable extends Error {
  override readonly name = "BrowserPoolAgentUnavailable";
}

/**
 * The agent answered, signed by the slot's control key, that the slot was deleted. Unlike an
 * unavailable agent this is evidence: the guest has ended and its saved state is erased.
 */
export class BrowserPoolAgentSlotDeleted extends Error {
  override readonly name = "BrowserPoolAgentSlotDeleted";
}

export interface BrowserPoolAgentEndpoint {
  /** Such as `http://10.128.0.7:7310`. */
  readonly url: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

/**
 * One signed request to the agent's Home interface. The reply must be signed by the slot's
 * control key for exactly this request; anything else (an unsigned refusal included) throws.
 */
export async function callBrowserPoolAgent(
  endpoint: BrowserPoolAgentEndpoint & {
    readonly homeKey: KeyObject;
    readonly agentKey: KeyObject;
  },
  slotId: string,
  term: number,
  request: BrowserPoolAgentRequest,
): Promise<Exclude<BrowserPoolAgentReply, { op: "refused" }>> {
  const envelope: BrowserPoolAgentEnvelope = {
    v: 1,
    slotId,
    term,
    issuedAt: new Date((endpoint.now ?? Date.now)()).toISOString(),
    nonce: randomUUID(),
    request,
  };
  const bytes = browserPoolAgentRequestBytes(envelope);
  const parsed = await post<BrowserPoolAgentReply>(endpoint, bytes, envelope, endpoint.homeKey);
  const reply = parsed.reply;
  if (
    !parsed.signature ||
    !verifyBrowserPoolAgentBytes(
      browserPoolAgentReplyBytes(bytes, reply),
      endpoint.agentKey,
      parsed.signature,
    )
  ) {
    const message = reply.op === "refused" ? `: ${reply.message}` : ".";
    throw new BrowserPoolAgentUnavailable(
      `The pool agent's reply is not signed by the slot${message}`,
    );
  }
  if (reply.op === "refused") {
    if (reply.code === "unknown-slot") throw new BrowserPoolAgentSlotDeleted(reply.message);
    throw new BrowserPoolAgentUnavailable(reply.message);
  }
  return reply;
}

/** One signed request to the agent's provisioner interface. */
export async function callBrowserPoolAgentAdmin(
  endpoint: BrowserPoolAgentEndpoint & { readonly provisionerKey: KeyObject },
  request: BrowserPoolAgentAdminRequest,
): Promise<Exclude<BrowserPoolAgentAdminReply, { op: "refused" }>> {
  const envelope: BrowserPoolAgentAdminEnvelope = {
    v: 1,
    issuedAt: new Date((endpoint.now ?? Date.now)()).toISOString(),
    nonce: randomUUID(),
    request,
  };
  const bytes = browserPoolAgentAdminBytes(envelope);
  const { reply } = await post<BrowserPoolAgentAdminReply>(
    endpoint,
    bytes,
    envelope,
    endpoint.provisionerKey,
  );
  if (reply.op === "refused") throw new BrowserPoolAgentUnavailable(reply.message);
  return reply;
}

async function post<Reply>(
  endpoint: BrowserPoolAgentEndpoint,
  bytes: Buffer,
  envelope: unknown,
  key: KeyObject,
): Promise<{ readonly reply: Reply; readonly signature?: string }> {
  const response = await (endpoint.fetch ?? fetch)(new URL("/v1", endpoint.url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [browserPoolAgentSignatureHeader]: signBrowserPoolAgentBytes(bytes, key),
    },
    body: JSON.stringify(envelope),
    signal: AbortSignal.timeout(endpoint.timeoutMs ?? 60_000),
    redirect: "error",
  });
  const text = await response.text();
  let parsed: { reply?: Reply; signature?: string };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new BrowserPoolAgentUnavailable(
      `The pool agent answered ${response.status} without a reply.`,
    );
  }
  if (!parsed.reply)
    throw new BrowserPoolAgentUnavailable("The pool agent answered without a reply.");
  return parsed as { reply: Reply; signature?: string };
}
