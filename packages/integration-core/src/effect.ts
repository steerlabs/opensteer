export type IntegrationToolEffect = "read" | "write";

export function integrationToolEffect(
  annotations: Readonly<Record<string, unknown>>,
): IntegrationToolEffect {
  return annotations.readOnlyHint === true ? "read" : "write";
}
