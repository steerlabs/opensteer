import { z } from "zod";
import { IntegrationAuthorizationReturnPortSchema } from "@opensteer/integration-core";

export const oauthBrokerMetadataVersion = "4";
export const oauthBrokerManagedTokenContextVersion = 3;

const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const digestPattern = /^[A-Za-z0-9_-]{43}$/u;
const secretPattern = /^[A-Za-z0-9_-]{43}$/u;
const IsoDateTimeSchema = z.iso.datetime({ offset: true });
export const OAuthBrokerReturnPathSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine((value) => value.startsWith("/") && !value.startsWith("//"), "Expected a relative path");
export const OAuthBrokerClientSurfaceSchema = z.enum(["desktop", "native", "web"]);
const ControlPlaneAccountIdSchema = z
  .string()
  .regex(new RegExp(`^acct_${uuidPattern}$`, "i"))
  .brand<"ControlPlaneAccountId">();

function brokerIdSchema<Prefix extends string, Brand extends string>(prefix: Prefix) {
  return z
    .string()
    .regex(new RegExp(`^${prefix}_${uuidPattern}$`, "i"))
    .brand<Brand>();
}

export const HostedOAuthAttemptIdSchema = brokerIdSchema<"hoa", "HostedOAuthAttemptId">("hoa");
export type HostedOAuthAttemptId = z.infer<typeof HostedOAuthAttemptIdSchema>;
export const HostedOAuthRefreshTransactionIdSchema = brokerIdSchema<
  "hor",
  "HostedOAuthRefreshTransactionId"
>("hor");
export type HostedOAuthRefreshTransactionId = z.infer<typeof HostedOAuthRefreshTransactionIdSchema>;
export const HostedOAuthRevocationTransactionIdSchema = brokerIdSchema<
  "hov",
  "HostedOAuthRevocationTransactionId"
>("hov");
export type HostedOAuthRevocationTransactionId = z.infer<
  typeof HostedOAuthRevocationTransactionIdSchema
>;

export const OAuthBrokerDigestSchema = z.string().regex(digestPattern);
export const OAuthBrokerProviderSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9.-]*$/u);
export const OAuthBrokerPublicKeySchema = z.string().regex(secretPattern);

export const OAuthBrokerSealedEnvelopeSchema = z.strictObject({
  ciphertext: z
    .string()
    .min(1)
    .max(262_144)
    .regex(/^[A-Za-z0-9_-]+$/u),
  ephemeralPublicKey: OAuthBrokerPublicKeySchema,
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16}$/u),
  tag: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
  version: z.literal(1),
});
export type OAuthBrokerSealedEnvelope = z.infer<typeof OAuthBrokerSealedEnvelopeSchema>;

export const OAuthBrokerAccountSubjectSchema = z.strictObject({
  issuer: z.url(),
  subject: ControlPlaneAccountIdSchema,
});

export const OAuthBrokerAuthorizationResponseSchema = z.strictObject({
  parameters: z.array(z.tuple([z.string().max(256), z.string().max(131_072)])).max(32),
});

export const OAuthBrokerRevocationCredentialSchema = z.strictObject({
  accessToken: z.string().min(1).max(131_072),
  refreshToken: z.string().min(1).max(131_072).optional(),
});

export const OAuthBrokerTokenBundleSchema = z.strictObject({
  accessToken: z.string().min(1).max(131_072),
  expiresAt: z.number().int().nonnegative().optional(),
  grantedScopes: z.array(z.string().min(1).max(256)).max(512),
  refreshToken: z.string().min(1).max(131_072).optional(),
  tokenType: z.string().min(1).max(128),
});

/**
 * `app`: the attempt finishes in the desktop or native app that started it. Its
 * launch needs no Account browser session; the callback holds the sealed result
 * and returns a one-use proof to the app, which its Host redeems through
 * `/return`. Without it the browser's Account session proves the requester.
 */
export const OAuthBrokerFinishSchema = z.literal("app");

export const CreateHostedOAuthAttemptResponseSchema = z.strictObject({
  attemptId: HostedOAuthAttemptIdSchema,
  expiresAt: IsoDateTimeSchema,
  launchUrl: z.url(),
});

const HostedOAuthAttemptStatusSchema = z.enum([
  "pending",
  "launched",
  "sealed",
  "acknowledged",
  "denied",
  "failed",
  "expired",
]);
export const HostedOAuthSafeFailureCodeSchema = z.enum([
  "account-link-mismatch",
  "authorization-denied",
  "invalid-provider-response",
  "provider-exchange-failed",
  "scope-escalation",
  "stale-provider-application",
  "grant-rejected",
  "client-rejected",
]);

/**
 * The provider's own RFC 6749 error code, bounded and passed through untouched. It is a
 * diagnostic beside the classified failure code, never the thing a caller branches on.
 */
export const HostedOAuthProviderErrorSchema = z.string().regex(/^[a-z0-9_]{1,64}$/u);

export const HostedOAuthAttemptStatusResponseSchema = z.strictObject({
  attemptId: HostedOAuthAttemptIdSchema,
  expiresAt: IsoDateTimeSchema,
  failureCode: HostedOAuthSafeFailureCodeSchema.nullable(),
  retryGeneration: z.number().int().nonnegative(),
  status: HostedOAuthAttemptStatusSchema,
});

export const PullHostedOAuthResultResponseSchema = HostedOAuthAttemptStatusResponseSchema.extend({
  sealedResult: OAuthBrokerSealedEnvelopeSchema.nullable(),
}).strict();

/** The app's browser return, redeemed once by the attempt's own Host. */
export const ReturnHostedOAuthAttemptRequestSchema = z.strictObject({
  attemptId: HostedOAuthAttemptIdSchema,
  returnProof: z.string().regex(secretPattern),
});
export const ReturnHostedOAuthAttemptResponseSchema = HostedOAuthAttemptStatusResponseSchema;

export const AcknowledgeHostedOAuthResultRequestSchema = z.strictObject({
  attemptId: HostedOAuthAttemptIdSchema,
});
export const AcknowledgeHostedOAuthResultResponseSchema = z.strictObject({
  acknowledged: z.literal(true),
  attemptId: HostedOAuthAttemptIdSchema,
});

export const CreateHostedOAuthRefreshResponseSchema = z.strictObject({
  expiresAt: IsoDateTimeSchema,
  failureCode: HostedOAuthSafeFailureCodeSchema.nullable(),
  providerError: HostedOAuthProviderErrorSchema.nullable(),
  status: z.enum(["sealed", "failed"]),
  transactionId: HostedOAuthRefreshTransactionIdSchema,
});

export const CreateHostedOAuthRevocationResponseSchema = z.strictObject({
  revoked: z.literal(true),
  transactionId: HostedOAuthRevocationTransactionIdSchema,
});

export const PullHostedOAuthRefreshResponseSchema = z.strictObject({
  expiresAt: IsoDateTimeSchema,
  failureCode: HostedOAuthSafeFailureCodeSchema.nullable(),
  providerError: HostedOAuthProviderErrorSchema.nullable(),
  sealedResult: OAuthBrokerSealedEnvelopeSchema.nullable(),
  status: z.enum(["sealed", "acknowledged", "failed", "expired"]),
  transactionId: HostedOAuthRefreshTransactionIdSchema,
});

export const AcknowledgeHostedOAuthRefreshRequestSchema = z.strictObject({
  transactionId: HostedOAuthRefreshTransactionIdSchema,
});

export const OAuthBrokerManagedPlacementSchema = z.strictObject({
  hosts: z
    .array(
      z
        .string()
        .regex(
          /^(\*\.)?[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*(?::[0-9]{1,5})?$/u,
        ),
    )
    .min(1),
  header: z
    .string()
    .regex(/^[!#$%&'*+.^_`|~0-9a-z-]+$/u)
    .optional(),
  scheme: z
    .string()
    .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u)
    .nullable()
    .optional(),
});

export const OAuthBrokerPublicMetadataSchema = z
  .object({
    pluginProviders: z.record(
      OAuthBrokerProviderSchema,
      z.strictObject({
        revision: z.number().int().positive(),
        authorizationUrl: z.url(),
        tokenUrl: z.url(),
        revocationUrl: z.url().optional(),
        allowedScopes: z.array(z.string().min(1).max(256)).max(512),
        scopeSeparator: z.string().min(1).max(4),
        placement: OAuthBrokerManagedPlacementSchema.optional(),
      }),
    ),
    pluginOAuth: z.literal(1),
    pluginCallbackRelay: z.literal(1).optional(),
    /** The broker accepts `finish: "app"` attempts and their `/return`. */
    appFinish: z.literal(1),
    /** The broker accepts `appReturnPort`; a Host drops the port otherwise. */
    appReturnPort: z.literal(1),
    encryptionPublicKey: OAuthBrokerPublicKeySchema,
    installationUrls: z.record(OAuthBrokerProviderSchema, z.url()).default({}),
    issuer: z.url(),
  })
  .superRefine((metadata, context) => {
    for (const provider of Object.keys(metadata.installationUrls)) {
      if (metadata.pluginProviders[provider] === undefined) {
        context.addIssue({
          code: "custom",
          message: `Installation URL provider ${provider} has no managed plugin registration`,
          path: ["installationUrls", provider],
        });
      }
    }
  });

/** Plugin requirements are reviewed on the Host; provider scope authority belongs to the broker registry. */
export const OAuthBrokerPluginBindingSchema = z.strictObject({
  accountSubject: OAuthBrokerAccountSubjectSchema,
  accountLinkGeneration: OAuthBrokerDigestSchema,
  deploymentAuthorityDigest: OAuthBrokerDigestSchema,
  hostPublicKey: OAuthBrokerPublicKeySchema,
  requirementDigest: OAuthBrokerDigestSchema,
  redirectUrl: z.url(),
});
export const OAuthBrokerPluginProviderSchema = z.strictObject({
  provider: OAuthBrokerProviderSchema,
  registryRevision: z.number().int().positive(),
  requestedScopes: z.array(z.string().min(1).max(256)).max(512),
  binding: OAuthBrokerPluginBindingSchema,
});
const PluginAuthorizationFieldsSchema = OAuthBrokerPluginProviderSchema.extend({
  attemptId: HostedOAuthAttemptIdSchema,
  expiresAt: IsoDateTimeSchema,
});
export const OAuthBrokerPluginAuthorizationContextSchema = PluginAuthorizationFieldsSchema.extend({
  schemaVersion: z.literal(oauthBrokerManagedTokenContextVersion),
}).strict();
export const CreatePluginOAuthAttemptRequestSchema = PluginAuthorizationFieldsSchema.extend({
  kind: z.literal("plugin"),
  clientSurface: OAuthBrokerClientSurfaceSchema.default("web"),
  finish: OAuthBrokerFinishSchema.optional(),
  appReturnPort: IntegrationAuthorizationReturnPortSchema.optional(),
  returnPath: OAuthBrokerReturnPathSchema.optional(),
}).strict();
export type CreatePluginOAuthAttemptRequest = z.infer<typeof CreatePluginOAuthAttemptRequestSchema>;

/** Custom clients, including discovered MCP servers, retain exchange and PKCE exclusively on the Host. */
export const OAuthBrokerPluginRelaySchema = z.strictObject({
  clientId: z.string().min(1).max(2_048),
  issuer: z.url().nullable(),
  authorizationEndpoint: z.url(),
  authorizationResponseIssuerParameterSupported: z.boolean(),
  usesPkce: z.boolean(),
  scopeSeparator: z.string().min(1).max(4),
});
export const CreatePluginOAuthCallbackRelayRequestSchema =
  CreatePluginOAuthAttemptRequestSchema.extend({
    kind: z.literal("plugin-relay"),
    authorizationUrl: z.url().max(262_144),
    relay: OAuthBrokerPluginRelaySchema,
  }).strict();
export const OAuthBrokerPluginRelayContextSchema = PluginAuthorizationFieldsSchema.extend({
  relay: OAuthBrokerPluginRelaySchema,
  schemaVersion: z.literal(2),
}).strict();
const PluginRenewalFieldsSchema = OAuthBrokerPluginProviderSchema.extend({
  expiresAt: IsoDateTimeSchema,
});
export const OAuthBrokerPluginRefreshContextSchema = PluginRenewalFieldsSchema.extend({
  schemaVersion: z.literal(oauthBrokerManagedTokenContextVersion),
  transactionId: HostedOAuthRefreshTransactionIdSchema,
}).strict();
export const CreatePluginOAuthRefreshRequestSchema = OAuthBrokerPluginRefreshContextSchema.omit({
  schemaVersion: true,
})
  .extend({
    kind: z.literal("plugin"),
    brokerSealedCredential: OAuthBrokerSealedEnvelopeSchema,
    grantedScopes: z.array(z.string().min(1).max(256)).max(512),
  })
  .strict();
export const OAuthBrokerPluginRevocationContextSchema = PluginRenewalFieldsSchema.extend({
  schemaVersion: z.literal(2),
  transactionId: HostedOAuthRevocationTransactionIdSchema,
}).strict();
export const CreatePluginOAuthRevocationRequestSchema =
  OAuthBrokerPluginRevocationContextSchema.omit({ schemaVersion: true })
    .extend({
      kind: z.literal("plugin"),
      brokerSealedCredential: OAuthBrokerSealedEnvelopeSchema,
    })
    .strict();
