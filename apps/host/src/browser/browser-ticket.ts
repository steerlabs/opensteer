import { randomBytes, sign, type KeyObject } from "node:crypto";
import {
  BrowserAttachTicketClaimsSchema,
  type BrowserAttachTicketClaims,
  type BrowserAttachTicketIdentity,
  type BrowserSessionId,
} from "@opensteer/protocol/browser";

const ticketType = "opensteer-browser-attach+jwt";

interface IssueBrowserAttachTicketInput {
  readonly access: "full-control";
  readonly passkeys?: 1;
  readonly navigationVersion?: 1;
  readonly initialNavigationVersion?: 1;
  readonly initialNavigation?: BrowserAttachTicketClaims["initialNavigation"];
  readonly editingVersion?: 1 | 2;
  readonly clipboard?: boolean;
  readonly workspaceTabRestoreVersion?: 1;
  readonly initialSurfaceId?: BrowserAttachTicketClaims["initialSurfaceId"];
  readonly dormantSurfaceIds?: BrowserAttachTicketClaims["dormantSurfaceIds"];
  /** The session's immutable identity: a profile with its state lease, or fresh. */
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
      ...(input.initialNavigationVersion !== undefined || input.initialNavigation !== undefined
        ? {
            initialNavigationVersion: input.initialNavigationVersion,
            initialNavigation: input.initialNavigation,
          }
        : {}),
      ...(input.workspaceTabRestoreVersion
        ? {
            workspaceTabRestoreVersion: input.workspaceTabRestoreVersion,
            initialSurfaceId: input.initialSurfaceId,
            dormantSurfaceIds: input.dormantSurfaceIds,
          }
        : {}),
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
    const protectedHeader = Buffer.from(
      JSON.stringify({ alg: "EdDSA", kid: this.#keyId, typ: ticketType }),
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
