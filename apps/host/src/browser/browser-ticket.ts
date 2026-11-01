import { OpensteerError } from "@opensteer/core";
import {
  BrowserAttachTicketClaimsSchema,
  type BrowserAttachTicketClaims,
  type BrowserAttachTicketIdentity,
  type BrowserSessionId,
} from "@opensteer/protocol/browser";
import { createPublicKey, randomBytes, sign, verify, type KeyObject } from "node:crypto";
import { z } from "zod";

const ticketType = "opensteer-browser-attach+jwt";

interface IssueBrowserAttachTicketInput {
  readonly access: "full-control";
  readonly operationExpiresAt?: string;
  readonly remainingBudgetMs?: number;
  readonly passkeys?: 1;
  readonly navigationVersion?: 1;
  readonly initialNavigation?: BrowserAttachTicketClaims["initialNavigation"];
  readonly navigationAttributionVersion?: 1;
  readonly editingVersion?: 1 | 2;
  readonly clipboard?: boolean;
  readonly workspaceTabRestoreVersion?: 1;
  readonly initialSurfaceId?: BrowserAttachTicketClaims["initialSurfaceId"];
  readonly dormantSurfaceIds?: BrowserAttachTicketClaims["dormantSurfaceIds"];
  /** The session's immutable native binding, or a temporary Guest. */
  readonly identity: BrowserAttachTicketIdentity;
  readonly runtimeId: string;
  readonly sessionId: BrowserSessionId;
  readonly subject: string;
  /** The view the person starts the browser from; its first page opens at it. */
  readonly viewport?: { readonly height: number; readonly width: number };
}

interface BrowserAttachTicketSignerOptions {
  readonly clock?: () => Date;
  readonly keyId: string;
  readonly lifetimeMs?: number;
  readonly privateKey: KeyObject;
}

/** Signs the narrow, single-use ticket consumed directly by Browser Runtime. */
export class BrowserAttachTicketSigner {
  readonly #clock: () => Date;
  readonly #keyId: string;
  readonly #lifetimeMs: number;
  readonly #privateKey: KeyObject;

  constructor(options: BrowserAttachTicketSignerOptions) {
    if (!/^[A-Za-z0-9._:-]{1,255}$/.test(options.keyId)) {
      throw new TypeError("The browser attach ticket key ID is invalid.");
    }
    if (
      options.privateKey.type !== "private" ||
      options.privateKey.asymmetricKeyType !== "ed25519"
    ) {
      throw new TypeError("Browser attach tickets require an Ed25519 private key.");
    }
    this.#clock = options.clock ?? (() => new Date());
    this.#keyId = options.keyId;
    this.#lifetimeMs = options.lifetimeMs ?? 60_000;
    if (
      !Number.isInteger(this.#lifetimeMs) ||
      this.#lifetimeMs < 1_000 ||
      this.#lifetimeMs > 300_000
    ) {
      throw new TypeError("Browser attach ticket lifetime must be from 1 through 300 seconds.");
    }
    this.#privateKey = options.privateKey;
  }

  /** Readiness can only acknowledge the exact native binding already signed for attach. */
  readNativeReady(ticket: string): BrowserAttachTicketClaims {
    const reject = () =>
      new OpensteerError({
        code: "forbidden",
        message: "Native profile readiness authority is invalid or expired.",
      });
    try {
      if (
        ticket.length > 16_384 ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(ticket)
      )
        throw reject();
      const [header, payload, signature] = ticket.split(".") as [string, string, string];
      z.strictObject({
        alg: z.literal("EdDSA"),
        kid: z.literal(this.#keyId),
        typ: z.literal(ticketType),
      }).parse(JSON.parse(Buffer.from(header, "base64url").toString("utf8")));
      if (
        !verify(
          null,
          Buffer.from(`${header}.${payload}`, "ascii"),
          createPublicKey(this.#privateKey),
          Buffer.from(signature, "base64url"),
        )
      )
        throw reject();
      const claims = BrowserAttachTicketClaimsSchema.parse(
        JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
      );
      const now = this.#clock().getTime();
      if (
        claims.identity.kind !== "profile-local" ||
        Date.parse(claims.issuedAt) > now ||
        Date.parse(claims.expiresAt) <= now ||
        Date.parse(claims.operationExpiresAt) <= now
      )
        throw reject();
      return claims;
    } catch {
      throw reject();
    }
  }

  issue(input: IssueBrowserAttachTicketInput): string {
    const issuedAt = this.#clock();
    const claims: BrowserAttachTicketClaims = BrowserAttachTicketClaimsSchema.parse({
      access: input.access,
      ...(input.passkeys === 1 ? { passkeys: 1 } : {}),
      ...(input.editingVersion
        ? {
            editingVersion: input.editingVersion,
            ...(input.editingVersion === 2 ? { clipboard: input.clipboard } : {}),
          }
        : {}),
      ...(input.navigationVersion === 1 ? { navigationVersion: 1 } : {}),
      ...(input.initialNavigation !== undefined
        ? {
            initialNavigation: input.initialNavigation,
          }
        : {}),
      ...(input.navigationAttributionVersion === 1 ? { navigationAttributionVersion: 1 } : {}),
      ...(input.workspaceTabRestoreVersion
        ? {
            workspaceTabRestoreVersion: input.workspaceTabRestoreVersion,
            initialSurfaceId: input.initialSurfaceId,
            dormantSurfaceIds: input.dormantSurfaceIds,
          }
        : {}),
      operationExpiresAt:
        input.operationExpiresAt ?? new Date(issuedAt.getTime() + 18_000).toISOString(),
      remainingBudgetMs: Math.min(18_000, input.remainingBudgetMs ?? 18_000),
      wireVersion: 1,
      audience: "opensteer-browser-runtime",
      expiresAt: new Date(issuedAt.getTime() + this.#lifetimeMs).toISOString(),
      identity: input.identity,
      issuedAt: issuedAt.toISOString(),
      nonce: randomBytes(24).toString("base64url"),
      runtimeId: input.runtimeId,
      sessionId: input.sessionId,
      subject: input.subject,
      ...(input.viewport ? { viewport: input.viewport } : {}),
    });
    return this.#sign(claims, ticketType);
  }

  #sign(claims: BrowserAttachTicketClaims, typ: string): string {
    const protectedHeader = Buffer.from(
      JSON.stringify({ alg: "EdDSA", kid: this.#keyId, typ }),
      "utf8",
    ).toString("base64url");
    const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    const signingInput = `${protectedHeader}.${payload}`;
    const signature = sign(null, Buffer.from(signingInput, "ascii"), this.#privateKey).toString(
      "base64url",
    );
    return `${signingInput}.${signature}`;
  }
}
