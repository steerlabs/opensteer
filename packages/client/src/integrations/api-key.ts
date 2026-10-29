import type { AuthMethod } from "@opensteer/integration-core";
import type {
  ApiKeyDisclosure,
  IntegrationDefinitionSummaryView,
} from "@opensteer/integration-core/adapter";

/**
 * The key method a person can use now. Opensteer sends a key only by an
 * installed snapshot that discloses where it goes, so a definition without that
 * disclosure takes no key until it is installed again.
 */
export function connectableApiKeyMethod(
  definition: IntegrationDefinitionSummaryView,
): Extract<AuthMethod, { kind: "api-key" }> | null {
  if (definition.apiKey === null) return null;
  return (
    definition.authMethods.find(
      (method): method is Extract<AuthMethod, { kind: "api-key" }> => method.kind === "api-key",
    ) ?? null
  );
}

/** Public key setup instructions, custody and check facts from the installed snapshot. */
export function apiKeyDisclosure(definition: IntegrationDefinitionSummaryView) {
  if (definition.apiKey === null) return null;
  const setup = definition.setupUrl === undefined ? null : new URL(definition.setupUrl);
  const setupUrl =
    setup?.protocol === "https:" && !setup.username && !setup.password ? setup.href : null;
  const method = connectableApiKeyMethod(definition);
  const credential = method?.inputs.length === 1 ? method.inputs[0]!.label : "key";
  return {
    ...apiKeyFacts(definition.name, definition.apiKey),
    setupInstruction: {
      prefix: `Get your ${credential} ${setupUrl ? "at " : `in your ${definition.name} account`}`,
      suffix: ", then paste it here.",
    },
    setupUrl,
  };
}

/**
 * Where a key goes and whether it is checked, said the same way before an
 * integration is installed and beside the key field once it is.
 */
export function apiKeyFacts(name: string, apiKey: ApiKeyDisclosure) {
  const hosts = apiKey.destinations.map((origin) => new URL(origin).host);
  return {
    custody: `Your key is stored encrypted by your Opensteer and sent to ${hosts.join(", ")} when used.`,
    check: apiKey.check
      ? `Opensteer checks the key with ${name} before saving it.`
      : `${name} checks the key the first time it’s used.`,
  };
}
