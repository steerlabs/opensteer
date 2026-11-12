import {
  DesiredHostedTeamsResponseSchema,
  hostedTeamStatusPath,
  hostedTeamsDesiredPath,
  type DesiredHostedTeam,
  type HostedTeamStatusReport,
} from "@opensteer/control-plane-protocol/hosted-teams";
import { z } from "zod";
import type { AccountApi } from "./reconcile.js";

const requestTimeoutMilliseconds = 15_000;
/** Tokens last an hour; take a fresh one well before Account would refuse it. */
const tokenRefreshMarginSeconds = 5 * 60;
const metadataIdentity =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";

/**
 * This pod's Google-signed ID token for Account, from GKE's metadata server. Workload Identity
 * makes it the provisioner's service account, which is the one identity Account admits.
 */
export function workloadIdentityToken(
  audience: string,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): () => Promise<string> {
  let cached: { readonly token: string; readonly expiresAt: number } | undefined;
  return async () => {
    if (cached && cached.expiresAt - tokenRefreshMarginSeconds * 1_000 > now()) return cached.token;
    const url = new URL(metadataIdentity);
    url.search = new URLSearchParams({ audience, format: "full" }).toString();
    const response = await fetchImpl(url, {
      headers: { "metadata-flavor": "Google" },
      signal: AbortSignal.timeout(requestTimeoutMilliseconds),
    });
    if (!response.ok)
      throw new Error(`The metadata server refused an ID token (${response.status})`);
    const token = (await response.text()).trim();
    const payload = z
      .object({ exp: z.number() })
      .parse(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")));
    cached = { token, expiresAt: payload.exp * 1_000 };
    return token;
  };
}

export class AccountClient implements AccountApi {
  readonly #origin: URL;
  readonly #token: () => Promise<string>;
  readonly #fetch: typeof fetch;

  constructor(input: {
    readonly origin: URL;
    readonly token: () => Promise<string>;
    readonly fetch?: typeof fetch;
  }) {
    this.#origin = input.origin;
    this.#token = input.token;
    this.#fetch = input.fetch ?? fetch;
  }

  async desired(): Promise<readonly DesiredHostedTeam[]> {
    const response = await this.#request("GET", hostedTeamsDesiredPath);
    return DesiredHostedTeamsResponseSchema.parse(await response.json()).teams;
  }

  async report(id: string, report: HostedTeamStatusReport): Promise<void> {
    await this.#request("POST", hostedTeamStatusPath(id), report);
  }

  async #request(method: string, path: string, body?: unknown): Promise<Response> {
    const response = await this.#fetch(new URL(path, this.#origin), {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(requestTimeoutMilliseconds),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${await this.#token()}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok)
      throw new AccountRequestError(
        response.status,
        `Account answered ${method} ${path} with ${response.status}`,
      );
    return response;
  }
}

export class AccountRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "AccountRequestError";
    this.status = status;
  }
}
