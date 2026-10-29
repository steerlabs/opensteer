import { noFollowFlag } from "@opensteer/shared/privateFiles";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { ManagedHostProvisioningBundleSchema } from "@opensteer/control-plane-protocol";
import type { VerifiedDeploymentOwnerProfile } from "@opensteer/control-plane-protocol";
import {
  DeploymentShapeSchema,
  DeploymentKindSchema,
  DeploymentIdSchema,
  RuntimeModeSchema,
  WorkspaceBackingKindSchema,
  allowsPlaintextRunnerTransport,
  localWorkspaceNamespace,
  isLoopbackHostname,
  HostKeyFingerprintSchema,
  EnvironmentIdSchema,
  HostInstanceIdSchema,
  opensteerHostNativeOAuthClients,
  RunnerIdSchema,
  type NativeOAuthClient,
  type DeploymentId,
  type DeploymentShape,
  type EnvironmentId,
  type HostExposure,
  type HostInstanceId,
  type RunnerId,
  type RuntimeMode,
} from "@opensteer/core";
import { z } from "zod";

export const hostEnvironmentKeys = {
  defaultWorkspaceBacking: "OPENSTEER_DEFAULT_WORKSPACE_BACKING",
} as const;

export { RuntimeModeSchema } from "@opensteer/core";
export type { RuntimeMode } from "@opensteer/core";

/**
 * A Host reachable only from its own machine may bootstrap itself: it mints its
 * own first-owner code and its own deployment-owned Main Runner enrollment.
 * Every other Host is network-reachable and keeps operator-held credentials.
 *
 * Both the browser-visible origin and the listener must be loopback. Requiring
 * both stops a Host that binds a wildcard address while declaring
 * `http://localhost` from claiming the relaxed exposure.
 */
function deriveHostExposure(input: {
  readonly bindAddress: string;
  readonly canonicalOrigin: URL;
}): HostExposure {
  return isLoopbackHostname(input.canonicalOrigin.hostname) &&
    isLoopbackBindAddress(input.bindAddress)
    ? "loopback"
    : "networked";
}

function isLoopbackBindAddress(bindAddress: string): boolean {
  // A wildcard listener accepts connections from every interface, so it is
  // never loopback-only even when the declared public origin says localhost.
  if (bindAddress === "0.0.0.0" || bindAddress === "::") return false;
  return isLoopbackHostname(bindAddress);
}

const positiveInteger = (defaultValue: number) =>
  z.preprocess(
    (value) => (value === undefined || value === "" ? defaultValue : Number(value)),
    z.number().int().positive(),
  );

const nonnegativeInteger = (defaultValue: number) =>
  z.preprocess(
    (value) => (value === undefined || value === "" ? defaultValue : Number(value)),
    z.number().int().nonnegative(),
  );

const booleanValue = (defaultValue: boolean) =>
  z.preprocess((value) => {
    if (value === undefined || value === "") return defaultValue;
    if (typeof value === "boolean") return value;
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
    return value;
  }, z.boolean());

const optionalBooleanValue = z.preprocess((value) => {
  if (value === undefined || value === "") return undefined;
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return value;
}, z.boolean().optional());

const optionalPath = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(1).optional(),
);

const optionalReleaseVersion = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z
    .string()
    .max(120)
    .regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u)
    .optional(),
);

const optionalUrl = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.url().optional(),
);

const optionalDeploymentName = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).max(120).optional(),
);

const optionalEnrollmentToken = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(16).max(4_096).optional(),
);

// The app-held Personal owner claim is minted by the desktop as 32 random bytes;
// a shorter value is a misconfiguration, not a weaker password.
const optionalLocalOwnerClaimToken = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(32).max(4_096).optional(),
);

const optionalFileDescriptor = z.preprocess(
  (value) => (value === undefined || value === "" ? undefined : Number(value)),
  z.number().int().min(3).max(1_024).optional(),
);

const configuredSecret = (maximumLength: number) =>
  z
    .string()
    .min(32)
    .max(maximumLength)
    .refine((value) => !value.startsWith("replace-with-"), {
      message: "Run pnpm setup:local to generate development secrets",
    });

const portableFsIdentity = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim() === value)
  .refine((value) => !/\p{Control}/u.test(value));

const bindAddress = z.union([z.ipv4(), z.ipv6(), z.literal("localhost")]);
const HostEnvironmentSchema = z.object({
  OPENSTEER_AUTH_SECRET: configuredSecret(8_192),
  OPENSTEER_ACCOUNT_BUNDLE_FD: optionalFileDescriptor,
  OPENSTEER_ACCOUNT_BUNDLE_PATH: optionalPath,
  OPENSTEER_BIND_ADDRESS: bindAddress.default("127.0.0.1"),
  OPENSTEER_BROWSER_ATTACH_KEY_ID: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{1,255}$/)
    .default("host-v1"),
  OPENSTEER_BROWSER_PROFILE_KEY_PATH: optionalPath,
  OPENSTEER_DATABASE_URL: z.string().min(1),
  OPENSTEER_DEPLOYMENT_ID: DeploymentIdSchema.optional(),
  OPENSTEER_DEPLOYMENT_NAME: optionalDeploymentName,
  OPENSTEER_CREDENTIAL_KEY_PATH: optionalPath,
  OPENSTEER_FILES_SERVICE_URL: optionalUrl,
  OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN: optionalEnrollmentToken,
  OPENSTEER_INITIAL_BROWSER_RUNNER_ENROLLMENT_TOKEN: optionalEnrollmentToken,
  OPENSTEER_INITIAL_MESSAGING_RUNNER_ENROLLMENT_TOKEN: optionalEnrollmentToken,
  OPENSTEER_INITIAL_OWNER_ENROLLMENT_LIFETIME_SECONDS: positiveInteger(24 * 60 * 60),
  OPENSTEER_LOCAL_OWNER_CLAIM_TOKEN: optionalLocalOwnerClaimToken,
  OPENSTEER_LOCAL_PASSWORD_ENABLED: booleanValue(true),
  OPENSTEER_LOCAL_WORKSPACE_ENVIRONMENT_ID: EnvironmentIdSchema.optional(),
  OPENSTEER_NATIVE_OAUTH_ENABLED: optionalBooleanValue,
  OPENSTEER_DEPLOYMENT_KIND: DeploymentKindSchema.optional(),
  OPENSTEER_HOST_INSTANCE_ID: HostInstanceIdSchema.optional(),
  OPENSTEER_HOST_KEY_FINGERPRINT: HostKeyFingerprintSchema.optional(),
  OPENSTEER_HOST_PRIVATE_KEY_PATH: optionalPath,
  OPENSTEER_HOST_PUBLIC_KEY_PATH: optionalPath,
  OPENSTEER_HOST_DATA_DIR: z.string().min(1).default(".opensteer/host"),
  OPENSTEER_MODE: RuntimeModeSchema.default("development"),
  OPENSTEER_ACCEPTS_EXTERNAL_RUNNERS: optionalBooleanValue,
  [hostEnvironmentKeys.defaultWorkspaceBacking]: WorkspaceBackingKindSchema.optional(),
  /**
   * How long a Run survives without word from its Runner: the grace a network
   * blip or Host restart has before the Run is failed. Heartbeats renew it.
   */
  OPENSTEER_EXECUTION_LEASE_SECONDS: z.preprocess(
    (value) => (value === undefined || value === "" ? 90 : Number(value)),
    z.number().int().min(10).max(3_600),
  ),
  OPENSTEER_MAX_CONCURRENT_DISPATCHES: positiveInteger(32),
  OPENSTEER_MAX_CONCURRENT_TRIGGER_DISPATCHES: positiveInteger(32),
  OPENSTEER_OIDC_CONFIG_PATH: optionalPath,
  OPENSTEER_PORTABLEFS_AUTHORIZATION_DOMAIN: portableFsIdentity.default("opensteer"),
  OPENSTEER_PORTABLEFS_SERVICE_ID: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/)
    .optional(),
  OPENSTEER_PORTABLEFS_MANAGER_CA_PATH: optionalPath,
  OPENSTEER_PORTABLEFS_MANAGER_CERT_PATH: optionalPath,
  OPENSTEER_PORTABLEFS_MANAGER_KEY_PATH: optionalPath,
  OPENSTEER_PORTABLEFS_MANAGER_SERVER_NAME: z.string().trim().min(1).max(253).optional(),
  OPENSTEER_PORTABLEFS_MANAGER_URL: optionalUrl,
  OPENSTEER_PORTABLEFS_PRODUCT_ISSUER: portableFsIdentity.default("opensteer"),
  OPENSTEER_PORTABLEFS_PRODUCT_PRIVATE_KEY_PATH: optionalPath,
  OPENSTEER_PORT: positiveInteger(4310),
  OPENSTEER_PERSONAL_ACCOUNT_ISSUER: optionalUrl,
  OPENSTEER_PORTAL_ORIGIN: optionalUrl,
  OPENSTEER_CANONICAL_ORIGIN: z.url(),
  OPENSTEER_RUNTIME_ORIGIN: optionalUrl,
  OPENSTEER_SIGNUP_POLICY: z.enum(["closed", "invite-only", "open"]).default("invite-only"),
  OPENSTEER_WEB_DISTRIBUTION_DIRECTORY: optionalPath,
  OPENSTEER_WEB_DISTRIBUTION_MANIFEST: optionalPath,
  OPENSTEER_HOST_RELEASE_VERSION: optionalReleaseVersion,
  OPENSTEER_WORKSPACE_DEFAULT_BLOCK_LIMIT_BYTES: positiveInteger(10 * 1_024 * 1_024 * 1_024),
  OPENSTEER_WORKSPACE_DEFAULT_INODE_LIMIT: positiveInteger(1_000_000),
  OPENSTEER_WORKSPACE_ARCHIVE_AFTER_DAYS: nonnegativeInteger(7),
  OPENSTEER_WORKSPACE_DELETION_RETENTION_DAYS: nonnegativeInteger(14),
  OPENSTEER_WORKSPACE_MAX_BLOCK_LIMIT_BYTES: positiveInteger(100 * 1_024 * 1_024 * 1_024),
  OPENSTEER_WORKSPACE_MAX_INODE_LIMIT: positiveInteger(10_000_000),
});

export interface HostConfig {
  readonly account?:
    | {
        readonly provisioningMode: "adoption" | "managed";
        readonly controlApiOrigin: URL;
        readonly hostCredential: string;
        readonly initialRunnerEnrollmentToken: string | undefined;
        readonly reachability: "canonical";
        readonly issuer: URL;
        readonly oidcClientId: string;
        readonly oidcClientSecret: string;
        readonly owner: VerifiedDeploymentOwnerProfile | undefined;
      }
    | undefined;
  /**
   * Whether people may lend this Deployment machines that sit outside its own
   * network. It is what the `runtimeOrigin === canonicalOrigin` rule now hangs
   * on: every Runner capability URL is minted from the runtime origin, so a
   * Deployment reachable only at a private runtime origin cannot honestly
   * accept a Runner that can only reach the canonical one.
   */
  readonly acceptsExternalRunners: boolean;
  readonly authSecret: string;
  readonly bindAddress: string;
  readonly canonicalOrigin: URL;
  /**
   * The key the Host signs browser attach tickets with. Every browser now
   * belongs to an enrolled Runner, so there is no runtime URL to configure:
   * the machine comes to the Host, not the other way round.
   */
  readonly browserRuntime: { readonly attachKeyId: string };
  readonly browserProfileKeyPath: string | undefined;
  readonly databaseUrl: string;
  readonly credentialKeyPath: string | undefined;
  readonly dataDirectory: string;
  readonly deploymentIdentity?:
    | {
        readonly deploymentId: DeploymentId;
        readonly hostKeyFingerprint: z.infer<typeof HostKeyFingerprintSchema>;
        readonly hostInstanceId: HostInstanceId;
      }
    | undefined;
  readonly identity: {
    readonly initialOwnerEnrollment:
      { readonly lifetimeSeconds: number; readonly token: string } | undefined;
    readonly localOwnerClaimToken?: string | undefined;
    readonly localPasswordEnabled: boolean;
    /**
     * The Host's own OAuth authorization server and the applications allowed
     * to use it. Absent means the surface is not served at all, which is the
     * only state a Personal Deployment may be in.
     */
    readonly nativeOAuth?: { readonly clients: readonly NativeOAuthClient[] };
    readonly oidcConfigPath: string | undefined;
    readonly signupPolicy: "closed" | "invite-only" | "open";
  };
  /**
   * One-use enrollment tokens for the computers a managed Deployment supervises
   * for itself. Each is scoped to exactly one module, so a token minted for a
   * browser pod can never come back as a machine that executes agents.
   */
  readonly initialBrowserRunnerEnrollmentToken?: string | undefined;
  readonly initialMessagingRunnerEnrollmentToken?: string | undefined;
  /**
   * How long a Run's execution lease lasts without renewal. It is the grace a
   * Runner has to reconnect after a network blip or a Host restart.
   */
  readonly executionLeaseMs: number;
  readonly maxConcurrentDispatches: number;
  readonly maxConcurrentTriggerDispatches: number;
  readonly mode: RuntimeMode;
  readonly port: number;
  /** The place's display name as its own Door shows it; presentation metadata, not identity. */
  readonly deploymentName?: string;
  /** Apex portal this Deployment belongs to, for the "back to the portal"
   * navigation its own web UI and the Desktop app render. It is cell-level
   * navigation metadata rather than trust material, so any Deployment may
   * declare one and an absent value simply leaves the link unrendered. */
  readonly portalOrigin?: URL;
  /** Pinned trust root for Account-signed Personal link/session grants. It is
   * separate from a managed Host Account bundle because a Personal Host keeps
   * its own loopback canonical authority. */
  readonly personalAccountIssuer?: URL;
  readonly exposure: HostExposure;
  readonly privateKeyPath: string | undefined;
  readonly publicKeyPath: string | undefined;
  readonly runtimeOrigin: URL;
  readonly workspace: {
    readonly deletionRetentionDays: number;
    readonly shape: DeploymentShape;
    readonly storage:
      | {
          readonly kind: "local-directory";
          /**
           * Where a Workspace goes when the caller names no machine — the
           * cohosted Runner's environment. The Host holds nothing else about
           * local storage: roots, registries and the native helper belong to
           * the machine that owns the disk.
           */
          readonly ownerEnvironmentId: EnvironmentId;
        }
      | {
          readonly authorizationDomain: string;
          readonly archiveAfterDays: number;
          /** Safety ceiling for a normal Workspace, not a storage entitlement.
           * Legitimate users should never reach it. The deployment runbook
           * migrates to PortableFS Manager v2 measured admission before fleet
           * defaults are raised, because v1 entitlement-sum admission would
           * reserve these ceilings and exhaust capacity. */
          readonly defaultBlockLimitBytes: number;
          /** Inode counterpart to `defaultBlockLimitBytes`; it is the same
           * circuit breaker rather than an entitlement. */
          readonly defaultInodeLimit: number;
          readonly filesServiceUrl: URL;
          readonly kind: "portablefs";
          readonly maxBlockLimitBytes: number;
          readonly maxInodeLimit: number;
          readonly managerCaPath: string | undefined;
          readonly managerCertPath: string | undefined;
          readonly managerKeyPath: string | undefined;
          readonly managerServerName: string | undefined;
          readonly managerUrl: URL;
          readonly productIssuer: string;
          readonly productPrivateKeyPath: string | undefined;
          readonly serviceId: string;
        };
  };
  readonly webDistribution?: {
    readonly directory: string;
    readonly expectedHostVersion: string;
    readonly manifestPath: string;
  };
}

export class HostConfigurationIssue extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HostConfigurationIssue";
    this.code = code;
  }
}

const PinnedDeploymentIdentitySchema = z.strictObject({
  deploymentId: DeploymentIdSchema,
  hostKeyFingerprint: HostKeyFingerprintSchema,
  hostInstanceId: HostInstanceIdSchema,
});

/**
 * Checks relationships that TypeScript cannot express for callers that build
 * HostConfig directly. Keep this free of I/O so Host startup can call it before
 * creating an installation identity or opening PostgreSQL.
 */
export function assertHostConfigInvariants(config: HostConfig): void {
  if (
    config.account !== undefined &&
    !PinnedDeploymentIdentitySchema.safeParse(config.deploymentIdentity).success
  ) {
    throw new Error(
      "An Opensteer Account Host requires a pinned deployment and Host instance identity",
    );
  }
  if (config.workspace.shape.defaultWorkspaceBacking !== config.workspace.storage.kind) {
    throw new Error("Deployment backing and storage configuration do not match");
  }
  if (config.workspace.shape.kind === "personal" && config.exposure !== "loopback") {
    throw new Error("A Personal Deployment must be confined to loopback");
  }
  // A Personal Host's only tenancy evidence is that the caller reached it over
  // its canonical loopback origin. Its own OAuth server would hand out bearer
  // credentials that bypass that check from anywhere its Connect route
  // reaches, so the surface stays off rather than being fenced after the fact.
  if (config.workspace.shape.kind === "personal" && config.identity.nativeOAuth !== undefined) {
    throw new Error(
      "A Personal Deployment cannot serve native OAuth: set OPENSTEER_NATIVE_OAUTH_ENABLED=false",
    );
  }
  // A loopback Host mints its own first-owner code; only a networked Host
  // takes an operator-held one.
  if (config.exposure === "loopback" && config.identity.initialOwnerEnrollment !== undefined) {
    throw new Error(
      "OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN is allowed only for a networked Deployment",
    );
  }
  // Every Runner capability URL — the PortableFS mount-grant exchange, egress,
  // dispatch, and the tool servers — is minted from the runtime origin. A
  // Deployment whose Runners all live inside its own private network may be
  // handed a private origin. One that accepts a machine somebody lends it from
  // outside cannot: that Runner reaches only the canonical origin.
  if (
    config.acceptsExternalRunners &&
    config.runtimeOrigin.origin !== config.canonicalOrigin.origin
  ) {
    throw new Error(
      "A Deployment that accepts external Runners requires OPENSTEER_RUNTIME_ORIGIN to equal OPENSTEER_CANONICAL_ORIGIN",
    );
  }
  if (config.acceptsExternalRunners && config.workspace.shape.kind !== "server") {
    throw new Error("Only a Server Deployment can accept external Runners");
  }
  // PortableFS exists so Runners outside the Host's network can hold its
  // Workspaces; declaring otherwise would describe a stack nobody can attach to.
  if (
    config.workspace.shape.defaultWorkspaceBacking === "portablefs" &&
    !config.acceptsExternalRunners
  ) {
    throw new Error("A PortableFS Deployment must accept external Runners");
  }
  if (config.webDistribution) {
    if (
      config.mode !== "production" ||
      !isAbsolute(config.webDistribution.directory) ||
      !isAbsolute(config.webDistribution.manifestPath)
    ) {
      throw new Error(
        "A Host Web distribution is valid only for a production Host with absolute paths",
      );
    }
  }
  if (
    config.mode === "production" &&
    config.workspace.shape.kind === "personal" &&
    config.exposure === "loopback" &&
    !config.webDistribution
  ) {
    throw new HostConfigurationIssue(
      "packaged-personal-web-distribution-required",
      "A packaged Personal Host requires its version-matched Web distribution.",
    );
  }
  if (config.personalAccountIssuer) {
    if (
      config.workspace.shape.kind !== "personal" ||
      config.exposure !== "loopback" ||
      config.account !== undefined
    ) {
      throw new Error(
        "A Personal Account issuer is valid only for an unmanaged loopback Personal Host",
      );
    }
    assertPublicHttpsOrigin(config.personalAccountIssuer, "Personal Account issuer");
  }
  if (config.deploymentIdentity && !config.account) {
    if (config.workspace.shape.kind !== "personal" || config.exposure !== "loopback") {
      throw new Error(
        "An explicit Personal Deployment identity is allowed only for a loopback Personal Host",
      );
    }
  }
  const requiresLocalOwnerClaim =
    config.workspace.shape.kind === "personal" &&
    config.exposure === "loopback" &&
    config.account === undefined;
  if (requiresLocalOwnerClaim !== (config.identity.localOwnerClaimToken !== undefined)) {
    throw new Error(
      requiresLocalOwnerClaim
        ? "An unmanaged Personal Host requires an app-held local owner claim token"
        : "A local owner claim token is allowed only for an unmanaged loopback Personal Host",
    );
  }
  if (config.account && config.workspace.shape.kind !== "server") {
    throw new Error("An attached Opensteer Account requires a Server deployment");
  }
  if (config.account?.provisioningMode === "managed") {
    if (config.exposure !== "networked") {
      throw new Error("Managed Account provisioning requires a networked Deployment");
    }
    if (!config.account.owner) {
      throw new Error("Managed Account provisioning requires a verified owner profile");
    }
    if (config.identity.localPasswordEnabled) {
      throw new Error("Local password sign-in conflicts with managed Account provisioning");
    }
    if (config.identity.initialOwnerEnrollment) {
      throw new Error("An owner enrollment code conflicts with managed Account provisioning");
    }
  } else if (config.account?.owner) {
    throw new Error("An adoption bundle cannot designate a managed owner");
  }
}

export function parseHostConfig(environment: NodeJS.ProcessEnv): HostConfig {
  const parsed = HostEnvironmentSchema.parse(environment);
  const webDistributionValues = [
    parsed.OPENSTEER_WEB_DISTRIBUTION_DIRECTORY,
    parsed.OPENSTEER_WEB_DISTRIBUTION_MANIFEST,
    parsed.OPENSTEER_HOST_RELEASE_VERSION,
  ];
  const configuredWebDistributionValues = webDistributionValues.filter(
    (value) => value !== undefined,
  ).length;
  if (configuredWebDistributionValues !== 0 && configuredWebDistributionValues !== 3) {
    throw new Error(
      "OPENSTEER_WEB_DISTRIBUTION_DIRECTORY, OPENSTEER_WEB_DISTRIBUTION_MANIFEST, and OPENSTEER_HOST_RELEASE_VERSION must be configured together",
    );
  }
  if (
    parsed.OPENSTEER_MODE === "production" &&
    (!parsed.OPENSTEER_DEFAULT_WORKSPACE_BACKING || !parsed.OPENSTEER_DEPLOYMENT_KIND)
  ) {
    throw new Error(
      "Production requires OPENSTEER_DEFAULT_WORKSPACE_BACKING and OPENSTEER_DEPLOYMENT_KIND",
    );
  }
  const deploymentShape = DeploymentShapeSchema.parse({
    defaultWorkspaceBacking: parsed.OPENSTEER_DEFAULT_WORKSPACE_BACKING ?? "local-directory",
    kind: parsed.OPENSTEER_DEPLOYMENT_KIND ?? "server",
  });
  const accountBundle = readManagedAccountBundle(parsed);
  const account = accountConfig(accountBundle, parsed.OPENSTEER_MODE);
  const managedAccountProvisioning = account?.provisioningMode === "managed";
  if (
    managedAccountProvisioning &&
    environment.OPENSTEER_LOCAL_PASSWORD_ENABLED !== undefined &&
    parsed.OPENSTEER_LOCAL_PASSWORD_ENABLED
  ) {
    throw new Error(
      "OPENSTEER_LOCAL_PASSWORD_ENABLED=true conflicts with managed Account provisioning",
    );
  }
  // A bearer token minted by the Host's own OAuth server skips every origin
  // check, and on a Personal Deployment the canonical-origin fence is what
  // stands in for "the owner is at this keyboard". A Personal Host therefore
  // does not serve the surface at all, and saying otherwise is refused by
  // assertHostConfigInvariants rather than quietly ignored.
  const nativeOAuthEnabled =
    parsed.OPENSTEER_NATIVE_OAUTH_ENABLED ?? deploymentShape.kind === "server";
  const browserRuntime = { attachKeyId: parsed.OPENSTEER_BROWSER_ATTACH_KEY_ID };
  requireProductionKeyPair(parsed.OPENSTEER_MODE, parsed, deploymentShape.defaultWorkspaceBacking);
  requireSecureServiceUrl(
    parsed.OPENSTEER_MODE,
    parsed.OPENSTEER_CANONICAL_ORIGIN,
    "OPENSTEER_CANONICAL_ORIGIN",
    {
      allowLoopback:
        deploymentShape.kind === "personal" && isLoopbackBindAddress(parsed.OPENSTEER_BIND_ADDRESS),
    },
  );
  const canonicalOrigin = originUrl(
    parsed.OPENSTEER_CANONICAL_ORIGIN,
    "OPENSTEER_CANONICAL_ORIGIN",
  );
  if (accountBundle && accountBundle.deployment.canonicalOrigin !== canonicalOrigin.origin) {
    throw new Error("OPENSTEER_CANONICAL_ORIGIN must match the managed provisioning bundle");
  }
  const runtimeOrigin = originUrl(
    parsed.OPENSTEER_RUNTIME_ORIGIN ?? parsed.OPENSTEER_CANONICAL_ORIGIN,
    "OPENSTEER_RUNTIME_ORIGIN",
  );
  requireSecureServiceUrl(parsed.OPENSTEER_MODE, runtimeOrigin.origin, "OPENSTEER_RUNTIME_ORIGIN", {
    allowLoopback:
      deploymentShape.kind === "personal" && isLoopbackBindAddress(parsed.OPENSTEER_BIND_ADDRESS),
  });
  const exposure = deriveHostExposure({
    bindAddress: parsed.OPENSTEER_BIND_ADDRESS,
    canonicalOrigin,
  });
  // Navigation metadata, not trust material: any Deployment may name the apex
  // portal it belongs to, and a Deployment that names none is self-hosted and
  // simply renders no portal link.
  const portalOrigin = parsed.OPENSTEER_PORTAL_ORIGIN
    ? originUrl(parsed.OPENSTEER_PORTAL_ORIGIN, "OPENSTEER_PORTAL_ORIGIN")
    : undefined;
  const deploymentName = parsed.OPENSTEER_DEPLOYMENT_NAME;
  if (
    portalOrigin &&
    portalOrigin.protocol !== "https:" &&
    !isLoopbackHostname(portalOrigin.hostname)
  ) {
    throw new Error("OPENSTEER_PORTAL_ORIGIN must use HTTPS except for loopback development");
  }
  const workspaceStorage = workspaceStorageConfig(environment, parsed, deploymentShape);
  const explicitPersonalIdentityValues = [
    parsed.OPENSTEER_DEPLOYMENT_ID,
    parsed.OPENSTEER_HOST_INSTANCE_ID,
    parsed.OPENSTEER_HOST_KEY_FINGERPRINT,
  ];
  const configuredPersonalIdentityValues = explicitPersonalIdentityValues.filter(
    (value) => value !== undefined,
  ).length;
  if (configuredPersonalIdentityValues !== 0 && configuredPersonalIdentityValues !== 3) {
    throw new Error(
      "OPENSTEER_DEPLOYMENT_ID, OPENSTEER_HOST_INSTANCE_ID, and OPENSTEER_HOST_KEY_FINGERPRINT must be configured together",
    );
  }
  if (accountBundle && configuredPersonalIdentityValues !== 0) {
    throw new Error(
      "A managed provisioning bundle cannot be combined with an explicit Personal Deployment identity",
    );
  }
  const explicitPersonalIdentity =
    configuredPersonalIdentityValues === 3
      ? {
          deploymentId: parsed.OPENSTEER_DEPLOYMENT_ID!,
          hostInstanceId: parsed.OPENSTEER_HOST_INSTANCE_ID!,
          hostKeyFingerprint: parsed.OPENSTEER_HOST_KEY_FINGERPRINT!,
        }
      : undefined;
  if (account && parsed.OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN) {
    throw new Error(
      "OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN conflicts with an Opensteer Account provisioning bundle",
    );
  }
  const config: HostConfig = {
    account,
    // PortableFS only ever made sense with Runners attaching from outside, so
    // that stays the default for it. Every other Deployment declares it, and
    // declares nothing by staying inside its own network.
    acceptsExternalRunners:
      parsed.OPENSTEER_ACCEPTS_EXTERNAL_RUNNERS ??
      deploymentShape.defaultWorkspaceBacking === "portablefs",
    authSecret: parsed.OPENSTEER_AUTH_SECRET,
    bindAddress: parsed.OPENSTEER_BIND_ADDRESS,
    canonicalOrigin,
    browserRuntime,
    browserProfileKeyPath: parsed.OPENSTEER_BROWSER_PROFILE_KEY_PATH,
    databaseUrl: parsed.OPENSTEER_DATABASE_URL,
    credentialKeyPath: parsed.OPENSTEER_CREDENTIAL_KEY_PATH,
    dataDirectory: parsed.OPENSTEER_HOST_DATA_DIR,
    deploymentIdentity:
      explicitPersonalIdentity ??
      (accountBundle
        ? {
            deploymentId: accountBundle.deployment.deploymentId,
            hostKeyFingerprint: accountBundle.deployment.hostKeyFingerprint,
            hostInstanceId: accountBundle.deployment.hostInstanceId,
          }
        : undefined),
    identity: {
      initialOwnerEnrollment: parsed.OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN
        ? {
            lifetimeSeconds: Math.min(
              parsed.OPENSTEER_INITIAL_OWNER_ENROLLMENT_LIFETIME_SECONDS,
              7 * 24 * 60 * 60,
            ),
            token: parsed.OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN,
          }
        : undefined,
      localPasswordEnabled: managedAccountProvisioning
        ? false
        : parsed.OPENSTEER_LOCAL_PASSWORD_ENABLED,
      localOwnerClaimToken: parsed.OPENSTEER_LOCAL_OWNER_CLAIM_TOKEN,
      ...(nativeOAuthEnabled ? { nativeOAuth: { clients: opensteerHostNativeOAuthClients } } : {}),
      oidcConfigPath: parsed.OPENSTEER_OIDC_CONFIG_PATH,
      signupPolicy: parsed.OPENSTEER_SIGNUP_POLICY,
    },
    initialBrowserRunnerEnrollmentToken: parsed.OPENSTEER_INITIAL_BROWSER_RUNNER_ENROLLMENT_TOKEN,
    initialMessagingRunnerEnrollmentToken:
      parsed.OPENSTEER_INITIAL_MESSAGING_RUNNER_ENROLLMENT_TOKEN,
    executionLeaseMs: parsed.OPENSTEER_EXECUTION_LEASE_SECONDS * 1_000,
    maxConcurrentDispatches: parsed.OPENSTEER_MAX_CONCURRENT_DISPATCHES,
    maxConcurrentTriggerDispatches: parsed.OPENSTEER_MAX_CONCURRENT_TRIGGER_DISPATCHES,
    mode: parsed.OPENSTEER_MODE,
    port: parsed.OPENSTEER_PORT,
    ...(deploymentName ? { deploymentName } : {}),
    ...(parsed.OPENSTEER_PERSONAL_ACCOUNT_ISSUER
      ? { personalAccountIssuer: new URL(parsed.OPENSTEER_PERSONAL_ACCOUNT_ISSUER) }
      : {}),
    ...(portalOrigin ? { portalOrigin } : {}),
    exposure,
    privateKeyPath: parsed.OPENSTEER_HOST_PRIVATE_KEY_PATH,
    publicKeyPath: parsed.OPENSTEER_HOST_PUBLIC_KEY_PATH,
    runtimeOrigin,
    workspace: {
      deletionRetentionDays: parsed.OPENSTEER_WORKSPACE_DELETION_RETENTION_DAYS,
      shape: deploymentShape,
      storage: workspaceStorage,
    },
    ...(configuredWebDistributionValues === 3
      ? {
          webDistribution: {
            directory: parsed.OPENSTEER_WEB_DISTRIBUTION_DIRECTORY!,
            expectedHostVersion: parsed.OPENSTEER_HOST_RELEASE_VERSION!,
            manifestPath: parsed.OPENSTEER_WEB_DISTRIBUTION_MANIFEST!,
          },
        }
      : {}),
  };
  assertHostConfigInvariants(config);
  return config;
}

function accountConfig(
  bundle: z.infer<typeof ManagedHostProvisioningBundleSchema> | undefined,
  mode: RuntimeMode,
): HostConfig["account"] {
  if (!bundle) return undefined;
  const controlApiOrigin = new URL(bundle.controlApiOrigin);
  const issuer = new URL(bundle.oidc.issuer);
  requireSecureServiceUrl(mode, controlApiOrigin.toString(), "Opensteer Account control API");
  requireSecureServiceUrl(mode, issuer.toString(), "Opensteer Account issuer");
  return {
    provisioningMode: bundle.provisioningMode,
    controlApiOrigin,
    hostCredential: bundle.hostCredential,
    initialRunnerEnrollmentToken:
      bundle.provisioningMode === "managed" ? bundle.initialRunnerEnrollmentToken : undefined,
    reachability: bundle.deployment.reachability,
    issuer,
    oidcClientId: bundle.oidc.clientId,
    oidcClientSecret: bundle.oidcClientSecret,
    owner: bundle.provisioningMode === "managed" ? bundle.owner : undefined,
  };
}

const maximumManagedAccountBundleBytes = 64 * 1_024;

function readManagedAccountBundle(parsed: {
  readonly OPENSTEER_ACCOUNT_BUNDLE_FD?: number | undefined;
  readonly OPENSTEER_ACCOUNT_BUNDLE_PATH?: string | undefined;
}): z.infer<typeof ManagedHostProvisioningBundleSchema> | undefined {
  const descriptor = parsed.OPENSTEER_ACCOUNT_BUNDLE_FD;
  const path = parsed.OPENSTEER_ACCOUNT_BUNDLE_PATH;
  if (descriptor !== undefined && path !== undefined) {
    throw new Error(
      "Configure exactly one of OPENSTEER_ACCOUNT_BUNDLE_FD or OPENSTEER_ACCOUNT_BUNDLE_PATH",
    );
  }
  if (descriptor === undefined && path === undefined) return undefined;

  let handle = descriptor;
  try {
    if (path !== undefined) {
      const before = lstatSync(path);
      if (!before.isFile() || before.isSymbolicLink()) {
        throw new Error("Opensteer Account bundle must be a regular file");
      }
      if (process.platform !== "win32" && (before.mode & 0o077) !== 0) {
        throw new Error("Opensteer Account bundle must not be readable by group or other users");
      }
      handle = openSync(path, fsConstants.O_RDONLY | noFollowFlag() | fsConstants.O_NONBLOCK);
      const after = fstatSync(handle);
      if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino) {
        throw new Error("Opensteer Account bundle changed while it was opened");
      }
      if (process.platform !== "win32" && (after.mode & 0o077) !== 0) {
        throw new Error("Opensteer Account bundle must not be readable by group or other users");
      }
    }
    if (handle === undefined) throw new Error("Opensteer Account bundle is unavailable");
    const serialized = readBoundedDescriptor(handle, maximumManagedAccountBundleBytes);
    return ManagedHostProvisioningBundleSchema.parse(JSON.parse(serialized));
  } catch (error) {
    throw new Error("Unable to load the Opensteer Account provisioning bundle", { cause: error });
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

function readBoundedDescriptor(descriptor: number, maximumBytes: number): string {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maximumBytes) {
    const chunk = Buffer.allocUnsafe(Math.min(8_192, maximumBytes + 1 - total));
    const bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  if (total === 0 || total > maximumBytes) {
    throw new Error("Opensteer Account provisioning bundle has an invalid size");
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function originUrl(value: string, name: string): URL {
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be an uncredentialed HTTP(S) origin.`);
  }
  return url;
}

function requireSecureServiceUrl(
  mode: RuntimeMode,
  value: string,
  name: string,
  options: { readonly allowLoopback?: boolean } = {},
): void {
  const url = new URL(value);
  const allowedLoopbackHttp =
    options.allowLoopback === true && url.protocol === "http:" && isLoopbackHostname(url.hostname);
  if (mode === "production" && url.protocol !== "https:" && !allowedLoopbackHttp) {
    throw new Error(`${name} must use HTTPS in production`);
  }
}

function assertPublicHttpsOrigin(value: URL, name: string): void {
  if (
    value.protocol !== "https:" ||
    value.username ||
    value.password ||
    value.pathname !== "/" ||
    value.search ||
    value.hash ||
    isLoopbackHostname(value.hostname)
  ) {
    throw new Error(`${name} must be a bare public HTTPS origin`);
  }
}

function requireProductionKeyPair(
  mode: RuntimeMode,
  values: {
    readonly OPENSTEER_CREDENTIAL_KEY_PATH?: string | undefined;
    readonly OPENSTEER_BROWSER_PROFILE_KEY_PATH?: string | undefined;
    readonly OPENSTEER_HOST_PRIVATE_KEY_PATH?: string | undefined;
    readonly OPENSTEER_HOST_PUBLIC_KEY_PATH?: string | undefined;
    readonly OPENSTEER_PORTABLEFS_PRODUCT_PRIVATE_KEY_PATH?: string | undefined;
  },
  backing: DeploymentShape["defaultWorkspaceBacking"],
): void {
  if (
    mode === "production" &&
    (!values.OPENSTEER_HOST_PRIVATE_KEY_PATH || !values.OPENSTEER_HOST_PUBLIC_KEY_PATH)
  ) {
    throw new Error(
      "Production requires OPENSTEER_HOST_PRIVATE_KEY_PATH and OPENSTEER_HOST_PUBLIC_KEY_PATH",
    );
  }
  if (mode === "production" && !values.OPENSTEER_CREDENTIAL_KEY_PATH) {
    throw new Error("Production requires OPENSTEER_CREDENTIAL_KEY_PATH");
  }
  if (mode === "production" && !values.OPENSTEER_BROWSER_PROFILE_KEY_PATH) {
    throw new Error("Production requires OPENSTEER_BROWSER_PROFILE_KEY_PATH");
  }
  if (
    mode === "production" &&
    backing === "portablefs" &&
    !values.OPENSTEER_PORTABLEFS_PRODUCT_PRIVATE_KEY_PATH
  ) {
    throw new Error("Production requires OPENSTEER_PORTABLEFS_PRODUCT_PRIVATE_KEY_PATH");
  }
}

function requirePortableFsManagerIdentity(values: {
  readonly OPENSTEER_PORTABLEFS_MANAGER_CA_PATH?: string | undefined;
  readonly OPENSTEER_PORTABLEFS_MANAGER_CERT_PATH?: string | undefined;
  readonly OPENSTEER_PORTABLEFS_MANAGER_KEY_PATH?: string | undefined;
  readonly OPENSTEER_PORTABLEFS_MANAGER_URL: string | URL;
}): void {
  const paths = [
    values.OPENSTEER_PORTABLEFS_MANAGER_CA_PATH,
    values.OPENSTEER_PORTABLEFS_MANAGER_CERT_PATH,
    values.OPENSTEER_PORTABLEFS_MANAGER_KEY_PATH,
  ];
  const configured = paths.filter(Boolean).length;
  if (configured !== 0 && configured !== paths.length) {
    throw new Error(
      "OPENSTEER_PORTABLEFS_MANAGER_CA_PATH, OPENSTEER_PORTABLEFS_MANAGER_CERT_PATH, and OPENSTEER_PORTABLEFS_MANAGER_KEY_PATH must be configured together",
    );
  }
  const managerUrl = new URL(values.OPENSTEER_PORTABLEFS_MANAGER_URL);
  const protocol = managerUrl.protocol;
  if (protocol === "https:" && configured !== paths.length) {
    throw new Error("PortableFS manager HTTPS requires the product mTLS identity paths");
  }
  if (protocol !== "https:" && protocol !== "http:") {
    throw new Error("OPENSTEER_PORTABLEFS_MANAGER_URL must use HTTP or HTTPS");
  }
  if (
    managerUrl.username ||
    managerUrl.password ||
    managerUrl.search ||
    managerUrl.hash ||
    (managerUrl.pathname !== "" && managerUrl.pathname !== "/")
  ) {
    throw new Error(
      "OPENSTEER_PORTABLEFS_MANAGER_URL must be an origin-only URL for mount-owned renewal",
    );
  }
}

function workspaceStorageConfig(
  environment: NodeJS.ProcessEnv,
  parsed: z.infer<typeof HostEnvironmentSchema>,
  shape: DeploymentShape,
): HostConfig["workspace"]["storage"] {
  if (shape.defaultWorkspaceBacking === "local-directory") {
    const portableFsVariables = [
      "OPENSTEER_FILES_SERVICE_URL",
      "OPENSTEER_PORTABLEFS_AUTHORIZATION_DOMAIN",
      "OPENSTEER_PORTABLEFS_MANAGER_CA_PATH",
      "OPENSTEER_PORTABLEFS_MANAGER_CERT_PATH",
      "OPENSTEER_PORTABLEFS_MANAGER_KEY_PATH",
      "OPENSTEER_PORTABLEFS_MANAGER_SERVER_NAME",
      "OPENSTEER_PORTABLEFS_MANAGER_URL",
      "OPENSTEER_PORTABLEFS_PRODUCT_ISSUER",
      "OPENSTEER_PORTABLEFS_PRODUCT_PRIVATE_KEY_PATH",
      "OPENSTEER_PORTABLEFS_SERVICE_ID",
      "OPENSTEER_WORKSPACE_ARCHIVE_AFTER_DAYS",
      "OPENSTEER_WORKSPACE_DEFAULT_BLOCK_LIMIT_BYTES",
      "OPENSTEER_WORKSPACE_DEFAULT_INODE_LIMIT",
      "OPENSTEER_WORKSPACE_MAX_BLOCK_LIMIT_BYTES",
      "OPENSTEER_WORKSPACE_MAX_INODE_LIMIT",
    ] as const;
    const configuredPortableFsVariable = portableFsVariables.find((name) =>
      isConfigured(environment[name]),
    );
    if (configuredPortableFsVariable) {
      throw new Error(
        `A local-directory backing must not configure PortableFS variable ${configuredPortableFsVariable}`,
      );
    }
    const ownerEnvironmentId =
      parsed.OPENSTEER_LOCAL_WORKSPACE_ENVIRONMENT_ID ??
      (parsed.OPENSTEER_MODE === "production"
        ? undefined
        : EnvironmentIdSchema.parse("env_00000000-0000-4000-8000-000000000001"));
    if (!ownerEnvironmentId) {
      throw new Error(
        "A local-directory default requires OPENSTEER_LOCAL_WORKSPACE_ENVIRONMENT_ID to name the machine that holds new Workspaces",
      );
    }
    return { kind: "local-directory", ownerEnvironmentId };
  }

  if (isConfigured(environment.OPENSTEER_LOCAL_WORKSPACE_ENVIRONMENT_ID)) {
    throw new Error(
      "A PortableFS default must not configure local Workspace variable OPENSTEER_LOCAL_WORKSPACE_ENVIRONMENT_ID",
    );
  }
  const serviceId = parsed.OPENSTEER_PORTABLEFS_SERVICE_ID;
  const managerUrl = parsed.OPENSTEER_PORTABLEFS_MANAGER_URL;
  if (!serviceId || !managerUrl) {
    throw new Error(
      "A PortableFS backing requires OPENSTEER_PORTABLEFS_SERVICE_ID and OPENSTEER_PORTABLEFS_MANAGER_URL",
    );
  }
  if (parsed.OPENSTEER_MODE === "production" && !parsed.OPENSTEER_FILES_SERVICE_URL) {
    throw new Error("A production PortableFS backing requires OPENSTEER_FILES_SERVICE_URL");
  }
  requireSecureServiceUrl(
    parsed.OPENSTEER_MODE,
    managerUrl.toString(),
    "OPENSTEER_PORTABLEFS_MANAGER_URL",
  );
  requirePortableFsManagerIdentity({
    OPENSTEER_PORTABLEFS_MANAGER_CA_PATH: parsed.OPENSTEER_PORTABLEFS_MANAGER_CA_PATH,
    OPENSTEER_PORTABLEFS_MANAGER_CERT_PATH: parsed.OPENSTEER_PORTABLEFS_MANAGER_CERT_PATH,
    OPENSTEER_PORTABLEFS_MANAGER_KEY_PATH: parsed.OPENSTEER_PORTABLEFS_MANAGER_KEY_PATH,
    OPENSTEER_PORTABLEFS_MANAGER_URL: managerUrl,
  });
  if (parsed.OPENSTEER_WORKSPACE_DEFAULT_BLOCK_LIMIT_BYTES % 1_024 !== 0) {
    throw new Error("OPENSTEER_WORKSPACE_DEFAULT_BLOCK_LIMIT_BYTES must be a multiple of 1024");
  }
  if (parsed.OPENSTEER_WORKSPACE_MAX_BLOCK_LIMIT_BYTES % 1_024 !== 0) {
    throw new Error("OPENSTEER_WORKSPACE_MAX_BLOCK_LIMIT_BYTES must be a multiple of 1024");
  }
  if (
    parsed.OPENSTEER_WORKSPACE_DEFAULT_BLOCK_LIMIT_BYTES >
      parsed.OPENSTEER_WORKSPACE_MAX_BLOCK_LIMIT_BYTES ||
    parsed.OPENSTEER_WORKSPACE_DEFAULT_INODE_LIMIT > parsed.OPENSTEER_WORKSPACE_MAX_INODE_LIMIT
  ) {
    throw new Error("Default Workspace quotas must not exceed the configured quota ceilings");
  }
  const filesServiceUrl = originUrl(
    parsed.OPENSTEER_FILES_SERVICE_URL ?? "http://127.0.0.1:4315",
    "OPENSTEER_FILES_SERVICE_URL",
  );
  return {
    archiveAfterDays: parsed.OPENSTEER_WORKSPACE_ARCHIVE_AFTER_DAYS,
    authorizationDomain: parsed.OPENSTEER_PORTABLEFS_AUTHORIZATION_DOMAIN,
    defaultBlockLimitBytes: parsed.OPENSTEER_WORKSPACE_DEFAULT_BLOCK_LIMIT_BYTES,
    defaultInodeLimit: parsed.OPENSTEER_WORKSPACE_DEFAULT_INODE_LIMIT,
    filesServiceUrl,
    kind: "portablefs",
    maxBlockLimitBytes: parsed.OPENSTEER_WORKSPACE_MAX_BLOCK_LIMIT_BYTES,
    maxInodeLimit: parsed.OPENSTEER_WORKSPACE_MAX_INODE_LIMIT,
    managerCaPath: parsed.OPENSTEER_PORTABLEFS_MANAGER_CA_PATH,
    managerCertPath: parsed.OPENSTEER_PORTABLEFS_MANAGER_CERT_PATH,
    managerKeyPath: parsed.OPENSTEER_PORTABLEFS_MANAGER_KEY_PATH,
    managerServerName: parsed.OPENSTEER_PORTABLEFS_MANAGER_SERVER_NAME,
    managerUrl: new URL(managerUrl),
    productIssuer: parsed.OPENSTEER_PORTABLEFS_PRODUCT_ISSUER,
    productPrivateKeyPath: parsed.OPENSTEER_PORTABLEFS_PRODUCT_PRIVATE_KEY_PATH,
    serviceId,
  };
}

function isConfigured(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

export const defaultRunnerMaxConcurrentTriggerPrograms = 4;

const RunnerEnvironmentSchema = z.object({
  OPENSTEER_DEPLOYMENT_KIND: DeploymentKindSchema.optional(),
  [hostEnvironmentKeys.defaultWorkspaceBacking]: WorkspaceBackingKindSchema.optional(),
  OPENSTEER_ENVIRONMENT_ID: EnvironmentIdSchema.optional(),
  OPENSTEER_HOST_URL: z.url(),
  OPENSTEER_MAX_CONCURRENT_RUNS: positiveInteger(4),
  OPENSTEER_MAX_CONCURRENT_TRIGGER_PROGRAMS: positiveInteger(
    defaultRunnerMaxConcurrentTriggerPrograms,
  ),
  OPENSTEER_MODE: RuntimeModeSchema.default("development"),
  OPENSTEER_NODE_EXECUTABLE: optionalPath.refine(
    (value) => value === undefined || isAbsolute(value),
    "OPENSTEER_NODE_EXECUTABLE must be an absolute path",
  ),
  OPENSTEER_PORTABLEFS_MOUNT_BINARY: optionalPath,
  OPENSTEER_RUNNER_WORKSPACE_BACKINGS: z.string().trim().min(1).default("local-directory"),
  OPENSTEER_RUNNER_WORKSPACE_ROOT: optionalPath,
  OPENSTEER_LOCAL_WORKSPACE_REGISTRY_PATH: optionalPath,
  OPENSTEER_LOCAL_WORKSPACE_ROOT: optionalPath,
  OPENSTEER_BROWSER_BRIDGE_TOKEN: z.string().min(32).max(4_096).optional(),
  OPENSTEER_BROWSER_BRIDGE_URL: z.url().optional(),
  OPENSTEER_BROWSER_RUNTIME_ID: z.string().trim().min(1).max(255).optional(),
  OPENSTEER_BROWSER_SIGN_IN: z.literal("1").optional(),
  // The same bounds as `ComputerUseBridgeTokenSchema` in `@opensteer/protocol`,
  // written out because this package parses environments for every runtime and
  // does not depend on the wire schemas.
  OPENSTEER_COMPUTER_USE_BRIDGE_TOKEN: z.string().min(32).max(4_096).optional(),
  OPENSTEER_COMPUTER_USE_BRIDGE_URL: z.url().optional(),
  OPENSTEER_RUNNER_CONTROL_CA_PATH: optionalPath,
  OPENSTEER_RUNNER_DATA_DIR: z.string().min(1).default(".opensteer/runner"),
  OPENSTEER_RUNNER_ENROLLMENT_TOKEN: z.string().min(32).max(4_096).optional(),
  OPENSTEER_RUNNER_ENROLLMENT_TOKEN_FD: z.preprocess(
    (value) => (value === undefined || value === "" ? undefined : Number(value)),
    z.number().int().min(3).max(1_024).optional(),
  ),
  OPENSTEER_RUNNER_ID: RunnerIdSchema.optional(),
  OPENSTEER_RUNNER_KIND: z.enum(["main", "local", "managed"]).default("main"),
  // Preparation drops a requested module the platform cannot actually serve.
  OPENSTEER_RUNNER_MODULES: z.string().trim().min(1).default("agents,browser,integrations,shell"),
  OPENSTEER_RUNNER_NAME: z.string().trim().min(1).max(120).default("Main runner"),
});

const RunnerProcessModuleSchema = z.enum([
  "agents",
  "browser",
  "integrations",
  "messaging",
  "shell",
]);
/**
 * A module this Runner process can run. `messaging` here carries only the
 * transports this computer alone can hold; a Deployment's messaging service
 * is its own program.
 */
export type RunnerProcessModule = z.infer<typeof RunnerProcessModuleSchema>;

export interface RunnerConfig {
  /**
   * Present when this computer also relays a browser. The relay lives in the
   * Runner process and reaches the browser over an uncredentialed loopback
   * origin, so the Runner key never has to be copied into the browser runtime.
   */
  readonly browserBridge:
    | {
        readonly bridgeToken: string;
        readonly runtimeId: string;
        /** The browser runs saved-password sign-ins with Opensteer Passwords on this Mac. */
        readonly signIn: boolean;
        readonly url: URL;
      }
    | undefined;
  /**
   * Present when the Opensteer desktop app supervises this Runner and offers
   * it computer use on the Mac they share. It is Darwin-only in meaning — no
   * other platform has the helper behind it — but it is parsed everywhere, so
   * a slot started with the pair on another platform is refused here rather
   * than ignored until something asks for a Mac.
   */
  readonly computerUseBridge?: { readonly token: string; readonly url: URL } | undefined;
  readonly controlCaPath: string | undefined;
  readonly dataDirectory: string;
  readonly deploymentShape: DeploymentShape;
  readonly enrollmentToken: string | undefined;
  readonly environmentId: EnvironmentId | undefined;
  readonly hostUrl: URL;
  readonly maxConcurrentRuns: number;
  readonly maxConcurrentTriggerPrograms: number;
  readonly mode: RuntimeMode;
  /**
   * What this process runs, in `agents, browser, integrations, shell` order.
   * Without `agents` the Runner is reach-only: it holds no Workspace storage
   * and starts nothing that executes work (`docs/computers.md` §2).
   */
  readonly modules: readonly RunnerProcessModule[];
  readonly mountBinary: string | undefined;
  readonly name: string;
  readonly nodeExecutable: string;
  /** Set when PortableFS was requested but cannot run here, so the Runner can
   * say why it connected with local-directory only. */
  readonly portableFsUnavailableReason?: string;
  readonly runnerId: RunnerId | undefined;
  readonly runnerKind: "main" | "local" | "managed";
  readonly workspaceBackings: readonly ("local-directory" | "portablefs")[];
  readonly workspaceNamespace: "single-owner" | "owner-scoped";
  readonly workspaceRoot: string | undefined;
  readonly localWorkspaceRegistryPath: string | undefined;
  readonly localWorkspaceRoot: string | undefined;
}

/**
 * Checks the deployment, storage, and transport contract before a Runner opens
 * any files or starts its reconnect loop. Production control traffic needs TLS
 * whenever it crosses a network boundary; loopback never leaves the machine.
 */
function assertRunnerConfigInvariants(config: RunnerConfig): void {
  const hostUrl = config.hostUrl;
  if (
    (hostUrl.protocol !== "http:" && hostUrl.protocol !== "https:") ||
    hostUrl.username ||
    hostUrl.password ||
    hostUrl.pathname !== "/" ||
    hostUrl.search ||
    hostUrl.hash
  ) {
    throw new Error("OPENSTEER_HOST_URL must be an uncredentialed HTTP(S) origin");
  }
  // A Runner advertises what it can reach, and the Deployment's default says
  // only what a Workspace gets when nobody chooses. A machine that holds only
  // its own directories is a useful machine on a PortableFS Deployment.
  //
  // The Main Runner is the one that shares a computer with its Personal Host,
  // so only it must reach that Host over loopback. Every other computer on a
  // Personal Deployment is reachable-only and connects to the signed access
  // route, which is an HTTPS origin (`docs/computers.md` §1, invariant 3).
  if (
    config.deploymentShape.kind === "personal" &&
    config.runnerKind === "main" &&
    !isLoopbackHostname(hostUrl.hostname)
  ) {
    throw new Error("A Personal Runner requires a loopback OPENSTEER_HOST_URL");
  }
  if (hostUrl.protocol !== "https:" && !allowsPlaintextRunnerTransport(config.mode, hostUrl)) {
    throw new Error("OPENSTEER_HOST_URL must use HTTPS in production");
  }
}

/**
 * The Runner's credentials, which a supervisor hands it off its environment
 * (see `@opensteer/shared/processSecrets`). They keep their variable names, so
 * one set of rules — a bridge's URL and token together, the token's bounds —
 * applies however they arrived.
 */
export const RunnerSecretsSchema = z.strictObject({
  OPENSTEER_BROWSER_BRIDGE_TOKEN: z.string().min(32).max(4_096).optional(),
  OPENSTEER_COMPUTER_USE_BRIDGE_TOKEN: z.string().min(32).max(4_096).optional(),
  OPENSTEER_RUNNER_ENROLLMENT_TOKEN: z.string().min(32).max(4_096).optional(),
});
export type RunnerSecrets = z.infer<typeof RunnerSecretsSchema>;
export const runnerSecretNames = RunnerSecretsSchema.keyof().options;

/**
 * The Runner's configuration from its environment and the secrets delivered
 * beside it. A delivered secret takes the place of the same variable in the
 * environment; a name the Runner does not take as a secret is refused.
 */
export function parseRunnerConfig(
  environment: NodeJS.ProcessEnv,
  secrets: Readonly<Record<string, string>> = {},
): RunnerConfig {
  const parsed = RunnerEnvironmentSchema.parse({
    ...environment,
    ...RunnerSecretsSchema.parse(secrets),
  });
  if (
    parsed.OPENSTEER_MODE === "production" &&
    (!parsed.OPENSTEER_DEFAULT_WORKSPACE_BACKING || !parsed.OPENSTEER_DEPLOYMENT_KIND)
  ) {
    throw new Error(
      "Production requires OPENSTEER_DEFAULT_WORKSPACE_BACKING and OPENSTEER_DEPLOYMENT_KIND",
    );
  }
  const deploymentShape = DeploymentShapeSchema.parse({
    defaultWorkspaceBacking: parsed.OPENSTEER_DEFAULT_WORKSPACE_BACKING ?? "local-directory",
    kind: parsed.OPENSTEER_DEPLOYMENT_KIND ?? "server",
  });
  const modules = parseRunnerModules(parsed.OPENSTEER_RUNNER_MODULES);
  const enrollmentToken =
    readEnrollmentTokenFromDescriptor(parsed.OPENSTEER_RUNNER_ENROLLMENT_TOKEN_FD) ??
    parsed.OPENSTEER_RUNNER_ENROLLMENT_TOKEN;
  const config: RunnerConfig = {
    // The module list is what this process runs, so a bridge nothing relays is
    // simply not this Runner's browser: a reach-only computer started from the
    // same environment as an agent one must not open it.
    browserBridge: modules.includes("browser") ? runnerBrowserBridge(parsed) : undefined,
    computerUseBridge: runnerComputerUseBridge(parsed),
    controlCaPath: parsed.OPENSTEER_RUNNER_CONTROL_CA_PATH,
    dataDirectory: parsed.OPENSTEER_RUNNER_DATA_DIR,
    deploymentShape,
    enrollmentToken,
    environmentId: parsed.OPENSTEER_ENVIRONMENT_ID,
    hostUrl: new URL(parsed.OPENSTEER_HOST_URL),
    maxConcurrentRuns: parsed.OPENSTEER_MAX_CONCURRENT_RUNS,
    maxConcurrentTriggerPrograms: parsed.OPENSTEER_MAX_CONCURRENT_TRIGGER_PROGRAMS,
    mode: parsed.OPENSTEER_MODE,
    modules,
    name: parsed.OPENSTEER_RUNNER_NAME,
    nodeExecutable: resolveRunnerNodeExecutable(parsed.OPENSTEER_NODE_EXECUTABLE),
    runnerId: parsed.OPENSTEER_RUNNER_ID,
    runnerKind: parsed.OPENSTEER_RUNNER_KIND,
    workspaceNamespace: localWorkspaceNamespace(deploymentShape),
    // A reach-only Runner holds no Workspaces at all. Its storage settings are
    // not merely unused: leaving them out is what lets the desktop restart the
    // same computer with only auxiliary modules from the environment it already builds.
    ...(modules.includes("agents")
      ? runnerWorkspaceStorage(parsed)
      : {
          localWorkspaceRegistryPath: undefined,
          localWorkspaceRoot: undefined,
          mountBinary: undefined,
          workspaceBackings: [],
          workspaceRoot: undefined,
        }),
  };
  assertRunnerConfigInvariants(config);
  return config;
}

/**
 * The Workspace storage a computer that runs agents offers. Every rule here is
 * about bytes on that machine's disk, which is why none of it is parsed for a
 * reach-only Runner.
 */
function runnerWorkspaceStorage(
  parsed: z.infer<typeof RunnerEnvironmentSchema>,
): Pick<
  RunnerConfig,
  | "localWorkspaceRegistryPath"
  | "localWorkspaceRoot"
  | "mountBinary"
  | "portableFsUnavailableReason"
  | "workspaceBackings"
  | "workspaceRoot"
> {
  const requestedBackings = parseRunnerWorkspaceBackings(
    parsed.OPENSTEER_RUNNER_WORKSPACE_BACKINGS,
  );
  const supportsLocal = requestedBackings.includes("local-directory");
  // A machine that can hold its own directories stays useful without PortableFS.
  // Dropping the unusable capability here is what lets somebody lend a computer
  // with no FUSE or FSKit installed, instead of failing to start.
  const portableFsUnavailableReason =
    requestedBackings.includes("portablefs") &&
    supportsLocal &&
    !parsed.OPENSTEER_PORTABLEFS_MOUNT_BINARY
      ? "No PortableFS mount binary is installed, so this machine offers only its own directories."
      : undefined;
  const workspaceBackings = portableFsUnavailableReason
    ? requestedBackings.filter((backing) => backing !== "portablefs")
    : requestedBackings;
  const supportsPortableFs = workspaceBackings.includes("portablefs");
  if (
    supportsLocal &&
    (!parsed.OPENSTEER_LOCAL_WORKSPACE_ROOT || !parsed.OPENSTEER_LOCAL_WORKSPACE_REGISTRY_PATH)
  ) {
    throw new Error(
      "A local-directory Runner requires OPENSTEER_LOCAL_WORKSPACE_ROOT and OPENSTEER_LOCAL_WORKSPACE_REGISTRY_PATH",
    );
  }
  if (
    !supportsLocal &&
    (parsed.OPENSTEER_LOCAL_WORKSPACE_ROOT || parsed.OPENSTEER_LOCAL_WORKSPACE_REGISTRY_PATH)
  ) {
    throw new Error(
      "A Runner without local-directory support must not configure local Workspace paths",
    );
  }
  if (supportsPortableFs && !parsed.OPENSTEER_PORTABLEFS_MOUNT_BINARY) {
    throw new Error("A PortableFS Runner requires OPENSTEER_PORTABLEFS_MOUNT_BINARY");
  }
  if (
    !supportsPortableFs &&
    !portableFsUnavailableReason &&
    parsed.OPENSTEER_PORTABLEFS_MOUNT_BINARY
  ) {
    throw new Error(
      "A Runner without PortableFS support must not configure a PortableFS mount binary",
    );
  }
  if (
    !supportsPortableFs &&
    !portableFsUnavailableReason &&
    parsed.OPENSTEER_RUNNER_WORKSPACE_ROOT
  ) {
    throw new Error(
      "A Runner without PortableFS support must not configure OPENSTEER_RUNNER_WORKSPACE_ROOT",
    );
  }
  const workspaceRoot = supportsPortableFs
    ? (parsed.OPENSTEER_RUNNER_WORKSPACE_ROOT ??
      (parsed.OPENSTEER_RUNNER_KIND === "managed"
        ? "/workspaces"
        : resolve(parsed.OPENSTEER_RUNNER_DATA_DIR, "workspaces")))
    : undefined;
  if (workspaceRoot !== undefined && !isAbsolute(workspaceRoot)) {
    throw new Error("OPENSTEER_RUNNER_WORKSPACE_ROOT must be an absolute path");
  }
  return {
    localWorkspaceRegistryPath: parsed.OPENSTEER_LOCAL_WORKSPACE_REGISTRY_PATH,
    localWorkspaceRoot: parsed.OPENSTEER_LOCAL_WORKSPACE_ROOT,
    mountBinary: parsed.OPENSTEER_PORTABLEFS_MOUNT_BINARY,
    ...(portableFsUnavailableReason ? { portableFsUnavailableReason } : {}),
    workspaceBackings,
    workspaceRoot,
  };
}

/**
 * What this Runner process runs. `browser` names a relay that reaches the Host
 * through this Runner's own identity and serves the agents on this computer, so
 * a browser without agents is a machine nobody can use.
 */
function parseRunnerModules(value: string): readonly RunnerProcessModule[] {
  const values = value.split(",").map((entry) => entry.trim());
  const selection = RunnerProcessModuleSchema.options.filter((module) => values.includes(module));
  if (values.length !== selection.length || new Set(values).size !== values.length) {
    throw new Error(
      "OPENSTEER_RUNNER_MODULES must be a unique comma-separated list of agents, browser, integrations, messaging and shell",
    );
  }
  if (selection.includes("browser") && !selection.includes("agents")) {
    throw new Error("browser relay belongs to a computer that runs agents");
  }
  // A Mac's own transports reach its Messages through the helper the
  // integrations module's bridge connects to.
  if (selection.includes("messaging") && !selection.includes("integrations")) {
    throw new Error(
      "OPENSTEER_RUNNER_MODULES: messaging on a computer comes with its integrations module",
    );
  }
  return selection;
}

/**
 * The browser this Runner relays, if any. All three settings travel together:
 * a bridge with no token would be an open door on loopback, and a token with
 * no target is a credential for nothing.
 */
function runnerBrowserBridge(parsed: {
  readonly OPENSTEER_BROWSER_BRIDGE_TOKEN?: string | undefined;
  readonly OPENSTEER_BROWSER_BRIDGE_URL?: string | undefined;
  readonly OPENSTEER_BROWSER_RUNTIME_ID?: string | undefined;
  readonly OPENSTEER_BROWSER_SIGN_IN?: "1" | undefined;
}): RunnerConfig["browserBridge"] {
  const configured = [
    parsed.OPENSTEER_BROWSER_BRIDGE_TOKEN,
    parsed.OPENSTEER_BROWSER_BRIDGE_URL,
    parsed.OPENSTEER_BROWSER_RUNTIME_ID,
  ].filter((value) => value !== undefined);
  if (configured.length === 0) {
    if (parsed.OPENSTEER_BROWSER_SIGN_IN !== undefined) {
      throw new Error("OPENSTEER_BROWSER_SIGN_IN needs the Runner's browser bridge settings");
    }
    return undefined;
  }
  if (
    configured.length !== 3 ||
    !parsed.OPENSTEER_BROWSER_BRIDGE_TOKEN ||
    !parsed.OPENSTEER_BROWSER_BRIDGE_URL ||
    !parsed.OPENSTEER_BROWSER_RUNTIME_ID
  ) {
    throw new Error(
      "A Runner browser module needs OPENSTEER_BROWSER_BRIDGE_URL, OPENSTEER_BROWSER_BRIDGE_TOKEN and OPENSTEER_BROWSER_RUNTIME_ID together",
    );
  }
  return {
    bridgeToken: parsed.OPENSTEER_BROWSER_BRIDGE_TOKEN,
    runtimeId: parsed.OPENSTEER_BROWSER_RUNTIME_ID,
    signIn: parsed.OPENSTEER_BROWSER_SIGN_IN === "1",
    url: new URL(parsed.OPENSTEER_BROWSER_BRIDGE_URL),
  };
}

/**
 * The desktop bridge this Runner reaches computer use through, if any.
 *
 * Both settings travel together for the browser bridge's reason: a target with
 * no token is an open door on loopback, and a token with no target is a
 * credential for nothing. The target must stay on this computer — the helper
 * holding the macOS grants is on it, and a bridge naming anywhere else would
 * be a Mac nobody approved — so the hostname is checked here rather than at
 * the socket.
 */
function runnerComputerUseBridge(parsed: {
  readonly OPENSTEER_COMPUTER_USE_BRIDGE_TOKEN?: string | undefined;
  readonly OPENSTEER_COMPUTER_USE_BRIDGE_URL?: string | undefined;
}): RunnerConfig["computerUseBridge"] {
  const token = parsed.OPENSTEER_COMPUTER_USE_BRIDGE_TOKEN;
  const configured = parsed.OPENSTEER_COMPUTER_USE_BRIDGE_URL;
  if (token === undefined && configured === undefined) return undefined;
  if (!token || !configured) {
    throw new Error(
      "A Runner computer use bridge needs OPENSTEER_COMPUTER_USE_BRIDGE_URL and OPENSTEER_COMPUTER_USE_BRIDGE_TOKEN together",
    );
  }
  const url = new URL(configured);
  if (
    (url.protocol !== "ws:" && url.protocol !== "http:") ||
    !isLoopbackHostname(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "OPENSTEER_COMPUTER_USE_BRIDGE_URL must be an uncredentialed loopback ws:// or http:// URL",
    );
  }
  return { token, url };
}

export function resolveRunnerNodeExecutable(
  configured: string | undefined,
  runtime: {
    readonly electronVersion: string | undefined;
    readonly execPath: string;
  } = {
    electronVersion: process.versions.electron,
    execPath: process.execPath,
  },
): string {
  if (configured !== undefined) return configured;
  if (runtime.electronVersion === undefined) return runtime.execPath;
  throw new Error(
    "OPENSTEER_NODE_EXECUTABLE is required when the Runner process is running inside Electron",
  );
}

function parseRunnerWorkspaceBackings(
  value: string,
): readonly ("local-directory" | "portablefs")[] {
  const values = value.split(",").map((entry) => entry.trim());
  if (
    values.length === 0 ||
    values.some((entry) => entry !== "local-directory" && entry !== "portablefs") ||
    new Set(values).size !== values.length
  ) {
    throw new Error(
      "OPENSTEER_RUNNER_WORKSPACE_BACKINGS must be a unique comma-separated list of local-directory and portablefs",
    );
  }
  return values as readonly ("local-directory" | "portablefs")[];
}

/**
 * A supervisor that already owns this process — the development stack or the
 * packaged desktop shell — hands the one-use enrollment token over an inherited
 * file descriptor. Unlike an environment variable, that never appears in `ps`
 * output or a crash dump of the process table.
 */
function readEnrollmentTokenFromDescriptor(descriptor: number | undefined): string | undefined {
  if (descriptor === undefined) return undefined;
  let raw: string;
  try {
    raw = readFileSync(descriptor, "utf8");
  } catch (error) {
    throw new Error(`OPENSTEER_RUNNER_ENROLLMENT_TOKEN_FD=${descriptor} could not be read`, {
      cause: error,
    });
  }
  const token = raw.trim();
  if (token === "") return undefined;
  if (token.length < 32 || token.length > 4_096) {
    throw new Error(
      `OPENSTEER_RUNNER_ENROLLMENT_TOKEN_FD=${descriptor} did not contain a Runner enrollment token`,
    );
  }
  return token;
}
