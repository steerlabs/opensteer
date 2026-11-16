import { integrationSchemaDigest } from "./digest.js";

export const authorizationDigestVersion = 1;

/** Digest only the immutable definition fields that govern authorization. */
export function authorizationDigest(definition: unknown): string {
  const value = definition as Record<string, unknown>;
  return integrationSchemaDigest({
    authorizationDigestVersion,
    authMethods: authorizationContract(value.authMethods ?? []),
    hostedOAuth: value.hostedOAuth ?? null,
    id: value.id ?? null,
    provider: value.provider ?? null,
  });
}

/** Provider-facing account labels do not grant or constrain authority. */
function authorizationContract(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(authorizationContract);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "accountIdentifierPath")
      .map(([key, item]) => [key, authorizationContract(item)]),
  );
}
