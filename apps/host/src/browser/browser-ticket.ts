import type { PersonFillVersion } from "@opensteer/protocol";
import {
  BrowserAttachTicketClaimsSchema,
  PooledBrowserAttachTicketClaimsSchema,
  type RuntimeBrowserAttachTicketClaims,
  type BrowserAttachTicketIdentity,
  type BrowserHomeAddresses,
  type BrowserSessionId,
} from "@opensteer/protocol/browser";
import { randomBytes, sign, type KeyObject } from "node:crypto";
import type { ThisHomeAddresses } from "@opensteer/shared/homeAddress";

const ticketType = "opensteer-browser-attach+jwt";

interface IssueBrowserAttachTicketInput {
  readonly access: "read-write";
  readonly standardCdp?: RuntimeBrowserAttachTicketClaims["standardCdp"];
  readonly standardCdpAttempt?: RuntimeBrowserAttachTicketClaims["standardCdpAttempt"];
  readonly standardCdpLineage?: RuntimeBrowserAttachTicketClaims["standardCdpLineage"];
  readonly standardCdpLease?: RuntimeBrowserAttachTicketClaims["standardCdpLease"];
  readonly creationOrigin: "agent" | "person";
  /** Whom the attachment acts for; only for a runtime that reads it. */
  readonly actor?: "agent" | "person" | undefined;
  readonly operationExpiresAt?: string;
  readonly remainingBudgetMs?: number;
  readonly passkeys?: 1;
  readonly personFillVersion?: PersonFillVersion | undefined;
  readonly navigationVersion?: 1;
  readonly initialNavigation?: RuntimeBrowserAttachTicketClaims["initialNavigation"];
  readonly reattach?: true;
  readonly pool?: RuntimeBrowserAttachTicketClaims["pool"];
  readonly navigationAttributionVersion?: 1;
  readonly popupFollowVersion?: 1;
  readonly editingVersion?: 1 | 2;
  readonly basicInput?: 1;
  readonly surfaceState?: 1;
  readonly clipboard?: boolean;
  readonly tabRestoreVersion?: 1;
  readonly initialSurfaceId?: RuntimeBrowserAttachTicketClaims["initialSurfaceId"];
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
  /**
   * The addresses of this Home as they are now (`home-addresses.ts`), put on every ticket that
   * carries the actor claim so the runtime knows where a tab an agent drives may not go. Held in
   * memory: issuing reads nothing.
   */
  readonly homeAddresses?: () => ThisHomeAddresses;
}

/** Signs the narrow, single-use ticket consumed directly by Browser Runtime. */
export class BrowserAttachTicketSigner {
  readonly #clock: () => Date;
  readonly #keyId: string;
  readonly #lifetimeMs: number;
  readonly #privateKey: KeyObject;
  readonly #homeAddresses: (() => ThisHomeAddresses) | undefined;

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
    this.#homeAddresses = options.homeAddresses;
  }

  issue(input: IssueBrowserAttachTicketInput): string {
    const issuedAt = this.#clock();
    const schema = input.pool
      ? PooledBrowserAttachTicketClaimsSchema
      : BrowserAttachTicketClaimsSchema;
    // Only a ticket with the actor claim carries the set (B4): no other one pays for it.
    const home = input.actor ? this.#homeAddresses?.() : undefined;
    const claims: RuntimeBrowserAttachTicketClaims = schema.parse({
      access: input.access,
      ...(input.standardCdp ? { standardCdp: input.standardCdp } : {}),
      ...(input.standardCdpAttempt ? { standardCdpAttempt: input.standardCdpAttempt } : {}),
      ...(input.standardCdpLineage ? { standardCdpLineage: input.standardCdpLineage } : {}),
      ...(input.standardCdpLease ? { standardCdpLease: input.standardCdpLease } : {}),
      creationOrigin: input.creationOrigin,
      ...(input.actor ? { actor: input.actor } : {}),
      ...(input.basicInput === 1 ? { basicInput: 1 } : {}),
      ...(input.surfaceState === 1 ? { surfaceState: 1 } : {}),
      ...(input.personFillVersion ? { personFillVersion: input.personFillVersion } : {}),
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
      ...(input.reattach ? { reattach: true } : {}),
      ...(input.pool ? { pool: input.pool } : {}),
      ...(input.navigationAttributionVersion === 1 ? { navigationAttributionVersion: 1 } : {}),
      ...(input.popupFollowVersion === 1 ? { popupFollowVersion: 1 } : {}),
      ...(input.tabRestoreVersion
        ? {
            tabRestoreVersion: input.tabRestoreVersion,
            initialSurfaceId: input.initialSurfaceId,
          }
        : {}),
      operationExpiresAt:
        input.operationExpiresAt ?? new Date(issuedAt.getTime() + 18_000).toISOString(),
      remainingBudgetMs: Math.min(18_000, input.remainingBudgetMs ?? 18_000),
      wireVersion: 2,
      audience: "opensteer-browser-runtime",
      expiresAt: new Date(issuedAt.getTime() + this.#lifetimeMs).toISOString(),
      identity: input.identity,
      issuedAt: issuedAt.toISOString(),
      nonce: randomBytes(24).toString("base64url"),
      runtimeId: input.runtimeId,
      sessionId: input.sessionId,
      subject: input.subject,
      ...(input.viewport ? { viewport: input.viewport } : {}),
      // Only beside the actor claim: a runtime that reads it (the Mac's, a pooled one) holds the
      // tabs agents drive; a phone browser reads neither and refuses a claim it does not know.
      ...(home && (home.origins.length || home.loopbackPorts.length)
        ? {
            homeAddresses: {
              origins: [...home.origins],
              loopbackPorts: [...home.loopbackPorts],
            } satisfies BrowserHomeAddresses,
          }
        : {}),
    });
    return this.#sign(claims, ticketType);
  }

  #sign(claims: RuntimeBrowserAttachTicketClaims, typ: string): string {
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
