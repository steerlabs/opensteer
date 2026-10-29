import { readBoundedText } from "@opensteer/shared/boundedJson";
import { createHash, createPrivateKey, sign, type KeyObject } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { z } from "zod";
import { isLoopbackHostname } from "@opensteer/core";
import {
  PortableFsAbortError,
  PortableFsControlPlaneError,
  PortableFsError,
  PortableFsOutputLimitError,
  PortableFsProtocolError,
  PortableFsRenewalScopeFencedError,
  PortableFsTimeoutError,
  redactSensitiveText,
  type PortableFsOperation,
} from "./errors.js";
import {
  CreatePortableFsVolumeInputSchema,
  IssuePortableFsMountGrantInputSchema,
  IssuePortableFsReadSessionGrantInputSchema,
  PortableFsIdempotencyKeySchema,
  PortableFsManagerErrorEnvelopeSchema,
  PortableFsManagerCapacitySchema,
  PortableFsDestroyedVolumeSchema,
  PortableFsManagerIdentitySchema,
  PortableFsManagerMountAuthorizationSchema,
  PortableFsManagerMountEnrollmentRevocationSchema,
  PortableFsManagerReadSessionAuthorizationSchema,
  PortableFsManagerRemoteCodeSchema,
  PortableFsManagerVolumeSchema,
  PortableFsManagerRenewalFencesSchema,
  PortableFsMountManagerEndpointSchema,
  PortableFsMountGrantSchema,
  PortableFsMountEnrollmentRevocationSchema,
  PortableFsReadSessionGrantSchema,
  PortableFsRenewalFencesSchema,
  PortableFsRenewalScopeSchema,
  PortableFsVolumeIdSchema,
  type CreatePortableFsVolumeInput,
  type IssuePortableFsMountGrantInput,
  type IssuePortableFsReadSessionGrantInput,
  type PortableFsManagerVolume,
  type PortableFsManagerCapacity,
  type PortableFsDestroyedVolume,
  type PortableFsMountEnrollmentRevocation,
  type PortableFsMountManagerEndpoint,
  type PortableFsMountGrant,
  type PortableFsReadSessionGrant,
  type PortableFsRenewalFence,
  type PortableFsRenewalFences,
  type PortableFsMountAccess,
} from "./schemas.js";
import { formatIssues } from "@opensteer/shared/validationIssues";
import { parseInput } from "./parsing.js";

export const PORTABLEFS_MANAGER_API_PREFIX = "v1";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const PRODUCT_AUTHORIZATION_DOMAIN = Buffer.from("portablefs-product-authorization-v1\0");

export interface PortableFsControlRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface PortableFsControlMutationOptions extends PortableFsControlRequestOptions {
  /** Stable across retries so the manager can replay one byte-identical durable receipt. */
  readonly idempotencyKey: string;
}

/** The product-facing subset of PortableFS's hosted manager used by Opensteer. */
export interface PortableFsControlPlane {
  archiveVolume(
    volumeId: string,
    options: PortableFsControlMutationOptions,
  ): Promise<PortableFsManagerVolume>;
  health(options?: PortableFsControlRequestOptions): Promise<PortableFsManagerHealth>;
  capacity(options?: PortableFsControlRequestOptions): Promise<PortableFsManagerCapacity>;
  createVolume(
    input: CreatePortableFsVolumeInput,
    options: PortableFsControlMutationOptions,
  ): Promise<PortableFsManagerVolume>;
  destroyVolume(
    volumeId: string,
    options: PortableFsControlMutationOptions,
  ): Promise<PortableFsDestroyedVolume>;
  getVolume(
    volumeId: string,
    options?: PortableFsControlRequestOptions,
  ): Promise<PortableFsManagerVolume>;
  issueAutomaticMountGrant(
    volumeId: string,
    input: IssuePortableFsMountGrantInput,
    options: PortableFsControlMutationOptions,
  ): Promise<PortableFsMountGrant>;
  issueReadSessionGrant(
    volumeId: string,
    input: IssuePortableFsReadSessionGrantInput,
    options: PortableFsControlMutationOptions,
  ): Promise<PortableFsReadSessionGrant>;
  revokeMountEnrollment(
    volumeId: string,
    enrollmentId: string,
    reason: string,
    options?: PortableFsControlRequestOptions,
  ): Promise<PortableFsMountEnrollmentRevocation>;
  advanceRenewalFences(
    reason: string,
    fences: readonly PortableFsRenewalFence[],
  ): Promise<PortableFsRenewalFences>;
  wakeVolume(
    volumeId: string,
    options: PortableFsControlMutationOptions,
  ): Promise<PortableFsManagerVolume>;
}

export interface PortableFsManagerHealth {
  readonly releaseId: string;
}

export interface PortableFsProductAuthorizationClaims {
  readonly access: readonly PortableFsMountAccess[];
  readonly audience: "portablefs-manager";
  readonly authorizationDomain: string;
  readonly expires: number;
  readonly issuer: string;
  readonly nonce: string;
  readonly notBefore: number;
  readonly owner: string;
  readonly peerSpkiSha256: string;
  readonly renewalEpoch?: number;
  readonly renewalScope?: string;
  readonly subject: string;
  readonly volumeId: string;
}

export interface PortableFsProductAuthorizationSigner {
  sign(claims: PortableFsProductAuthorizationClaims): string;
}

export class Ed25519PortableFsProductAuthorizationSigner implements PortableFsProductAuthorizationSigner {
  readonly #privateKey: KeyObject;

  constructor(privateKey: KeyObject | string | Buffer) {
    this.#privateKey =
      typeof privateKey === "string" || Buffer.isBuffer(privateKey)
        ? createPrivateKey(privateKey)
        : privateKey;
    if (this.#privateKey.type !== "private" || this.#privateKey.asymmetricKeyType !== "ed25519") {
      throw new TypeError("PortableFS product authorization requires an Ed25519 private key");
    }
  }

  sign(claims: PortableFsProductAuthorizationClaims): string {
    const parsed = ProductAuthorizationClaimsSchema.parse({
      access: claims.access,
      audience: claims.audience,
      authorization_domain: claims.authorizationDomain,
      expires: claims.expires,
      issuer: claims.issuer,
      nonce: claims.nonce,
      not_before: claims.notBefore,
      owner: claims.owner,
      peer_spki_sha256: claims.peerSpkiSha256,
      ...(claims.renewalEpoch === undefined ? {} : { renewal_epoch: claims.renewalEpoch }),
      ...(claims.renewalScope === undefined ? {} : { renewal_scope: claims.renewalScope }),
      subject: claims.subject,
      volume_id: claims.volumeId,
    });
    const payload = Buffer.from(JSON.stringify(parsed));
    const signature = sign(
      null,
      Buffer.concat([PRODUCT_AUTHORIZATION_DOMAIN, payload]),
      this.#privateKey,
    );
    return `v1.${payload.toString("base64url")}.${signature.toString("base64url")}`;
  }
}

export interface PortableFsManagerTlsIdentity {
  readonly caCertificatePem: string | Buffer;
  readonly clientCertificatePem: string | Buffer;
  readonly clientPrivateKeyPem: string | Buffer;
  readonly serverName?: string;
}

interface PortableFsManagerClientOptions {
  readonly authorizationDomain: string;
  readonly baseUrl: string | URL;
  readonly defaultTimeoutMs?: number;
  readonly fetchImplementation?: typeof globalThis.fetch;
  readonly maxResponseBytes?: number;
  /** Runner-reachable Manager origin and trust for mount-owned automatic renewal. */
  readonly mountEndpoint?: PortableFsMountManagerEndpoint;
  readonly productIssuer: string;
  readonly signer: PortableFsProductAuthorizationSigner;
  readonly tls?: PortableFsManagerTlsIdentity;
}

interface InternalRequestOptions extends PortableFsControlRequestOptions {
  readonly idempotencyKey?: string;
  readonly retryConflict?: boolean;
}

/** Client for the product role in PortableFS's hosted manager v1 API. */
export class PortableFsManagerClient implements PortableFsControlPlane {
  readonly #authorizationDomain: string;
  readonly #baseUrl: URL;
  readonly #defaultTimeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #maxResponseBytes: number;
  readonly #mountEndpoint: PortableFsMountManagerEndpoint | undefined;
  readonly #productIssuer: string;
  readonly #signer: PortableFsProductAuthorizationSigner;

  constructor(options: PortableFsManagerClientOptions) {
    this.#baseUrl = parseBaseUrl(options.baseUrl);
    this.#authorizationDomain = PortableFsManagerIdentitySchema.parse(options.authorizationDomain);
    this.#productIssuer = PortableFsManagerIdentitySchema.parse(options.productIssuer);
    this.#signer = options.signer;
    this.#mountEndpoint = options.mountEndpoint
      ? PortableFsMountManagerEndpointSchema.parse(options.mountEndpoint)
      : this.#baseUrl.protocol === "https:" && options.tls
        ? PortableFsMountManagerEndpointSchema.parse({
            caCertificatePem: bufferText(options.tls.caCertificatePem),
            serverName: options.tls.serverName ?? this.#baseUrl.hostname,
            url: this.#baseUrl.origin,
          })
        : undefined;
    this.#defaultTimeoutMs = requirePositiveInteger(
      options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      "defaultTimeoutMs",
    );
    this.#maxResponseBytes = requirePositiveInteger(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      "maxResponseBytes",
    );
    if (options.fetchImplementation) {
      this.#fetch = options.fetchImplementation;
    } else if (this.#baseUrl.protocol === "https:") {
      if (!options.tls) {
        throw new TypeError("PortableFS manager HTTPS requires a product mTLS identity");
      }
      this.#fetch = createMtlsFetch(options.tls, this.#maxResponseBytes);
    } else {
      this.#fetch = globalThis.fetch;
    }
  }

  async health(options: PortableFsControlRequestOptions = {}): Promise<PortableFsManagerHealth> {
    const response = await this.#request(
      "manager-health",
      "GET",
      "healthz",
      PortableFsManagerHealthSchema,
      undefined,
      options,
    );
    return { releaseId: response.release_id };
  }

  capacity(options: PortableFsControlRequestOptions = {}): Promise<PortableFsManagerCapacity> {
    return this.#request(
      "capacity",
      "GET",
      `${PORTABLEFS_MANAGER_API_PREFIX}/capacity`,
      PortableFsManagerCapacitySchema,
      undefined,
      options,
    );
  }

  archiveVolume(
    volumeId: string,
    options: PortableFsControlMutationOptions,
  ): Promise<PortableFsManagerVolume> {
    return this.#mutateVolume("archive-volume", volumeId, "archive", options);
  }

  async createVolume(
    input: CreatePortableFsVolumeInput,
    options: PortableFsControlMutationOptions,
  ): Promise<PortableFsManagerVolume> {
    const body = parseInput(CreatePortableFsVolumeInputSchema, input, "create-volume");
    const volume = await this.#request(
      "create-volume",
      "POST",
      `${PORTABLEFS_MANAGER_API_PREFIX}/volumes`,
      PortableFsManagerVolumeSchema,
      {
        authorization_domain: this.#authorizationDomain,
        owner: body.owner,
        product_issuer: this.#productIssuer,
        quota_bytes: body.quotaBytes,
        quota_inodes: body.quotaInodes,
      },
      parseMutationOptions(options, "create-volume"),
    );
    requireIdentity(volume.owner === body.owner, "create-volume", "owner");
    requireIdentity(
      volume.product_issuer === this.#productIssuer,
      "create-volume",
      "product issuer",
    );
    return volume;
  }

  async getVolume(
    volumeId: string,
    options: PortableFsControlRequestOptions = {},
  ): Promise<PortableFsManagerVolume> {
    const id = parseVolumeId(volumeId, "get-volume");
    const volume = await this.#request(
      "get-volume",
      "GET",
      `${PORTABLEFS_MANAGER_API_PREFIX}/volumes/${encodeURIComponent(id)}`,
      PortableFsManagerVolumeSchema,
      undefined,
      options,
    );
    requireIdentity(volume.id === id, "get-volume", "volume");
    return volume;
  }

  async destroyVolume(
    volumeId: string,
    options: PortableFsControlMutationOptions,
  ): Promise<PortableFsDestroyedVolume> {
    const operation = "destroy-volume" as const;
    const id = parseVolumeId(volumeId, operation);
    try {
      const destroyed = await this.#request(
        operation,
        "DELETE",
        `${PORTABLEFS_MANAGER_API_PREFIX}/volumes/${encodeURIComponent(id)}`,
        PortableFsDestroyedVolumeSchema,
        {
          reason: "workspace deleted",
          volume_id: id,
        },
        parseMutationOptions(options, operation),
      );
      requireIdentity(destroyed.id === id, operation, "volume");
      if (destroyed.state === "DESTROYED") return destroyed;
      requireIdentity(destroyed.state === "DESTROYING", operation, "destroyed state");
      const observed = await this.#request(
        operation,
        "GET",
        `${PORTABLEFS_MANAGER_API_PREFIX}/volumes/${encodeURIComponent(id)}`,
        PortableFsDestroyedVolumeSchema,
        undefined,
        {
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        },
      );
      requireIdentity(observed.id === id, operation, "volume");
      if (observed.state === "DESTROYED") return observed;
      requireIdentity(observed.state === "DESTROYING", operation, "destroyed state");
      throw new PortableFsControlPlaneError({
        message: "PortableFS volume destruction is still in progress",
        operation,
        retryable: true,
      });
    } catch (error) {
      if (
        error instanceof PortableFsControlPlaneError &&
        (error.httpStatus === 404 || error.httpStatus === 410)
      ) {
        return { id, state: "DESTROYED" };
      }
      throw error;
    }
  }

  wakeVolume(
    volumeId: string,
    options: PortableFsControlMutationOptions,
  ): Promise<PortableFsManagerVolume> {
    return this.#mutateVolume("wake-volume", volumeId, "wake", options);
  }

  issueAutomaticMountGrant(
    volumeId: string,
    input: IssuePortableFsMountGrantInput,
    options: PortableFsControlMutationOptions,
  ): Promise<PortableFsMountGrant> {
    const endpoint = this.#mountEndpoint;
    if (!endpoint) {
      throw new PortableFsProtocolError({
        message: "PortableFS automatic mounts require a Runner-reachable Manager HTTPS endpoint",
        operation: "issue-mount-grant",
      });
    }
    return this.#mountAuthorization(
      volumeId,
      parseInput(IssuePortableFsMountGrantInputSchema, input, "issue-mount-grant"),
      options,
      endpoint,
    );
  }

  async issueReadSessionGrant(
    volumeId: string,
    input: IssuePortableFsReadSessionGrantInput,
    options: PortableFsControlMutationOptions,
  ): Promise<PortableFsReadSessionGrant> {
    const operation = "issue-read-session-grant" as const;
    const id = parseVolumeId(volumeId, operation);
    const parsed = parseInput(IssuePortableFsReadSessionGrantInputSchema, input, operation);
    const peerSpkiSha256 = portableFsCsrSpkiSha256(parsed.clientCertificateRequestPem);
    const productAuthorization = this.#signer.sign({
      access: ["read"],
      audience: "portablefs-manager",
      authorizationDomain: this.#authorizationDomain,
      expires: parsed.authorization.expiresUnix,
      issuer: this.#productIssuer,
      nonce: parsed.authorization.nonce,
      notBefore: parsed.authorization.notBeforeUnix,
      owner: parsed.owner,
      peerSpkiSha256,
      subject: parsed.subject,
      volumeId: id,
    });
    const response = await this.#request(
      operation,
      "POST",
      `${PORTABLEFS_MANAGER_API_PREFIX}/mount-authorizations`,
      PortableFsManagerReadSessionAuthorizationSchema,
      {
        access: ["read"],
        automatic_reauthorization: false,
        client_csr_pem: parsed.clientCertificateRequestPem,
        product_authorization: productAuthorization,
        volume_id: id,
      },
      parseMutationOptions(options, operation),
      [productAuthorization],
    );
    requireIdentity(response.volume_id === id, operation, "volume");
    return PortableFsReadSessionGrantSchema.parse({
      access: response.access,
      authorityAddress: response.authority_endpoint,
      authorityCaCertificatePem: response.authority_ca_pem,
      authorityGeneration: response.authority_generation,
      authorityServerName: response.authority_server_name,
      capability: response.capability,
      certificateExpiresAt: unixSecondsToIso(response.certificate_expires_unix, operation),
      clientCertificatePem: response.client_certificate_pem,
      expiresAt: unixSecondsToIso(response.expires_unix, operation),
      managerReleaseId: response.release_id,
      volumeId: response.volume_id,
    });
  }

  async #mountAuthorization(
    volumeId: string,
    input: z.output<typeof IssuePortableFsMountGrantInputSchema>,
    options: PortableFsControlMutationOptions,
    mountEndpoint: PortableFsMountManagerEndpoint,
  ): Promise<PortableFsMountGrant> {
    const operation = "issue-mount-grant" as const;
    const id = parseVolumeId(volumeId, operation);
    const peerSpkiSha256 = portableFsCsrSpkiSha256(input.clientCertificateRequestPem);
    const productAuthorization = this.#signer.sign({
      access: [input.access],
      audience: "portablefs-manager",
      authorizationDomain: this.#authorizationDomain,
      expires: input.authorization.expiresUnix,
      issuer: this.#productIssuer,
      nonce: input.authorization.nonce,
      notBefore: input.authorization.notBeforeUnix,
      owner: input.owner,
      peerSpkiSha256,
      ...(input.renewalEpoch === undefined ? {} : { renewalEpoch: input.renewalEpoch }),
      ...(input.renewalScope === undefined ? {} : { renewalScope: input.renewalScope }),
      subject: input.subject,
      volumeId: id,
    });
    const response = await this.#request(
      operation,
      "POST",
      `${PORTABLEFS_MANAGER_API_PREFIX}/mount-authorizations`,
      PortableFsManagerMountAuthorizationSchema,
      {
        access: [input.access],
        automatic_reauthorization: true,
        client_csr_pem: input.clientCertificateRequestPem,
        product_authorization: productAuthorization,
        volume_id: id,
      },
      parseMutationOptions(options, operation),
      [productAuthorization],
    );
    requireIdentity(response.volume_id === id, operation, "volume");
    requireIdentity(
      response.access.length === 1 && response.access[0] === input.access,
      operation,
      "access ceiling",
    );
    const responseSequence = response.sequence ?? 0;
    requireIdentity(responseSequence === 0, operation, "initial sequence");
    return PortableFsMountGrantSchema.parse({
      access: response.access,
      authorityAddress: response.authority_endpoint,
      authorityCaCertificatePem: response.authority_ca_pem,
      authorityGeneration: response.authority_generation,
      authorityServerName: response.authority_server_name,
      capability: response.capability,
      certificateExpiresAt: unixSecondsToIso(response.certificate_expires_unix, operation),
      clientCertificatePem: response.client_certificate_pem,
      enrollment: {
        certificatePem: response.enrollment_certificate_pem,
        id: response.enrollment_id,
      },
      expiresAt: unixSecondsToIso(response.expires_unix, operation),
      manager: mountEndpoint,
      managerReleaseId: response.release_id,
      sequence: responseSequence,
      volumeId: response.volume_id,
    });
  }

  async revokeMountEnrollment(
    volumeId: string,
    enrollmentId: string,
    reason: string,
    options: PortableFsControlRequestOptions = {},
  ): Promise<PortableFsMountEnrollmentRevocation> {
    const volume = parseVolumeId(volumeId, "revoke-mount-enrollment");
    const id = PortableFsManagerIdentitySchema.parse(enrollmentId);
    const parsedReason = PortableFsManagerIdentitySchema.parse(reason);
    const response = await this.#request(
      "revoke-mount-enrollment",
      "PUT",
      `${PORTABLEFS_MANAGER_API_PREFIX}/volumes/${encodeURIComponent(volume)}/mount-enrollments/${encodeURIComponent(id)}/revocation`,
      PortableFsManagerMountEnrollmentRevocationSchema,
      { reason: parsedReason },
      options,
    );
    requireIdentity(response.volume_id === volume, "revoke-mount-enrollment", "volume");
    requireIdentity(response.enrollment_id === id, "revoke-mount-enrollment", "mount enrollment");
    return PortableFsMountEnrollmentRevocationSchema.parse({
      enrollmentId: response.enrollment_id,
      outcome: response.outcome,
      volumeId: response.volume_id,
    });
  }

  async advanceRenewalFences(
    reason: string,
    fences: readonly PortableFsRenewalFence[],
  ): Promise<PortableFsRenewalFences> {
    const operation = "advance-renewal-fences" as const;
    const parsedReason = parseInput(PortableFsManagerIdentitySchema, reason, operation);
    const request = parseInput(PortableFsRenewalFencesSchema, { fences }, operation);
    const response = await this.#request(
      operation,
      "PUT",
      `${PORTABLEFS_MANAGER_API_PREFIX}/renewal-fences`,
      PortableFsManagerRenewalFencesSchema,
      { reason: parsedReason, fences: request.fences },
      {},
    );
    requireIdentity(response.fences.length === request.fences.length, operation, "fence count");
    for (const [index, fence] of response.fences.entries()) {
      const requested = request.fences[index]!;
      requireIdentity(fence.scope === requested.scope, operation, "renewal scope");
      requireIdentity(fence.epoch >= requested.epoch, operation, "renewal epoch");
    }
    return PortableFsRenewalFencesSchema.parse(response);
  }

  async #mutateVolume(
    operation: "archive-volume" | "wake-volume",
    volumeId: string,
    action: "archive" | "wake",
    options: PortableFsControlMutationOptions,
  ): Promise<PortableFsManagerVolume> {
    const id = parseVolumeId(volumeId, operation);
    const volume = await this.#request(
      operation,
      "POST",
      `${PORTABLEFS_MANAGER_API_PREFIX}/volumes/${encodeURIComponent(id)}/${action}`,
      PortableFsManagerVolumeSchema,
      undefined,
      { ...parseMutationOptions(options, operation), retryConflict: true },
    );
    requireIdentity(volume.id === id, operation, "volume");
    return volume;
  }

  async #request<T>(
    operation: PortableFsOperation,
    method: "DELETE" | "GET" | "POST" | "PUT",
    path: string,
    responseSchema: z.ZodType<T>,
    body: unknown,
    options: InternalRequestOptions,
    secrets: readonly string[] = [],
  ): Promise<T> {
    const timeoutMs = requirePositiveInteger(
      options.timeoutMs ?? this.#defaultTimeoutMs,
      "timeoutMs",
      operation,
    );
    if (options.signal?.aborted === true) throw new PortableFsAbortError(operation);
    const abortController = new AbortController();
    let terminationReason: "aborted" | "timeout" | undefined;
    const timeout = setTimeout(() => {
      terminationReason ??= "timeout";
      abortController.abort();
    }, timeoutMs);
    timeout.unref();
    const abort = (): void => {
      terminationReason ??= "aborted";
      abortController.abort();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      const headers = new Headers({ accept: "application/json" });
      if (options.idempotencyKey) headers.set("idempotency-key", options.idempotencyKey);
      let serializedBody: string | undefined;
      if (body !== undefined) {
        serializedBody = JSON.stringify(body);
        headers.set("content-type", "application/json");
      }
      const response = await this.#fetch(new URL(path, this.#baseUrl), {
        ...(serializedBody ? { body: serializedBody } : {}),
        headers,
        method,
        redirect: "manual",
        signal: abortController.signal,
      });
      const responseBody = await readBoundedText(response, {
        maximumBytes: this.#maxResponseBytes,
        sizeError: () => new PortableFsOutputLimitError(operation, this.#maxResponseBytes),
      });
      if (!response.ok) {
        const envelope = parseErrorEnvelope(responseBody);
        const remoteCode = PortableFsManagerRemoteCodeSchema.safeParse(envelope?.error);
        const message = envelope
          ? redactSensitiveText(envelope.error, secrets)
          : `PortableFS manager request failed with HTTP ${response.status}`;
        if (response.status === 409 && remoteCode.data === "renewal_scope_fenced") {
          throw new PortableFsRenewalScopeFencedError({
            message,
            operation,
          });
        }
        throw new PortableFsControlPlaneError({
          httpStatus: response.status,
          message,
          operation,
          ...(remoteCode.success ? { remoteCode: remoteCode.data } : {}),
          retryable:
            isRetryableStatus(response.status) ||
            (response.status === 409 && options.retryConflict === true),
        });
      }
      return parseResponse(responseSchema, responseBody, operation);
    } catch (error) {
      if (terminationReason === "timeout") throw new PortableFsTimeoutError(operation, timeoutMs);
      if (terminationReason === "aborted") throw new PortableFsAbortError(operation);
      if (error instanceof PortableFsError) throw error;
      throw new PortableFsControlPlaneError({
        message: `PortableFS manager request failed: ${redactSensitiveText(
          error instanceof Error ? error.message : "network failure",
          secrets,
        )}`,
        operation,
        retryable: true,
      });
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    }
  }
}

const ProductAuthorizationClaimsSchema = z
  .strictObject({
    issuer: PortableFsManagerIdentitySchema,
    audience: z.literal("portablefs-manager"),
    authorization_domain: PortableFsManagerIdentitySchema,
    owner: PortableFsManagerIdentitySchema,
    subject: PortableFsManagerIdentitySchema,
    volume_id: PortableFsVolumeIdSchema,
    access: z
      .array(z.enum(["read", "write"]))
      .min(1)
      .max(3),
    peer_spki_sha256: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    renewal_epoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    renewal_scope: PortableFsRenewalScopeSchema.optional(),
    nonce: PortableFsManagerIdentitySchema,
    not_before: z.number().int().nonnegative(),
    expires: z.number().int().positive(),
  })
  .refine(
    (value) => (value.renewal_scope === undefined) === (value.renewal_epoch === undefined),
    "Renewal scope and epoch must be provided together",
  );

const PortableFsManagerHealthSchema = z.strictObject({
  release_id: z.string().min(1).max(255),
  status: z.literal("ok"),
});

/** Extracts the exact DER SubjectPublicKeyInfo bound by PortableFS product authorization. */
export function portableFsCsrSpkiSha256(csrPem: string): string {
  const match =
    /^-----BEGIN CERTIFICATE REQUEST-----\r?\n([A-Za-z0-9+/=\r\n]+)-----END CERTIFICATE REQUEST-----\r?\n?$/u.exec(
      csrPem,
    );
  if (!match?.[1])
    throw new PortableFsProtocolError({
      message: "PortableFS mount CSR is not one PEM certificate request",
      operation: "issue-mount-grant",
    });
  const der = Buffer.from(match[1].replaceAll(/\s/gu, ""), "base64");
  if (der.length === 0 || der.length > 32_768) throw invalidCsr();
  const root = readDerElement(der, 0);
  if (root.tag !== 0x30 || root.end !== der.length) throw invalidCsr();
  const rootChildren = readDerChildren(der, root);
  if (rootChildren.length !== 3 || rootChildren[0]?.tag !== 0x30) throw invalidCsr();
  const requestInfo = rootChildren[0];
  const infoChildren = readDerChildren(der, requestInfo);
  const spki = infoChildren[2];
  if (
    infoChildren.length !== 4 ||
    infoChildren[0]?.tag !== 0x02 ||
    infoChildren[1]?.tag !== 0x30 ||
    spki?.tag !== 0x30 ||
    infoChildren[3]?.tag !== 0xa0
  ) {
    throw invalidCsr();
  }
  return createHash("sha256").update(der.subarray(spki.start, spki.end)).digest("base64url");
}

interface DerElement {
  readonly contentStart: number;
  readonly end: number;
  readonly start: number;
  readonly tag: number;
}

function readDerElement(input: Buffer, start: number): DerElement {
  if (start < 0 || start + 2 > input.length) throw invalidCsr();
  const tag = input[start];
  const firstLength = input[start + 1];
  if (tag === undefined || firstLength === undefined || (tag & 0x1f) === 0x1f) throw invalidCsr();
  let length: number;
  let contentStart: number;
  if ((firstLength & 0x80) === 0) {
    length = firstLength;
    contentStart = start + 2;
  } else {
    const count = firstLength & 0x7f;
    if (count === 0 || count > 4 || start + 2 + count > input.length) throw invalidCsr();
    if (input[start + 2] === 0) throw invalidCsr();
    length = 0;
    for (let index = 0; index < count; index += 1) {
      length = length * 256 + (input[start + 2 + index] ?? 0);
    }
    if (length < 128) throw invalidCsr();
    contentStart = start + 2 + count;
  }
  const end = contentStart + length;
  if (!Number.isSafeInteger(end) || end > input.length) throw invalidCsr();
  return { contentStart, end, start, tag };
}

function readDerChildren(input: Buffer, parent: DerElement): DerElement[] {
  const children: DerElement[] = [];
  let offset = parent.contentStart;
  while (offset < parent.end) {
    const child = readDerElement(input, offset);
    if (child.end > parent.end) throw invalidCsr();
    children.push(child);
    if (children.length > 32) throw invalidCsr();
    offset = child.end;
  }
  if (offset !== parent.end) throw invalidCsr();
  return children;
}

function invalidCsr(): PortableFsProtocolError {
  return new PortableFsProtocolError({
    message: "PortableFS mount CSR has an invalid DER structure",
    operation: "issue-mount-grant",
  });
}

function createMtlsFetch(
  identity: PortableFsManagerTlsIdentity,
  maxBytes: number,
): typeof globalThis.fetch {
  const ca = Buffer.from(identity.caCertificatePem);
  const cert = Buffer.from(identity.clientCertificatePem);
  const key = Buffer.from(identity.clientPrivateKeyPem);
  return (async (input: string | URL | globalThis.Request, init?: RequestInit) => {
    const url = input instanceof globalThis.Request ? new URL(input.url) : new URL(input);
    if (url.protocol !== "https:") throw new TypeError("mTLS transport requires HTTPS");
    const headers = new Headers(
      input instanceof globalThis.Request ? input.headers : init?.headers,
    );
    const body = init?.body;
    if (body !== undefined && typeof body !== "string" && !Buffer.isBuffer(body)) {
      throw new TypeError("PortableFS manager request body must be buffered JSON");
    }
    if (body !== undefined) {
      // Node does not automatically frame DELETE bodies with chunked encoding.
      headers.set(
        "content-length",
        String(Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body)),
      );
    }
    return await new Promise<Response>((resolve, reject) => {
      const request = httpsRequest(
        url,
        {
          ca,
          cert,
          headers: Object.fromEntries(headers.entries()),
          key,
          method: init?.method ?? "GET",
          minVersion: "TLSv1.3",
          rejectUnauthorized: true,
          ...(identity.serverName ? { servername: identity.serverName } : {}),
          signal: init?.signal ?? undefined,
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          let total = 0;
          incoming.on("data", (chunk: Buffer | string) => {
            const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            total += value.length;
            if (total > maxBytes) {
              incoming.destroy(new Error("PortableFS manager response exceeded its byte limit"));
              return;
            }
            chunks.push(value);
          });
          incoming.once("error", reject);
          incoming.once("end", () => {
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(incoming.headers)) {
              if (Array.isArray(value))
                for (const item of value) responseHeaders.append(name, item);
              else if (value !== undefined) responseHeaders.set(name, value);
            }
            resolve(
              new Response(Buffer.concat(chunks), {
                headers: responseHeaders,
                status: incoming.statusCode ?? 500,
                ...(incoming.statusMessage ? { statusText: incoming.statusMessage } : {}),
              }),
            );
          });
        },
      );
      request.once("error", reject);
      if (body !== undefined) request.write(body);
      request.end();
    });
  }) as typeof globalThis.fetch;
}

function parseResponse<T>(schema: z.ZodType<T>, body: string, operation: PortableFsOperation): T {
  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch {
    throw new PortableFsProtocolError({
      message: "PortableFS manager returned invalid JSON",
      operation,
    });
  }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) {
    throw new PortableFsProtocolError({
      message: `PortableFS manager returned an incompatible ${operation} response (${formatIssues(parsed.error.issues)})`,
      operation,
    });
  }
  return parsed.data;
}

function parseErrorEnvelope(
  body: string,
): z.infer<typeof PortableFsManagerErrorEnvelopeSchema> | undefined {
  try {
    const parsed = PortableFsManagerErrorEnvelopeSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function parseMutationOptions(
  options: PortableFsControlMutationOptions,
  operation: PortableFsOperation,
): InternalRequestOptions {
  return {
    idempotencyKey: parseInput(PortableFsIdempotencyKeySchema, options.idempotencyKey, operation),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  };
}

function parseVolumeId(value: string, operation: PortableFsOperation) {
  return parseInput(PortableFsVolumeIdSchema, value, operation);
}

function parseBaseUrl(input: string | URL): URL {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("PortableFS manager baseUrl must use HTTP or HTTPS");
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new TypeError("PortableFS manager uses HTTPS outside loopback tests");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new TypeError(
      "PortableFS manager baseUrl must be an origin-only URL without credentials",
    );
  }
  url.pathname = "/";
  return url;
}

function requirePositiveInteger(
  value: number,
  name: string,
  operation?: PortableFsOperation,
): number {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (operation) {
    throw new PortableFsError({
      code: "invalid_input",
      message: `${name} must be a positive integer`,
      operation,
    });
  }
  throw new TypeError(`${name} must be a positive integer`);
}

function unixSecondsToIso(value: number, operation: PortableFsOperation): string {
  const milliseconds = value * 1_000;
  const date = new Date(milliseconds);
  if (!Number.isSafeInteger(milliseconds) || Number.isNaN(date.valueOf())) {
    throw new PortableFsProtocolError({
      message: "PortableFS manager returned an invalid timestamp",
      operation,
    });
  }
  return date.toISOString();
}

function requireIdentity(
  matches: boolean,
  operation: PortableFsOperation,
  identity: string,
): asserts matches {
  if (!matches) {
    throw new PortableFsProtocolError({
      message: `PortableFS manager returned a different ${identity}`,
      operation,
    });
  }
}

function isRetryableStatus(status: number): boolean {
  return [408, 425, 429, 500, 502, 503, 504].includes(status);
}

function bufferText(value: string | Buffer): string {
  return Buffer.isBuffer(value) ? value.toString("utf8") : value;
}

/** Convenience for deterministic callers that do not already own a request nonce. */
