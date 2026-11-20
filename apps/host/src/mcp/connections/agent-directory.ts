import { createPublicHttpsFetch } from "@opensteer/access/host";
import {
  AgentDirectoryClaimsSchema,
  AgentDirectoryResponseSchema,
  agentDirectoryJwtTyp,
  agentDirectoryPath,
  isLoopbackHostname,
  maximumAgentDirectoryEnvelopeBytes,
  type AgentConnectionIdentityAtConsent,
  type AgentDirectoryDocument,
  type AgentDirectoryEntry,
} from "@opensteer/control-plane-protocol";
import { readBoundedJson } from "@opensteer/shared/boundedJson";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JSONWebKeySet } from "jose";
import { z } from "zod";

const maximumJwksBytes = 64 * 1_024;
const defaultJwksCacheLifetimeMs = 5 * 60_000;
const minimumForcedJwksRefreshIntervalMs = 5_000;
const defaultRequestTimeoutMs = 10_000;
const issuedAtFutureToleranceMs = 60_000;

/** Default refresh interval: directory edits are operator-curated and rare, so 15 minutes bounds Account load while picking up withdrawals quickly. */
export const defaultAgentDirectoryRefreshIntervalMs = 15 * 60_000;
/** Default maximum cache age: survive a day-long Account outage without trusting stale verification indefinitely. */
export const defaultAgentDirectoryMaxAgeMs = 24 * 60 * 60_000;

const AccountJwksSchema = z.strictObject({
  keys: z
    .array(
      z
        .object({
          alg: z.literal("EdDSA"),
          crv: z.literal("Ed25519"),
          kid: z.string().min(1).max(256),
          kty: z.literal("OKP"),
          use: z.literal("sig").optional(),
          x: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
        })
        .passthrough(),
    )
    .min(1)
    .max(16),
});

interface CachedJwks {
  readonly fetchedAt: number;
  readonly keyIds: ReadonlySet<string>;
  readonly resolve: ReturnType<typeof createLocalJWKSet>;
}

interface CachedDirectory {
  readonly document: AgentDirectoryDocument;
  readonly fetchedAt: number;
}

export interface AgentDirectoryCacheOptions {
  /** Fixed Account origin from Home configuration, never supplied by an agent. */
  readonly issuer: URL;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly refreshIntervalMs?: number;
  readonly maxAgeMs?: number;
  readonly jwksCacheLifetimeMs?: number;
  readonly requestTimeoutMs?: number;
}

/**
 * Fetches and verifies the Account-signed agent directory from one fixed Account origin.
 * Never throws into callers: any read, verification, or expiry failure degrades to `null` (unverified).
 */
export class AgentDirectoryCache {
  readonly #issuer: string;
  readonly #directoryUrl: URL;
  readonly #jwksUrl: URL;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  readonly #refreshIntervalMs: number;
  readonly #maxAgeMs: number;
  readonly #jwksCacheLifetimeMs: number;
  readonly #requestTimeoutMs: number;
  #cache: CachedDirectory | undefined;
  #highestRevision: number | undefined;
  #inflight: Promise<AgentDirectoryDocument | null> | undefined;
  #jwksCache: CachedJwks | undefined;
  #jwksRefresh: Promise<CachedJwks> | undefined;
  #lastForcedJwksRefreshAt = 0;

  constructor(options: AgentDirectoryCacheOptions) {
    this.#issuer = bareHttpsOrigin(options.issuer).origin;
    this.#directoryUrl = new URL(agentDirectoryPath, this.#issuer);
    this.#jwksUrl = new URL("/api/auth/jwks", this.#issuer);
    this.#now = options.now ?? Date.now;
    this.#refreshIntervalMs = options.refreshIntervalMs ?? defaultAgentDirectoryRefreshIntervalMs;
    this.#maxAgeMs = options.maxAgeMs ?? defaultAgentDirectoryMaxAgeMs;
    this.#jwksCacheLifetimeMs = options.jwksCacheLifetimeMs ?? defaultJwksCacheLifetimeMs;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? defaultRequestTimeoutMs;
    if (this.#refreshIntervalMs < 0 || this.#maxAgeMs <= 0) {
      throw new RangeError(
        "Agent directory cache intervals must be non-negative with positive maxAgeMs",
      );
    }
    this.#fetch =
      options.fetch ??
      createPublicHttpsFetch({
        maxRequestBytes: 1,
        maxResponseBytes: maximumAgentDirectoryEnvelopeBytes,
        timeoutMs: this.#requestTimeoutMs,
      });
  }

  get issuer(): string {
    return this.#issuer;
  }

  /** Returns the currently cached directory if it has not exceeded `maxAgeMs`, else `null`. */
  current(): AgentDirectoryDocument | null {
    const cached = this.#cache;
    if (!cached) return null;
    const now = this.#now();
    return this.#isWithinMaxAge(cached, now) ? cached.document : null;
  }

  /** Returns a verified directory document, refreshing when due; never throws. */
  async get(): Promise<AgentDirectoryDocument | null> {
    const now = this.#now();
    const cached = this.#cache;
    if (
      cached &&
      now - cached.fetchedAt < this.#refreshIntervalMs &&
      this.#isWithinMaxAge(cached, now)
    ) {
      return cached.document;
    }
    if (this.#inflight) return this.#inflight;
    const promise = this.#refresh();
    this.#inflight = promise;
    try {
      return await promise;
    } finally {
      if (this.#inflight === promise) this.#inflight = undefined;
    }
  }

  #isWithinMaxAge(cached: CachedDirectory, now: number): boolean {
    if (now - cached.fetchedAt > this.#maxAgeMs) return false;
    const issuedAtMs = Date.parse(cached.document.issuedAt);
    return Number.isFinite(issuedAtMs) && now - issuedAtMs <= this.#maxAgeMs;
  }

  async #refresh(): Promise<AgentDirectoryDocument | null> {
    try {
      const response = await this.#fetch(this.#directoryUrl, {
        credentials: "omit",
        headers: { accept: "application/json" },
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(this.#requestTimeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return this.current();
      }
      if (response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
        await response.body?.cancel();
        return this.current();
      }
      const envelope = AgentDirectoryResponseSchema.parse(
        await readBoundedJson(response, {
          maximumBytes: maximumAgentDirectoryEnvelopeBytes,
          sizeError: () => new Error("Agent directory response is too large"),
        }),
      );
      const document = await this.#verifyEnvelope(envelope.assertion);
      const now = this.#now();
      const issuedAtMs = Date.parse(document.issuedAt);
      if (
        !Number.isFinite(issuedAtMs) ||
        issuedAtMs > now + issuedAtFutureToleranceMs ||
        now - issuedAtMs > this.#maxAgeMs
      ) {
        return this.current();
      }
      if (this.#highestRevision !== undefined && document.revision < this.#highestRevision) {
        return this.current();
      }
      this.#highestRevision = document.revision;
      this.#cache = { document, fetchedAt: now };
      return document;
    } catch {
      return this.current();
    }
  }

  async #verifyEnvelope(token: string): Promise<AgentDirectoryDocument> {
    const header = decodeProtectedHeader(token);
    if (
      header.alg !== "EdDSA" ||
      header.typ !== agentDirectoryJwtTyp ||
      typeof header.kid !== "string" ||
      !header.kid
    ) {
      throw new Error("Agent directory header is invalid");
    }
    let jwks = await this.#loadJwks(false);
    if (!jwks.keyIds.has(header.kid)) jwks = await this.#loadJwks(true);
    if (!jwks.keyIds.has(header.kid)) throw new Error("Agent directory signing key is unknown");
    const verified = await jwtVerify(token, jwks.resolve, {
      algorithms: ["EdDSA"],
      currentDate: new Date(this.#now()),
      issuer: this.#issuer,
      typ: agentDirectoryJwtTyp,
    });
    const claims = AgentDirectoryClaimsSchema.parse(verified.payload);
    if (claims.iss !== this.#issuer) throw new Error("Agent directory issuer mismatch");
    return {
      revision: claims.revision,
      issuedAt: claims.issuedAt,
      entries: claims.entries,
    };
  }

  async #loadJwks(force: boolean): Promise<CachedJwks> {
    const now = this.#now();
    if (
      this.#jwksCache &&
      (!force || now - this.#lastForcedJwksRefreshAt < minimumForcedJwksRefreshIntervalMs) &&
      now - this.#jwksCache.fetchedAt < this.#jwksCacheLifetimeMs
    ) {
      return this.#jwksCache;
    }
    if (this.#jwksRefresh) return this.#jwksRefresh;
    if (force) this.#lastForcedJwksRefreshAt = now;
    const promise = this.#fetchJwks();
    this.#jwksRefresh = promise;
    try {
      this.#jwksCache = await promise;
      return this.#jwksCache;
    } finally {
      if (this.#jwksRefresh === promise) this.#jwksRefresh = undefined;
    }
  }

  async #fetchJwks(): Promise<CachedJwks> {
    const response = await this.#fetch(this.#jwksUrl, {
      credentials: "omit",
      headers: { accept: "application/json" },
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(this.#requestTimeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Account JWKS returned HTTP ${response.status}`);
    }
    if (response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
      await response.body?.cancel();
      throw new Error("Account JWKS did not return application/json");
    }
    const parsed = AccountJwksSchema.parse(
      await readBoundedJson(response, {
        maximumBytes: maximumJwksBytes,
        sizeError: () => new Error("Account JWKS is too large"),
      }),
    );
    const keyIds = new Set<string>();
    for (const key of parsed.keys) {
      if (keyIds.has(key.kid)) throw new Error("Account JWKS contains a duplicate key ID");
      keyIds.add(key.kid);
    }
    const set: JSONWebKeySet = {
      keys: parsed.keys.map((key) => ({
        alg: key.alg,
        crv: key.crv,
        kid: key.kid,
        kty: key.kty,
        ...(key.use ? { use: key.use } : {}),
        x: key.x,
      })),
    };
    return { fetchedAt: this.#now(), keyIds, resolve: createLocalJWKSet(set) };
  }
}

function bareHttpsOrigin(input: URL): URL {
  const url = new URL(input.toString());
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("Agent directory requires a bare public HTTPS Account issuer");
  }
  return url;
}

/** Exact HTTPS origin match of a proven redirect URI against directory entries; loopback and non-HTTPS never match. */
export function matchPlatform(
  directory: AgentDirectoryDocument | null,
  redirectUri: string,
): AgentDirectoryEntry | null {
  if (!directory || redirectUri.includes("#")) return null;
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    isLoopbackHostname(url.hostname)
  ) {
    return null;
  }
  const origin = url.origin;
  return directory.entries.find((entry) => entry.origins.includes(origin)) ?? null;
}

export function isLoopbackRedirect(redirectUri: string): boolean {
  try {
    const url = new URL(redirectUri);
    return isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

export function extractRedirectOrigin(redirectUri: string): string | null {
  try {
    const url = new URL(redirectUri);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Checks whether a previously recorded consent identity is still backed by the current directory.
 * Returns `null` when the directory is unavailable (cannot claim withdrawal without a live directory).
 */
export function isIdentityStillVerified(
  identity: AgentConnectionIdentityAtConsent,
  directory: AgentDirectoryDocument | null,
): boolean | null {
  if (identity.kind === "unverified") return false;
  if (!directory) return null;
  const platform = directory.entries.find(
    (entry) =>
      entry.id === identity.platformDirectoryId && entry.origins.includes(identity.platformOrigin),
  );
  if (!platform) return false;
  if (identity.kind === "platform") return true;
  const embedder = directory.entries.find(
    (entry) =>
      entry.id === identity.embedderDirectoryId && entry.origins.includes(identity.embedderOrigin),
  );
  if (!embedder) return false;
  return Boolean(embedder.embedsVia?.includes(platform.id));
}
