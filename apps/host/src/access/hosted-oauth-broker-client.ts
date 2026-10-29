import { OpensteerError, OpensteerErrorCodeSchema } from "@opensteer/core";
import { readBoundedJson } from "@opensteer/shared/boundedJson";
import { z } from "zod";
import { isBareOrigin } from "@opensteer/core";
import {
  AcknowledgeHostedOAuthRefreshRequestSchema,
  AcknowledgeHostedOAuthResultRequestSchema,
  CreateHostedOAuthAttemptRequestSchema,
  CreateHostedOAuthAttemptResponseSchema,
  CreateOAuthCallbackRelayRequestSchema,
  CreateHostedOAuthRevocationRequestSchema,
  CreateHostedOAuthRevocationResponseSchema,
  CreateHostedOAuthRefreshRequestSchema,
  CreateHostedOAuthRefreshResponseSchema,
  HostedOAuthAttemptStatusResponseSchema,
  OAuthBrokerPublicMetadataSchema,
  PullHostedOAuthRefreshResponseSchema,
  PullHostedOAuthResultResponseSchema,
  type CreateHostedOAuthAttemptRequest,
  type HostedOAuthAttemptId,
  type HostedOAuthRefreshTransactionId,
} from "@opensteer/control-plane-protocol";

const maximumBrokerResponseBytes = 512 * 1_024;

export class HostedOAuthBrokerClient {
  readonly #fetch: typeof globalThis.fetch;
  readonly #hostCredential: () => Promise<string | null>;
  readonly #serviceOrigin: string;
  readonly issuer: string;

  constructor(options: {
    readonly fetch?: typeof globalThis.fetch;
    readonly hostCredential: string | (() => Promise<string | null>);
    readonly issuer: URL;
    readonly serviceOrigin?: URL;
  }) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#hostCredential =
      typeof options.hostCredential === "string"
        ? () => Promise.resolve(options.hostCredential as string)
        : options.hostCredential;
    this.issuer = exactOrigin(options.issuer);
    this.#serviceOrigin = exactOrigin(options.serviceOrigin ?? options.issuer);
  }

  async metadata() {
    return OAuthBrokerPublicMetadataSchema.parse(
      await this.#request("/v1/oauth-broker/metadata?version=2"),
    );
  }

  async createAttempt(input: CreateHostedOAuthAttemptRequest) {
    return CreateHostedOAuthAttemptResponseSchema.parse(
      await this.#request("/v1/host/oauth-broker/attempts", {
        body: CreateHostedOAuthAttemptRequestSchema.parse(input),
        method: "POST",
      }),
    );
  }

  async createCallbackRelay(input: unknown) {
    return CreateHostedOAuthAttemptResponseSchema.parse(
      await this.#request("/v1/host/oauth-broker/callback-relays", {
        body: CreateOAuthCallbackRelayRequestSchema.parse(input),
        method: "POST",
      }),
    );
  }

  callbackUrl(provider: string): string {
    return new URL(
      `/v1/oauth-broker/callback/${encodeURIComponent(provider)}`,
      this.issuer,
    ).toString();
  }

  async status(attemptId: HostedOAuthAttemptId) {
    return HostedOAuthAttemptStatusResponseSchema.parse(
      await this.#request(`/v1/host/oauth-broker/attempts/${encodeURIComponent(attemptId)}`),
    );
  }

  async pull(attemptId: HostedOAuthAttemptId) {
    return PullHostedOAuthResultResponseSchema.parse(
      await this.#request(`/v1/host/oauth-broker/attempts/${encodeURIComponent(attemptId)}/result`),
    );
  }

  async acknowledge(attemptId: HostedOAuthAttemptId) {
    await this.#request(`/v1/host/oauth-broker/attempts/${encodeURIComponent(attemptId)}/ack`, {
      body: AcknowledgeHostedOAuthResultRequestSchema.parse({ attemptId }),
      method: "POST",
    });
  }

  async refresh(input: unknown) {
    return CreateHostedOAuthRefreshResponseSchema.parse(
      await this.#request("/v1/host/oauth-broker/refreshes", {
        body: CreateHostedOAuthRefreshRequestSchema.parse(input),
        method: "POST",
      }),
    );
  }

  async revoke(input: unknown) {
    return CreateHostedOAuthRevocationResponseSchema.parse(
      await this.#request("/v1/host/oauth-broker/revocations", {
        body: CreateHostedOAuthRevocationRequestSchema.parse(input),
        method: "POST",
      }),
    );
  }

  async pullRefresh(transactionId: HostedOAuthRefreshTransactionId) {
    return PullHostedOAuthRefreshResponseSchema.parse(
      await this.#request(
        `/v1/host/oauth-broker/refreshes/${encodeURIComponent(transactionId)}/result`,
      ),
    );
  }

  async acknowledgeRefresh(transactionId: HostedOAuthRefreshTransactionId) {
    await this.#request(
      `/v1/host/oauth-broker/refreshes/${encodeURIComponent(transactionId)}/ack`,
      {
        body: AcknowledgeHostedOAuthRefreshRequestSchema.parse({ transactionId }),
        method: "POST",
      },
    );
  }

  async #request(
    path: string,
    options: { readonly body?: unknown; readonly method?: "POST" } = {},
  ): Promise<unknown> {
    const hostCredential = await this.#hostCredential();
    if (!hostCredential) {
      throw new Error("Attach this Deployment to an Opensteer Account to use the OAuth broker");
    }
    let response: Response;
    try {
      response = await this.#fetch(new URL(path, this.#serviceOrigin), {
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        headers: {
          accept: "application/json",
          authorization: `Bearer ${hostCredential}`,
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        },
        method: options.method ?? "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new Error("Opensteer hosted OAuth service is unavailable", { cause: error });
    }
    if (!response.ok) throw await brokerRefusal(response);
    return readBoundedJson(response, {
      maximumBytes: maximumBrokerResponseBytes,
      sizeError: () => new Error("Opensteer hosted OAuth response is too large"),
    });
  }
}

function exactOrigin(value: URL): string {
  if (!isBareOrigin(value)) {
    throw new TypeError("Hosted OAuth broker issuer must be a bare origin");
  }
  return value.origin;
}

/**
 * A refusal from the Account service is the owner's problem to act on, not a
 * fault of this Deployment: it names the reason (a changed Host authority, a
 * stale catalog definition, an expired attempt), so it must surface with the
 * Account service's own code and sentence instead of collapsing to a 500.
 */
async function brokerRefusal(response: Response): Promise<OpensteerError> {
  let body: unknown = null;
  try {
    body = await readBoundedJson(response, {
      maximumBytes: maximumBrokerResponseBytes,
      sizeError: () => new Error("Opensteer hosted OAuth response is too large"),
    });
  } catch {
    await response.body?.cancel().catch(() => undefined);
  }
  const refusal = BrokerErrorBodySchema.safeParse(body);
  const detail = refusal.success ? refusal.data.error.message : `HTTP ${response.status}`;
  const code = refusal.success ? OpensteerErrorCodeSchema.safeParse(refusal.data.error.code) : null;
  return new OpensteerError({
    code: code?.success ? code.data : "conflict",
    message: `Opensteer Account refused the hosted OAuth request: ${detail}`,
    retryable: response.status >= 500,
  });
}

const BrokerErrorBodySchema = z.object({
  error: z.object({ code: z.string().max(64), message: z.string().max(1_000) }),
});
