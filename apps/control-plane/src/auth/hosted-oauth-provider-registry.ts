import { z } from "zod";
import { OAuthMethodConfigSchema, type OAuthMethodConfig } from "@opensteer/integration-core";
import {
  OAuthBrokerProviderSchema,
  OAuthBrokerManagedPlacementSchema,
} from "@opensteer/control-plane-protocol";

const HttpsEndpointSchema = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.hash;
}, "Expected an HTTPS provider endpoint");
const ScopeSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\x21\x23-\x5B\x5D-\x7E]+$/u);

const ProviderFieldsSchema = z.strictObject({
  provider: OAuthBrokerProviderSchema,
  revision: z.number().int().positive(),
  installationUrl: z.url().optional(),
  allowedScopes: z.array(ScopeSchema).max(512),
  oauth: OAuthMethodConfigSchema,
  placement: OAuthBrokerManagedPlacementSchema.optional(),
});

function validateProvider(
  application: z.infer<typeof ProviderFieldsSchema> & { readonly clientId?: string },
  context: z.RefinementCtx,
) {
  const config = application.oauth;
  const endpoints = [
    config.authorizationUrl,
    config.tokenUrl,
    config.issuer,
    config.revocation?.url,
    config.identity.userinfoUrl,
  ].filter((value) => value !== undefined);
  if (endpoints.some((value) => !HttpsEndpointSchema.safeParse(value).success)) {
    context.addIssue({ code: "custom", message: "Provider endpoints must use HTTPS" });
  }
  if (
    Object.keys(config.extraAuthorizeParams ?? {}).some((name) =>
      [
        "client_id",
        "redirect_uri",
        "response_type",
        "scope",
        "state",
        "code_challenge",
        "code_challenge_method",
      ].includes(name),
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "Provider authorization parameters cannot replace protocol bindings",
    });
  }
  if (
    new Set(application.allowedScopes).size !== application.allowedScopes.length ||
    application.allowedScopes.some((scope) => scope.includes(config.scopeSeparator)) ||
    config.scopes.some((scope) => !application.allowedScopes.includes(scope))
  ) {
    context.addIssue({
      code: "custom",
      message: "Provider scopes must be unique and within the allowed set",
    });
  }
  if (
    application.provider === "github" &&
    application.clientId !== undefined &&
    (!application.installationUrl ||
      !/^https:\/\/github\.com\/apps\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/installations\/new$/u.test(
        application.installationUrl,
      ))
  ) {
    context.addIssue({
      code: "custom",
      message: "Hosted OAuth GitHub requires its exact installation URL",
    });
  }
  if (
    application.provider === "slack" &&
    (config.tokenResponseProfile !== "slack-bot" ||
      config.usesPkce ||
      config.clientAuth !== "body" ||
      config.scopeSeparator !== "," ||
      config.identity.source !== "token-response" ||
      config.identity.identityPath !== "bot_user_id" ||
      config.identity.tenantPath !== "team.id")
  ) {
    context.addIssue({ code: "custom", message: "Slack requires a confidential bot grant" });
  }
  if (
    application.provider === "microsoft" &&
    (config.identity.source !== "userinfo" ||
      config.idTokenValidation !== "ignore" ||
      config.revocation ||
      application.allowedScopes.some((scope) => scope.endsWith(".default")))
  ) {
    context.addIssue({
      code: "custom",
      message: "Microsoft requires delegated scopes and userinfo identity",
    });
  }
}

export const HostedOAuthProviderApplicationSchema = ProviderFieldsSchema.extend({
  clientId: z.string().min(1).max(2_048),
  clientSecret: z.string().min(1).max(131_072),
}).superRefine(validateProvider);
const HostedOAuthRelayProviderSchema = ProviderFieldsSchema.extend({
  relayOnly: z.literal(true),
}).superRefine(validateProvider);
export type HostedOAuthProvider =
  | z.infer<typeof HostedOAuthProviderApplicationSchema>
  | z.infer<typeof HostedOAuthRelayProviderSchema>;
export type HostedOAuthProviderApplication = z.infer<typeof HostedOAuthProviderApplicationSchema>;

export const HostedOAuthProviderRegistrySchema = z
  .array(z.union([HostedOAuthProviderApplicationSchema, HostedOAuthRelayProviderSchema]))
  .max(32)
  .superRefine((entries, context) => {
    if (new Set(entries.map((entry) => entry.provider)).size !== entries.length) {
      context.addIssue({
        code: "custom",
        message: "Hosted OAuth provider applications must be unique by provider",
      });
    }
  });

export function registryOAuthConfig(
  application: HostedOAuthProviderApplication,
  scopes: readonly string[],
): OAuthMethodConfig {
  if (scopes.some((scope) => !application.allowedScopes.includes(scope))) {
    throw new TypeError("Requested OAuth scopes exceed the provider registry");
  }
  return { ...application.oauth, scopes: [...scopes] };
}
