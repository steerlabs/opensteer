import { createPublicHttpsFetch } from "@opensteer/access/host";
import {
  AgentDirectoryClaimsSchema,
  AgentDirectoryResponseSchema,
  agentDirectoryJwtTyp,
  agentDirectoryPath,
  isLoopbackHostname,
  maximumAgentDirectoryEnvelopeBytes,
  type AgentDirectoryDocument,
  type AgentDirectoryEntry,
} from "@opensteer/control-plane-protocol";
import { readBoundedJson } from "@opensteer/shared/boundedJson";
import { decodeProtectedHeader } from "jose";
import { AccountJwksVerifier } from "../../access/account-jwks-verifier.js";

const requestTimeoutMs = 10_000;
const coldStartWaitMs = 2_000;
const issuedAtFutureToleranceMs = 60_000;
export const defaultAgentDirectoryRefreshIntervalMs = 15 * 60_000;
export const defaultAgentDirectoryMaxAgeMs = 24 * 60 * 60_000;

interface DirectoryStorage {
  load(issuer: string): Promise<AgentDirectoryDocument | null>;
  accept(issuer: string, document: AgentDirectoryDocument): Promise<AgentDirectoryDocument>;
}

export interface AgentDirectoryCacheOptions {
  readonly issuer: URL;
  readonly storage: DirectoryStorage;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly refreshIntervalMs?: number;
  readonly maxAgeMs?: number;
}

export class AgentDirectoryCache {
  readonly #keys: AccountJwksVerifier;
  readonly #url: URL;
  readonly #fetch: typeof globalThis.fetch;
  readonly #storage: DirectoryStorage;
  readonly #now: () => number;
  readonly #refreshIntervalMs: number;
  readonly #maxAgeMs: number;
  readonly #abort = new AbortController();
  #accepted: AgentDirectoryDocument | null = null;
  #inflight: Promise<void> | undefined;
  #lastAttempt: number | undefined;

  constructor(options: AgentDirectoryCacheOptions) {
    this.#keys = new AccountJwksVerifier(options);
    this.#url = new URL(agentDirectoryPath, this.issuer);
    this.#storage = options.storage;
    this.#now = options.now ?? Date.now;
    this.#refreshIntervalMs = options.refreshIntervalMs ?? defaultAgentDirectoryRefreshIntervalMs;
    this.#maxAgeMs = options.maxAgeMs ?? defaultAgentDirectoryMaxAgeMs;
    this.#fetch =
      options.fetch ??
      createPublicHttpsFetch({
        maxRequestBytes: 1,
        maxResponseBytes: maximumAgentDirectoryEnvelopeBytes,
        timeoutMs: requestTimeoutMs,
      });
  }

  get issuer(): string {
    return this.#keys.issuer;
  }

  async start(): Promise<void> {
    this.#accepted = await this.#storage.load(this.issuer);
    void this.refresh();
  }

  close(): void {
    this.#abort.abort();
  }

  current(): AgentDirectoryDocument | null {
    if (!this.#accepted) return null;
    const age = this.#now() - Date.parse(this.#accepted.issuedAt);
    return age >= -issuedAtFutureToleranceMs && age < this.#maxAgeMs ? this.#accepted : null;
  }

  async get(): Promise<AgentDirectoryDocument | null> {
    const refresh = this.refresh();
    if (this.#accepted) return this.current();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        refresh,
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, coldStartWaitMs);
        }),
      ]);
      return this.current();
    } finally {
      clearTimeout(timeout);
    }
  }

  refresh(): Promise<void> {
    if (this.#inflight) return this.#inflight;
    const now = this.#now();
    const interval = this.current()
      ? this.#refreshIntervalMs
      : Math.min(30_000, this.#refreshIntervalMs);
    if (
      this.#abort.signal.aborted ||
      (this.#lastAttempt !== undefined && now - this.#lastAttempt < interval)
    ) {
      return Promise.resolve();
    }
    this.#lastAttempt = now;
    this.#inflight = this.#read().finally(() => {
      this.#inflight = undefined;
    });
    return this.#inflight;
  }

  async #read(): Promise<void> {
    try {
      const response = await this.#fetch(this.#url, {
        credentials: "omit",
        headers: { accept: "application/json" },
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.any([this.#abort.signal, AbortSignal.timeout(requestTimeoutMs)]),
      });
      if (
        !response.ok ||
        response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json"
      ) {
        await response.body?.cancel();
        return;
      }
      const { assertion } = AgentDirectoryResponseSchema.parse(
        await readBoundedJson(response, {
          maximumBytes: maximumAgentDirectoryEnvelopeBytes,
          sizeError: () => new Error("Agent directory response is too large"),
        }),
      );
      if (decodeProtectedHeader(assertion).typ !== agentDirectoryJwtTyp) return;
      const { payload } = await this.#keys.verify(assertion, {
        typ: agentDirectoryJwtTyp,
        currentDate: new Date(this.#now()),
      });
      const { revision, issuedAt, entries } = AgentDirectoryClaimsSchema.parse(payload);
      const age = this.#now() - Date.parse(issuedAt);
      if (age < -issuedAtFutureToleranceMs || age >= this.#maxAgeMs || this.#abort.signal.aborted) {
        return;
      }
      this.#accepted = await this.#storage.accept(this.issuer, { revision, issuedAt, entries });
    } catch {
      // A failed refresh leaves the last accepted document available until signed expiry.
    }
  }
}

/** Exact HTTPS origin match of a proven redirect URI against directory entries; loopback and non-HTTPS never match. */
export function matchDirectoryEntry(
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
