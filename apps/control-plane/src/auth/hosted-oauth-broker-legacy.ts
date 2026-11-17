import type { IntegrationDefinition } from "@opensteer/integration-core";
import { authorizationDigest } from "@opensteer/integration-core/authorization-digest";
import { ControlPlaneError } from "../server/errors.js";

/**
 * The catalog definitions old Host requests named. The catalog no longer ships any service
 * definition, so every catalog-qualified request is refused; only plugin sign-in remains.
 */
const integrationDefinitions: readonly IntegrationDefinition[] = [];

export function legacyOAuthDefinition(provider: string, definitionId: string) {
  return integrationDefinitions.find(
    (definition) => definition.provider === provider && definition.id === definitionId,
  );
}

export function qualifiedLegacyOAuthDefinition(
  provider: string,
  definitionId: string,
  revision: number,
) {
  const definition = legacyOAuthDefinition(provider, definitionId);
  return definition?.hostedOAuth?.providerApplicationRevision === revision ? definition : undefined;
}

export function assertLegacyAuthorizationDigest(
  expected: string,
  definition: IntegrationDefinition,
): void {
  if (authorizationDigest(definition) !== expected) {
    throw new ControlPlaneError(
      "conflict",
      "Hosted OAuth catalog authorization definition is stale",
    );
  }
}
