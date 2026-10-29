import { readBoundedJson } from "@opensteer/shared/boundedJson";
import { createPublicHttpsFetch } from "@opensteer/access/host";
import {
  AccountHostSessionGrantClaimsSchema,
  AccountHostSessionGrantSchema,
  PersonalHostAccountLinkCompletionGrantClaimsSchema,
  PersonalHostAccountLinkCompletionGrantSchema,
  type AccountHostSessionGrantClaims,
  type PersonalHostAccountLinkCompletionGrantClaims,
} from "@opensteer/control-plane-protocol";
import { OpensteerError } from "@opensteer/core";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JSONWebKeySet } from "jose";
import { z } from "zod";

const maximumJwksBytes = 64 * 1_024;
const jwksCacheLifetimeMilliseconds = 5 * 60_000;
const minimumForcedRefreshIntervalMilliseconds = 5_000;

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

export interface PersonalAccountGrantVerifier {
  readonly issuer: string;
  verifyLink(grant: unknown): Promise<PersonalHostAccountLinkCompletionGrantClaims>;
  verifySession(grant: unknown): Promise<AccountHostSessionGrantClaims>;
}

/** Pinned Account-JWKS trust boundary for an unmanaged Personal Host. The
 * issuer is Desktop release configuration, never a value read from a token. */
export class RemotePersonalAccountGrantVerifier implements PersonalAccountGrantVerifier {
  readonly #audience: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #issuer: string;
  readonly #jwksUrl: URL;
  #cache: CachedJwks | undefined;
  #lastForcedRefreshAt = 0;
  #refresh: Promise<CachedJwks> | undefined;

  constructor(options: {
    readonly audience: string;
    readonly fetch?: typeof globalThis.fetch;
    readonly issuer: URL;
  }) {
    this.#issuer = publicHttpsOrigin(options.issuer).origin;
    this.#audience = options.audience;
    this.#jwksUrl = new URL("/api/auth/jwks", this.#issuer);
    this.#fetch =
      options.fetch ??
      createPublicHttpsFetch({
        maxRequestBytes: 1,
        maxResponseBytes: maximumJwksBytes,
        timeoutMs: 10_000,
      });
  }

  get issuer(): string {
    return this.#issuer;
  }

  verifyLink(grant: unknown): Promise<PersonalHostAccountLinkCompletionGrantClaims> {
    return this.#verify(
      PersonalHostAccountLinkCompletionGrantSchema.parse(grant),
      PersonalHostAccountLinkCompletionGrantClaimsSchema,
      "Account-link completion grant",
    );
  }

  verifySession(grant: unknown): Promise<AccountHostSessionGrantClaims> {
    return this.#verify(
      AccountHostSessionGrantSchema.parse(grant),
      AccountHostSessionGrantClaimsSchema,
      "Account Host session grant",
    );
  }

  async #verify<T>(token: string, schema: z.ZodType<T>, label: string): Promise<T> {
    try {
      const header = decodeProtectedHeader(token);
      if (header.alg !== "EdDSA" || typeof header.kid !== "string" || !header.kid) {
        throw new Error("Account grant header is invalid");
      }
      let jwks = await this.#loadJwks(false);
      if (!jwks.keyIds.has(header.kid)) jwks = await this.#loadJwks(true);
      if (!jwks.keyIds.has(header.kid)) throw new Error("Account signing key is unknown");
      const verified = await jwtVerify(token, jwks.resolve, {
        algorithms: ["EdDSA"],
        audience: this.#audience,
        clockTolerance: 5,
        issuer: this.#issuer,
        maxTokenAge: "5m",
      });
      return schema.parse(verified.payload);
    } catch (error) {
      throw new OpensteerError({
        cause: error,
        code: "forbidden",
        message: `${label} is invalid or expired`,
      });
    }
  }

  async #loadJwks(force: boolean): Promise<CachedJwks> {
    const now = Date.now();
    if (
      this.#cache &&
      (!force || now - this.#lastForcedRefreshAt < minimumForcedRefreshIntervalMilliseconds) &&
      now - this.#cache.fetchedAt < jwksCacheLifetimeMilliseconds
    ) {
      return this.#cache;
    }
    if (this.#refresh) return this.#refresh;
    if (force) this.#lastForcedRefreshAt = now;
    const refresh = this.#fetchJwks();
    this.#refresh = refresh;
    try {
      this.#cache = await refresh;
      return this.#cache;
    } finally {
      if (this.#refresh === refresh) this.#refresh = undefined;
    }
  }

  async #fetchJwks(): Promise<CachedJwks> {
    const response = await this.#fetch(this.#jwksUrl, {
      credentials: "omit",
      headers: { accept: "application/json" },
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Account JWKS returned HTTP ${response.status}`);
    }
    if (response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
      await response.body?.cancel();
      throw new Error("Account JWKS did not return application/json");
    }
    const parsed = AccountJwksSchema.parse(await readBoundedJson(response, boundedJsonOptions));
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
    return { fetchedAt: Date.now(), keyIds, resolve: createLocalJWKSet(set) };
  }
}

function publicHttpsOrigin(input: URL): URL {
  const url = new URL(input.toString());
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("Personal Account grants require a bare public HTTPS issuer");
  }
  return url;
}

const boundedJsonOptions = {
  maximumBytes: maximumJwksBytes,
  sizeError: () => new Error("Account JWKS is too large"),
} as const;
