import { createHash } from "node:crypto";
import {
  encodeBrowserProfileSnapshot,
  type BrowserProfileSnapshot,
} from "@opensteer/browser-profile/snapshot";
import {
  CompleteProfileInitializationResultSchema,
  ProfileInitializationSeedResponseSchema,
  type BrowserAttachTicketIdentity,
} from "@opensteer/protocol";
import { BrowserRuntimeError } from "./errors.js";
import { sameFrozenSeed, sameLocalBinding } from "./local-profile-store.js";
import {
  readProfileStateJson,
  safeProfileStateUrl,
  safeTrustedHttpOrigin,
} from "./profile-http.js";

export type LocalProfileIdentity = Extract<BrowserAttachTicketIdentity, { kind: "profile-local" }>;
export interface ProfileInitializationClient {
  load(identity: LocalProfileIdentity, signal?: AbortSignal): Promise<BrowserProfileSnapshot>;
  complete(identity: LocalProfileIdentity, signal?: AbortSignal): Promise<void>;
}
export class HttpProfileInitializationClient implements ProfileInitializationClient {
  private readonly trustedHttpOrigin: string | undefined;
  private readonly options: {
    fetch?: typeof globalThis.fetch;
    trustedHttpOrigin?: string;
    timeoutMs?: number;
  };
  constructor(
    options: {
      fetch?: typeof globalThis.fetch;
      trustedHttpOrigin?: string;
      timeoutMs?: number;
    } = {},
  ) {
    this.options = options;
    this.trustedHttpOrigin = options.trustedHttpOrigin
      ? safeTrustedHttpOrigin(options.trustedHttpOrigin)
      : undefined;
  }
  async load(
    identity: LocalProfileIdentity,
    signal?: AbortSignal,
  ): Promise<BrowserProfileSnapshot> {
    const parsed = ProfileInitializationSeedResponseSchema.safeParse(
      await this.request(identity, "GET", signal),
    );
    if (!parsed.success)
      throw new BrowserRuntimeError(
        "conflict",
        "The browser profile initialization response is invalid.",
        { reason: "profile-initialization.invalid-response" },
      );
    const result = parsed.data;
    if (
      !identity.initialization ||
      !sameLocalBinding(identity.binding, result.binding) ||
      !sameFrozenSeed(identity.initialization.seed, result.seed) ||
      createHash("sha256").update(encodeBrowserProfileSnapshot(result.snapshot)).digest("hex") !==
        result.seed.digest
    )
      throw new BrowserRuntimeError(
        "conflict",
        "The initialization seed does not match this browser profile.",
        { reason: "profile-initialization.seed-mismatch" },
      );
    return result.snapshot;
  }
  async complete(identity: LocalProfileIdentity, signal?: AbortSignal): Promise<void> {
    const parsed = CompleteProfileInitializationResultSchema.safeParse(
      await this.request(identity, "POST", signal),
    );
    if (!parsed.success)
      throw new BrowserRuntimeError(
        "conflict",
        "The browser profile completion response is invalid.",
        { reason: "profile-initialization.invalid-response" },
      );
    const result = parsed.data;
    if (!sameLocalBinding(identity.binding, result.binding))
      throw new BrowserRuntimeError(
        "conflict",
        "The completed browser profile binding does not match.",
      );
  }
  private async request(
    identity: LocalProfileIdentity,
    method: "GET" | "POST",
    signal?: AbortSignal,
  ): Promise<unknown> {
    const initialization = identity.initialization;
    if (!initialization)
      throw new BrowserRuntimeError(
        "forbidden",
        "This ticket does not authorize profile initialization.",
      );
    const url = safeProfileStateUrl(initialization.initializationUrl, this.trustedHttpOrigin);
    try {
      const response = await (this.options.fetch ?? globalThis.fetch)(url, {
        method,
        redirect: "error",
        signal: AbortSignal.any([
          AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
          ...(signal ? [signal] : []),
        ]),
        headers: {
          authorization: `Bearer ${initialization.initializationToken}`,
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
        },
        ...(method === "POST"
          ? { body: JSON.stringify({ binding: identity.binding, seed: initialization.seed }) }
          : {}),
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new BrowserRuntimeError(
          "conflict",
          "The Host refused browser profile initialization.",
          { reason: "profile-initialization.http-refused", retryable: response.status >= 500 },
        );
      }
      return await readProfileStateJson(response);
    } catch (error) {
      if (error instanceof BrowserRuntimeError) throw error;
      throw new BrowserRuntimeError(
        "conflict",
        "Browser profile initialization could not reach the Host.",
        { reason: "profile-initialization.request-failed", retryable: true },
      );
    }
  }
}
