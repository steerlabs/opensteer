import { readBoundedJson } from "@opensteer/shared/boundedJson";
import { createPublicHttpsFetch } from "@opensteer/access/host";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JSONWebKeySet } from "jose";
import { z } from "zod";

const maximumJwksBytes = 64 * 1_024;
const jwksCacheLifetimeMilliseconds = 5 * 60_000;
const minimumForcedRefreshIntervalMilliseconds = 5_000;

const AccountJwkSchema = z
  .object({
    alg: z.literal("EdDSA"),
    crv: z.literal("Ed25519"),
    kid: z.string().min(1).max(256),
    kty: z.literal("OKP"),
    use: z.literal("sig").optional(),
    x: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  })
  .passthrough();

const AccountJwksSchema = z
  .strictObject({ keys: z.array(AccountJwkSchema).min(1).max(16) })
  .superRefine((value, context) => {
    const keyIds = new Set<string>();
    for (const [index, key] of value.keys.entries()) {
      if (keyIds.has(key.kid)) {
        context.addIssue({
          code: "custom",
          message: "Account JWKS contains a duplicate key ID",
          path: ["keys", index, "kid"],
        });
      }
      keyIds.add(key.kid);
    }
  });

interface CachedJwks {
  readonly fetchedAt: number;
  readonly keyIds: ReadonlySet<string>;
  readonly resolve: ReturnType<typeof createLocalJWKSet>;
}

export class RemoteAccountJwksVerifier {
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

  async verify(token: string, maxTokenAge: string) {
    const header = decodeProtectedHeader(token);
    if (header.alg !== "EdDSA" || typeof header.kid !== "string" || !header.kid) {
      throw new Error("Account grant header is invalid");
    }
    let jwks = await this.#loadJwks(false);
    if (!jwks.keyIds.has(header.kid)) jwks = await this.#loadJwks(true);
    if (!jwks.keyIds.has(header.kid)) throw new Error("Account signing key is unknown");
    return jwtVerify(token, jwks.resolve, {
      algorithms: ["EdDSA"],
      audience: this.#audience,
      clockTolerance: 5,
      issuer: this.#issuer,
      maxTokenAge,
    });
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
      const cache = await refresh;
      this.#cache = cache;
      return cache;
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
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (contentType !== "application/json") {
      await response.body?.cancel();
      throw new Error("Account JWKS did not return application/json");
    }
    const parsed = AccountJwksSchema.parse(await readBoundedJson(response, boundedJsonOptions));
    const jwks: JSONWebKeySet = {
      keys: parsed.keys.map((key) => ({
        alg: key.alg,
        crv: key.crv,
        kid: key.kid,
        kty: key.kty,
        ...(key.use ? { use: key.use } : {}),
        x: key.x,
      })),
    };
    return {
      fetchedAt: Date.now(),
      keyIds: new Set(parsed.keys.map((key) => key.kid)),
      resolve: createLocalJWKSet(jwks),
    };
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
    throw new TypeError("Opensteer Account grants require a bare public HTTPS issuer");
  }
  return url;
}

const boundedJsonOptions = {
  emptyError: () => new Error("Account JWKS returned an empty response"),
  maximumBytes: maximumJwksBytes,
  sizeError: () => new Error("Account JWKS response exceeded its byte limit"),
} as const;
