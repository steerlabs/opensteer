import type { z } from "zod";
import { verify as verifySignature } from "node:crypto";
import {
  BrowserAttachTicketClaimsSchema,
  BrowserPreparationTicketClaimsSchema,
  type BrowserPreparationTicketClaims,
  type BrowserAttachTicketClaims,
} from "@opensteer/protocol/browser";
import { decodeBase64Url } from "@opensteer/shared/base64url";
import { normalizeEd25519PublicKey, type Ed25519KeySource } from "@opensteer/shared/proof";
import { BrowserRuntimeError } from "../errors.js";
import { AttachTicketReplayLedgerError, DurableAttachTicketReplayLedger } from "./replay-ledger.js";

const compactTokenPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const ticketType = "opensteer-browser-attach+jwt";

export interface AttachTicketExpectation {
  now?: Date;
  runtimeId: string;
}

export interface AttachTicketVerifier {
  verify(token: string, expectation: AttachTicketExpectation): Promise<BrowserAttachTicketClaims>;
  verifyPreparation?(
    token: string,
    expectation: AttachTicketExpectation,
  ): Promise<BrowserPreparationTicketClaims>;
}

export type PublicKeySource = Ed25519KeySource;
export type PublicKeyResolver = (
  keyId: string,
) => Promise<PublicKeySource | null> | PublicKeySource | null;

export interface Ed25519AttachTicketVerifierOptions {
  clockSkewMs?: number;
  initializationNow?: Date;
  maxReplayEntries?: number;
  maxReplayFileBytes?: number;
  maxTicketBytes?: number;
  maxTicketLifetimeMs?: number;
  replayLedgerPath: string;
  resolvePublicKey: PublicKeyResolver;
}

interface TicketHeader {
  alg: "EdDSA";
  kid: string;
  typ: string;
}

export class Ed25519AttachTicketVerifier implements AttachTicketVerifier {
  private readonly clockSkewMs: number;
  private readonly maxTicketBytes: number;
  private readonly maxTicketLifetimeMs: number;
  private readonly replayLedger: DurableAttachTicketReplayLedger;
  private readonly resolvePublicKey: PublicKeyResolver;

  private constructor(
    options: Ed25519AttachTicketVerifierOptions,
    replayLedger: DurableAttachTicketReplayLedger,
  ) {
    this.clockSkewMs = options.clockSkewMs ?? 5_000;
    this.maxTicketBytes = options.maxTicketBytes ?? 16_384;
    this.maxTicketLifetimeMs = options.maxTicketLifetimeMs ?? 5 * 60_000;
    this.replayLedger = replayLedger;
    this.resolvePublicKey = options.resolvePublicKey;
  }

  static async create(
    options: Ed25519AttachTicketVerifierOptions,
  ): Promise<Ed25519AttachTicketVerifier> {
    let replayLedger: DurableAttachTicketReplayLedger;
    try {
      replayLedger = await DurableAttachTicketReplayLedger.open({
        filePath: options.replayLedgerPath,
        ...(options.maxReplayEntries === undefined ? {} : { maxEntries: options.maxReplayEntries }),
        ...(options.maxReplayFileBytes === undefined
          ? {}
          : { maxFileBytes: options.maxReplayFileBytes }),
        ...(options.initializationNow === undefined ? {} : { now: options.initializationNow }),
      });
    } catch (error) {
      throw replayUnavailable(error);
    }
    return new Ed25519AttachTicketVerifier(options, replayLedger);
  }

  async verify(
    token: string,
    expectation: AttachTicketExpectation,
  ): Promise<BrowserAttachTicketClaims> {
    return this.verifyClaims(token, expectation, BrowserAttachTicketClaimsSchema, ticketType);
  }

  async verifyPreparation(
    token: string,
    expectation: AttachTicketExpectation,
  ): Promise<BrowserPreparationTicketClaims> {
    return this.verifyClaims(
      token,
      expectation,
      BrowserPreparationTicketClaimsSchema,
      "opensteer-browser-prepare+jwt",
    );
  }

  private async verifyClaims<
    Claims extends Pick<
      BrowserAttachTicketClaims,
      "runtimeId" | "issuedAt" | "expiresAt" | "nonce"
    >,
  >(
    token: string,
    expectation: AttachTicketExpectation,
    schema: z.ZodType<Claims>,
    typ: string,
  ): Promise<Claims> {
    if (
      Buffer.byteLength(token, "utf8") > this.maxTicketBytes ||
      !compactTokenPattern.test(token)
    ) {
      throw forbidden("The browser attach ticket is malformed.");
    }

    const segments = token.split(".");
    const protectedSegment = segments[0];
    const payloadSegment = segments[1];
    const signatureSegment = segments[2];
    if (!protectedSegment || !payloadSegment || !signatureSegment) {
      throw forbidden("The browser attach ticket is malformed.");
    }

    const header = parseHeader(decodeJson(protectedSegment), typ);
    const keySource = await this.resolvePublicKey(header.kid);
    if (!keySource) throw forbidden("The browser attach ticket key is not trusted.");
    const key = normalizeEd25519PublicKey(keySource, attachTicketKeyFailure);
    const signature = ticketSegmentBytes(signatureSegment);
    if (signature.byteLength !== 64) {
      throw forbidden("The browser attach ticket signature is invalid.");
    }

    const valid = verifySignature(
      null,
      Buffer.from(`${protectedSegment}.${payloadSegment}`, "ascii"),
      key,
      signature,
    );
    if (!valid) throw forbidden("The browser attach ticket signature is invalid.");

    const parsedClaims = schema.safeParse(decodeJson(payloadSegment));
    if (!parsedClaims.success) throw forbidden("The browser attach ticket claims are invalid.");
    const claims = parsedClaims.data;
    const now = (expectation.now ?? new Date()).getTime();
    validateClaims(claims, expectation.runtimeId, now, this.clockSkewMs, this.maxTicketLifetimeMs);
    try {
      await this.replayLedger.claim(claims.nonce, Date.parse(claims.expiresAt), now);
    } catch (error) {
      if (error instanceof AttachTicketReplayLedgerError) {
        if (error.code === "already-used") {
          throw forbidden("The browser attach ticket has already been used.");
        }
        if (error.code === "full") {
          throw forbidden("The browser attach ticket replay ledger is full.");
        }
      }
      throw replayUnavailable(error);
    }
    return claims;
  }
}

function decodeJson(segment: string): unknown {
  try {
    return JSON.parse(ticketSegmentBytes(segment).toString("utf8"));
  } catch (error) {
    throw forbidden("The browser attach ticket is malformed.", error);
  }
}

/**
 * A JWS segment has one unpadded base64url spelling. Accepting a second one
 * would let a forged token reuse a signature over different bytes.
 */
function ticketSegmentBytes(segment: string): Buffer {
  try {
    return Buffer.from(decodeBase64Url(segment));
  } catch {
    throw forbidden("The browser attach ticket is malformed.");
  }
}

function parseHeader(value: unknown, typ: string): TicketHeader {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw forbidden("The browser attach ticket header is invalid.");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "alg" ||
    keys[1] !== "kid" ||
    keys[2] !== "typ" ||
    record.alg !== "EdDSA" ||
    record.typ !== typ ||
    typeof record.kid !== "string" ||
    record.kid.length < 1 ||
    record.kid.length > 255
  ) {
    throw forbidden("The browser attach ticket header is invalid.");
  }
  return { alg: "EdDSA", kid: record.kid, typ };
}

function attachTicketKeyFailure(kind: "unreadable" | "not-ed25519", cause?: unknown): Error {
  return kind === "unreadable"
    ? forbidden("The browser attach ticket key is invalid.", cause)
    : forbidden("The browser attach ticket key is not an Ed25519 public key.");
}

function validateClaims(
  claims: Pick<BrowserAttachTicketClaims, "runtimeId" | "issuedAt" | "expiresAt">,
  runtimeId: string,
  now: number,
  clockSkewMs: number,
  maxTicketLifetimeMs: number,
): void {
  const issuedAt = Date.parse(claims.issuedAt);
  const expiresAt = Date.parse(claims.expiresAt);
  if (claims.runtimeId !== runtimeId)
    throw forbidden("The browser attach ticket targets another runtime.");
  if (issuedAt > now + clockSkewMs) throw forbidden("The browser attach ticket is not active yet.");
  if (expiresAt <= now) throw forbidden("The browser attach ticket has expired.");
  if (expiresAt <= issuedAt || expiresAt - issuedAt > maxTicketLifetimeMs) {
    throw forbidden("The browser attach ticket lifetime is invalid.");
  }
}

function forbidden(message: string, cause?: unknown): BrowserRuntimeError {
  return new BrowserRuntimeError("forbidden", message, { cause });
}

function replayUnavailable(cause: unknown): BrowserRuntimeError {
  return forbidden("The browser attach ticket replay ledger is unavailable.", cause);
}
