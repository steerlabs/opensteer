/**
 * The wire between a Home and the pool agent that owns its browser's micro-VM, and between the
 * provisioner and that agent. Both directions are signed with Ed25519: a request by the slot's
 * Home (or by the provisioner, for slot administration), a reply by the slot's control key, so a
 * party on the path can neither act for the Home nor answer for the agent.
 */
import { createHash, sign, verify, type KeyObject } from "node:crypto";
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
 * A refusal of the request itself, before any slot state was read: the caller is not the
 * slot's Home, the envelope is stale or malformed, or the slot is not here. Nothing happened.
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
  /** Egress upstream for the slot's host-side proxy; absent means direct public egress. */
  readonly egress?: { readonly upstreamUrl: string; readonly credentialFile?: string };
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
