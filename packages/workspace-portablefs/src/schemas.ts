import { z } from "zod";

const nonEmptyString = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0);
export const PortableFsAbsolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => value.startsWith("/"), "Expected an absolute path")
  .refine((value) => !value.includes("\0"), "Path must not contain a NUL byte");
const positiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonnegativeSafeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** PortableFS v3's actual CLI volume-name contract. */
export const PortableFsVolumeIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,220}$/)
  .brand<"PortableFsVolumeId">();
export type PortableFsVolumeId = z.infer<typeof PortableFsVolumeIdSchema>;

export const PortableFsMountCapabilitySchema = z
  .string()
  .max(8192)
  .regex(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  .brand<"PortableFsMountCapability">();
/** Lowercase hexadecimal SHA-256 of the canonical route declaration. */
export const PortableFsRouteRevisionSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const PortableFsMountStrategySchema = z.enum(["auto", "fskit", "fuse"]);
export type PortableFsMountStrategy = z.infer<typeof PortableFsMountStrategySchema>;

export const PortableFsResolvedMountStrategySchema = z.enum(["fskit", "fuse"]);

export const PortableFsCoherenceSchema = z.enum(["strict", "uncached"]);

export const PortableFsTlsConfigurationSchema = z.discriminatedUnion("transport", [
  z
    .object({
      caPath: PortableFsAbsolutePathSchema,
      serverName: nonEmptyString.max(253),
      transport: z.literal("tls-private-ca"),
    })
    .strict(),
  z
    .object({
      serverName: nonEmptyString.max(253),
      transport: z.literal("tls-system-pki"),
    })
    .strict(),
]);

export const PortableFsMountInputSchema = z
  .object({
    automaticReauthorization: z
      .object({
        authorityGeneration: positiveSafeInteger,
        authorizationExpiresAtMs: positiveSafeInteger,
        enrollmentCertificatePath: PortableFsAbsolutePathSchema,
        enrollmentId: nonEmptyString.max(256),
        managerCaPath: PortableFsAbsolutePathSchema,
        managerServerName: nonEmptyString.max(253),
        managerUrl: z.url(),
      })
      .strict(),
    authorityAddress: nonEmptyString.max(512).refine((value) => !/\s/u.test(value)),
    capability: PortableFsMountCapabilitySchema,
    clientCertificatePath: PortableFsAbsolutePathSchema,
    clientKeyPath: PortableFsAbsolutePathSchema,
    coherence: PortableFsCoherenceSchema.optional(),
    mountPath: PortableFsAbsolutePathSchema,
    noLocalDirs: z.boolean().optional(),
    strategy: PortableFsMountStrategySchema.optional(),
    tls: PortableFsTlsConfigurationSchema,
    volumeId: PortableFsVolumeIdSchema,
  })
  .strict();
export type PortableFsMountInput = z.input<typeof PortableFsMountInputSchema>;

export const PortableFsUnmountInputSchema = z
  .object({
    force: z.boolean().optional(),
    mountPath: PortableFsAbsolutePathSchema,
  })
  .strict();
export type PortableFsUnmountInput = z.input<typeof PortableFsUnmountInputSchema>;

const MountHostDetailSchema = z
  .object({
    key: z.string(),
    value: z.string(),
  })
  .passthrough();

export const PortableFsMountHostFactsSchema = z
  .object({
    details: z.array(MountHostDetailSchema).optional(),
    helperPath: z.string().optional(),
    issue: z.string().optional(),
    mountMechanism: z.string().optional(),
    state: z.enum(["blocked", "unverified", "verified"]),
    summary: z.string(),
    transport: PortableFsResolvedMountStrategySchema,
  })
  .passthrough();

export const PortableFsMountCheckErrorSchema = z
  .object({
    code: z.string().optional(),
    kind: z.string(),
    message: z.string(),
  })
  .passthrough();

export const PortableFsMountCheckResultSchema = z.union([
  z
    .object({
      facts: PortableFsMountHostFactsSchema,
      error: z.never().optional(),
      schemaVersion: z.literal(1),
    })
    .passthrough(),
  z
    .object({
      error: PortableFsMountCheckErrorSchema,
      facts: z.never().optional(),
      schemaVersion: z.literal(1),
    })
    .passthrough(),
]);
export type PortableFsMountCheckResult = z.infer<typeof PortableFsMountCheckResultSchema>;

export const PortableFsMountedWorkspaceSchema = z
  .object({
    attachRef: z.string().min(1).optional(),
    authorizationSessionId: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
    localRouteRevision: PortableFsRouteRevisionSchema.optional(),
    localRoutes: z.array(z.string()).optional(),
    mountPath: PortableFsAbsolutePathSchema,
    ok: z.literal(true),
    pid: z.number().int().positive(),
    strategy: PortableFsResolvedMountStrategySchema,
    volumeId: PortableFsVolumeIdSchema,
  })
  .passthrough();
export type PortableFsMountedWorkspace = z.infer<typeof PortableFsMountedWorkspaceSchema>;

export const PortableFsMountStatusSchema = z
  .object({
    alive: z.boolean(),
    attachError: z.string().optional(),
    attachRef: z.string().optional(),
    attachState: z.string().optional(),
    authorityUrl: z.string().optional(),
    cleanupRequired: z.boolean().optional(),
    authorizationDeadlineAtMs: z.number().int().nonnegative().optional(),
    health: z.string().min(1),
    localRouteRevision: PortableFsRouteRevisionSchema.optional(),
    localRoutes: z.array(z.string()).optional(),
    mountPath: PortableFsAbsolutePathSchema,
    mountEnrollmentId: z.string().min(1).max(256).optional(),
    lastReauthorizationAtMs: z.number().int().nonnegative().optional(),
    nextReauthorizationAtMs: z.number().int().nonnegative().optional(),
    operationPhase: z.string().optional(),
    pid: z.number().int().nonnegative(),
    startedAtMs: z.number().int().nonnegative(),
    status: z.string().optional(),
    statusChangedAtMs: z.number().int().nonnegative().optional(),
    reauthorizationError: z.string().max(2_048).optional(),
    reauthorizationFailures: z.number().int().nonnegative().optional(),
    strategy: PortableFsResolvedMountStrategySchema,
    volumeId: PortableFsVolumeIdSchema,
  })
  .passthrough();
export type PortableFsMountStatus = z.infer<typeof PortableFsMountStatusSchema>;

export const PortableFsMountListSchema = z
  .object({
    mounts: z.array(PortableFsMountStatusSchema),
  })
  .passthrough();
export type PortableFsMountList = z.infer<typeof PortableFsMountListSchema>;

export const PortableFsUnmountResultSchema = z
  .object({
    forced: z.boolean().optional(),
    mountPath: PortableFsAbsolutePathSchema,
    tracked: z.boolean().optional(),
    unmounted: z.literal(true),
    volumeId: PortableFsVolumeIdSchema.optional(),
  })
  .passthrough();
export type PortableFsUnmountResult = z.infer<typeof PortableFsUnmountResultSchema>;

export const PortableFsVersionResultSchema = z
  .object({
    features: z.array(z.string().min(1).max(255)).max(128).optional(),
    version: z.string().trim().min(1).max(255),
  })
  .passthrough();
export type PortableFsVersionResult = z.infer<typeof PortableFsVersionResultSchema>;

export const PortableFsRouteResultSchema = z
  .object({
    backingBytes: z.number().int().nonnegative().optional(),
    backingExists: z.boolean().optional(),
    backingPath: PortableFsAbsolutePathSchema.optional(),
    mountPath: PortableFsAbsolutePathSchema,
    path: PortableFsAbsolutePathSchema,
    patterns: z.array(z.string()).optional(),
    perMachineRoutes: z.boolean().optional(),
    revision: PortableFsRouteRevisionSchema,
    routeRoot: z.string().optional(),
    rule: z.string().optional(),
    storage: z.enum(["machine-local", "shared"]),
    volumeId: PortableFsVolumeIdSchema,
    volumePath: z.string(),
  })
  .passthrough();
export type PortableFsRouteResult = z.infer<typeof PortableFsRouteResultSchema>;

export const PortableFsManagerIdentitySchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim() === value)
  .refine((value) => !/\p{Control}/u.test(value));

export const PortableFsRenewalScopeSchema = z.string().regex(/^[A-Za-z0-9._:/-]{1,200}$/u);

export const PortableFsIdempotencyKeySchema = z.string().regex(/^[\x21-\x7e]{1,255}$/);

export const PortableFsMountAccessSchema = z.enum(["read", "write"]);
export type PortableFsMountAccess = z.infer<typeof PortableFsMountAccessSchema>;

/**
 * Manager volume states this Host maps explicitly, including the states the
 * Manager gains later in the tiered-storage rollout. Opensteer ships this list
 * before the Manager learns those states, and the list only ever grows: a
 * state removed from it silently becomes an unmapped state again.
 */
export const PORTABLEFS_KNOWN_VOLUME_STATES = [
  "PROVISIONING",
  "READY",
  "FENCING",
  "RETIRED",
  "QUARANTINED",
  "ARCHIVING",
  "ARCHIVED",
  "RESTORING",
  "DESTROYED",
] as const;
type PortableFsKnownVolumeState = (typeof PORTABLEFS_KNOWN_VOLUME_STATES)[number];

/** `string & {}` keeps the known states narrowable while admitting the rest. */
type PortableFsManagerVolumeState = PortableFsKnownVolumeState | (string & {});

/**
 * Deliberately open. A Manager one release ahead of this Host reports a state
 * this Host has never heard of; parsing it as a failure would turn every
 * Workspace terminally `failed` in a single reconcile pass, so the unknown
 * state travels through as data and the driver decides what it means.
 */
export const PortableFsManagerVolumeStateSchema: z.ZodType<PortableFsManagerVolumeState, string> =
  nonEmptyString.max(64);

export const PortableFsManagerArchiveSummarySchema = z
  .object({
    attempt: nonEmptyString.max(64),
    logical_bytes: nonnegativeSafeInteger,
    logical_inodes: nonnegativeSafeInteger,
    sealed_epoch: positiveSafeInteger,
    sealed_unix: positiveSafeInteger,
  })
  .passthrough();

/**
 * Tolerates both wire shapes: the v1 Manager keeps placement fields at the
 * top level; the v2 Manager nests them under `placement` (absent for a
 * released ARCHIVED volume, whose `authority_endpoint` is also empty). A
 * strict top-level requirement here would fail every workspace fleet-wide in
 * one reconcile pass the moment the Manager upgrades — the exact cascade the
 * rollout guardrails exist to prevent.
 */
export const PortableFsManagerVolumeSchema = z
  .object({
    archive_cycle_step: z.string().max(64).optional(),
    archive_summary: PortableFsManagerArchiveSummarySchema.optional(),
    authority_endpoint: z.string().max(512).optional(),
    authority_generation: positiveSafeInteger,
    authority_server_name: nonEmptyString.max(253).optional(),
    cell_id: z.uuid().optional(),
    created_unix: positiveSafeInteger,
    id: z.uuid(),
    owner: PortableFsManagerIdentitySchema,
    placement: z
      .object({
        authority_server_name: nonEmptyString.max(253).optional(),
        cell_id: z.uuid().optional(),
        sequence: positiveSafeInteger.optional(),
      })
      .passthrough()
      .optional(),
    placement_sequence: positiveSafeInteger.optional(),
    product_issuer: PortableFsManagerIdentitySchema,
    project_id: positiveSafeInteger.optional(),
    quota_bytes: positiveSafeInteger,
    quota_inodes: positiveSafeInteger,
    restore_progress_permille: z.number().int().min(0).max(1_000).optional(),
    restore_step: z.string().max(64).optional(),
    state: PortableFsManagerVolumeStateSchema,
    updated_unix: positiveSafeInteger,
    wake_requested: z.boolean().optional(),
  })
  .passthrough();
export type PortableFsManagerVolume = z.infer<typeof PortableFsManagerVolumeSchema>;

export const PortableFsManagerCapacitySchema = z
  .object({
    pools: z.array(
      z
        .object({
          archived_volumes: nonnegativeSafeInteger,
          capacity_bytes: nonnegativeSafeInteger,
          capacity_inodes: nonnegativeSafeInteger,
          create_admissible: z.boolean(),
          measured_used_bytes: nonnegativeSafeInteger,
          measured_used_inodes: nonnegativeSafeInteger,
          pending_bytes: nonnegativeSafeInteger,
          pending_inodes: nonnegativeSafeInteger,
          placements: nonnegativeSafeInteger,
          pool: nonEmptyString.max(255),
          restore_admissible: z.boolean(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
export type PortableFsManagerCapacity = z.infer<typeof PortableFsManagerCapacitySchema>;

export const PortableFsDestroyedVolumeSchema = z
  .object({
    id: PortableFsVolumeIdSchema,
    state: PortableFsManagerVolumeStateSchema,
  })
  .passthrough();
export type PortableFsDestroyedVolume = z.infer<typeof PortableFsDestroyedVolumeSchema>;

export const CreatePortableFsVolumeInputSchema = z
  .object({
    owner: PortableFsManagerIdentitySchema,
    quotaBytes: positiveSafeInteger.refine((value) => value % 1024 === 0),
    quotaInodes: positiveSafeInteger,
  })
  .strict();
export type CreatePortableFsVolumeInput = z.input<typeof CreatePortableFsVolumeInputSchema>;

export const PortableFsProductAuthorizationWindowSchema = z
  .object({
    expiresUnix: positiveSafeInteger,
    nonce: PortableFsManagerIdentitySchema,
    notBeforeUnix: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .refine((value) => value.expiresUnix > value.notBeforeUnix);

const IssuePortableFsMountGrantInputBaseSchema = z
  .object({
    access: PortableFsMountAccessSchema,
    authorization: PortableFsProductAuthorizationWindowSchema,
    clientCertificateRequestPem: z
      .string()
      .includes("-----BEGIN CERTIFICATE REQUEST-----")
      .max(32_768),
    owner: PortableFsManagerIdentitySchema,
    renewalEpoch: positiveSafeInteger.optional(),
    renewalScope: PortableFsRenewalScopeSchema.optional(),
    subject: PortableFsManagerIdentitySchema,
  })
  .strict();

export const IssuePortableFsMountGrantInputSchema = IssuePortableFsMountGrantInputBaseSchema.refine(
  (value) => (value.renewalScope === undefined) === (value.renewalEpoch === undefined),
  "Renewal scope and epoch must be provided together",
);
export type IssuePortableFsMountGrantInput = z.input<typeof IssuePortableFsMountGrantInputSchema>;

export const IssuePortableFsReadSessionGrantInputSchema =
  IssuePortableFsMountGrantInputBaseSchema.omit({
    access: true,
    renewalEpoch: true,
    renewalScope: true,
  });
export type IssuePortableFsReadSessionGrantInput = z.input<
  typeof IssuePortableFsReadSessionGrantInputSchema
>;

export const PortableFsMountManagerEndpointSchema = z
  .object({
    caCertificatePem: z
      .string()
      .includes("-----BEGIN CERTIFICATE-----")
      .max(1024 * 1024),
    serverName: nonEmptyString.max(253),
    url: z.url().refine(isOriginOnlyHttpsUrl, "Expected an origin-only HTTPS Manager URL"),
  })
  .strict();
export type PortableFsMountManagerEndpoint = z.infer<typeof PortableFsMountManagerEndpointSchema>;

export const PortableFsMountEnrollmentSchema = z
  .object({
    certificatePem: z
      .string()
      .includes("-----BEGIN CERTIFICATE-----")
      .max(1024 * 1024),
    id: nonEmptyString.max(256),
  })
  .strict();

export const PortableFsMountGrantSchema = z
  .object({
    access: z.array(PortableFsMountAccessSchema).min(1).max(3),
    authorityAddress: nonEmptyString.max(512).refine((value) => !/\s/u.test(value)),
    authorityCaCertificatePem: z.string().includes("-----BEGIN CERTIFICATE-----"),
    authorityGeneration: positiveSafeInteger,
    authorityServerName: nonEmptyString.max(253),
    capability: PortableFsMountCapabilitySchema,
    certificateExpiresAt: z.iso.datetime({ offset: true }),
    clientCertificatePem: z.string().includes("-----BEGIN CERTIFICATE-----"),
    enrollment: PortableFsMountEnrollmentSchema,
    expiresAt: z.iso.datetime({ offset: true }),
    manager: PortableFsMountManagerEndpointSchema,
    managerReleaseId: PortableFsManagerIdentitySchema,
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    volumeId: PortableFsVolumeIdSchema,
  })
  .strict();
export type PortableFsMountGrant = z.infer<typeof PortableFsMountGrantSchema>;

export const PortableFsReadSessionGrantSchema = z
  .object({
    access: z.tuple([z.literal("read")]),
    authorityAddress: nonEmptyString.max(512).refine((value) => !/\s/u.test(value)),
    authorityCaCertificatePem: z.string().includes("-----BEGIN CERTIFICATE-----"),
    authorityGeneration: positiveSafeInteger,
    authorityServerName: nonEmptyString.max(253),
    capability: PortableFsMountCapabilitySchema,
    certificateExpiresAt: z.iso.datetime({ offset: true }),
    clientCertificatePem: z.string().includes("-----BEGIN CERTIFICATE-----"),
    expiresAt: z.iso.datetime({ offset: true }),
    managerReleaseId: PortableFsManagerIdentitySchema,
    volumeId: PortableFsVolumeIdSchema,
  })
  .strict();
export type PortableFsReadSessionGrant = z.infer<typeof PortableFsReadSessionGrantSchema>;

export const PortableFsManagerMountAuthorizationSchema = z
  .object({
    access: z.array(PortableFsMountAccessSchema).min(1).max(3),
    authority_ca_pem: z.string().includes("-----BEGIN CERTIFICATE-----"),
    authority_endpoint: nonEmptyString.max(512),
    authority_generation: positiveSafeInteger,
    authority_server_name: nonEmptyString.max(253),
    capability: PortableFsMountCapabilitySchema,
    certificate_expires_unix: positiveSafeInteger,
    client_certificate_pem: z.string().includes("-----BEGIN CERTIFICATE-----"),
    expires_unix: positiveSafeInteger,
    enrollment_certificate_pem: z
      .string()
      .includes("-----BEGIN CERTIFICATE-----")
      .max(1024 * 1024),
    enrollment_id: nonEmptyString.max(256),
    release_id: PortableFsManagerIdentitySchema,
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    volume_id: PortableFsVolumeIdSchema,
  })
  .passthrough();

export const PortableFsManagerReadSessionAuthorizationSchema = z
  .object({
    access: z.tuple([z.literal("read")]),
    authority_ca_pem: z.string().includes("-----BEGIN CERTIFICATE-----"),
    authority_endpoint: nonEmptyString.max(512),
    authority_generation: positiveSafeInteger,
    authority_server_name: nonEmptyString.max(253),
    capability: PortableFsMountCapabilitySchema,
    certificate_expires_unix: positiveSafeInteger,
    client_certificate_pem: z.string().includes("-----BEGIN CERTIFICATE-----"),
    expires_unix: positiveSafeInteger,
    release_id: PortableFsManagerIdentitySchema,
    volume_id: PortableFsVolumeIdSchema,
  })
  .passthrough();

export const PortableFsMountEnrollmentRevocationOutcomeSchema = z.enum([
  "REVOKED",
  "CLOSED",
  "EXPIRED",
  "ABSENT",
]);

export const PortableFsManagerMountEnrollmentRevocationSchema = z
  .object({
    enrollment_id: nonEmptyString.max(256),
    outcome: PortableFsMountEnrollmentRevocationOutcomeSchema,
    volume_id: PortableFsVolumeIdSchema,
  })
  .passthrough();

export const PortableFsMountEnrollmentRevocationSchema = z
  .object({
    enrollmentId: nonEmptyString.max(256),
    outcome: PortableFsMountEnrollmentRevocationOutcomeSchema,
    volumeId: PortableFsVolumeIdSchema,
  })
  .strict();
export type PortableFsMountEnrollmentRevocation = z.infer<
  typeof PortableFsMountEnrollmentRevocationSchema
>;

export const PortableFsRenewalFenceSchema = z
  .object({
    epoch: positiveSafeInteger,
    scope: PortableFsRenewalScopeSchema,
  })
  .strict();
export type PortableFsRenewalFence = z.infer<typeof PortableFsRenewalFenceSchema>;

export const PortableFsRenewalFencesSchema = z
  .object({
    fences: z.array(PortableFsRenewalFenceSchema).min(1).max(4_096),
  })
  .strict();
export type PortableFsRenewalFences = z.infer<typeof PortableFsRenewalFencesSchema>;

export const PortableFsManagerRenewalFencesSchema = z
  .object({
    fences: z.array(PortableFsRenewalFenceSchema).min(1).max(4_096),
  })
  .passthrough();

function isOriginOnlyHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.pathname === "" || url.pathname === "/")
    );
  } catch {
    return false;
  }
}

export const PortableFsManagerErrorEnvelopeSchema = z
  .object({ error: z.string().min(1).max(8_192) })
  .passthrough();

export const PortableFsManagerRemoteCodeSchema = z.enum(["renewal_scope_fenced"]);
