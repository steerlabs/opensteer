import {
  verifyAttachTicket,
  AttachTicketPolicyError,
} from "@opensteer/browser-core/attach-ticket-policy";
import { verify as verifySignature } from "node:crypto";
import {
  BrowserAttachTicketClaimsSchema,
  type BrowserAttachTicketClaims,
} from "@opensteer/protocol/browser";
import { decodeBase64Url } from "@opensteer/shared/base64url";
import { normalizeEd25519PublicKey, type Ed25519KeySource } from "@opensteer/shared/proof";
import { BrowserRuntimeError } from "../errors.js";
import { AttachTicketReplayLedgerError, DurableAttachTicketReplayLedger } from "./replay-ledger.js";

export interface AttachTicketExpectation {
  now?: Date;
  runtimeId: string;
}

export interface AttachTicketVerifier {
  verify(token: string, expectation: AttachTicketExpectation): Promise<BrowserAttachTicketClaims>;
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
    try {
      return await verifyAttachTicket(
        token,
        { runtimeId: expectation.runtimeId, now: (expectation.now ?? new Date()).getTime() },
        {
          decodeBase64Url,
          parseClaims: (value) => BrowserAttachTicketClaimsSchema.parse(value),
          verify: async (keyId, signed, signature) => {
            const source = await this.resolvePublicKey(keyId);
            if (!source) throw forbidden("The browser attach ticket key is not trusted.");
            return verifySignature(
              null,
              signed,
              normalizeEd25519PublicKey(source, attachTicketKeyFailure),
              signature,
            );
          },
          claim: async (nonce, expiresAt, now) => {
            try {
              await this.replayLedger.claim(nonce, expiresAt, now);
            } catch (error) {
              if (error instanceof AttachTicketReplayLedgerError) {
                if (error.code === "already-used")
                  throw forbidden("The browser attach ticket has already been used.");
                if (error.code === "full")
                  throw forbidden("The browser attach ticket replay ledger is full.");
              }
              throw replayUnavailable(error);
            }
          },
        },
        {
          clockSkewMs: this.clockSkewMs,
          maxTicketBytes: this.maxTicketBytes,
          maxTicketLifetimeMs: this.maxTicketLifetimeMs,
        },
      );
    } catch (error) {
      if (error instanceof AttachTicketPolicyError) throw forbidden(error.message, error);
      throw error;
    }
  }
}

function attachTicketKeyFailure(kind: "unreadable" | "not-ed25519", cause?: unknown): Error {
  return kind === "unreadable"
    ? forbidden("The browser attach ticket key is invalid.", cause)
    : forbidden("The browser attach ticket key is not an Ed25519 public key.");
}

function forbidden(message: string, cause?: unknown): BrowserRuntimeError {
  return new BrowserRuntimeError("forbidden", message, { cause });
}

function replayUnavailable(cause: unknown): BrowserRuntimeError {
  return forbidden("The browser attach ticket replay ledger is unavailable.", cause);
}
