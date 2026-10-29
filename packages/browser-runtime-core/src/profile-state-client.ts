import { isIP } from "node:net";
import type { BrowserAttachTicketClaims, BrowserAttachTicketIdentity } from "@opensteer/protocol";
import {
  BrowserProfileSnapshotSchema,
  maxBrowserProfileSnapshotBytes,
  type BrowserProfileSnapshot,
} from "@opensteer/browser-profile/snapshot";
import { readBoundedJson } from "@opensteer/shared/boundedJson";
import { z } from "zod";
import { BrowserRuntimeError } from "./errors.js";

const LoadResponseSchema = z.strictObject({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  snapshot: BrowserProfileSnapshotSchema,
});

const CommitResponseSchema = z.strictObject({
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

/**
 * Attach-ticket claims that carry a profile identity, and with it the lease and
 * endpoint the profile-state protocol needs. Every profile-state call is typed
 * against these claims, so a fresh session cannot reach the profile vault: it
 * has no lease token or state URL to reach it with.
 */
export type BrowserProfileAttachTicketClaims = BrowserAttachTicketClaims & {
  readonly identity: Extract<BrowserAttachTicketIdentity, { kind: "profile" }>;
};

export function isProfileAttachTicketClaims(
  claims: BrowserAttachTicketClaims,
): claims is BrowserProfileAttachTicketClaims {
  return claims.identity.kind === "profile";
}

export interface BrowserProfileStateClient {
  commit(
    claims: BrowserProfileAttachTicketClaims,
    expectedRevision: number,
    snapshot: BrowserProfileSnapshot,
  ): Promise<number>;
  load(
    claims: BrowserProfileAttachTicketClaims,
  ): Promise<{ readonly revision: number; readonly snapshot: BrowserProfileSnapshot }>;
}

export class HttpBrowserProfileStateClient implements BrowserProfileStateClient {
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  readonly #trustedHttpOrigin: string | undefined;

  constructor(
    options: {
      readonly fetch?: typeof globalThis.fetch;
      readonly timeoutMs?: number;
      readonly trustedHttpOrigin?: string;
    } = {},
  ) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#trustedHttpOrigin = options.trustedHttpOrigin
      ? safeTrustedHttpOrigin(options.trustedHttpOrigin)
      : undefined;
    if (
      !Number.isSafeInteger(this.#timeoutMs) ||
      this.#timeoutMs < 1_000 ||
      this.#timeoutMs > 60_000
    ) {
      throw new TypeError("Browser profile state timeout must be from 1 through 60 seconds.");
    }
  }

  async load(claims: BrowserProfileAttachTicketClaims) {
    return this.#request(claims, { method: "GET" }, LoadResponseSchema);
  }

  async commit(
    claims: BrowserProfileAttachTicketClaims,
    expectedRevision: number,
    snapshot: BrowserProfileSnapshot,
  ): Promise<number> {
    const body = JSON.stringify({
      expectedRevision,
      snapshot: BrowserProfileSnapshotSchema.parse(snapshot),
    });
    if (Buffer.byteLength(body, "utf8") > maxBrowserProfileSnapshotBytes + 64 * 1_024) {
      throw new Error("Browser profile commit exceeds its byte limit.");
    }
    const response = await this.#request(
      claims,
      {
        body,
        headers: { "content-type": "application/json" },
        method: "PUT",
      },
      CommitResponseSchema,
    );
    return response.revision;
  }

  async #request<T>(
    claims: BrowserProfileAttachTicketClaims,
    init: RequestInit,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const url = safeProfileStateUrl(claims.identity.profileStateUrl, this.#trustedHttpOrigin);
    const signal = AbortSignal.timeout(this.#timeoutMs);
    let readingResponse = false;
    try {
      const response = await this.#fetch(url, {
        ...init,
        headers: {
          ...init.headers,
          authorization: `Bearer ${claims.identity.profileLeaseToken}`,
        },
        redirect: "error",
        signal,
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        const status = response.status;
        const leaseRejected = status === 401 || status === 403;
        throw new BrowserRuntimeError(
          leaseRejected
            ? "forbidden"
            : status === 409
              ? "conflict"
              : status === 404
                ? "not_found"
                : "internal",
          `Browser profile state request failed with HTTP ${status}.`,
          {
            retryable: status >= 500 || status === 408 || status === 429,
            reason: leaseRejected
              ? "profile-state.lease-rejected"
              : status === 409
                ? "profile-state.revision-conflict"
                : status === 404
                  ? "profile-state.profile-missing"
                  : "profile-state.http-refused",
          },
        );
      }
      readingResponse = true;
      return schema.parse(await readProfileStateJson(response));
    } catch (cause) {
      if (cause instanceof BrowserRuntimeError) throw cause;
      const timedOut = signal.aborted;
      throw new BrowserRuntimeError(
        "internal",
        timedOut
          ? "Browser profile state request timed out."
          : readingResponse
            ? "Browser profile state response is not valid JSON or does not match its schema."
            : "Browser profile state request failed.",
        {
          cause,
          retryable: timedOut || !readingResponse,
          reason: timedOut
            ? "profile-state.request-timeout"
            : readingResponse
              ? "profile-state.invalid-response"
              : "profile-state.transport-failed",
        },
      );
    }
  }
}

function safeProfileStateUrl(value: string, trustedHttpOrigin: string | undefined): URL {
  const url = new URL(value);
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    (isIP(url.hostname) === 6 && url.hostname.toLowerCase() === "0:0:0:0:0:0:0:1");
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && (loopback || url.origin === trustedHttpOrigin))) ||
    url.username ||
    url.password
  ) {
    throw new Error("Browser profile state URL is not a secure HTTP endpoint.");
  }
  return url;
}

function safeTrustedHttpOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("The trusted browser profile state origin is invalid.");
  }
  return url.origin;
}

function readProfileStateJson(response: Response): Promise<unknown> {
  return readBoundedJson(response, {
    invalidJsonError: (cause) =>
      new Error("Browser profile state response is not valid JSON.", { cause }),
    maximumBytes: maxBrowserProfileSnapshotBytes + 64 * 1_024,
    sizeError: () => new Error("Browser profile state response exceeds its byte limit."),
  });
}
