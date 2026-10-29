import { readBoundedText } from "@opensteer/shared/boundedJson";
import {
  CancelPersonalHostAccountLinkOperationResponseSchema,
  CompletePersonalHostAccountLinkRequestSchema,
  CompletePersonalHostAccountLinkResponseSchema,
  ControlPlaneErrorResponseSchema,
  IssuePersonalHostAccountLinkChallengeRequestSchema,
  IssuePersonalHostAccountLinkChallengeResponseSchema,
  IssueAccountHostSessionGrantResponseSchema,
  IssuePersonalAccountHostSessionGrantRequestSchema,
  ListAccountDeploymentsResponseSchema,
  RemoveAccountDeploymentResponseSchema,
  UpdateAccountDeploymentNameRequestSchema,
  UpdateAccountDeploymentNameResponseSchema,
  type AccountDeployment,
  type AccountDeploymentDirectoryEntry,
  type CompletePersonalHostAccountLinkRequest,
  type CompletePersonalHostAccountLinkResponse,
  type ControlPlaneAccountId,
  type ControlPlaneErrorCode,
  type IssueAccountHostSessionGrantResponse,
  type IssuePersonalHostAccountLinkChallengeRequest,
  type IssuePersonalHostAccountLinkChallengeResponse,
  type IssuePersonalAccountHostSessionGrantRequest,
  type PersonalHostAccountLinkOperationId,
  type PersonalHostAccountLinkChallengeId,
} from "@opensteer/control-plane-protocol";
import { DeploymentIdSchema, bareServiceOrigin, type DeploymentId } from "@opensteer/core";
import {
  HostDiscoveryEnvelopeSchema,
  PersonalHostAccessRouteEnvelopeSchema,
  hostAuthorityIdentityMatches,
  hostKeyFingerprint,
  personalHostAccessRouteEnvelopeSha256,
  verifyHostDiscoveryEnvelope,
  sameDiscoveryDocument,
  verifyPersonalHostAccessRouteEnvelope,
} from "@opensteer/deployment-authority";
import type { DesktopDeploymentUnavailableReason } from "@opensteer/protocol/desktop";
import {
  HostVersionMismatchError,
  deploymentConnectionFromVerifiedEndpoints,
  deploymentConnectionFromVerifiedPersonalRoute,
  verifyPersonalAccessEndpoint,
  verifyAccessEndpoint,
  VerifiedAccessEndpointSchema,
  DeploymentConnectionInputSchema,
  type DeploymentCatalogStore,
  type AccountDeploymentConnectionSource,
} from "./deployment-catalog.js";
import {
  ClientOperationError,
  clientTimeoutError,
  transientHttpStatus,
  unrefTimer,
} from "./operation-error.js";

const directoryTimeoutMs = 15_000;
const maximumDirectoryResponseBytes = 1 * 1_024 * 1_024;
const maximumAccountDeployments = 100;
const verificationConcurrency = 4;

export class AccountRequestError extends ClientOperationError {
  readonly code: ControlPlaneErrorCode | null;
  readonly reason: string | null;
  readonly status: number;

  constructor(input: {
    readonly code: ControlPlaneErrorCode | null;
    readonly status: number;
    readonly message: string;
    readonly reason?: string | null;
  }) {
    super(input.message, transientHttpStatus(input.status) ? "transient" : "blocked");
    this.name = "AccountRequestError";
    this.code = input.code;
    this.reason = input.reason ?? null;
    this.status = input.status;
  }
}

export interface AccountDeploymentDirectoryAuthorization {
  accountAuthorizationLease(): Promise<{
    readonly authorization: string;
    readonly issuer: string;
    readonly signal: AbortSignal;
    readonly subject: ControlPlaneAccountId;
  } | null>;
  /**
   * Who is signed in, known without a usable token. Present wherever the
   * session is held locally, so naming the Account never waits on a refresh
   * and never fails because the Account is briefly out of reach.
   */
  accountIdentity?(): { readonly issuer: string; readonly subject: ControlPlaneAccountId } | null;
}

export interface AccountHostSessionGrant {
  readonly response: IssueAccountHostSessionGrantResponse;
  readonly signal: AbortSignal;
}

/** Why one directory entry could not be verified, before it is named. */
interface DirectoryVerificationFailure {
  readonly deploymentId: DeploymentId;
  readonly reason: DesktopDeploymentUnavailableReason;
}

export interface AccountDeploymentDirectoryUnavailable extends DirectoryVerificationFailure {
  /** This Account's relation to the listing, which decides what it may do with it. */
  readonly accountAccess: "owner" | "member";
  /** The directory's name for the place, since it never entered the local catalog. */
  readonly name: string;
}

export interface AccountDeploymentDirectorySync {
  readonly syncedDeploymentIds: readonly DeploymentId[];
  readonly unavailable: readonly AccountDeploymentDirectoryUnavailable[];
}

/**
 * Turns the Account directory into verified device-local routes.
 *
 * Account metadata is a discovery hint, never Host authorization. Every route
 * is fetched without Account credentials and must prove the exact Deployment,
 * Host instance and Account-pinned signing key before it
 * enters the local catalog.
 */
export class AccountDeploymentDirectoryService {
  readonly #accountOrigin: string | null;
  readonly #authorization: AccountDeploymentDirectoryAuthorization;
  readonly #catalog: Pick<DeploymentCatalogStore, "reconcileAccountDeployments">;
  readonly #fetch: typeof globalThis.fetch;
  readonly #personalProjection:
    | ((
        deployment: AccountDeploymentDirectoryEntry,
        source: AccountDeploymentConnectionSource,
        signal: AbortSignal,
      ) => Promise<void>)
    | undefined;
  readonly #requestTimeoutMs: number;
  #syncTail: Promise<AccountDeploymentDirectorySync> | undefined;

  constructor(options: {
    readonly accountOrigin: URL | string | null;
    readonly authorization: AccountDeploymentDirectoryAuthorization;
    readonly catalog: Pick<DeploymentCatalogStore, "reconcileAccountDeployments">;
    readonly fetch?: typeof globalThis.fetch;
    readonly requestTimeoutMs?: number;
    readonly personalProjection?: (
      deployment: AccountDeploymentDirectoryEntry,
      source: AccountDeploymentConnectionSource,
      signal: AbortSignal,
    ) => Promise<void>;
  }) {
    this.#accountOrigin =
      options.accountOrigin === null
        ? null
        : bareServiceOrigin(options.accountOrigin, "Opensteer Account origin");
    this.#authorization = options.authorization;
    this.#catalog = options.catalog;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#personalProjection = options.personalProjection;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? directoryTimeoutMs;
  }

  sync(): Promise<AccountDeploymentDirectorySync> {
    this.#syncTail ??= this.#sync().finally(() => {
      this.#syncTail = undefined;
    });
    return this.#syncTail;
  }

  get accountOrigin(): string | null {
    return this.#accountOrigin;
  }

  async accountIdentity(): Promise<{
    readonly issuer: string;
    readonly subject: ControlPlaneAccountId;
  } | null> {
    const credential =
      this.#authorization.accountIdentity?.() ??
      (await this.#authorization.accountAuthorizationLease());
    return credential ? { issuer: credential.issuer, subject: credential.subject } : null;
  }

  async issuePersonalHostAccountLinkChallenge(
    input: IssuePersonalHostAccountLinkChallengeRequest,
  ): Promise<IssuePersonalHostAccountLinkChallengeResponse> {
    const response = await this.#accountJson("/v1/account/personal-host-links/challenges", {
      body: JSON.stringify(IssuePersonalHostAccountLinkChallengeRequestSchema.parse(input)),
      method: "POST",
    });
    return IssuePersonalHostAccountLinkChallengeResponseSchema.parse(response);
  }

  async completePersonalHostAccountLink(
    challengeId: PersonalHostAccountLinkChallengeId,
    input: CompletePersonalHostAccountLinkRequest,
  ): Promise<CompletePersonalHostAccountLinkResponse> {
    const response = await this.#accountJson(
      `/v1/account/personal-host-links/${encodeURIComponent(challengeId)}/complete`,
      {
        body: JSON.stringify(CompletePersonalHostAccountLinkRequestSchema.parse(input)),
        method: "POST",
      },
    );
    return CompletePersonalHostAccountLinkResponseSchema.parse(response);
  }

  async cancelPersonalHostAccountLinkOperation(
    operationId: PersonalHostAccountLinkOperationId,
  ): Promise<void> {
    const response = await this.#accountJson(
      `/v1/account/personal-host-link-operations/${encodeURIComponent(operationId)}`,
      { method: "DELETE" },
    );
    const cancelled = CancelPersonalHostAccountLinkOperationResponseSchema.parse(response);
    if (cancelled.operationId !== operationId) {
      throw new Error("Opensteer Account cancelled a different Personal Host link operation.");
    }
  }

  async renamePersonalDeployment(
    deploymentId: DeploymentId,
    name: string,
  ): Promise<AccountDeployment> {
    const response = await this.#accountJson(
      `/v1/account/deployments/${encodeURIComponent(deploymentId)}/name`,
      {
        body: JSON.stringify(UpdateAccountDeploymentNameRequestSchema.parse({ name })),
        method: "PUT",
      },
    );
    return UpdateAccountDeploymentNameResponseSchema.parse(response).deployment;
  }

  async removeFromAccount(deploymentId: DeploymentId): Promise<void> {
    const response = RemoveAccountDeploymentResponseSchema.parse(
      await this.#accountJson(`/v1/account/deployments/${encodeURIComponent(deploymentId)}`, {
        method: "DELETE",
      }),
    );
    if (response.deploymentId !== deploymentId) {
      throw new Error("Opensteer Account removed a different deployment from the directory.");
    }
  }

  async issuePersonalHostSessionGrant(
    deploymentId: DeploymentId,
    input: IssuePersonalAccountHostSessionGrantRequest,
  ): Promise<AccountHostSessionGrant> {
    const result = await this.#accountJsonWithLease(
      `/v1/account/deployments/${encodeURIComponent(deploymentId)}/personal-session-grants`,
      {
        body: JSON.stringify(IssuePersonalAccountHostSessionGrantRequestSchema.parse(input)),
        method: "POST",
      },
    );
    return {
      response: IssueAccountHostSessionGrantResponseSchema.parse(result.body),
      signal: result.signal,
    };
  }

  async #sync(): Promise<AccountDeploymentDirectorySync> {
    const accountOrigin = this.#accountOrigin;
    if (accountOrigin === null) {
      throw new Error("Opensteer Account deployment discovery isn't available yet.");
    }
    const credential = await this.#authorization.accountAuthorizationLease();
    if (!credential)
      throw new Error("Sign in to your Opensteer account to see your computers and servers.");
    if (credential.issuer !== accountOrigin) {
      throw new Error("The signed-in Account issuer does not match this directory.");
    }
    const source: AccountDeploymentConnectionSource = {
      issuer: credential.issuer,
      kind: "account",
      subject: credential.subject,
    };
    const deployments = await this.#fetchDirectory(
      accountOrigin,
      credential.authorization,
      credential.signal,
    );
    if (deployments.length > maximumAccountDeployments) {
      throw new Error("This Account has more Hosts than this Desktop version can safely store.");
    }

    const syncedDeploymentIds: DeploymentId[] = [];
    const unavailable: AccountDeploymentDirectoryUnavailable[] = [];
    const connections: ReturnType<typeof deploymentConnectionFromVerifiedEndpoints>[] = [];
    for (let offset = 0; offset < deployments.length; offset += verificationConcurrency) {
      const batch = deployments.slice(offset, offset + verificationConcurrency);
      const results = await Promise.all(
        batch.map((deployment) => this.#verify(deployment, source)),
      );
      for (const [index, result] of results.entries()) {
        if ("connection" in result) {
          const deployment = batch[index]!;
          if (deployment.reachability === "routed") {
            credential.signal.throwIfAborted();
            await this.#personalProjection?.(deployment, source, credential.signal);
          }
          connections.push(result.connection);
          syncedDeploymentIds.push(result.deploymentId);
        } else {
          unavailable.push({
            ...result,
            accountAccess: batch[index]!.access,
            name: batch[index]!.name,
          });
        }
      }
    }
    credential.signal.throwIfAborted();
    await this.#catalog.reconcileAccountDeployments({
      connections,
      directoryDeployments: deployments,
      source,
    });
    return { syncedDeploymentIds, unavailable };
  }

  async #fetchDirectory(
    accountOrigin: string,
    authorization: string,
    accountSignal: AbortSignal,
  ): Promise<readonly AccountDeploymentDirectoryEntry[]> {
    const endpoint = new URL("/v1/account/deployments", accountOrigin).toString();
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(clientTimeoutError("Account Host discovery timed out.")),
      this.#requestTimeoutMs,
    );
    unrefTimer(timeout);
    const relayAccountAbort = () => controller.abort(accountSignal.reason);
    if (accountSignal.aborted) relayAccountAbort();
    else accountSignal.addEventListener("abort", relayAccountAbort, { once: true });
    try {
      const response = await this.#fetch(endpoint, {
        cache: "no-store",
        credentials: "omit",
        headers: { accept: "application/json", authorization },
        method: "GET",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      accountSignal.throwIfAborted();
      if (response.redirected || (response.url !== "" && response.url !== endpoint)) {
        throw new Error("Account Host discovery must not redirect.");
      }
      if (!response.ok) throw new Error("Account Host discovery was rejected.");
      if (response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
        throw new Error("Account Host discovery returned an invalid response.");
      }
      const decoded = JSON.parse(
        await readBoundedText(response, {
          maximumBytes: maximumDirectoryResponseBytes,
          sizeError: () => new Error("Account Host discovery response is too large."),
        }),
      ) as unknown;
      return ListAccountDeploymentsResponseSchema.parse(decoded).deployments;
    } catch (error) {
      if (controller.signal.aborted) {
        throw controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new Error("Account Host discovery was cancelled.", { cause: error });
      }
      if (error instanceof SyntaxError) {
        throw new Error("Account Host discovery returned an invalid response.");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      accountSignal.removeEventListener("abort", relayAccountAbort);
    }
  }

  async #accountJson(
    path: string,
    input: { readonly method: "DELETE" | "GET" | "POST" | "PUT"; readonly body?: string },
  ): Promise<unknown> {
    return (await this.#accountJsonWithLease(path, input)).body;
  }

  async #accountJsonWithLease(
    path: string,
    input: { readonly method: "DELETE" | "GET" | "POST" | "PUT"; readonly body?: string },
  ): Promise<{ readonly body: unknown; readonly signal: AbortSignal }> {
    const accountOrigin = this.#accountOrigin;
    if (accountOrigin === null) {
      throw new Error("Opensteer Account isn't available yet.");
    }
    const lease = await this.#authorization.accountAuthorizationLease();
    if (!lease || !/^Bearer [^\p{Control}\s]+$/u.test(lease.authorization)) {
      // Reported as an unauthorized Account request so every caller classifies
      // a missing credential exactly like a rejected one.
      throw new AccountRequestError({
        code: null,
        status: 401,
        message: "Sign in to your Opensteer Account to continue.",
      });
    }
    if (lease.issuer !== accountOrigin) {
      throw new Error("The signed-in Account issuer does not match this service.");
    }
    const endpoint = new URL(path, accountOrigin).toString();
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(clientTimeoutError("Opensteer Account request timed out.")),
      this.#requestTimeoutMs,
    );
    unrefTimer(timeout);
    const relayAccountAbort = () => controller.abort(lease.signal.reason);
    if (lease.signal.aborted) relayAccountAbort();
    else lease.signal.addEventListener("abort", relayAccountAbort, { once: true });
    try {
      const response = await this.#fetch(endpoint, {
        cache: "no-store",
        credentials: "omit",
        headers: {
          accept: "application/json",
          authorization: lease.authorization,
          ...(input.body === undefined ? {} : { "content-type": "application/json" }),
        },
        method: input.method,
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
        ...(input.body === undefined ? {} : { body: input.body }),
      });
      lease.signal.throwIfAborted();
      if (response.redirected || (response.url !== "" && response.url !== endpoint)) {
        throw new Error("Opensteer Account requests must not redirect.");
      }
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
      if (!response.ok) {
        const errorBody =
          contentType === "application/json"
            ? ControlPlaneErrorResponseSchema.safeParse(
                JSON.parse(
                  await readBoundedText(response, {
                    maximumBytes: maximumDirectoryResponseBytes,
                    sizeError: () => new Error("Account Host discovery response is too large."),
                  }),
                ) as unknown,
              ).data
            : undefined;
        if (contentType !== "application/json") await response.body?.cancel();
        throw new AccountRequestError({
          code: errorBody?.error.code ?? null,
          reason: errorBody?.error.reason ?? null,
          status: response.status,
          message: errorBody?.error.message ?? `Opensteer Account request was rejected.`,
        });
      }
      if (contentType !== "application/json") {
        throw new Error("Opensteer Account returned an invalid response.");
      }
      const body = JSON.parse(
        await readBoundedText(response, {
          maximumBytes: maximumDirectoryResponseBytes,
          sizeError: () => new Error("Account Host discovery response is too large."),
        }),
      ) as unknown;
      lease.signal.throwIfAborted();
      return { body, signal: lease.signal };
    } catch (error) {
      if (controller.signal.aborted) {
        throw controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new Error("Opensteer Cloud request was cancelled.", { cause: error });
      }
      if (error instanceof SyntaxError) {
        throw new Error("Opensteer Cloud returned an invalid response.");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      lease.signal.removeEventListener("abort", relayAccountAbort);
    }
  }

  async #verify(
    deployment: AccountDeploymentDirectoryEntry,
    source: AccountDeploymentConnectionSource,
  ): Promise<
    | {
        readonly connection: ReturnType<typeof deploymentConnectionFromVerifiedEndpoints>;
        readonly deploymentId: DeploymentId;
      }
    | DirectoryVerificationFailure
  > {
    const deploymentId = DeploymentIdSchema.parse(deployment.id);
    if (deployment.lifecycle !== "active") {
      return { deploymentId, reason: "not-active" };
    }
    let discovery;
    let authorityEnvelope;
    try {
      authorityEnvelope = HostDiscoveryEnvelopeSchema.parse(deployment.authorityEnvelope);
      discovery = verifyHostDiscoveryEnvelope(authorityEnvelope);
      if (
        !hostAuthorityIdentityMatches(
          discovery,
          hostKeyFingerprint(authorityEnvelope.publicKey.spki),
          deployment.authority,
        )
      ) {
        return { deploymentId, reason: "identity-mismatch" };
      }
      if (
        deployment.reachability === "canonical" &&
        deployment.canonicalOrigin !== discovery.canonicalOrigin
      ) {
        return { deploymentId, reason: "identity-mismatch" };
      }
    } catch {
      return { deploymentId, reason: "identity-mismatch" };
    }
    try {
      if (deployment.reachability === "routed") {
        const projected = deployment.connectRoute;
        if (!projected) {
          return {
            connection: DeploymentConnectionInputSchema.parse({
              accountAccess: deployment.access,
              accountLivenessExpiresAt: null,
              authority: authorityEnvelope,
              bootstrapMethods: [],
              endpoints: [
                {
                  kind: "canonical",
                  origin: discovery.canonicalOrigin,
                  verifiedAt: deployment.updatedAt,
                },
              ],
              kind: "personal",
              name: deployment.name,
              personalAccessRoute: null,
              preferredEndpointOrigin: null,
              reachability: "routed",
              source,
            }),
            deploymentId,
          };
        }
        const accessRoute = verifyPersonalHostAccessRouteEnvelope(
          PersonalHostAccessRouteEnvelopeSchema.parse(projected),
        );
        if (
          !sameDiscoveryDocument(accessRoute.document.authority, discovery) ||
          hostKeyFingerprint(accessRoute.publicKey.spki) !==
            hostKeyFingerprint(authorityEnvelope.publicKey.spki)
        ) {
          return { deploymentId, reason: "identity-mismatch" };
        }
        if (!deployment.lastSeenAt || Date.parse(deployment.lastSeenAt.expiresAt) <= Date.now()) {
          return {
            connection: DeploymentConnectionInputSchema.parse({
              accountAccess: deployment.access,
              accountLivenessExpiresAt: deployment.lastSeenAt?.expiresAt ?? deployment.updatedAt,
              authority: authorityEnvelope,
              bootstrapMethods: [],
              endpoints: [
                VerifiedAccessEndpointSchema.parse({
                  kind: "canonical",
                  origin: discovery.canonicalOrigin,
                  verifiedAt: deployment.updatedAt,
                }),
              ],
              kind: "personal",
              name: deployment.name,
              personalAccessRoute: accessRoute,
              preferredEndpointOrigin: null,
              reachability: "routed",
              source,
            }),
            deploymentId,
          };
        }
        const verified = await verifyPersonalAccessEndpoint({
          expectedDeploymentId: deploymentId,
          expectedDiscovery: discovery,
          fetch: this.#fetch,
          origin: accessRoute.document.route.origin,
        });
        // The canonical envelope digest is what the Host itself compares, so
        // the two sides agree without depending on property order.
        if (
          !sameDiscoveryDocument(verified.discovery, discovery) ||
          personalHostAccessRouteEnvelopeSha256(verified.accessRoute) !==
            personalHostAccessRouteEnvelopeSha256(accessRoute)
        ) {
          return { deploymentId, reason: "identity-mismatch" };
        }
        return {
          connection: deploymentConnectionFromVerifiedPersonalRoute({
            accountAccess: deployment.access,
            accountLivenessExpiresAt: deployment.lastSeenAt?.expiresAt ?? null,
            name: deployment.name,
            source,
            verified,
          }),
          deploymentId,
        };
      }
      const verified = await verifyAccessEndpoint({
        expectedDeploymentId: deploymentId,
        expectedHostKeyFingerprint: deployment.authority.hostKeyFingerprint,
        fetch: this.#fetch,
        kind: "canonical",
        origin: deployment.canonicalOrigin,
      });
      if (
        !hostAuthorityIdentityMatches(
          verified.discovery,
          hostKeyFingerprint(verified.discoveryEnvelope.publicKey.spki),
          deployment.authority,
        )
      ) {
        return { deploymentId, reason: "identity-mismatch" };
      }
      return {
        connection: deploymentConnectionFromVerifiedEndpoints({
          accountAccess: deployment.access,
          endpoints: [verified],
          kind: "self-hosted",
          name: deployment.name,
          source,
        }),
        deploymentId,
      };
    } catch (error) {
      // A Host that answered and named a protocol epoch is not unreachable —
      // it is on the wrong side of one, and only its own side can repair that.
      if (error instanceof HostVersionMismatchError) {
        return { deploymentId, reason: error.code };
      }
      return { deploymentId, reason: "host-unavailable" };
    }
  }
}
