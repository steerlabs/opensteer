import { readBoundedJson } from "@opensteer/shared/boundedJson";
import { isDeepStrictEqual } from "node:util";
import {
  ActivatePersonalHostAccountLinkRequestSchema,
  ActivatePersonalHostAccountLinkResponseSchema,
  ConnectProjectionRequestSchema,
  ConnectProjectionResponseSchema,
  ControlPlaneAccountIdSchema,
  ControlPlaneErrorResponseSchema,
  DirectoryProjectionRequestSchema,
  DirectoryProjectionResponseSchema,
  PublishHostAuthorityRequestSchema,
  PublishHostAuthorityResponseSchema,
  RevokeConnectRequestSchema,
  RevokeConnectResponseSchema,
  UnlinkPersonalHostRequestSchema,
  UnlinkPersonalHostResponseSchema,
  type ActivatePersonalHostAccountLinkRequest,
  type ActivatePersonalHostAccountLinkResponse,
  type DirectoryProjectionRequest,
  type PersonalHostAccessRouteEnvelope,
  type PublishHostAuthorityRequest,
  type RevokeConnectRequest,
  type RevokeConnectResponse,
  type UnlinkPersonalHostRequest,
} from "@opensteer/control-plane-protocol";
import type { Deployment } from "@opensteer/core";
import type { AccountDirectoryProjection } from "@opensteer/database";
import type { HostDiscoveryEnvelope } from "@opensteer/deployment-authority";

const maximumResponseBytes = 16 * 1_024;

export interface AccountDirectoryClientOptions {
  readonly controlApiOrigin: URL;
  readonly deployment: Pick<Deployment, "activeHostInstanceId" | "lifecycle">;
  readonly authorityEnvelope: HostDiscoveryEnvelope;
  readonly fetch?: typeof globalThis.fetch;
  readonly hostCredential: string;
}

export class AccountDirectoryClient {
  readonly #authorityEnvelope: HostDiscoveryEnvelope;
  readonly #controlApiOrigin: URL;
  readonly #deployment: AccountDirectoryClientOptions["deployment"];
  readonly #fetch: typeof globalThis.fetch;
  readonly #hostCredential: string;

  constructor(options: AccountDirectoryClientOptions) {
    if (options.deployment.lifecycle !== "active") {
      throw new Error("Account directory publication requires active Deployment authority");
    }
    this.#authorityEnvelope = options.authorityEnvelope;
    this.#controlApiOrigin = exactOrigin(options.controlApiOrigin);
    this.#deployment = options.deployment;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#hostCredential = hostCredential(options.hostCredential);
  }

  async publish(projection: AccountDirectoryProjection): Promise<void> {
    const accountId = ControlPlaneAccountIdSchema.parse(projection.accountId);
    const request = DirectoryProjectionRequestSchema.parse({
      generation: projection.generation,
      hostInstanceId: this.#deployment.activeHostInstanceId,
      observedAt: projection.observedAt,
      present: projection.present,
    } satisfies DirectoryProjectionRequest);
    const response = await this.#request(
      `/v1/host/directory/${encodeURIComponent(accountId)}`,
      "PUT",
      request,
      "Account directory",
    );
    const acknowledged = DirectoryProjectionResponseSchema.parse(
      await readBoundedJson(response, boundedJsonOptions),
    );
    if (
      acknowledged.accountId !== accountId ||
      acknowledged.generation !== projection.generation ||
      acknowledged.present !== projection.present
    ) {
      throw new Error("Account directory API acknowledged a different projection");
    }
  }

  /**
   * The Account stores a copy of this Host's signed discovery envelope and
   * every client verifies that copy before it will route to the Deployment.
   * Nothing else refreshes it, so the Host re-asserts its own identity rather
   * than letting the copy age out of the document format it was signed in.
   */
  async publishAuthority(): Promise<void> {
    const request = PublishHostAuthorityRequestSchema.parse({
      authorityEnvelope: this.#authorityEnvelope,
    } satisfies PublishHostAuthorityRequest);
    const response = await this.#request(
      "/v1/host/authority",
      "PUT",
      request,
      "Host authority publication",
    );
    const acknowledged = PublishHostAuthorityResponseSchema.parse(
      await readBoundedJson(response, boundedJsonOptions),
    );
    if (acknowledged.deploymentId !== this.#authorityEnvelope.document.deploymentId) {
      throw new Error("Host authority publication acknowledged a different Deployment");
    }
  }

  async activatePersonalAccountLink(
    input: ActivatePersonalHostAccountLinkRequest,
  ): Promise<ActivatePersonalHostAccountLinkResponse> {
    const request = ActivatePersonalHostAccountLinkRequestSchema.parse(input);
    const response = await this.#request(
      "/v1/host/personal-account-link/activate",
      "POST",
      request,
      "Personal Account-link activation",
      async (failed) => {
        const reason = await controlPlaneErrorReason(failed);
        if (failed.status === 404 && reason === "personal-account-link-not-found") {
          throw new PersonalAccountLinkNotFoundError();
        }
        if (failed.status === 409) {
          if (reason === "personal-account-link-reservation-expired") {
            throw new PersonalAccountLinkActivationExpiredError();
          }
          if (reason === "personal-account-link-cancelled") {
            throw new PersonalAccountLinkCancelledError();
          }
        }
      },
    );
    const activated = ActivatePersonalHostAccountLinkResponseSchema.parse(
      await readBoundedJson(response, boundedJsonOptions),
    );
    if (
      activated.deploymentId !== this.#authorityEnvelope.document.deploymentId ||
      activated.linkGeneration !== request.linkGeneration
    ) {
      throw new Error("Personal Account-link activation acknowledged another link");
    }
    return activated;
  }

  async publishPersonalConnect(input: {
    readonly accessRoute: PersonalHostAccessRouteEnvelope | null;
    readonly generation: number;
    readonly state: "disabled" | "offline" | "ready";
  }): Promise<void> {
    const origin = input.accessRoute?.document.route.origin ?? null;
    const request = ConnectProjectionRequestSchema.parse({
      accessRoute: input.accessRoute,
      generation: input.generation,
      hostInstanceId: this.#deployment.activeHostInstanceId,
      origin,
      state: input.state,
    });
    const response = await this.#request(
      "/v1/host/connect",
      "PUT",
      request,
      "Account Connect projection",
    );
    const acknowledged = ConnectProjectionResponseSchema.parse(
      await readBoundedJson(response, boundedJsonOptions),
    );
    if (
      acknowledged.generation !== input.generation ||
      acknowledged.state !== input.state ||
      acknowledged.origin !== origin ||
      !isDeepStrictEqual(acknowledged.accessRoute, input.accessRoute)
    ) {
      throw new Error("Account Connect projection API acknowledged different route authority");
    }
  }

  async revokePersonalConnect(input: RevokeConnectRequest): Promise<RevokeConnectResponse> {
    const request = RevokeConnectRequestSchema.parse(input);
    if (request.hostInstanceId !== this.#deployment.activeHostInstanceId) {
      throw new Error("Personal Connect revoke authority does not match this Host");
    }
    const response = await this.#request(
      "/v1/host/connect",
      "DELETE",
      request,
      "Personal Connect revoke",
    );
    return RevokeConnectResponseSchema.parse(await readBoundedJson(response, boundedJsonOptions));
  }

  async unlinkPersonalHost(input: UnlinkPersonalHostRequest): Promise<void> {
    const request = UnlinkPersonalHostRequestSchema.parse(input);
    const response = await this.#request(
      "/v1/host/personal-account-link",
      "DELETE",
      request,
      "Personal Account unlink",
      async (failed) => {
        if (
          failed.status === 404 &&
          (await controlPlaneErrorReason(failed)) === "personal-account-link-not-found"
        ) {
          throw new PersonalAccountLinkNotFoundError();
        }
      },
    );
    const acknowledged = UnlinkPersonalHostResponseSchema.parse(
      await readBoundedJson(response, boundedJsonOptions),
    );
    if (acknowledged.deploymentId !== this.#authorityEnvelope.document.deploymentId) {
      throw new Error("Personal Account unlink API acknowledged a different Deployment");
    }
  }

  async #request(
    path: string,
    method: "DELETE" | "POST" | "PUT",
    body: unknown,
    label: string,
    handleFailure?: (response: Response) => Promise<void>,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.#fetch(new URL(path, this.#controlApiOrigin), {
        body: JSON.stringify(body),
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.#hostCredential}`,
          "content-type": "application/json",
        },
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new Error(`${label} API request failed`, { cause: error });
    }
    if (!response.ok) {
      await handleFailure?.(response.clone());
      await response.body?.cancel();
      throw new Error(`${label} API returned HTTP ${response.status}`);
    }
    return response;
  }
}

export class PersonalAccountLinkActivationExpiredError extends Error {
  readonly code = "personal-account-link-activation-expired";

  constructor() {
    super("The Personal Account-link activation result has expired.");
    this.name = "PersonalAccountLinkActivationExpiredError";
  }
}

export class PersonalAccountLinkCancelledError extends Error {
  readonly code = "personal-account-link-cancelled";

  constructor() {
    super("The Personal Account-link reservation was cancelled.");
    this.name = "PersonalAccountLinkCancelledError";
  }
}

export class PersonalAccountLinkNotFoundError extends Error {
  readonly code = "personal-account-link-not-found";

  constructor() {
    super("Opensteer Account holds no Personal Host link for this credential.");
    this.name = "PersonalAccountLinkNotFoundError";
  }
}

async function controlPlaneErrorReason(response: Response): Promise<string | null> {
  let body: unknown;
  try {
    body = await readBoundedJson(response, boundedJsonOptions);
  } catch {
    return null;
  }
  const parsed = ControlPlaneErrorResponseSchema.safeParse(body);
  return parsed.success ? (parsed.data.error.reason ?? null) : null;
}

function exactOrigin(input: URL): URL {
  const url = new URL(input.toString());
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("Account directory control API must be an uncredentialed HTTP(S) origin");
  }
  return url;
}

function hostCredential(value: string): string {
  if (!/^osc_[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new TypeError("Account directory Host credential is invalid");
  }
  return value;
}

const boundedJsonOptions = {
  emptyError: () => new Error("Account directory API returned an empty response"),
  invalidJsonError: (cause: unknown) =>
    new Error("Account directory API returned invalid JSON", { cause }),
  maximumBytes: maximumResponseBytes,
  sizeError: () => new Error("Account directory API response exceeded its size limit"),
} as const;
