import { z } from "zod";

const VariableNameSchema = z.string().regex(/^[a-z][A-Za-z0-9]{0,63}$/);
const AuthMethodIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/);

/**
 * Where one credential value lands on an outbound request. A credential is a
 * map of named values; placements are the only mechanism that turns those
 * values into request material. Values are never pre-rendered into headers at
 * rest — rendering happens per call, so rotation and refresh never leave
 * stale composites behind.
 */
const authPlacementBase = {
  carrier: z.enum(["env", "header", "query"]),
  name: z.string().min(1).max(256),
  prefix: z.string().max(64).optional(),
};

export const AuthPlacementSchema = z.union([
  z.strictObject({
    ...authPlacementBase,
    literal: z.string().min(1).max(4_096),
  }),
  z.strictObject({
    ...authPlacementBase,
    variable: VariableNameSchema,
  }),
  z.strictObject({
    ...authPlacementBase,
    encoding: z.literal("base64"),
    separator: z.string().max(16),
    variables: z.array(VariableNameSchema).min(2).max(8),
  }),
]);
const AuthPlacementViewSchema = z.union([
  z.object(AuthPlacementSchema.options[0].shape),
  z.object(AuthPlacementSchema.options[1].shape),
  z.object(AuthPlacementSchema.options[2].shape),
]);
export type AuthPlacement = z.infer<typeof AuthPlacementSchema>;

/** A value the user (or the OAuth engine) supplies for an auth method. */
export const AuthMethodInputSchema = z.strictObject({
  description: z.string().min(1).max(240).optional(),
  label: z.string().min(1).max(80),
  placeholder: z.string().min(1).max(120).optional(),
  secret: z.boolean(),
  variable: VariableNameSchema,
});
const AuthMethodInputViewSchema = z.object(AuthMethodInputSchema.shape);
export type AuthMethodInput = z.infer<typeof AuthMethodInputSchema>;

/**
 * Declarative extraction of the external account identity after authorization
 * completes. `source` names the JSON document to read; paths are dot-separated
 * object paths into it. This exists so reconnecting the same external account
 * updates the existing connection instead of duplicating it.
 */
export const OAuthIdentitySourceSchema = z.strictObject({
  accountIdentifierPath: z.string().min(1).max(256).optional(),
  displayNamePath: z.string().min(1).max(256).optional(),
  identityPath: z.string().min(1).max(256),
  source: z.enum(["token-response", "userinfo"]),
  tenantPath: z.string().min(1).max(256).optional(),
  userinfoUrl: z.url().optional(),
});
const OAuthIdentitySourceViewSchema = z.object(OAuthIdentitySourceSchema.shape);

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

/** Provider identity selected from a validated token response. */
export const OAuthTokenResponseIdentitySchema = z.strictObject({
  accountIdentifier: z.string().min(1).max(2_048).optional(),
  displayName: z.string().min(1).max(2_048).optional(),
  externalIdentityId: z.string().min(1).max(2_048),
  externalTenantId: z.string().min(1).max(2_048).optional(),
});
export type OAuthTokenResponseIdentity = z.infer<typeof OAuthTokenResponseIdentitySchema>;

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
const OAuthRevocationConfigViewSchema = z.object(OAuthRevocationConfigSchema.shape);

/**
 * Everything the shared OAuth engine needs to run a provider's flow. The
 * catalog selects request settings and reviewed response profiles explicitly.
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
const OAuthMethodConfigViewSchema = z.object({
  ...OAuthMethodConfigObjectSchema.shape,
  identity: OAuthIdentitySourceViewSchema,
  revocation: OAuthRevocationConfigViewSchema.optional(),
});
export type OAuthMethodConfig = z.infer<typeof OAuthMethodConfigSchema>;

const authMethodBase = {
  id: AuthMethodIdSchema,
  label: z.string().min(1).max(80),
  placements: z.array(AuthPlacementSchema).min(1).max(8),
};

export const AuthMethodSchema = z.discriminatedUnion("kind", [
  /** User pastes named values (API keys, tokens, multi-key auth). */
  z.strictObject({
    ...authMethodBase,
    inputs: z.array(AuthMethodInputSchema).min(1).max(8),
    kind: z.literal("api-key"),
  }),
  /**
   * The OAuth engine manages the values. `inputs` is fixed by convention:
   * the engine maintains `accessToken` (and internally refreshToken); the
   * default placement is `Authorization: Bearer <accessToken>`.
   */
  z.strictObject({
    ...authMethodBase,
    kind: z.literal("oauth"),
    oauth: OAuthMethodConfigSchema,
  }),
  /** Remote MCP server authorization via RFC 8414 discovery + RFC 7591 DCR. */
  z.strictObject({
    id: AuthMethodIdSchema,
    kind: z.literal("mcp-oauth"),
    label: z.string().min(1).max(80),
  }),
  /** The service requires no credential at all. */
  z.strictObject({
    id: AuthMethodIdSchema,
    kind: z.literal("none"),
    label: z.string().min(1).max(80),
  }),
  /** Authority comes from one enrolled computer rather than a credential. */
  z.strictObject({
    id: AuthMethodIdSchema,
    kind: z.literal("computer"),
    label: z.string().min(1).max(80),
  }),
]);
export const AuthMethodViewSchema = z.discriminatedUnion("kind", [
  z.object({
    ...AuthMethodSchema.options[0].shape,
    inputs: z.array(AuthMethodInputViewSchema).min(1).max(8),
    placements: z.array(AuthPlacementViewSchema).min(1).max(8),
  }),
  z.object({
    ...AuthMethodSchema.options[1].shape,
    oauth: OAuthMethodConfigViewSchema,
    placements: z.array(AuthPlacementViewSchema).min(1).max(8),
  }),
  z.object(AuthMethodSchema.options[2].shape),
  z.object(AuthMethodSchema.options[3].shape),
  z.object(AuthMethodSchema.options[4].shape),
]);
export type AuthMethod = z.infer<typeof AuthMethodSchema>;

export const bearerAccessTokenPlacement: AuthPlacement = {
  carrier: "header",
  name: "Authorization",
  prefix: "Bearer ",
  variable: "accessToken",
};

interface RenderedAuthPlacements {
  readonly env: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
}

/**
 * Render placements against resolved credential values. Throws when a
 * referenced variable is absent — a missing credential value is a caller bug
 * or a revoked credential, never something to silently skip.
 */
export function renderAuthPlacements(
  placements: readonly AuthPlacement[],
  values: Readonly<Record<string, string>>,
): RenderedAuthPlacements {
  const rendered = { env: {}, headers: {}, query: {} } as {
    env: Record<string, string>;
    headers: Record<string, string>;
    query: Record<string, string>;
  };
  for (const placement of placements) {
    let value: string;
    if ("literal" in placement) {
      value = placement.literal;
    } else if ("variable" in placement) {
      const resolved = values[placement.variable];
      if (resolved === undefined) {
        throw new Error(
          `auth placement references missing credential value "${placement.variable}"`,
        );
      }
      value = resolved;
    } else {
      const parts = placement.variables.map((variable) => {
        const resolved = values[variable];
        if (resolved === undefined) {
          throw new Error(`auth placement references missing credential value "${variable}"`);
        }
        return resolved;
      });
      value = base64Utf8(parts.join(placement.separator));
    }
    const composed = `${placement.prefix ?? ""}${value}`;
    if (placement.carrier === "header") {
      rendered.headers[placement.name] = composed;
    } else if (placement.carrier === "query") {
      rendered.query[placement.name] = composed;
    } else {
      rendered.env[placement.name] = composed;
    }
  }
  return rendered;
}

function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
