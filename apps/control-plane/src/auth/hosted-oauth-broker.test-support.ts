import { integrationDefinitions } from "@opensteer/integration-catalog";
import type { HostedOAuthProviderApplication } from "./hosted-oauth-provider-registry.js";

export function brokerProviderFixture(
  provider: string,
): Pick<HostedOAuthProviderApplication, "oauth" | "allowedScopes"> {
  const methods = integrationDefinitions
    .filter((definition) => definition.provider === provider)
    .flatMap((definition) => definition.authMethods.filter((method) => method.kind === "oauth"));
  const method = methods[0];
  if (!method) throw new Error(`Missing OAuth fixture for ${provider}`);
  return {
    oauth: method.oauth,
    allowedScopes: [...new Set(methods.flatMap((entry) => entry.oauth.scopes))],
  };
}
