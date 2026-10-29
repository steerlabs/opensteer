import {
  isBareOrigin,
  isSecureOrLoopbackOrigin,
  NativeOAuthClientSetSchema,
  opensteerAccountNativeOAuthClients,
  type NativeOAuthClient,
} from "@opensteer/core";
import { createPrivateKey, type KeyObject } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

const BareOriginSchema = z.url().transform((value, context) => {
  const url = new URL(value);
  if (!isBareOrigin(url)) {
    context.addIssue({ code: "custom", message: "Expected a bare public origin" });
    return z.NEVER;
  }
  if (!isSecureOrLoopbackOrigin(url)) {
    context.addIssue({ code: "custom", message: "Expected HTTPS or HTTP loopback" });
    return z.NEVER;
  }
  return url;
});

const DeploymentDomainSchema = z
  .string()
  .trim()
  .superRefine((value, context) => {
    const domain = value.replace(/\.$/u, "");
    let url: URL;
    try {
      url = new URL(`https://${domain}`);
    } catch {
      context.addIssue({ code: "custom", message: "Expected a DNS domain" });
      return;
    }
    if (!domain || domain.length > 253 || url.hostname !== domain || url.port || value !== domain) {
      context.addIssue({ code: "custom", message: "Expected a normalized DNS domain" });
    }
  });

const CloudflareIdentifierSchema = z.string().regex(/^[a-f0-9]{32}$/u);
const GitHubInstallationUrlSchema = z
  .url()
  .refine(
    (value) =>
      /^https:\/\/github\.com\/apps\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/installations\/new$/u.test(
        value,
      ),
    "Expected https://github.com/apps/<app-slug>/installations/new",
  );
const Base64UrlKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/u)
  .refine((value) => {
    const key = Buffer.from(value, "base64url");
    return key.byteLength === 32 && key.toString("base64url") === value;
  }, "Expected canonical base64url for a 32-byte key");
/**
 * A private key is checked by importing it, not by recognising its header.
 *
 * A key that parses at startup is one the delivery worker can sign with; a
 * malformed or wrong-algorithm key that only fails at send time is a
 * notification nobody gets and nobody is told about. `createPrivateKey` is the
 * same parser `jose` reaches for, and it is synchronous, so the check belongs
 * in configuration rather than in the first push of the day.
 */
function assertPrivateKey(
  value: string,
  expected: { readonly curve?: string; readonly type: "ec" | "rsa" },
  context: z.RefinementCtx,
  label: string,
): void {
  let key: KeyObject;
  try {
    key = createPrivateKey(value);
  } catch {
    context.addIssue({ code: "custom", message: `${label} is not a readable PEM private key` });
    return;
  }
  if (key.asymmetricKeyType !== expected.type) {
    context.addIssue({
      code: "custom",
      message: `${label} must be ${expected.type === "ec" ? "an EC" : "an RSA"} private key`,
    });
    return;
  }
  if (expected.curve && key.asymmetricKeyDetails?.namedCurve !== expected.curve) {
    context.addIssue({ code: "custom", message: `${label} must use the P-256 curve for ES256` });
  }
  if (
    expected.type === "rsa" &&
    (key.asymmetricKeyDetails?.modulusLength ?? 0) < minimumRsaModulusLength
  ) {
    context.addIssue({
      code: "custom",
      message: `${label} must be at least ${minimumRsaModulusLength} bits`,
    });
  }
}

const minimumRsaModulusLength = 2_048;

/** The ES256 signing key Apple issues for the APNs provider token. */
const ApnsPrivateKeySchema = z
  .string()
  .min(100)
  .max(8_192)
  .superRefine((value, context) =>
    assertPrivateKey(
      value,
      { curve: "prime256v1", type: "ec" },
      context,
      "OPENSTEER_APNS_PRIVATE_KEY",
    ),
  );

/**
 * The Google service account FCM v1 authenticates with. The project id comes
 * from the document rather than a second variable, so the two can never
 * disagree about which Firebase project the phone was registered against.
 */
const FcmServiceAccountSchema = z
  .string()
  .transform((value, context) => {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      context.addIssue({
        code: "custom",
        message: "OPENSTEER_FCM_SERVICE_ACCOUNT_JSON must be a service-account JSON document",
      });
      return z.NEVER;
    }
  })
  .pipe(
    z.object({
      client_email: z.email(),
      private_key: z
        .string()
        .min(100)
        .max(8_192)
        .superRefine((value, context) =>
          assertPrivateKey(
            value,
            { type: "rsa" },
            context,
            "OPENSTEER_FCM_SERVICE_ACCOUNT_JSON private_key",
          ),
        ),
      project_id: z.string().regex(/^[a-z][a-z0-9-]{4,29}$/u),
      token_uri: z.url().optional(),
    }),
  );

const ControlPlaneDatabaseUrlSchema = z
  .url()
  .refine((value) => ["postgres:", "postgresql:"].includes(new URL(value).protocol), {
    message: "Expected a PostgreSQL URL",
  });

const CommonEnvironmentShape = {
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  OPENSTEER_CONTROL_PLANE_DATABASE_URL: ControlPlaneDatabaseUrlSchema,
  OPENSTEER_CONTROL_PLANE_PUBLIC_URL: BareOriginSchema,
  OPENSTEER_CONTROL_PLANE_AUTH_SECRET: z.string().min(32),
  OPENSTEER_MANAGED_DEPLOYMENT_DOMAIN: DeploymentDomainSchema,
} as const;

const MigrationEnvironmentSchema = z
  .object({ OPENSTEER_CONTROL_PLANE_DATABASE_URL: ControlPlaneDatabaseUrlSchema })
  .passthrough();

const AccountEnvironmentSchema = z
  .object({
    ...CommonEnvironmentShape,
    OPENSTEER_ADOPTION_OPERATION_KEY: Base64UrlKeySchema,
    OPENSTEER_CLOUD_OPERATION_KEY: Base64UrlKeySchema.optional(),
    OPENSTEER_CLOUD_TEMPLATE_PATH: z.string().min(1).optional(),
    OPENSTEER_PERSONAL_ACCOUNT_LINK_OPERATION_KEY: Base64UrlKeySchema,
    OPENSTEER_GOOGLE_CLIENT_ID: z.string().min(1),
    OPENSTEER_GOOGLE_CLIENT_SECRET: z.string().min(1),
    OPENSTEER_HOSTED_OAUTH_STATE_KEY: Base64UrlKeySchema.optional(),
    OPENSTEER_HOSTED_OAUTH_ENCRYPTION_KEY: z.string().min(80).max(512).optional(),
    OPENSTEER_HOSTED_OAUTH_DISCORD_CLIENT_ID: z.string().min(1).optional(),
    OPENSTEER_HOSTED_OAUTH_DISCORD_CLIENT_SECRET: z.string().min(1).optional(),
    OPENSTEER_HOSTED_OAUTH_DISCORD_REVISION: z.coerce.number().int().positive().optional(),
    OPENSTEER_HOSTED_OAUTH_GITHUB_CLIENT_ID: z.string().min(1).optional(),
    OPENSTEER_HOSTED_OAUTH_GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
    OPENSTEER_HOSTED_OAUTH_GITHUB_INSTALLATION_URL: GitHubInstallationUrlSchema.optional(),
    OPENSTEER_HOSTED_OAUTH_GITHUB_REVISION: z.coerce.number().int().positive().optional(),
    OPENSTEER_HOSTED_OAUTH_GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    OPENSTEER_HOSTED_OAUTH_GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    OPENSTEER_HOSTED_OAUTH_GOOGLE_REVISION: z.coerce.number().int().positive().optional(),
    OPENSTEER_HOSTED_OAUTH_MICROSOFT_CLIENT_ID: z.string().min(1).optional(),
    OPENSTEER_HOSTED_OAUTH_MICROSOFT_CLIENT_SECRET: z.string().min(1).optional(),
    OPENSTEER_HOSTED_OAUTH_MICROSOFT_REVISION: z.coerce.number().int().positive().optional(),
    OPENSTEER_HOSTED_OAUTH_SLACK_CLIENT_ID: z.string().min(1).optional(),
    OPENSTEER_HOSTED_OAUTH_SLACK_CLIENT_SECRET: z.string().min(1).optional(),
    OPENSTEER_HOSTED_OAUTH_SLACK_REVISION: z.coerce.number().int().positive().optional(),
    OPENSTEER_DESKTOP_DOWNLOAD_URL: z.url().optional(),
    OPENSTEER_CONNECT_DOMAIN: DeploymentDomainSchema,
    OPENSTEER_CONNECT_CLOUDFLARE_ACCOUNT_ID: CloudflareIdentifierSchema,
    OPENSTEER_CONNECT_CLOUDFLARE_API_TOKEN: z.string().trim().min(20).max(2_048),
    OPENSTEER_CONNECT_CLOUDFLARE_ZONE_ID: CloudflareIdentifierSchema,
    OPENSTEER_CONNECT_CLOUDFLARE_WORKERS_ROUTE_BYPASS: z.enum(["off", "on"]).default("off"),
    OPENSTEER_CONNECT_CREDENTIAL_DERIVATION_SECRET: z.string().min(32).max(4_096),
    OPENSTEER_APNS_KEY_ID: z
      .string()
      .regex(/^[A-Z0-9]{10}$/u)
      .optional(),
    OPENSTEER_APNS_TEAM_ID: z
      .string()
      .regex(/^[A-Z0-9]{10}$/u)
      .optional(),
    OPENSTEER_APNS_PRIVATE_KEY: ApnsPrivateKeySchema.optional(),
    OPENSTEER_APNS_TOPIC: z
      .string()
      .regex(/^[a-z][a-z0-9]*(?:\.[a-z0-9][a-z0-9-]*)+$/u)
      .optional(),
    OPENSTEER_FCM_SERVICE_ACCOUNT_JSON: FcmServiceAccountSchema.optional(),
    OPENSTEER_CONTROL_PLANE_HOST: z.string().min(1).default("127.0.0.1"),
    OPENSTEER_CONTROL_PLANE_PORT: z.coerce.number().int().min(1).max(65_535).default(4142),
  })
  .passthrough();

export interface ControlPlaneConfig {
  readonly environment: "development" | "test" | "production";
  readonly databaseUrl: string;
  readonly publicOrigin: URL;
  readonly authSecret: string;
  readonly adoptionOperationKey: string;
  readonly cloud?: { readonly operationKey: string; readonly templatePath: string };
  readonly personalAccountLinkOperationKey: string;
  readonly googleClientId: string;
  readonly googleClientSecret: string;
  readonly hostedOAuth?: {
    readonly encryptionPrivateKey: string;
    readonly attemptContextEncryptionKey: string;
    readonly applications: readonly {
      readonly clientId: string;
      readonly clientSecret: string;
      readonly installationUrl?: string;
      readonly provider: "discord" | "github" | "google" | "microsoft" | "slack";
      readonly revision: number;
    }[];
  };
  readonly managedDeploymentDomain: string;
  readonly connectDomain: string;
  /**
   * Where the portal sends someone who wants a private, on-their-computer
   * Opensteer. Purely navigational: without it the portal simply offers no
   * Desktop app row.
   */
  readonly desktopDownloadUrl?: string;
  readonly connectCloudflare: {
    readonly accountId: string;
    readonly apiToken: string;
    readonly credentialDerivationSecret: string;
    readonly workersRouteBypass: boolean;
    readonly zoneId: string;
  };
  readonly nativeOAuthClients: readonly NativeOAuthClient[];
  /** Each provider can be enabled independently. */
  readonly push?: {
    readonly apns?: {
      readonly keyId: string;
      readonly privateKeyPem: string;
      readonly teamId: string;
      readonly topic: string;
    };
    readonly fcm?: {
      readonly clientEmail: string;
      readonly privateKeyPem: string;
      readonly projectId: string;
      readonly tokenUri: string;
    };
  };
  readonly listenHost: string;
  readonly listenPort: number;
}

interface ControlPlaneMigrationConfig {
  readonly databaseUrl: string;
}

export function loadControlPlaneMigrationConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ControlPlaneMigrationConfig {
  const parsed = MigrationEnvironmentSchema.parse(environment);
  return { databaseUrl: parsed.OPENSTEER_CONTROL_PLANE_DATABASE_URL };
}

export function loadControlPlaneConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ControlPlaneConfig {
  const parsed = AccountEnvironmentSchema.parse(environment);
  if (
    parsed.NODE_ENV === "production" &&
    parsed.OPENSTEER_CONTROL_PLANE_PUBLIC_URL.protocol !== "https:"
  ) {
    throw new Error("OPENSTEER_CONTROL_PLANE_PUBLIC_URL must use HTTPS in production");
  }
  if (
    new Set([
      parsed.OPENSTEER_ADOPTION_OPERATION_KEY,
      parsed.OPENSTEER_PERSONAL_ACCOUNT_LINK_OPERATION_KEY,
    ]).size !== 2
  ) {
    throw new Error("Adoption and Personal Account-link keys must be different");
  }
  if (
    Boolean(parsed.OPENSTEER_CLOUD_OPERATION_KEY) !== Boolean(parsed.OPENSTEER_CLOUD_TEMPLATE_PATH)
  ) {
    throw new Error(
      "Cloud requires both OPENSTEER_CLOUD_OPERATION_KEY and OPENSTEER_CLOUD_TEMPLATE_PATH",
    );
  }
  if (
    parsed.OPENSTEER_CLOUD_OPERATION_KEY &&
    [
      parsed.OPENSTEER_ADOPTION_OPERATION_KEY,
      parsed.OPENSTEER_PERSONAL_ACCOUNT_LINK_OPERATION_KEY,
    ].includes(parsed.OPENSTEER_CLOUD_OPERATION_KEY)
  ) {
    throw new Error("Cloud operation encryption requires its own key");
  }
  const config = {
    environment: parsed.NODE_ENV,
    databaseUrl: parsed.OPENSTEER_CONTROL_PLANE_DATABASE_URL,
    publicOrigin: parsed.OPENSTEER_CONTROL_PLANE_PUBLIC_URL,
    authSecret: parsed.OPENSTEER_CONTROL_PLANE_AUTH_SECRET,
    adoptionOperationKey: parsed.OPENSTEER_ADOPTION_OPERATION_KEY,
    ...(parsed.OPENSTEER_CLOUD_OPERATION_KEY && parsed.OPENSTEER_CLOUD_TEMPLATE_PATH
      ? {
          cloud: {
            operationKey: parsed.OPENSTEER_CLOUD_OPERATION_KEY,
            templatePath: parsed.OPENSTEER_CLOUD_TEMPLATE_PATH,
          },
        }
      : {}),
    personalAccountLinkOperationKey: parsed.OPENSTEER_PERSONAL_ACCOUNT_LINK_OPERATION_KEY,
    googleClientId: parsed.OPENSTEER_GOOGLE_CLIENT_ID,
    googleClientSecret: parsed.OPENSTEER_GOOGLE_CLIENT_SECRET,
    ...(hostedOAuthConfig(parsed) ? { hostedOAuth: hostedOAuthConfig(parsed)! } : {}),
    managedDeploymentDomain: parsed.OPENSTEER_MANAGED_DEPLOYMENT_DOMAIN,
    connectDomain: parsed.OPENSTEER_CONNECT_DOMAIN,
    ...(parsed.OPENSTEER_DESKTOP_DOWNLOAD_URL
      ? { desktopDownloadUrl: parsed.OPENSTEER_DESKTOP_DOWNLOAD_URL }
      : {}),
    connectCloudflare: {
      accountId: parsed.OPENSTEER_CONNECT_CLOUDFLARE_ACCOUNT_ID,
      apiToken: parsed.OPENSTEER_CONNECT_CLOUDFLARE_API_TOKEN,
      credentialDerivationSecret: parsed.OPENSTEER_CONNECT_CREDENTIAL_DERIVATION_SECRET,
      workersRouteBypass: parsed.OPENSTEER_CONNECT_CLOUDFLARE_WORKERS_ROUTE_BYPASS === "on",
      zoneId: parsed.OPENSTEER_CONNECT_CLOUDFLARE_ZONE_ID,
    },
    nativeOAuthClients: opensteerAccountNativeOAuthClients,
    ...(pushConfig(parsed) ? { push: pushConfig(parsed)! } : {}),
    listenHost: parsed.OPENSTEER_CONTROL_PLANE_HOST,
    listenPort: parsed.OPENSTEER_CONTROL_PLANE_PORT,
  } satisfies ControlPlaneConfig;
  assertNativeOAuthConfig(config);
  return config;
}

function pushConfig(parsed: z.infer<typeof AccountEnvironmentSchema>) {
  const values = [
    parsed.OPENSTEER_APNS_KEY_ID,
    parsed.OPENSTEER_APNS_TEAM_ID,
    parsed.OPENSTEER_APNS_PRIVATE_KEY,
    parsed.OPENSTEER_APNS_TOPIC,
  ];
  const hasApns = values.some((value) => value !== undefined);
  const serviceAccount = parsed.OPENSTEER_FCM_SERVICE_ACCOUNT_JSON;
  if (!hasApns && !serviceAccount) return undefined;
  if (hasApns && values.some((value) => value === undefined)) {
    throw new Error(
      "Push delivery requires the APNs key ID, team ID, private key and topic together",
    );
  }
  return {
    ...(hasApns
      ? {
          apns: {
            keyId: parsed.OPENSTEER_APNS_KEY_ID!,
            privateKeyPem: parsed.OPENSTEER_APNS_PRIVATE_KEY!,
            teamId: parsed.OPENSTEER_APNS_TEAM_ID!,
            topic: parsed.OPENSTEER_APNS_TOPIC!,
          },
        }
      : {}),
    ...(serviceAccount
      ? {
          fcm: {
            clientEmail: serviceAccount.client_email,
            privateKeyPem: serviceAccount.private_key,
            projectId: serviceAccount.project_id,
            tokenUri: serviceAccount.token_uri ?? "https://oauth2.googleapis.com/token",
          },
        }
      : {}),
  };
}

function hostedOAuthConfig(parsed: z.infer<typeof AccountEnvironmentSchema>) {
  const discord = providerApplicationConfig("Discord", {
    clientId: parsed.OPENSTEER_HOSTED_OAUTH_DISCORD_CLIENT_ID,
    clientSecret: parsed.OPENSTEER_HOSTED_OAUTH_DISCORD_CLIENT_SECRET,
    revision: parsed.OPENSTEER_HOSTED_OAUTH_DISCORD_REVISION,
  });
  const github = providerApplicationConfig(
    "GitHub",
    {
      clientId: parsed.OPENSTEER_HOSTED_OAUTH_GITHUB_CLIENT_ID,
      clientSecret: parsed.OPENSTEER_HOSTED_OAUTH_GITHUB_CLIENT_SECRET,
      installationUrl: parsed.OPENSTEER_HOSTED_OAUTH_GITHUB_INSTALLATION_URL,
      revision: parsed.OPENSTEER_HOSTED_OAUTH_GITHUB_REVISION,
    },
    true,
  );
  const google = providerApplicationConfig("Google", {
    clientId: parsed.OPENSTEER_HOSTED_OAUTH_GOOGLE_CLIENT_ID,
    clientSecret: parsed.OPENSTEER_HOSTED_OAUTH_GOOGLE_CLIENT_SECRET,
    revision: parsed.OPENSTEER_HOSTED_OAUTH_GOOGLE_REVISION,
  });
  const slack = providerApplicationConfig("Slack", {
    clientId: parsed.OPENSTEER_HOSTED_OAUTH_SLACK_CLIENT_ID,
    clientSecret: parsed.OPENSTEER_HOSTED_OAUTH_SLACK_CLIENT_SECRET,
    revision: parsed.OPENSTEER_HOSTED_OAUTH_SLACK_REVISION,
  });
  const microsoft = providerApplicationConfig("Microsoft", {
    clientId: parsed.OPENSTEER_HOSTED_OAUTH_MICROSOFT_CLIENT_ID,
    clientSecret: parsed.OPENSTEER_HOSTED_OAUTH_MICROSOFT_CLIENT_SECRET,
    revision: parsed.OPENSTEER_HOSTED_OAUTH_MICROSOFT_REVISION,
  });
  const applications = [
    ...(discord ? [{ ...discord, provider: "discord" as const }] : []),
    ...(github ? [{ ...github, provider: "github" as const }] : []),
    ...(google ? [{ ...google, provider: "google" as const }] : []),
    ...(microsoft ? [{ ...microsoft, provider: "microsoft" as const }] : []),
    ...(slack ? [{ ...slack, provider: "slack" as const }] : []),
  ];
  const brokerKeys = [
    parsed.OPENSTEER_HOSTED_OAUTH_STATE_KEY,
    parsed.OPENSTEER_HOSTED_OAUTH_ENCRYPTION_KEY,
  ];
  if (applications.length === 0 && brokerKeys.every((value) => value === undefined))
    return undefined;
  if (brokerKeys.some((value) => value === undefined)) {
    throw new Error("Hosted OAuth providers require attempt-context and result-encryption keys");
  }
  return {
    applications,
    encryptionPrivateKey: parsed.OPENSTEER_HOSTED_OAUTH_ENCRYPTION_KEY!,
    attemptContextEncryptionKey: parsed.OPENSTEER_HOSTED_OAUTH_STATE_KEY!,
  };
}

function providerApplicationConfig(
  label: string,
  values: {
    readonly clientId: string | undefined;
    readonly clientSecret: string | undefined;
    readonly installationUrl?: string | undefined;
    readonly revision: number | undefined;
  },
  installationUrlRequired = false,
) {
  const entries = [
    values.clientId,
    values.clientSecret,
    values.revision,
    ...(installationUrlRequired ? [values.installationUrl] : []),
  ];
  if (entries.every((value) => value === undefined)) return undefined;
  if (entries.some((value) => value === undefined)) {
    throw new Error(
      `Hosted ${label} OAuth requires ${
        installationUrlRequired
          ? "client, secret, revision, and installation URL"
          : "client, secret, and revision"
      } configuration`,
    );
  }
  return {
    clientId: values.clientId!,
    clientSecret: values.clientSecret!,
    ...(values.installationUrl ? { installationUrl: values.installationUrl } : {}),
    revision: values.revision!,
  };
}

/** Prevents direct runtime construction from drifting from the signed registry. */
export function assertNativeOAuthConfig(config: ControlPlaneConfig): void {
  NativeOAuthClientSetSchema.parse(config.nativeOAuthClients);
  if (!isDeepStrictEqual(config.nativeOAuthClients, opensteerAccountNativeOAuthClients)) {
    throw new Error("nativeOAuthClients must equal the signed first-party Account registry");
  }
}
