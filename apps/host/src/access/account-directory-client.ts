import { readBoundedJson } from "@opensteer/shared/boundedJson";
import { isDeepStrictEqual } from "node:util";
import {
  AccountOperationRefusalReasonSchema,
  type AccountOperationRefusalReason,
  type ConnectOperationCompletion,
  type ControlPlaneErrorReason,
  ConnectCredentialResponseSchema,
  ProvisionConnectRequestSchema,
  RotateConnectCredentialRequestSchema,
  type ProvisionConnectRequest,
  type RotateConnectCredentialRequest,
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
      (status, reason) => {
        if (status === 404 && reason === "personal-account-link-not-found") {
          throw new PersonalAccountLinkNotFoundError();
        }
        if (status === 409) {
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

  async connectCredential(
    input: ProvisionConnectRequest | RotateConnectCredentialRequest,
    rotate: boolean,
  ) {
    const request = rotate
      ? RotateConnectCredentialRequestSchema.parse(input)
      : ProvisionConnectRequestSchema.parse(input);
    if (request.hostInstanceId !== this.#deployment.activeHostInstanceId)
      throw new Error("Personal Connect authority does not match this Host");
    const response = await this.#request(
      rotate ? "/v1/host/connect/credential/rotate" : "/v1/host/connect/provision",
      "POST",
      request,
      "Personal Connect credential",
      undefined,
      30_000,
    );
    return ConnectCredentialResponseSchema.parse(
      await readBoundedJson(response, { ...boundedJsonOptions, maximumBytes: 32 * 1024 }),
    );
  }

  async revokePersonalConnect(input: RevokeConnectRequest): Promise<RevokeConnectResponse> {
    const request = RevokeConnectRequestSchema.parse(input);
    if (request.hostInstanceId !== this.#deployment.activeHostInstanceId) {
      throw new Error("Personal Connect revoke authority does not match this Host");
    }
    try {
      const response = await this.#request(
        "/v1/host/connect",
        "DELETE",
        request,
        "Personal Connect revoke",
      );
      return RevokeConnectResponseSchema.parse(await readBoundedJson(response, boundedJsonOptions));
    } catch (error) {
      if (
        error instanceof AccountRequestError &&
        error.completedOperation?.operationKind === "revoke" &&
        error.completedOperation.operationId === request.operationId
      ) {
        // The effect committed, even though a later operation changed the resource.
        // Return its historical result so the journal's conditional finalizer runs.
        return { generation: error.completedOperation.generation, revoked: true };
      }
      throw error;
    }
  }

  async unlinkPersonalHost(input: UnlinkPersonalHostRequest): Promise<void> {
    const request = UnlinkPersonalHostRequestSchema.parse(input);
    const response = await this.#request(
      "/v1/host/personal-account-link",
      "DELETE",
      request,
      "Personal Account unlink",
      (status, reason) => {
        if (status === 404 && reason === "personal-account-link-not-found") {
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
    handleFailure?: (status: number, reason: ControlPlaneErrorReason | null) => void,
    timeoutMs = 15_000,
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
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new Error(`${label} API request failed`, { cause: error });
    }
    if (!response.ok) {
      let accountError;
      try {
        accountError = await controlPlaneError(response);
        handleFailure?.(response.status, accountError?.reason ?? null);
      } finally {
        await response.body?.cancel();
      }
      throw new AccountRequestError({
        message: `${label} API returned HTTP ${response.status}`,
        status: response.status,
        refusalReason: AccountOperationRefusalReasonSchema.safeParse(accountError?.reason).data,
        completedOperation:
          accountError?.reason === "connect-operation-completed-superseded"
            ? accountError.completedOperation
            : undefined,
      });
    }
    return response;
  }
}

export class AccountRequestError extends Error {
  readonly status: number;
  readonly refusalReason: AccountOperationRefusalReason | null;
  readonly completedOperation: ConnectOperationCompletion | undefined;

  constructor(options: {
    readonly message: string;
    readonly status: number;
    readonly refusalReason?: AccountOperationRefusalReason | undefined;
    readonly completedOperation?: ConnectOperationCompletion | undefined;
  }) {
    super(options.message);
    this.name = "AccountRequestError";
    this.status = options.status;
    this.refusalReason = options.refusalReason ?? null;
    this.completedOperation = options.completedOperation;
  }

  refuses(operation: "activate" | "unlink" | "projection" | "revoke"): boolean {
    switch (operation) {
      case "activate":
        return (
          this.refusalReason === "personal-account-link-reservation-expired" ||
          this.refusalReason === "personal-account-link-cancelled" ||
          this.refusalReason === "personal-account-link-not-found"
        );
      case "unlink":
        return this.refusalReason === "connect-resource-active";
      case "projection":
        return this.refusalReason === "connect-revocation-required";
      case "revoke":
        return false;
    }
  }
}

export class PersonalAccountLinkActivationExpiredError extends AccountRequestError {
  readonly code = "personal-account-link-activation-expired";

  constructor() {
    super({
      message: "The Personal Account-link activation result has expired.",
      status: 409,
      refusalReason: "personal-account-link-reservation-expired",
    });
    this.name = "PersonalAccountLinkActivationExpiredError";
  }
}

export class PersonalAccountLinkCancelledError extends AccountRequestError {
  readonly code = "personal-account-link-cancelled";

  constructor() {
    super({
      message: "The Personal Account-link reservation was cancelled.",
      status: 409,
      refusalReason: "personal-account-link-cancelled",
    });
    this.name = "PersonalAccountLinkCancelledError";
  }
}

export class PersonalAccountLinkNotFoundError extends AccountRequestError {
  readonly code = "personal-account-link-not-found";

  constructor() {
    super({
      message: "Opensteer Account holds no Personal Host link for this credential.",
      status: 404,
      refusalReason: "personal-account-link-not-found",
    });
    this.name = "PersonalAccountLinkNotFoundError";
  }
}

async function controlPlaneError(response: Response) {
  let body: unknown;
  try {
    body = await readBoundedJson(response, boundedJsonOptions);
  } catch {
    return null;
  }
  const parsed = ControlPlaneErrorResponseSchema.safeParse(body);
  if (!parsed.success) return null;
  const error = parsed.data.error;
  // A typed reason on an inconsistent status/code is not an acknowledgement.
  const expectedStatus = error.reason === "personal-account-link-not-found" ? 404 : 409;
  const expectedCode = expectedStatus === 404 ? "not_found" : "conflict";
  return response.status === expectedStatus && error.code === expectedCode ? error : null;
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
