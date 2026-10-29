import { z } from "zod";
import { OAuthTokenResponseIdentitySchema } from "@opensteer/integration-core";

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

export const OAuthBrokerAuthorizationContextSchema = z.strictObject({
  accountSubject: OAuthBrokerAccountSubjectSchema,
  attemptId: HostedOAuthAttemptIdSchema,
  deploymentAuthorityDigest: OAuthBrokerDigestSchema,
  authorizationDigest: OAuthBrokerDigestSchema,
  definitionId: z.string().min(1).max(64),
  expiresAt: IsoDateTimeSchema,
  providerApplicationRevision: z.number().int().positive(),
  schemaVersion: z.literal(1),
});

export const OAuthBrokerCallbackRelayContextSchema = z.strictObject({
  accountSubject: OAuthBrokerAccountSubjectSchema,
  attemptId: HostedOAuthAttemptIdSchema,
  authorizationDigest: OAuthBrokerDigestSchema,
  definitionId: z.string().min(1).max(64),
  deploymentAuthorityDigest: OAuthBrokerDigestSchema,
  expiresAt: IsoDateTimeSchema,
  providerApplicationId: z.string().regex(new RegExp(`^ipa_${uuidPattern}$`, "i")),
  providerApplicationRevision: z.number().int().positive(),
  redirectUrl: z.url(),
  schemaVersion: z.literal(1),
});

export const OAuthBrokerAuthorizationCodeBundleSchema = z.strictObject({
  code: z.string().min(1).max(131_072),
});

export const OAuthBrokerRefreshContextSchema = z.strictObject({
  authorizationDigest: OAuthBrokerDigestSchema,
  definitionId: z.string().min(1).max(64),
  deploymentAuthorityDigest: OAuthBrokerDigestSchema,
  expiresAt: IsoDateTimeSchema,
  providerApplicationRevision: z.number().int().positive(),
  schemaVersion: z.literal(1),
  transactionId: HostedOAuthRefreshTransactionIdSchema,
});

export const OAuthBrokerRevocationContextSchema = z.strictObject({
  accountSubject: OAuthBrokerAccountSubjectSchema,
  authorizationDigest: OAuthBrokerDigestSchema,
  definitionId: z.string().min(1).max(64),
  deploymentAuthorityDigest: OAuthBrokerDigestSchema,
  expiresAt: IsoDateTimeSchema,
  provider: OAuthBrokerProviderSchema,
  providerApplicationRevision: z.number().int().positive(),
  schemaVersion: z.literal(1),
  transactionId: HostedOAuthRevocationTransactionIdSchema,
});

export const OAuthBrokerRevocationCredentialSchema = z.strictObject({
  accessToken: z.string().min(1).max(131_072),
  refreshToken: z.string().min(1).max(131_072).optional(),
});

export const OAuthBrokerTokenBundleSchema = z.strictObject({
  accessToken: z.string().min(1).max(131_072),
  expiresAt: z.number().int().nonnegative().optional(),
  grantedScopes: z.array(z.string().min(1).max(256)).max(512),
  idToken: z.string().min(1).max(131_072).optional(),
  refreshToken: z.string().min(1).max(131_072).optional(),
  tokenType: z.string().min(1).max(128),
  tokenResponseIdentity: OAuthTokenResponseIdentitySchema.optional(),
});

export const CreateHostedOAuthAttemptRequestSchema = z.strictObject({
  accountSubject: OAuthBrokerAccountSubjectSchema,
  clientSurface: OAuthBrokerClientSurfaceSchema.default("web"),
  attemptId: HostedOAuthAttemptIdSchema,
  authorizationDigest: OAuthBrokerDigestSchema,
  definitionId: z.string().min(1).max(64),
  deploymentAuthorityDigest: OAuthBrokerDigestSchema,
  expiresAt: IsoDateTimeSchema,
  hostPublicKey: OAuthBrokerPublicKeySchema,
  provider: OAuthBrokerProviderSchema,
  providerApplicationRevision: z.number().int().positive(),
  returnPath: OAuthBrokerReturnPathSchema.optional(),
});
export type CreateHostedOAuthAttemptRequest = z.infer<typeof CreateHostedOAuthAttemptRequestSchema>;

export const CreateOAuthCallbackRelayRequestSchema = z.strictObject({
  accountSubject: OAuthBrokerAccountSubjectSchema,
  clientSurface: OAuthBrokerClientSurfaceSchema.default("web"),
  attemptId: HostedOAuthAttemptIdSchema,
  authorizationDigest: OAuthBrokerDigestSchema,
  authorizationUrl: z.url().max(262_144),
  clientId: z.string().min(1).max(2_048),
  definitionId: z.string().min(1).max(64),
  deploymentAuthorityDigest: OAuthBrokerDigestSchema,
  expiresAt: IsoDateTimeSchema,
  hostPublicKey: OAuthBrokerPublicKeySchema,
  provider: OAuthBrokerProviderSchema,
  providerApplicationId: z.string().regex(new RegExp(`^ipa_${uuidPattern}$`, "i")),
  providerApplicationRevision: z.number().int().positive(),
  returnPath: OAuthBrokerReturnPathSchema.optional(),
});
export type CreateOAuthCallbackRelayRequest = z.infer<typeof CreateOAuthCallbackRelayRequestSchema>;

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
  "catalog-version-skew",
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

export const AcknowledgeHostedOAuthResultRequestSchema = z.strictObject({
  attemptId: HostedOAuthAttemptIdSchema,
});
export const AcknowledgeHostedOAuthResultResponseSchema = z.strictObject({
  acknowledged: z.literal(true),
  attemptId: HostedOAuthAttemptIdSchema,
});

export const CreateHostedOAuthRefreshRequestSchema = z.strictObject({
  accountSubject: OAuthBrokerAccountSubjectSchema,
  authorizationDigest: OAuthBrokerDigestSchema,
  brokerSealedCredential: OAuthBrokerSealedEnvelopeSchema,
  definitionId: z.string().min(1).max(64),
  deploymentAuthorityDigest: OAuthBrokerDigestSchema,
  expiresAt: IsoDateTimeSchema,
  grantedScopes: z.array(z.string().min(1).max(256)).max(512),
  hostPublicKey: OAuthBrokerPublicKeySchema,
  provider: OAuthBrokerProviderSchema,
  providerApplicationRevision: z.number().int().positive(),
  transactionId: HostedOAuthRefreshTransactionIdSchema,
});

export const CreateHostedOAuthRefreshResponseSchema = z.strictObject({
  expiresAt: IsoDateTimeSchema,
  failureCode: HostedOAuthSafeFailureCodeSchema.nullable(),
  providerError: HostedOAuthProviderErrorSchema.nullable(),
  status: z.enum(["sealed", "failed"]),
  transactionId: HostedOAuthRefreshTransactionIdSchema,
});

export const CreateHostedOAuthRevocationRequestSchema = z.strictObject({
  accountSubject: OAuthBrokerAccountSubjectSchema,
  authorizationDigest: OAuthBrokerDigestSchema,
  brokerSealedCredential: OAuthBrokerSealedEnvelopeSchema,
  definitionId: z.string().min(1).max(64),
  deploymentAuthorityDigest: OAuthBrokerDigestSchema,
  expiresAt: IsoDateTimeSchema,
  provider: OAuthBrokerProviderSchema,
  providerApplicationRevision: z.number().int().positive(),
  transactionId: HostedOAuthRevocationTransactionIdSchema,
});
export type CreateHostedOAuthRevocationRequest = z.infer<
  typeof CreateHostedOAuthRevocationRequestSchema
>;

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

export const OAuthBrokerPublicMetadataSchema = z
  .object({
    callbackRelayProviders: z.array(OAuthBrokerProviderSchema).max(32).default([]),
    encryptionPublicKey: OAuthBrokerPublicKeySchema,
    installationUrls: z.record(OAuthBrokerProviderSchema, z.url()).default({}),
    issuer: z.url(),
    providerRevisions: z.record(OAuthBrokerProviderSchema, z.number().int().positive()),
  })
  .superRefine((metadata, context) => {
    for (const provider of Object.keys(metadata.installationUrls)) {
      if (metadata.providerRevisions[provider] === undefined) {
        context.addIssue({
          code: "custom",
          message: `Installation URL provider ${provider} has no provider revision`,
          path: ["installationUrls", provider],
        });
      }
    }
  });
