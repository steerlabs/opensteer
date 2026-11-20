import {
  HostAccountAdoptionBundleSchema,
  WorkHomeMarkerSchema,
  type WorkHomeMarker,
} from "@opensteer/control-plane-protocol";
import { deploymentPolicy, hostExposurePolicy, normalizePersonName } from "@opensteer/core";
import {
  allowsPlaintextRunnerTransport,
  BackgroundModelChoiceSchema,
  DeploymentIdSchema,
  DeploymentKindSchema,
  DeploymentShapeSchema,
  EnvironmentIdSchema,
  HostInstanceIdSchema,
  HostKeyFingerprintSchema,
  isLoopbackHostname,
  opensteerHostNativeOAuthClients,
  RunnerIdSchema,
  RuntimeModeSchema,
  type BackgroundModelChoice,
  type DeploymentId,
  type DeploymentShape,
  type EnvironmentId,
  type HostExposure,
  type HostInstanceId,
  type NativeOAuthClient,
  type RunnerId,
  type RuntimeMode,
} from "@opensteer/core";
import { noFollowFlag } from "@opensteer/shared/privateFiles";
import { digestSecret } from "@opensteer/shared/secretDigest";
import {
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { PasskeysEnvironmentSchema } from "./passkeys.js";

export { RuntimeModeSchema } from "@opensteer/core";
export type { RuntimeMode } from "@opensteer/core";

/**
 * A Host reachable only from its own machine may bootstrap itself: it mints its
 * own first-owner code and its own hosting Runner enrollment.
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

const optionalPositiveInteger = z.preprocess(
  (value) => (value === undefined || value === "" ? undefined : Number(value)),
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
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

// The hosting computer's name for its user; anything that is not a usable person name is dropped.
const optionalOwnerNameSeed = z.preprocess(
  (value) => (typeof value === "string" ? (normalizePersonName(value) ?? undefined) : undefined),
  z.string().optional(),
);

const optionalEnrollmentToken = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(16).max(4_096).optional(),
);

/** `digestSecret` of a setup code, for a provisioner that never holds the code. */
const optionalEnrollmentTokenDigest = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z
    .string()
    .trim()
    .regex(/^[0-9a-f]{64}$/u, "Expected a lowercase hex SHA-256 digest")
    .optional(),
);

// The app-held Personal owner claim is minted by the desktop as 32 random bytes;
// a shorter value is a misconfiguration, not a weaker password.
const optionalLocalOwnerClaimToken = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(32).max(4_096).optional(),
);

const optionalRunnerEnrollmentToken = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(32).max(4_096).optional(),
);

/**
 * Which forwarding headers a Personal Host believes, and only from a peer on
 * its own loopback interface. `loopback` is a reverse proxy such as Caddy in
 * front of a networked Home (`X-Forwarded-For`, `X-Forwarded-Proto`);
 * `loopback-cloudflared` is a Cloudflare tunnel connector on the same computer
 * (`CF-Connecting-IP`, `X-Forwarded-Proto`); `none` believes no header.
 */
export const TrustedProxySchema = z.enum(["none", "loopback", "loopback-cloudflared"]);
export type TrustedProxy = z.infer<typeof TrustedProxySchema>;

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

const bindAddress = z.union([z.ipv4(), z.ipv6(), z.literal("localhost")]);
const HostEnvironmentSchema = z.object({
  OPENSTEER_AUTH_SECRET: configuredSecret(8_192),
  OPENSTEER_AGENT_REVIEW_MODEL: optionalPath,
  OPENSTEER_STRICT_INSTALLATION: z.enum(["true", "false"]).default("false"),
  OPENSTEER_HOST_INSTANCE_PATH: optionalPath,
  OPENSTEER_TEAM_FILE_STORE: z.enum(["local", "gcs"]).default("local"),
  OPENSTEER_TEAM_FILE_BUCKET: optionalPath,
  OPENSTEER_TEAM_FILE_PREFIX: optionalPath,
  OPENSTEER_ACCOUNT_BUNDLE_FD: optionalFileDescriptor,
  OPENSTEER_ACCOUNT_BUNDLE_PATH: optionalPath,
  OPENSTEER_BIND_ADDRESS: bindAddress.default("127.0.0.1"),
  OPENSTEER_BROWSER_ATTACH_KEY_ID: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{1,255}$/)
    .default("host-v1"),
  OPENSTEER_DATABASE_URL: z.string().min(1),
  OPENSTEER_DEPLOYMENT_ID: DeploymentIdSchema.optional(),
  OPENSTEER_DEPLOYMENT_NAME: optionalDeploymentName,
  OPENSTEER_OWNER_NAME_SEED: optionalOwnerNameSeed,
  OPENSTEER_CREDENTIAL_KEY_PATH: optionalPath,
  OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN: optionalEnrollmentToken,
  OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN_DIGEST: optionalEnrollmentTokenDigest,
  OPENSTEER_TEAM_STORAGE_LIMIT_BYTES: optionalPositiveInteger,
  OPENSTEER_INITIAL_MESSAGING_RUNNER_ENROLLMENT_TOKEN: optionalEnrollmentToken,
  OPENSTEER_INITIAL_MAIN_RUNNER_ENROLLMENT_TOKEN: optionalRunnerEnrollmentToken,
  OPENSTEER_INITIAL_OWNER_ENROLLMENT_LIFETIME_SECONDS: positiveInteger(24 * 60 * 60),
  OPENSTEER_LOCAL_OWNER_CLAIM_TOKEN: optionalLocalOwnerClaimToken,
  OPENSTEER_LOCAL_PASSWORD_ENABLED: booleanValue(true),
  OPENSTEER_PASSKEYS: PasskeysEnvironmentSchema.shape.OPENSTEER_PASSKEYS,
  OPENSTEER_HOSTING_ENVIRONMENT_ID: EnvironmentIdSchema.optional(),
  OPENSTEER_AGENT_HOME: optionalPath,
  OPENSTEER_BROWSER_EXTENSION_DIRECTORY: optionalPath,
  OPENSTEER_NATIVE_OAUTH_ENABLED: optionalBooleanValue,
  OPENSTEER_DEPLOYMENT_KIND: DeploymentKindSchema.optional(),
  OPENSTEER_HOST_INSTANCE_ID: HostInstanceIdSchema.optional(),
  OPENSTEER_HOST_KEY_FINGERPRINT: HostKeyFingerprintSchema.optional(),
  OPENSTEER_HOST_PRIVATE_KEY_PATH: optionalPath,
  OPENSTEER_HOST_PUBLIC_KEY_PATH: optionalPath,
  OPENSTEER_HOST_DATA_DIR: z.string().min(1).default(".opensteer/host"),
  OPENSTEER_MODE: RuntimeModeSchema.default("development"),
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
  OPENSTEER_PORT: positiveInteger(4310),
  OPENSTEER_PERSONAL_ACCOUNT_ISSUER: optionalUrl,
  OPENSTEER_PORTAL_ORIGIN: optionalUrl,
  OPENSTEER_CANONICAL_ORIGIN: z.url(),
  OPENSTEER_RUNTIME_ORIGIN: optionalUrl,
  OPENSTEER_SIGNUP_POLICY: z.enum(["closed", "invite-only", "open"]).default("invite-only"),
  OPENSTEER_MANAGED_HOME_ID: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string()
      .regex(/^cc_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
      .optional(),
  ),
  OPENSTEER_MANAGED_HOME_GENERATION: optionalPositiveInteger,
  OPENSTEER_MANAGED_HOME_WORK_JSON: z.string().optional(),
  OPENSTEER_MANAGED_HOME_ACCOUNT_ORIGIN: optionalUrl,
  OPENSTEER_MANAGED_HOME_OIDC_CLIENT_ID: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string()
      .regex(/^occ_[0-9a-f-]{36}$/u)
      .optional(),
  ),
  OPENSTEER_MANAGED_HOME_OIDC_CLIENT_SECRET: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z
      .string()
      .regex(/^ocs_[A-Za-z0-9_-]{43}$/u)
      .optional(),
  ),
  OPENSTEER_TRUSTED_PROXY: z.preprocess(
    (value) => (value === "" ? undefined : value),
    TrustedProxySchema.optional(),
  ),
  OPENSTEER_WEB_DISTRIBUTION_DIRECTORY: optionalPath,
  OPENSTEER_WEB_DISTRIBUTION_MANIFEST: optionalPath,
  OPENSTEER_HOST_RELEASE_VERSION: optionalReleaseVersion,
});

export interface HostConfig {
  readonly account?:
    | {
        readonly provisioningMode: "adoption";
        readonly controlApiOrigin: URL;
        readonly hostCredential: string;
        readonly reachability: "canonical";
        readonly issuer: URL;
        readonly oidcClientId: string;
        readonly oidcClientSecret: string;
      }
    | undefined;
  readonly deploymentShape: DeploymentShape;
  readonly personal?: {
    readonly environmentId: EnvironmentId;
    readonly agentHome: string;
    /** The unpacked extension folder the desktop app keeps current on this computer. */
    readonly browserExtensionDirectory?: string;
  };
  readonly accountBundlePath: string;
  readonly authSecret: string;
  readonly agentReviewModel?: BackgroundModelChoice;
  readonly strictInstallation?: boolean;
  readonly hostInstancePath?: string;
  readonly teamFileStore?: { kind: "local" } | { kind: "gcs"; bucket: string; prefix: string };
  readonly bindAddress: string;
  readonly canonicalOrigin: URL;
  /**
   * The key the Host signs browser attach tickets with. Every browser now
   * belongs to an enrolled Runner, so there is no runtime URL to configure:
   * the machine comes to the Host, not the other way round.
   */
  readonly passkeys?: boolean;
  readonly browserRuntime: { readonly attachKeyId: string };
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
      { readonly lifetimeSeconds: number; readonly tokenDigest: string } | undefined;
    readonly localOwnerClaimToken?: string | undefined;
    readonly localPasswordEnabled: boolean;
    /**
     * The Host's own OAuth authorization server and the applications allowed
     * to use it. Absent means the surface is not served at all, which is the
     * only state a loopback Personal Host may be in.
     */
    readonly nativeOAuth?: { readonly clients: readonly NativeOAuthClient[] };
    readonly oidcConfigPath: string | undefined;
    readonly signupPolicy: "closed" | "invite-only" | "open";
  };
  /**
   * One-use enrollment tokens for the computers a Deployment supervises
   * for itself. Each is scoped to exactly one module, so a token minted for a
   * browser service can never come back as a machine that executes agents.
   */
  readonly initialMessagingRunnerEnrollmentToken?: string | undefined;
  /**
   * The hosting Runner's one-use enrollment on a networked Home, where no
   * desktop app reads `/v1/local-bootstrap` to obtain it.
   */
  readonly initialMainRunnerEnrollmentToken?: string | undefined;
  /**
   * How long a Run's execution lease lasts without renewal. It is the grace a
   * Runner has to reconnect after a network blip or a Host restart.
   */
  readonly executionLeaseMs: number;
  readonly maxConcurrentDispatches: number;
  readonly maxConcurrentTriggerDispatches: number;
  readonly mode: RuntimeMode;
  readonly port: number;
  /** Bytes all team files may hold together; unset is unlimited, the self-hosted default. */
  readonly teamStorageLimitBytes?: number;
  /** The place's display name as its own Door shows it; presentation metadata, not identity. */
  readonly deploymentName?: string;
  /** The hosting computer's full name for its user: the personal owner's first name, if unset. */
  readonly ownerNameSeed?: string;
  /** Apex portal this Deployment belongs to, for the "back to the portal"
   * navigation its own web UI and the Desktop app render. It is cell-level
   * navigation metadata rather than trust material, so any Deployment may
   * declare one and an absent value simply leaves the link unrendered. */
  readonly portalOrigin?: URL;
  /** Pinned trust root for Account-signed Personal link/session grants. It is
   * separate from an Account adoption bundle because a Personal Host keeps
   * its own canonical authority. */
  readonly personalAccountIssuer?: URL;
  readonly exposure: HostExposure;
  /** Absent means the default for the exposure: see `hostTrustedProxy`. */
  readonly trustedProxy?: TrustedProxy;
  /**
   * An Opensteer Cloud Computer's Home: claimed once for its paying Account
   * with an Account-signed assertion, and signed in to with that Account only.
   */
  readonly managedHome?: {
    readonly accountOrigin: URL;
    readonly cloudComputerId: string;
    readonly generation: number;
    readonly work?: WorkHomeMarker;
    readonly oidc: { readonly clientId: string; readonly clientSecret: string };
  };
  readonly privateKeyPath: string | undefined;
  readonly publicKeyPath: string | undefined;
  readonly runtimeOrigin: URL;
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
  const personal = deploymentPolicy(config.deploymentShape).services.personal;
  const exposure = hostExposurePolicy(config.deploymentShape, config.exposure);
  const networkedPersonal = personal && config.exposure === "networked";
  if (networkedPersonal && isLoopbackHostname(config.canonicalOrigin.hostname)) {
    throw new Error("A networked Personal Host requires its public canonical origin");
  }
  // In every mode: the native apps refuse a Home at plain HTTP anyway.
  if (networkedPersonal && config.canonicalOrigin.protocol !== "https:") {
    throw new Error("A networked Personal Host requires an https canonical origin");
  }
  if (personal !== (config.personal !== undefined)) {
    throw new Error("Only a Personal Host requires hosting environment and agent home settings");
  }
  if (
    config.personal &&
    (!isAbsolute(config.personal.agentHome) ||
      (config.personal.browserExtensionDirectory &&
        !isAbsolute(config.personal.browserExtensionDirectory)))
  ) {
    throw new Error("Agent home must be an absolute path");
  }
  if (exposure.localOwnerClaim && config.identity.nativeOAuth !== undefined) {
    throw new Error("A loopback Personal Host cannot serve native OAuth");
  }
  if (exposure.localOwnerClaim && config.identity.initialOwnerEnrollment !== undefined) {
    throw new Error("A loopback Personal Host uses the app-held local owner claim");
  }
  if (personal && config.identity.signupPolicy === "open") {
    throw new Error("A Personal Host cannot allow open signup: its owner claims it");
  }
  // A Home on its own server is claimed with its setup link and a password; the
  // runtime wires OIDC sign-in only for a managed Home's Opensteer Account.
  if (networkedPersonal && config.managedHome === undefined) {
    if (!config.identity.localPasswordEnabled)
      throw new Error("A networked Personal Host requires password sign-in to be claimed");
    if (config.identity.oidcConfigPath !== undefined)
      throw new Error("A networked Personal Host does not support OIDC sign-in");
  }
  if (config.managedHome) {
    if (!networkedPersonal || config.account !== undefined)
      throw new Error("A managed Home is a networked Personal Host");
    if (config.identity.localPasswordEnabled || config.identity.oidcConfigPath !== undefined)
      throw new Error("A managed Home signs its owner in with the Opensteer Account only");
    assertPublicHttpsOrigin(config.managedHome.accountOrigin, "Managed Home Account origin");
    if (config.personalAccountIssuer?.origin !== config.managedHome.accountOrigin.origin)
      throw new Error("A managed Home links to the Opensteer Account it was booted by");
  }
  if (config.initialMainRunnerEnrollmentToken !== undefined && !networkedPersonal) {
    throw new Error("A configured Main Runner enrollment is only for a networked Personal Host");
  }
  if (!personal && (config.identity.localPasswordEnabled || config.identity.oidcConfigPath)) {
    throw new Error("A team Host uses Opensteer Account sign-in only");
  }
  if (personal && config.teamStorageLimitBytes !== undefined) {
    throw new Error("A team storage limit applies only to a team Host");
  }
  if (!personal && config.initialMessagingRunnerEnrollmentToken) {
    throw new Error("A team Host cannot enroll Runners");
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
  if (config.mode === "production" && personal && !config.webDistribution) {
    throw new HostConfigurationIssue(
      "packaged-personal-web-distribution-required",
      "A packaged Personal Host requires its version-matched Web distribution.",
    );
  }
  if (config.personalAccountIssuer) {
    if (!personal || config.account !== undefined) {
      throw new Error("A Personal Account issuer is valid only for an unmanaged Personal Host");
    }
    assertPublicHttpsOrigin(config.personalAccountIssuer, "Personal Account issuer");
  }
  const requiresLocalOwnerClaim = exposure.localOwnerClaim && config.account === undefined;
  if (requiresLocalOwnerClaim !== (config.identity.localOwnerClaimToken !== undefined)) {
    throw new Error(
      requiresLocalOwnerClaim
        ? "An unmanaged Personal Host requires an app-held local owner claim token"
        : "A local owner claim token is allowed only for an unmanaged loopback Personal Host",
    );
  }
  if (config.account && personal) {
    throw new Error("An attached Opensteer Account requires a team deployment");
  }
}

/** Secrets a production Host never takes from its process environment. */
const secretsReadFromFilesOnly = new Set<string>([
  "OPENSTEER_INITIAL_MAIN_RUNNER_ENROLLMENT_TOKEN",
  "OPENSTEER_MANAGED_HOME_OIDC_CLIENT_SECRET",
]);

export function parseHostConfig(environment: NodeJS.ProcessEnv): HostConfig {
  const values = { ...environment };
  for (const name of [
    "OPENSTEER_AUTH_SECRET",
    "OPENSTEER_DATABASE_URL",
    "OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN",
    "OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN_DIGEST",
    "OPENSTEER_INITIAL_MAIN_RUNNER_ENROLLMENT_TOKEN",
    "OPENSTEER_MANAGED_HOME_OIDC_CLIENT_SECRET",
  ] as const) {
    const file = environment[`${name}_FILE`];
    if (
      !file &&
      environment[name] !== undefined &&
      (environment.OPENSTEER_MODE ?? "development") === "production" &&
      secretsReadFromFilesOnly.has(name)
    )
      throw new Error(`${name} must be delivered as ${name}_FILE in production`);
    if (!file) continue;
    if (environment[name] !== undefined)
      throw new Error(`Configure exactly one of ${name} or ${name}_FILE`);
    const descriptor = openSync(
      file,
      fsConstants.O_RDONLY | noFollowFlag() | fsConstants.O_NONBLOCK,
    );
    try {
      if (!fstatSync(descriptor).isFile()) throw new Error(`${name}_FILE must be a regular file`);
      // A bring-your-own Home mounts the managed Home's secret file empty.
      values[name] = readBoundedDescriptor(
        descriptor,
        16 * 1024,
        name === "OPENSTEER_MANAGED_HOME_OIDC_CLIENT_SECRET",
      ).replace(/\r?\n$/u, "");
    } finally {
      closeSync(descriptor);
    }
  }
  const parsed = HostEnvironmentSchema.parse(values);
  if (
    parsed.OPENSTEER_TEAM_FILE_STORE === "gcs" &&
    (!parsed.OPENSTEER_TEAM_FILE_BUCKET ||
      !parsed.OPENSTEER_TEAM_FILE_PREFIX ||
      !parsed.OPENSTEER_TEAM_FILE_PREFIX.endsWith("/"))
  )
    throw new Error("GCS team files require a bucket and managed-folder prefix ending in /");
  if (
    parsed.OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN !== undefined &&
    parsed.OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN_DIGEST !== undefined
  )
    throw new Error(
      "Configure exactly one of OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN or OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN_DIGEST",
    );
  const initialOwnerTokenDigest =
    parsed.OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN_DIGEST ??
    (parsed.OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN === undefined
      ? undefined
      : digestSecret(parsed.OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN));
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
  if (parsed.OPENSTEER_MODE === "production" && !parsed.OPENSTEER_DEPLOYMENT_KIND) {
    throw new Error("Production requires OPENSTEER_DEPLOYMENT_KIND");
  }
  const deploymentShape = DeploymentShapeSchema.parse({
    kind: parsed.OPENSTEER_DEPLOYMENT_KIND ?? "personal",
  });
  if (parsed.OPENSTEER_STRICT_INSTALLATION === "true") {
    if (
      !deploymentPolicy(deploymentShape).services.team ||
      // The image entrypoint has already read each `_FILE` into its variable and dropped the name.
      !parsed.OPENSTEER_AUTH_SECRET ||
      !parsed.OPENSTEER_HOST_INSTANCE_PATH ||
      !parsed.OPENSTEER_HOST_PRIVATE_KEY_PATH ||
      !parsed.OPENSTEER_HOST_PUBLIC_KEY_PATH ||
      !parsed.OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN_DIGEST ||
      parsed.OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN !== undefined
    )
      throw new Error(
        "Strict team installation requires mounted auth secret, setup digest, Host instance and key pair files",
      );
  }
  const accountBundle = readAccountAdoptionBundle({
    ...parsed,
    ...(parsed.OPENSTEER_ACCOUNT_BUNDLE_FD === undefined &&
    parsed.OPENSTEER_ACCOUNT_BUNDLE_PATH === undefined &&
    existsSync(join(resolve(parsed.OPENSTEER_HOST_DATA_DIR), "account-bundle.json"))
      ? {
          OPENSTEER_ACCOUNT_BUNDLE_PATH: join(
            resolve(parsed.OPENSTEER_HOST_DATA_DIR),
            "account-bundle.json",
          ),
        }
      : {}),
  });
  const account = accountConfig(accountBundle, parsed.OPENSTEER_MODE);
  const browserRuntime = { attachKeyId: parsed.OPENSTEER_BROWSER_ATTACH_KEY_ID };
  requireProductionKeyPair(parsed.OPENSTEER_MODE, parsed);
  requireSecureServiceUrl(
    parsed.OPENSTEER_MODE,
    parsed.OPENSTEER_CANONICAL_ORIGIN,
    "OPENSTEER_CANONICAL_ORIGIN",
    {
      allowLoopback:
        deploymentPolicy(deploymentShape).services.personal &&
        isLoopbackBindAddress(parsed.OPENSTEER_BIND_ADDRESS),
    },
  );
  const canonicalOrigin = originUrl(
    parsed.OPENSTEER_CANONICAL_ORIGIN,
    "OPENSTEER_CANONICAL_ORIGIN",
  );
  if (accountBundle && accountBundle.deployment.canonicalOrigin !== canonicalOrigin.origin) {
    throw new Error("OPENSTEER_CANONICAL_ORIGIN must match the Account adoption bundle");
  }
  const runtimeOrigin = originUrl(
    parsed.OPENSTEER_RUNTIME_ORIGIN ?? parsed.OPENSTEER_CANONICAL_ORIGIN,
    "OPENSTEER_RUNTIME_ORIGIN",
  );
  requireSecureServiceUrl(parsed.OPENSTEER_MODE, runtimeOrigin.origin, "OPENSTEER_RUNTIME_ORIGIN", {
    allowLoopback:
      deploymentPolicy(deploymentShape).services.personal &&
      isLoopbackBindAddress(parsed.OPENSTEER_BIND_ADDRESS),
  });
  const exposure = deriveHostExposure({
    bindAddress: parsed.OPENSTEER_BIND_ADDRESS,
    canonicalOrigin,
  });
  // A bearer token minted by the Host's own OAuth server skips every origin
  // check, and on a loopback Personal Host the canonical-origin fence is what
  // stands in for "the owner is at this keyboard". That Host therefore does not
  // serve the surface at all, and saying otherwise is refused by
  // assertHostConfigInvariants rather than quietly ignored. A networked Home
  // signs its owner in at a public origin, so its phone and desktop apps use it.
  const nativeOAuthEnabled =
    parsed.OPENSTEER_NATIVE_OAUTH_ENABLED ??
    !hostExposurePolicy(deploymentShape, exposure).localOwnerClaim;
  // Navigation metadata, not trust material: any Deployment may name the apex
  // portal it belongs to; absent metadata renders no portal link.
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
  const personal = deploymentPolicy(deploymentShape).services.personal;
  const managedHome = parseManagedHome(parsed);
  const dataDirectory = resolve(parsed.OPENSTEER_HOST_DATA_DIR);
  const accountBundlePath =
    parsed.OPENSTEER_ACCOUNT_BUNDLE_PATH ?? join(dataDirectory, "account-bundle.json");
  const environmentId =
    parsed.OPENSTEER_HOSTING_ENVIRONMENT_ID ??
    (parsed.OPENSTEER_MODE === "development"
      ? EnvironmentIdSchema.parse("env_00000000-0000-4000-8000-000000000001")
      : undefined);
  if (personal && !environmentId)
    throw new Error("A Personal Host requires OPENSTEER_HOSTING_ENVIRONMENT_ID");
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
      "An Account adoption bundle cannot be combined with an explicit Personal Deployment identity",
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
  const config: HostConfig = {
    account,
    deploymentShape,
    accountBundlePath,
    ...(personal
      ? {
          personal: {
            environmentId: environmentId!,
            ...(parsed.OPENSTEER_BROWSER_EXTENSION_DIRECTORY
              ? { browserExtensionDirectory: parsed.OPENSTEER_BROWSER_EXTENSION_DIRECTORY }
              : {}),
            agentHome:
              parsed.OPENSTEER_AGENT_HOME ??
              (parsed.OPENSTEER_MODE === "development"
                ? join(dataDirectory, "agent-home")
                : join(homedir(), "Opensteer")),
          },
        }
      : {}),
    authSecret: parsed.OPENSTEER_AUTH_SECRET,
    ...(parsed.OPENSTEER_AGENT_REVIEW_MODEL
      ? {
          agentReviewModel: BackgroundModelChoiceSchema.parse(
            JSON.parse(parsed.OPENSTEER_AGENT_REVIEW_MODEL),
          ),
        }
      : {}),
    strictInstallation: parsed.OPENSTEER_STRICT_INSTALLATION === "true",
    ...(parsed.OPENSTEER_HOST_INSTANCE_PATH
      ? { hostInstancePath: parsed.OPENSTEER_HOST_INSTANCE_PATH }
      : {}),
    teamFileStore:
      parsed.OPENSTEER_TEAM_FILE_STORE === "gcs"
        ? {
            kind: "gcs",
            bucket: parsed.OPENSTEER_TEAM_FILE_BUCKET!,
            prefix: parsed.OPENSTEER_TEAM_FILE_PREFIX!,
          }
        : { kind: "local" },
    bindAddress: parsed.OPENSTEER_BIND_ADDRESS,
    canonicalOrigin,
    browserRuntime,
    passkeys: parsed.OPENSTEER_PASSKEYS,
    databaseUrl: parsed.OPENSTEER_DATABASE_URL,
    credentialKeyPath: parsed.OPENSTEER_CREDENTIAL_KEY_PATH,
    dataDirectory,
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
      initialOwnerEnrollment: initialOwnerTokenDigest
        ? {
            lifetimeSeconds: Math.min(
              parsed.OPENSTEER_INITIAL_OWNER_ENROLLMENT_LIFETIME_SECONDS,
              7 * 24 * 60 * 60,
            ),
            tokenDigest: initialOwnerTokenDigest,
          }
        : undefined,
      localPasswordEnabled: personal ? parsed.OPENSTEER_LOCAL_PASSWORD_ENABLED : false,
      localOwnerClaimToken: parsed.OPENSTEER_LOCAL_OWNER_CLAIM_TOKEN,
      ...(nativeOAuthEnabled ? { nativeOAuth: { clients: opensteerHostNativeOAuthClients } } : {}),
      oidcConfigPath: parsed.OPENSTEER_OIDC_CONFIG_PATH,
      signupPolicy: parsed.OPENSTEER_SIGNUP_POLICY,
    },
    initialMessagingRunnerEnrollmentToken:
      parsed.OPENSTEER_INITIAL_MESSAGING_RUNNER_ENROLLMENT_TOKEN,
    ...(parsed.OPENSTEER_INITIAL_MAIN_RUNNER_ENROLLMENT_TOKEN === undefined
      ? {}
      : {
          initialMainRunnerEnrollmentToken: parsed.OPENSTEER_INITIAL_MAIN_RUNNER_ENROLLMENT_TOKEN,
        }),
    executionLeaseMs: parsed.OPENSTEER_EXECUTION_LEASE_SECONDS * 1_000,
    maxConcurrentDispatches: parsed.OPENSTEER_MAX_CONCURRENT_DISPATCHES,
    maxConcurrentTriggerDispatches: parsed.OPENSTEER_MAX_CONCURRENT_TRIGGER_DISPATCHES,
    mode: parsed.OPENSTEER_MODE,
    port: parsed.OPENSTEER_PORT,
    ...(parsed.OPENSTEER_TEAM_STORAGE_LIMIT_BYTES === undefined
      ? {}
      : { teamStorageLimitBytes: parsed.OPENSTEER_TEAM_STORAGE_LIMIT_BYTES }),
    ...(deploymentName ? { deploymentName } : {}),
    ...(parsed.OPENSTEER_OWNER_NAME_SEED
      ? { ownerNameSeed: parsed.OPENSTEER_OWNER_NAME_SEED }
      : {}),
    ...(parsed.OPENSTEER_PERSONAL_ACCOUNT_ISSUER
      ? { personalAccountIssuer: new URL(parsed.OPENSTEER_PERSONAL_ACCOUNT_ISSUER) }
      : managedHome
        ? { personalAccountIssuer: managedHome.accountOrigin }
        : {}),
    ...(managedHome ? { managedHome } : {}),
    ...(portalOrigin ? { portalOrigin } : {}),
    exposure,
    ...(parsed.OPENSTEER_TRUSTED_PROXY === undefined
      ? {}
      : { trustedProxy: parsed.OPENSTEER_TRUSTED_PROXY }),
    privateKeyPath: parsed.OPENSTEER_HOST_PRIVATE_KEY_PATH,
    publicKeyPath: parsed.OPENSTEER_HOST_PUBLIC_KEY_PATH,
    runtimeOrigin,
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

function parseManagedHome(parsed: {
  readonly OPENSTEER_MANAGED_HOME_ID?: string | undefined;
  readonly OPENSTEER_MANAGED_HOME_GENERATION?: number | undefined;
  readonly OPENSTEER_MANAGED_HOME_WORK_JSON?: string | undefined;
  readonly OPENSTEER_MANAGED_HOME_ACCOUNT_ORIGIN?: string | undefined;
  readonly OPENSTEER_MANAGED_HOME_OIDC_CLIENT_ID?: string | undefined;
  readonly OPENSTEER_MANAGED_HOME_OIDC_CLIENT_SECRET?: string | undefined;
}): HostConfig["managedHome"] {
  const values = [
    parsed.OPENSTEER_MANAGED_HOME_ID,
    parsed.OPENSTEER_MANAGED_HOME_GENERATION,
    parsed.OPENSTEER_MANAGED_HOME_ACCOUNT_ORIGIN,
    parsed.OPENSTEER_MANAGED_HOME_OIDC_CLIENT_ID,
    parsed.OPENSTEER_MANAGED_HOME_OIDC_CLIENT_SECRET,
  ];
  const configured = values.filter((value) => value !== undefined).length;
  const work = parsed.OPENSTEER_MANAGED_HOME_WORK_JSON
    ? WorkHomeMarkerSchema.parse(JSON.parse(parsed.OPENSTEER_MANAGED_HOME_WORK_JSON))
    : undefined;
  if (configured === 0 && !work) return undefined;
  if (configured !== values.length)
    throw new Error(
      "OPENSTEER_MANAGED_HOME_ID, OPENSTEER_MANAGED_HOME_GENERATION, OPENSTEER_MANAGED_HOME_ACCOUNT_ORIGIN, OPENSTEER_MANAGED_HOME_OIDC_CLIENT_ID and OPENSTEER_MANAGED_HOME_OIDC_CLIENT_SECRET must be configured together",
    );
  return {
    accountOrigin: originUrl(
      parsed.OPENSTEER_MANAGED_HOME_ACCOUNT_ORIGIN!,
      "OPENSTEER_MANAGED_HOME_ACCOUNT_ORIGIN",
    ),
    cloudComputerId: parsed.OPENSTEER_MANAGED_HOME_ID!,
    generation: parsed.OPENSTEER_MANAGED_HOME_GENERATION!,
    ...(work ? { work } : {}),
    oidc: {
      clientId: parsed.OPENSTEER_MANAGED_HOME_OIDC_CLIENT_ID!,
      clientSecret: parsed.OPENSTEER_MANAGED_HOME_OIDC_CLIENT_SECRET!,
    },
  };
}

/**
 * The proxy a Host believes forwarding headers from. A loopback Personal Host
 * keeps reading the Cloudflare tunnel connector beside it, as it always has; a
 * networked Home believes the reverse proxy on its own loopback interface.
 */
export function hostTrustedProxy(
  config: Pick<HostConfig, "exposure" | "trustedProxy">,
): TrustedProxy {
  return (
    config.trustedProxy ?? (config.exposure === "loopback" ? "loopback-cloudflared" : "loopback")
  );
}

function accountConfig(
  bundle: z.infer<typeof HostAccountAdoptionBundleSchema> | undefined,
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
    reachability: bundle.deployment.reachability,
    issuer,
    oidcClientId: bundle.oidc.clientId,
    oidcClientSecret: bundle.oidcClientSecret,
  };
}

const maximumAccountAdoptionBundleBytes = 64 * 1_024;

export function readAccountAdoptionBundle(parsed: {
  readonly OPENSTEER_ACCOUNT_BUNDLE_FD?: number | undefined;
  readonly OPENSTEER_ACCOUNT_BUNDLE_PATH?: string | undefined;
}): z.infer<typeof HostAccountAdoptionBundleSchema> | undefined {
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
    const serialized = readBoundedDescriptor(handle, maximumAccountAdoptionBundleBytes);
    return HostAccountAdoptionBundleSchema.parse(JSON.parse(serialized));
  } catch (error) {
    throw new Error("Unable to load the Opensteer Account provisioning bundle", { cause: error });
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

function readBoundedDescriptor(
  descriptor: number,
  maximumBytes: number,
  allowEmpty = false,
): string {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maximumBytes) {
    const chunk = Buffer.allocUnsafe(Math.min(8_192, maximumBytes + 1 - total));
    const bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  if ((total === 0 && !allowEmpty) || total > maximumBytes) {
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
    readonly OPENSTEER_HOST_PRIVATE_KEY_PATH?: string | undefined;
    readonly OPENSTEER_HOST_PUBLIC_KEY_PATH?: string | undefined;
  },
): void {
  if (
    mode === "production" &&
    (!values.OPENSTEER_HOST_PRIVATE_KEY_PATH || !values.OPENSTEER_HOST_PUBLIC_KEY_PATH)
  ) {
    throw new Error(
      "Production requires OPENSTEER_HOST_PRIVATE_KEY_PATH and OPENSTEER_HOST_PUBLIC_KEY_PATH",
    );
  }
}

export const defaultRunnerMaxConcurrentTriggerPrograms = 4;

const RunnerEnvironmentSchema = z.object({
  OPENSTEER_DEPLOYMENT_KIND: DeploymentKindSchema.optional(),
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
  OPENSTEER_BROWSER_BRIDGE_TOKEN: z.string().min(32).max(4_096).optional(),
  OPENSTEER_BROWSER_BRIDGE_URL: z.url().optional(),
  OPENSTEER_BROWSER_RUNTIME_ID: z.string().trim().min(1).max(255).optional(),
  OPENSTEER_BROWSER_SIGN_IN: z.literal("1").optional(),
  OPENSTEER_BROWSER_PERSON_FILL: z.literal("1").optional(),
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
  OPENSTEER_RUNNER_NAME: z.string().trim().min(1).max(120).default("Hosting computer"),
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
        /** Its pages offer and fill the person's own saved logins. */
        readonly personFill: boolean;
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
   * Without `agents` the Runner is reach-only and starts no agents.
   */
  readonly modules: readonly RunnerProcessModule[];
  readonly name: string;
  readonly nodeExecutable: string;
  readonly runnerId: RunnerId | undefined;
  readonly runnerKind: "main" | "local" | "managed";
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
  // The hosting Runner is the one that shares a computer with its Personal Host,
  // so only it must reach that Host over loopback, on a networked Home too.
  // Every other computer on a Personal Deployment is reachable-only and
  // connects over HTTPS: the signed access route of a loopback Host, or a
  // networked Home's canonical origin.
  if (
    deploymentPolicy(config.deploymentShape).colocatedHostingRunner &&
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
  if (parsed.OPENSTEER_MODE === "production" && !parsed.OPENSTEER_DEPLOYMENT_KIND) {
    throw new Error("Production requires OPENSTEER_DEPLOYMENT_KIND");
  }
  const deploymentShape = DeploymentShapeSchema.parse({
    kind: parsed.OPENSTEER_DEPLOYMENT_KIND ?? "personal",
  });
  if (!deploymentPolicy(deploymentShape).services.personal)
    throw new Error("A team Host cannot run Runners");
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
  };
  assertRunnerConfigInvariants(config);
  return config;
}

/**
 * What this Runner process runs. `browser` names a relay that reaches the Host
 * through this Runner's own identity, independently of where agents run.
 */
function parseRunnerModules(value: string): readonly RunnerProcessModule[] {
  const values = value.split(",").map((entry) => entry.trim());
  const selection = RunnerProcessModuleSchema.options.filter((module) => values.includes(module));
  if (values.length !== selection.length || new Set(values).size !== values.length) {
    throw new Error(
      "OPENSTEER_RUNNER_MODULES must be a unique comma-separated list of agents, browser, integrations, messaging and shell",
    );
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
  readonly OPENSTEER_BROWSER_PERSON_FILL?: "1" | undefined;
}): RunnerConfig["browserBridge"] {
  const configured = [
    parsed.OPENSTEER_BROWSER_BRIDGE_TOKEN,
    parsed.OPENSTEER_BROWSER_BRIDGE_URL,
    parsed.OPENSTEER_BROWSER_RUNTIME_ID,
  ].filter((value) => value !== undefined);
  if (configured.length === 0) {
    for (const name of ["OPENSTEER_BROWSER_SIGN_IN", "OPENSTEER_BROWSER_PERSON_FILL"] as const)
      if (parsed[name] !== undefined)
        throw new Error(`${name} needs the Runner's browser bridge settings`);
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
    personFill: parsed.OPENSTEER_BROWSER_PERSON_FILL === "1",
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
