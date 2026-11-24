import { CloudComputerDeletionSchema } from "./cloud-computer-deletion.js";
import {
  DeploymentIdSchema,
  HostInstanceIdSchema,
  HostKeyFingerprintSchema,
} from "@opensteer/core";
import { z } from "zod";
import { ControlPlaneAccountIdSchema, prefixedIdSchema } from "./account-id.js";

export const CloudComputerIdSchema = prefixedIdSchema("cc")
  .refine((id) => id === id.toLowerCase())
  .brand<"CloudComputerId">();
export type CloudComputerId = z.infer<typeof CloudComputerIdSchema>;

export const CloudComputerHostnameSchema = z
  .string()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u);
export const CloudComputerLocationSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u);
export const CloudComputerGenerationSchema = z.number().int().positive();
export const CloudComputerBootstrapTokenSchema = z.string().regex(/^[A-Za-z0-9_.-]{1,2048}$/u);
export const CloudComputerInstallerUrlSchema = z
  .url({ protocol: /^https$/u })
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return !url.username && !url.password && !/[?#]/u.test(value);
  });
/** Public feed for in-place updates. Every candidate still has to pin its image digests. */
export const CloudComputerReleaseManifestUrlSchema = z
  .string()
  .regex(/^https:\/\/[a-zA-Z0-9.:/_=%+-]+$/u)
  .pipe(CloudComputerInstallerUrlSchema);
export const CloudComputerInstallerSha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);

export const CloudComputerReleaseSchema = z.object({
  version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/u),
  installerUrl: CloudComputerInstallerUrlSchema,
  installerSha256: CloudComputerInstallerSha256Schema,
});
export type CloudComputerRelease = z.infer<typeof CloudComputerReleaseSchema>;

export const CloudComputerIdentitySchema = z.strictObject({
  deploymentId: DeploymentIdSchema,
  hostKeyFingerprint: HostKeyFingerprintSchema,
});
export type CloudComputerIdentity = z.infer<typeof CloudComputerIdentitySchema>;

export const CloudComputerSnapshotSchema = z.string().regex(/^[0-9a-f]{8,64}$/u);
export const CloudComputerDesiredRevisionSchema = z.number().int().positive();

export const GoogleComputeServerRefSchema = z
  .string()
  .regex(/^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?\/[1-9][0-9]{0,19}$/u)
  .pipe(
    z
      .string()
      .refine((ref) => BigInt(ref.slice(ref.indexOf("/") + 1)) <= 18_446_744_073_709_551_615n),
  )
  .brand<"GoogleComputeServerRef">();
export type GoogleComputeServerRef = z.infer<typeof GoogleComputeServerRefSchema>;

export const CloudComputerProviderWriteSchema = z
  .strictObject({
    token: z.uuid(),
    kind: z.enum(["create", "dns-a", "dns-aaaa", "power-on"]),
    generation: CloudComputerGenerationSchema,
    serverId: z.number().int().positive().optional(),
    serverRef: GoogleComputeServerRefSchema.optional(),
    recoverAfter: z.iso.datetime().optional(),
    dispatched: z.boolean().optional(),
  })
  .refine(({ serverId, serverRef }) => serverId === undefined || serverRef === undefined);
export type CloudComputerProviderWrite = z.infer<typeof CloudComputerProviderWriteSchema>;

export const CloudComputerDesiredSchema = z
  .object({
    id: CloudComputerIdSchema,
    generation: CloudComputerGenerationSchema,
    revision: CloudComputerDesiredRevisionSchema,
    state: z.enum(["active", "suspended", "deleted"]),
    hostname: CloudComputerHostnameSchema,
    // Null selects the provisioner's configured default.
    region: CloudComputerLocationSchema.nullable(),
    serverType: CloudComputerLocationSchema.nullable(),
    release: CloudComputerReleaseSchema,
    bootstrapToken: CloudComputerBootstrapTokenSchema.optional(),
    providerServerId: z.number().int().positive().optional(),
    previousProviderServerId: z.number().int().positive().optional(),
    providerServerRef: GoogleComputeServerRefSchema.optional(),
    previousProviderServerRef: GoogleComputeServerRefSchema.optional(),
    ipv6Enabled: z.boolean().optional(),
    restoreSnapshot: CloudComputerSnapshotSchema.optional(),
    bootCompleted: z.boolean().optional(),
    bootstrapReceiptRecorded: z.boolean().optional(),
    replacementVerified: z.boolean().optional(),
    dnsQuarantined: z.boolean().optional(),
    pendingProviderWrites: z.array(CloudComputerProviderWriteSchema).max(4).optional(),
    // Account sets this on activation and generation bumps to preserve the initial deadline.
    readinessStartedAt: z.iso.datetime({ offset: true }).optional(),
    // Account echoes the first accepted identity for this generation across provisioner restarts.
    observedIdentity: CloudComputerIdentitySchema.optional(),
  })
  .refine((value) => value.state === "active" || value.bootstrapToken === undefined, {
    path: ["bootstrapToken"],
    message: "Only an active Cloud Computer can have a bootstrap token",
  });
export type CloudComputerDesired = z.infer<typeof CloudComputerDesiredSchema>;

export const CloudComputerDesiredPageSchema = z.object({
  after: CloudComputerIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  provider: z.literal("google").optional(),
});
export const CloudComputerDesiredResponseSchema = z.object({
  next: CloudComputerIdSchema.optional(),
  computers: z
    .array(CloudComputerDesiredSchema)
    .max(10_000)
    .refine(
      (computers) =>
        new Set(computers.map(({ id }) => id)).size === computers.length &&
        new Set(computers.map(({ hostname }) => hostname)).size === computers.length,
      { message: "Cloud Computer IDs and hostnames must be unique" },
    ),
});
export type CloudComputerDesiredResponse = z.infer<typeof CloudComputerDesiredResponseSchema>;

export const CloudComputerPhaseSchema = z.enum([
  "provisioning",
  "booting",
  "ready",
  "suspended",
  "deleting",
  "deleted",
  "failed",
]);

export const CloudComputerReportSchema = z
  .strictObject({
    id: CloudComputerIdSchema,
    generation: CloudComputerGenerationSchema,
    revision: CloudComputerDesiredRevisionSchema,
    phase: CloudComputerPhaseSchema,
    providerServerId: z.number().int().positive().nullable(),
    providerServerRef: GoogleComputeServerRefSchema.optional(),
    ipv4: z.ipv4().nullable(),
    ipv6: z.ipv6().nullable(),
    observedIdentity: CloudComputerIdentitySchema.nullable(),
    lastError: z
      .enum([
        "A bootstrap token is required to create this Cloud Computer.",
        "The provider has a newer Cloud Computer generation.",
        "The Cloud Computer has more than one server for this generation.",
        "The Cloud Computer did not become ready before its deadline.",
        "The Cloud Computer reported a different Home identity for this generation.",
        "The Cloud Computer provider operation failed.",
        "The Cloud Computer DNS operation failed.",
      ])
      .nullable(),
  })
  .superRefine((report, context) => {
    const hasServer = report.providerServerId !== null || report.providerServerRef !== undefined;
    if (report.providerServerId !== null && report.providerServerRef !== undefined) {
      context.addIssue({
        code: "custom",
        message: "A report can have only one provider server ID",
      });
    }
    if (
      report.phase === "ready" &&
      (!hasServer || (!report.ipv4 && !report.ipv6) || !report.observedIdentity)
    ) {
      context.addIssue({
        code: "custom",
        message: "A ready Cloud Computer requires a server, an IP address and a Home identity",
      });
    }
    if (
      report.phase === "deleted" &&
      (hasServer || report.ipv4 || report.ipv6 || report.observedIdentity)
    ) {
      context.addIssue({
        code: "custom",
        message: "A deleted Cloud Computer cannot have server details",
      });
    }
    if ((report.phase === "failed") !== (report.lastError !== null)) {
      context.addIssue({
        code: "custom",
        path: ["lastError"],
        message: "Only failed reports carry an error",
      });
    }
  });
export type CloudComputerReport = z.infer<typeof CloudComputerReportSchema>;

export const CloudComputerReportResponseSchema = z.object({ recorded: z.boolean() });
export type CloudComputerReportResponse = z.infer<typeof CloudComputerReportResponseSchema>;

/** Whether `text` is a private IPv4 network (10/8, 172.16/12, 192.168/16) at its own address. */
function isPrivateIpv4Network(text: string): boolean {
  const match =
    /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\/([1-9]|[12]\d|3[0-2])$/u.exec(
      text,
    );
  if (!match) return false;
  const octets = match.slice(1, 5).map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  const prefix = Number(match[5]);
  const address = octets.reduce((value, octet) => value * 256 + octet, 0);
  const hostSize = 2 ** (32 - prefix);
  if (address % hostSize !== 0) return false;
  const [a, b] = octets as [number, number];
  return (
    (a === 10 && prefix >= 8) ||
    (a === 172 && b >= 16 && b <= 31 && prefix >= 12) ||
    (a === 192 && b === 168 && prefix >= 16)
  );
}

/**
 * The network a Cloud Computer's pool hosts live in: the provisioner's Home subnet, where it
 * creates both Homes and pool hosts. Always private, and never wider than a private range.
 */
export const BrowserPoolNetworkCidrSchema = z
  .string()
  .refine(isPrivateIpv4Network, "Expected a private IPv4 network at its own address");

const poolPortSchema = z.number().int().min(1).max(65_535);

/** What a Cloud Computer's Home may reach of the browser pool: that network, on two ports. */
export const CloudComputerBrowserPoolNetworkSchema = z
  .strictObject({
    cidr: BrowserPoolNetworkCidrSchema,
    agentPort: poolPortSchema,
    relayPort: poolPortSchema,
  })
  .refine((network) => network.agentPort !== network.relayPort, "Expected two different ports");
export type CloudComputerBrowserPoolNetwork = z.infer<typeof CloudComputerBrowserPoolNetworkSchema>;

export const CloudComputerLeaseSchema = z.strictObject({
  holder: z.uuid(),
  poolConfigured: z.boolean().optional(),
  /** The provisioner's Home subnet, where its pool hosts live too. */
  poolNetwork: BrowserPoolNetworkCidrSchema.optional(),
});
export const CloudComputerCheckSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("orphan") }),
  z.strictObject({
    operation: z.literal("begin-provider-write"),
    revision: CloudComputerDesiredRevisionSchema,
    write: CloudComputerProviderWriteSchema,
  }),
  z.strictObject({ operation: z.literal("finish-provider-write"), token: z.uuid() }),
  z.strictObject({
    operation: z.enum(["recover-provider-write", "send-provider-write"]),
    revision: CloudComputerDesiredRevisionSchema,
    token: z.uuid(),
  }),
  z.strictObject({
    operation: z.enum(["mutate", "create"]),
    revision: CloudComputerDesiredRevisionSchema,
  }),
]);
export type CloudComputerCheck = z.infer<typeof CloudComputerCheckSchema>;
export const CloudComputerCheckResponseSchema = z.object({ allowed: z.boolean() });
export const cloudComputerLeaseHeader = "x-opensteer-provisioner-lease";
export const cloudComputerLeasePath = "/v1/cloud-computers/lease";
export const cloudComputerCheckPath = (id: CloudComputerId) => `/v1/cloud-computers/${id}/check`;

export const cloudComputersDesiredPath = "/v1/cloud-computers/desired";
// Account checks that the URL ID matches the body and fences writes on the current generation.
export const cloudComputerStatusPath = (id: CloudComputerId) =>
  `/v1/cloud-computers/${encodeURIComponent(id)}/status`;

const httpsUrl = z
  .url({ protocol: /^https$/u })
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return !url.username && !url.password;
  });
const secret = z
  .string()
  .min(1)
  .max(8192)
  .refine((value) => !/\p{Cc}/u.test(value));
const pinnedImage = z
  .string()
  .max(512)
  .regex(/^[a-z0-9./_:-]+@sha256:[0-9a-f]{64}(?![\s\S])/u);

export const CloudComputerBootReleaseSchema = z.strictObject({
  version: z
    .string()
    .max(79)
    .regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?![\s\S])/u)
    .refine((value) => value !== "0.0.0"),
  images: z.strictObject({
    host: pinnedImage,
    runner: pinnedImage,
    "browser-runtime": pinnedImage,
    "browser-egress": pinnedImage,
    "channel-runtime": pinnedImage,
    gateway: pinnedImage,
  }),
});
export const CloudComputerEgressSchema = z.strictObject({
  url: z
    .string()
    .regex(/^https:\/\/(?:\[[a-fA-F0-9:.]+\]|[a-zA-Z0-9.-]+)(?::[0-9]{1,5})?\/?(?![\s\S])/u)
    .pipe(httpsUrl.refine((value) => new URL(value).port !== "0")),
  username: secret.max(255).refine((value) => value.trim() !== "" && !value.includes(":")),
  password: secret.max(255).refine((value) => value.trim() !== ""),
});

export const CloudComputerEgressResponseSchema = z.strictObject({
  egress: CloudComputerEgressSchema.optional(),
});
export const cloudComputerEgressPath = (id: CloudComputerId) => `/v1/cloud-computers/${id}/egress`;

export const CloudComputerBackupReportSchema = z.strictObject({
  completedAt: z.iso.datetime(),
  snapshotId: CloudComputerSnapshotSchema,
});
export type CloudComputerBackupReport = z.infer<typeof CloudComputerBackupReportSchema>;
export const cloudComputerBackupReportPath = (id: CloudComputerId) =>
  `/v1/cloud-computers/${id}/backup`;

export const CloudComputerBootRequestSchema = z.strictObject({
  hostname: CloudComputerHostnameSchema,
  bootstrapToken: CloudComputerBootstrapTokenSchema,
});
export type CloudComputerBootRequest = z.infer<typeof CloudComputerBootRequestSchema>;
export const CloudComputerBootCompleteRequestSchema = CloudComputerBootRequestSchema.extend({
  identity: CloudComputerIdentitySchema,
});
export type CloudComputerBootCompleteRequest = z.infer<
  typeof CloudComputerBootCompleteRequestSchema
>;
export const CloudComputerBootCompleteResponseSchema = z.strictObject({
  completed: z.literal(true),
});
export const cloudComputerBootCompletePath = (id: CloudComputerId) =>
  `/v1/cloud-computers/${id}/boot-complete`;

/**
 * What a managed Home needs to accept its Account-bound claim and to sign its
 * owner in with the Opensteer Account: which claim it is, and the OIDC client
 * the Account registered for its address. Optional so an older Account still
 * boots an older installer.
 */
export const CloudComputerManagedHomeSchema = z.strictObject({
  cloudComputerId: CloudComputerIdSchema,
  generation: CloudComputerGenerationSchema,
  oidc: z.strictObject({
    clientId: z.string().regex(/^occ_[0-9a-f-]{36}$/u),
    clientSecret: z.string().regex(/^ocs_[A-Za-z0-9_-]{43}$/u),
  }),
});
export type CloudComputerManagedHome = z.infer<typeof CloudComputerManagedHomeSchema>;

export const CloudComputerBootResponseSchema = z.strictObject({
  hostname: CloudComputerHostnameSchema,
  accountOrigin: httpsUrl.refine((value) => new URL(value).origin === value),
  setupCodeDigest: CloudComputerInstallerSha256Schema,
  release: CloudComputerBootReleaseSchema,
  releaseManifestUrl: CloudComputerReleaseManifestUrlSchema.optional(),
  egress: CloudComputerEgressSchema.optional(),
  managedHome: CloudComputerManagedHomeSchema.optional(),
  browserPool: z.boolean().optional(),
  /** With browserPool: the only private network, and ports, the Home's firewall lets it reach. */
  browserPoolNetwork: CloudComputerBrowserPoolNetworkSchema.optional(),
  ipv6Enabled: z.boolean(),
  restoreSnapshot: CloudComputerSnapshotSchema.optional(),
  backup: z.strictObject({
    endpoint: httpsUrl.refine((value) => new URL(value).origin === value),
    bucket: z
      .string()
      .min(3)
      .max(63)
      .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u),
    prefix: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/u),
    repository: z.string().startsWith("s3:https://").max(4096),
    accessKeyId: secret,
    secretAccessKey: secret,
    password: secret,
  }),
});
export type CloudComputerBootResponse = z.infer<typeof CloudComputerBootResponseSchema>;
export const cloudComputerBootPath = (id: CloudComputerId) => `/v1/cloud-computers/${id}/boot`;

export const CloudComputerPlanSchema = z.object({
  name: z.string().trim().min(1).max(120),
  currency: z.string().regex(/^[a-z]{3}$/u),
  amountMinor: z.number().int().positive(),
  interval: z.enum(["day", "week", "month", "year"]).optional(),
});

/**
 * The public offer: what a Cloud Computer costs now, from the account service's own plan, for
 * the website to say before anyone signs in. Null while checkout isn't ready, when the site
 * says only that it is paid monthly. It names nothing about whoever asked.
 */
export const cloudComputerOfferPath = "/v1/cloud-computers/offer";
export const CloudComputerOfferResponseSchema = z.strictObject({
  plan: CloudComputerPlanSchema.nullable(),
});
export type CloudComputerOfferResponse = z.infer<typeof CloudComputerOfferResponseSchema>;

export const CloudComputerReasonCodeSchema = z.enum([
  "cloud-computer-already-exists",
  "cloud-computer-no-capacity",
  "cloud-computer-sales-not-open",
  "cloud-computer-billing-problem",
  "cloud-computer-checkout-expired",
  "cloud-computer-checkout-complete",
  "cloud-computer-checkout-in-progress",
  "cloud-computer-checkout-unavailable",
  "cloud-computer-billing-web-only",
  "cloud-computer-delete-confirmation-required",
  "cloud-computer-not-found",
  "cloud-computer-deleted",
  "cloud-computer-owner-suspended",
  "cloud-computer-operator-suspended",
  "cloud-computer-deletion-pending",
  "cloud-computer-claim-failed",
  "cloud-computer-bootstrap-expired",
  "cloud-computer-provisioning-failed",
]);
export type CloudComputerReasonCode = z.infer<typeof CloudComputerReasonCodeSchema>;

export const CloudComputerRegionSchema = z.object({
  id: CloudComputerLocationSchema,
  label: z.string().trim().min(1).max(120),
});
export const CloudComputerEgressAddressSchema = z.union([z.ipv4(), z.ipv6()]);
export const CloudComputerPreparationStepSchema = z.object({
  id: z.enum(["payment", "machine", "opensteer", "claim"]),
  state: z.enum(["done", "current", "pending", "failed"]),
});
export type CloudComputerPreparationStep = z.infer<typeof CloudComputerPreparationStepSchema>;

const cloudComputerViewFields = {
  id: CloudComputerIdSchema,
  egress: z.enum(["pending", "assigned", "unavailable"]),
  deploymentId: DeploymentIdSchema.optional(),
  region: CloudComputerRegionSchema.optional(),
  egressAddress: CloudComputerEgressAddressSchema.optional(),
  renewsAt: z.iso.datetime().optional(),
  lastBackupAt: z.iso.datetime().optional(),
  deletion: CloudComputerDeletionSchema.optional(),
};
const cloudComputerReasonFields = {
  reason: z.string().min(1).max(1000),
  reasonCode: CloudComputerReasonCodeSchema.optional(),
};
export const CloudComputerViewSchema = z.discriminatedUnion("status", [
  z.object({
    ...cloudComputerViewFields,
    status: z.literal("preparing"),
    steps: z.array(CloudComputerPreparationStepSchema).optional(),
  }),
  z.object({ ...cloudComputerViewFields, status: z.literal("ready"), address: httpsUrl }),
  z.object({
    ...cloudComputerViewFields,
    ...cloudComputerReasonFields,
    status: z.literal("needs_attention"),
  }),
  z.object({
    ...cloudComputerViewFields,
    ...cloudComputerReasonFields,
    status: z.literal("suspended"),
  }),
  z.object({ ...cloudComputerViewFields, status: z.literal("deleted") }),
]);
export type CloudComputerView = z.infer<typeof CloudComputerViewSchema>;

export const CloudComputerListResponseSchema = z.object({
  computers: z.array(CloudComputerViewSchema),
  /** The plan a Cloud Computer is on: what its status page shows. */
  plan: CloudComputerPlanSchema,
  /**
   * What checkout sells now, the same answer as the public offer: null until the payment
   * provider has confirmed it. A client shows a price for buying only from this; an older
   * account service leaves it out, and then nothing is offered for sale.
   */
  offer: CloudComputerPlanSchema.nullable().optional(),
});

export type CloudComputerListResponse = z.infer<typeof CloudComputerListResponseSchema>;

export const CloudComputerCheckoutRequestSchema = z.strictObject({ requestId: z.uuid() });
export type CloudComputerCheckoutRequest = z.infer<typeof CloudComputerCheckoutRequestSchema>;
export const CloudComputerBillingUrlResponseSchema = z.object({ url: httpsUrl });
export type CloudComputerBillingUrlResponse = z.infer<typeof CloudComputerBillingUrlResponseSchema>;
export const CloudComputerDeleteRequestSchema = z.strictObject({
  confirmation: z.templateLiteral(["DELETE:", CloudComputerIdSchema]),
});
export type CloudComputerDeleteRequest = z.infer<typeof CloudComputerDeleteRequestSchema>;
export const cloudComputerDeleteConfirmation = (id: CloudComputerId) => `DELETE:${id}` as const;

export const accountCloudComputersPath = "/v1/account/cloud-computers";
export const accountCloudComputerCheckoutPath = `${accountCloudComputersPath}/checkout`;
export const accountCloudComputerBillingPortalPath = `${accountCloudComputersPath}/billing-portal`;
export const accountCloudComputerPath = (id: CloudComputerId) =>
  `${accountCloudComputersPath}/${id}`;
export const cloudComputerStripeWebhookPath = "/v1/cloud-computers/stripe-webhook";

export const accountCloudComputerSuspendPath = (id: CloudComputerId) =>
  `${accountCloudComputerPath(id)}/suspend`;
export const accountCloudComputerResumePath = (id: CloudComputerId) =>
  `${accountCloudComputerPath(id)}/resume`;

/** The Home route the Account claims a ready managed Home on, once. */
export const managedHomeClaimPath = "/v1/managed-home/claim";

const base64Url43 = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const bareHttpsOrigin = httpsUrl.refine((value) => new URL(value).origin === value);

/** The exact Home a claim is for: what the Account pinned when the Home reported ready. */
export const ManagedHomeClaimAuthoritySchema = z.strictObject({
  canonicalOrigin: bareHttpsOrigin,
  deploymentId: DeploymentIdSchema,
  hostKeyFingerprint: HostKeyFingerprintSchema,
});
export type ManagedHomeClaimAuthority = z.infer<typeof ManagedHomeClaimAuthoritySchema>;

const ManagedHomeClaimTargetSchema = z.strictObject({
  cloudComputerId: CloudComputerIdSchema,
  generation: CloudComputerGenerationSchema,
});

/**
 * Account-signed (EdDSA, the Account's JWKS) statement of who owns this Home.
 * It names the owner subject, binds the Home's identity, canonical origin and
 * claim generation, and pins the link credential that travels beside it.
 */
export const ManagedHomeClaimClaimsSchema = z
  .strictObject({
    tokenUse: z.literal("opensteer-managed-home-claim"),
    iss: bareHttpsOrigin,
    aud: bareHttpsOrigin,
    sub: ControlPlaneAccountIdSchema,
    iat: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    exp: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    jti: prefixedIdSchema("mhc"),
    // The installation that answered the discovery this claim was built from.
    authority: ManagedHomeClaimAuthoritySchema.extend({ hostInstanceId: HostInstanceIdSchema }),
    claim: ManagedHomeClaimTargetSchema,
    owner: z.strictObject({
      email: z.email().max(320),
      displayName: z.string().trim().min(1).max(120),
      emailVerified: z.literal(true),
    }),
    link: z.strictObject({ generation: base64Url43, hostCredentialSha256: base64Url43 }),
  })
  .superRefine((claims, context) => {
    if (claims.exp <= claims.iat || claims.exp - claims.iat > 5 * 60) {
      context.addIssue({
        code: "custom",
        message: "A managed Home claim may live for at most five minutes",
        path: ["exp"],
      });
    }
    if (claims.aud !== claims.authority.canonicalOrigin) {
      context.addIssue({
        code: "custom",
        message: "A managed Home claim's audience is the Home's canonical origin",
        path: ["aud"],
      });
    }
  });
export type ManagedHomeClaimClaims = z.infer<typeof ManagedHomeClaimClaimsSchema>;

export const ManagedHomeClaimRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  setupCode: z.string().min(32).max(4096),
  assertion: z
    .string()
    .min(64)
    .max(16_384)
    .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u),
  hostCredential: z.string().regex(/^osc_[A-Za-z0-9_-]{43}$/u),
});
export type ManagedHomeClaimRequest = z.infer<typeof ManagedHomeClaimRequestSchema>;

export const ManagedHomeClaimReceiptDocumentSchema = z.strictObject({
  purpose: z.literal("opensteer-managed-home-claim-receipt"),
  documentVersion: z.literal(1),
  account: z.strictObject({ issuer: bareHttpsOrigin, subject: ControlPlaneAccountIdSchema }),
  authority: ManagedHomeClaimAuthoritySchema.extend({ hostInstanceId: HostInstanceIdSchema }),
  claim: ManagedHomeClaimTargetSchema,
  linkGeneration: base64Url43,
  /** The digest of the Account link credential the Home committed with this claim. */
  hostCredentialSha256: base64Url43,
  claimedAt: z.iso.datetime({ offset: true }),
});
export type ManagedHomeClaimReceiptDocument = z.infer<typeof ManagedHomeClaimReceiptDocumentSchema>;

/** Signed by the Home's own Host key, so Account can trust it read back from the Home. */
export const ManagedHomeClaimReceiptSchema = z.strictObject({
  document: ManagedHomeClaimReceiptDocumentSchema,
  publicKey: z.strictObject({
    algorithm: z.literal("Ed25519"),
    spki: z.string().regex(/^[A-Za-z0-9_-]{59}$/u),
  }),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/u),
});
export type ManagedHomeClaimReceipt = z.infer<typeof ManagedHomeClaimReceiptSchema>;

/** Exact bytes the Home signs, in a fixed field order every runtime agrees on. */
export function managedHomeClaimReceiptSigningBytes(
  documentInput: ManagedHomeClaimReceiptDocument,
): Uint8Array {
  const document = ManagedHomeClaimReceiptDocumentSchema.parse(documentInput);
  return new TextEncoder().encode(
    `opensteer-managed-home-claim-receipt-v1\0${JSON.stringify({
      account: { issuer: document.account.issuer, subject: document.account.subject },
      authority: {
        canonicalOrigin: document.authority.canonicalOrigin,
        deploymentId: document.authority.deploymentId,
        hostInstanceId: document.authority.hostInstanceId,
        hostKeyFingerprint: document.authority.hostKeyFingerprint,
      },
      claim: {
        cloudComputerId: document.claim.cloudComputerId,
        generation: document.claim.generation,
      },
      claimedAt: document.claimedAt,
      documentVersion: document.documentVersion,
      hostCredentialSha256: document.hostCredentialSha256,
      linkGeneration: document.linkGeneration,
      purpose: document.purpose,
    })}`,
  );
}
