import { integrationDefinitions } from "@opensteer/integration-catalog";
import type { IntegrationDefinition } from "@opensteer/integration-core";
import { authorizationDigest } from "@opensteer/integration-core/authorization-digest";
import { ControlPlaneError } from "../server/errors.js";

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
