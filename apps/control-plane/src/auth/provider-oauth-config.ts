import { z } from "zod";

export const OAuthIdentitySourceSchema = z.strictObject({
  accountIdentifierPath: z.string().min(1).max(256).optional(),
  displayNamePath: z.string().min(1).max(256).optional(),
  identityPath: z.string().min(1).max(256),
  source: z.enum(["token-response", "userinfo"]),
  tenantPath: z.string().min(1).max(256).optional(),
  userinfoUrl: z.url().optional(),
});

export const OAuthClientAuthSchema = z.enum(["basic", "body", "none"]);

/**
 * A closed set of token-endpoint response contracts that differ from the
 * OAuth bearer-token response. Profiles are deliberately named semantics,
 * not field-mapping instructions: each one is reviewed and implemented by the
 * shared OAuth engine.
 */
export const OAuthTokenResponseProfileSchema = z.enum(["standard", "slack-bot"]);
export type OAuthTokenResponseProfile = z.infer<typeof OAuthTokenResponseProfileSchema>;
export const OAuthIdTokenValidationSchema = z.enum(["issuer", "ignore"]);
export type OAuthIdTokenValidation = z.infer<typeof OAuthIdTokenValidationSchema>;

export const OAuthRevocationConfigSchema = z.strictObject({
  clientAuth: OAuthClientAuthSchema,
  errorPath: z.string().min(1).max(256).optional(),
  ignoredErrors: z.array(z.string().min(1).max(256)).max(8).optional(),
  method: z.enum(["delete-json", "post-form"]),
  successPath: z.string().min(1).max(256).optional(),
  tokenField: z.string().min(1).max(128),
  tokenSource: z.enum(["access-token", "refresh-token-preferred"]),
  url: z.string().min(1).max(2_048),
});

/**
 * The broker registry owns provider request settings and response profiles.
 */
const OAuthMethodConfigObjectSchema = z.strictObject({
  authorizationUrl: z.url(),
  clientAuth: OAuthClientAuthSchema,
  extraAuthorizeParams: z.record(z.string().max(64), z.string().max(512)).optional(),
  idTokenValidation: OAuthIdTokenValidationSchema.optional(),
  identity: OAuthIdentitySourceSchema,
  issuer: z.url().optional(),
  revocation: OAuthRevocationConfigSchema.optional(),
  /** Provider aliases for equivalent returned scopes, keyed by canonical scope. */
  scopeAliases: z
    .record(z.string().min(1).max(256), z.array(z.string().min(1).max(256)))
    .optional(),
  scopeSeparator: z.string().min(1).max(4).default(" "),
  /** The complete fixed consent set requested by this OAuth method. */
  scopes: z.array(z.string().min(1).max(256)).max(256),
  tokenUrl: z.url(),
  tokenResponseProfile: OAuthTokenResponseProfileSchema.optional(),
  usesPkce: z.boolean(),
});
export const OAuthMethodConfigSchema = OAuthMethodConfigObjectSchema.superRefine(
  (config, context) => {
    if (config.idTokenValidation === "ignore" && config.identity.source !== "userinfo") {
      context.addIssue({
        code: "custom",
        message: "Ignoring ID tokens requires userinfo to be the identity authority",
        path: ["idTokenValidation"],
      });
    }
  },
);
export type OAuthMethodConfig = z.infer<typeof OAuthMethodConfigSchema>;
