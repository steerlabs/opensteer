import { createHash, randomBytes } from "node:crypto";
import {
  OpensteerError,
  type BrowserProfileId,
  type BrowserSourceId,
  type EnvironmentId,
  type UserId,
} from "@opensteer/core";
import type { BrowserSessionId } from "@opensteer/protocol";
import type { StandardCdpMode } from "@opensteer/protocol/standard-cdp";

export const standardCdpConnectPrefix = "/v1/browser/connect/";

export interface CdpAuthority {
  readonly agentBindingId: string;
  readonly ownerId: UserId;
  readonly environmentId?: EnvironmentId;
  readonly expiresAt?: number;
}

export interface StandardCdpFacts {
  readonly profileId: BrowserProfileId | null;
  readonly profileBindingId: string | null;
  readonly runtimeId: string;
  readonly placementKey: string;
  readonly grantRevision: number | null;
  readonly agentConnectionId: string | null;
}

export interface StandardCdpTicketClaims {
  readonly authority: Omit<CdpAuthority, "environmentId">;
  readonly browserSessionId: BrowserSessionId;
  readonly mode: StandardCdpMode;
  readonly facts: StandardCdpFacts;
  readonly sharedChromeTab?: { readonly sourceId: BrowserSourceId; readonly tabId: string };
}

const ticketPattern = /^[A-Za-z0-9_-]{43}$/u;
const maxTickets = 4_096;
const maxTtl = 300_000;

export class StandardCdpTickets {
  readonly #claims: Map<string, { claims: StandardCdpTicketClaims; expiresAt: number }>;
  readonly #now: () => number;

  constructor(
    now = Date.now,
    claims = new Map<string, { claims: StandardCdpTicketClaims; expiresAt: number }>(),
  ) {
    this.#now = now;
    this.#claims = claims;
  }

  issue(
    input: Omit<StandardCdpTicketClaims, "authority"> & {
      readonly authority: CdpAuthority;
      readonly ttl?: number;
    },
  ): string {
    const { ttl = 60_000, authority, browserSessionId, mode, facts, sharedChromeTab } = input;
    if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > maxTtl)
      throw new OpensteerError({
        code: "bad_request",
        message: "Browser connection links last at most five minutes.",
      });
    const now = this.#now();
    const expiresAt = Math.min(now + ttl, authority.expiresAt ?? Infinity);
    if (expiresAt <= now)
      throw new OpensteerError({ code: "forbidden", message: "Browser authority expired." });
    for (const [key, entry] of this.#claims) if (entry.expiresAt <= now) this.#claims.delete(key);
    if (this.#claims.size >= maxTickets)
      throw new OpensteerError({
        code: "conflict",
        message: "Too many pending browser connection links.",
      });
    const ticket = randomBytes(32).toString("base64url");
    this.#claims.set(digest(ticket), {
      claims: Object.freeze({
        authority: Object.freeze({
          agentBindingId: authority.agentBindingId,
          ownerId: authority.ownerId,
          ...(authority.expiresAt !== undefined ? { expiresAt: authority.expiresAt } : {}),
        }),
        browserSessionId,
        mode,
        facts: Object.freeze({ ...facts }),
        ...(sharedChromeTab ? { sharedChromeTab: Object.freeze({ ...sharedChromeTab }) } : {}),
      }),
      expiresAt,
    });
    return ticket;
  }

  consume(ticket: string): StandardCdpTicketClaims | undefined {
    if (!ticketPattern.test(ticket)) return undefined;
    const key = digest(ticket);
    const entry = this.#claims.get(key);
    this.#claims.delete(key);
    return entry && entry.expiresAt > this.#now() ? entry.claims : undefined;
  }

  bindingsForConnection(connectionId: string): Set<string> {
    const bindings = new Set<string>();
    for (const { claims } of this.#claims.values())
      if (claims.facts.agentConnectionId === connectionId)
        bindings.add(claims.authority.agentBindingId);
    return bindings;
  }

  revoke(agentBindingId: string): void {
    for (const [key, entry] of this.#claims)
      if (entry.claims.authority.agentBindingId === agentBindingId) this.#claims.delete(key);
  }
}

function digest(ticket: string): string {
  return createHash("sha256").update(ticket, "ascii").digest("hex");
}
