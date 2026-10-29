import type { IntegrationAccess } from "./models.js";

export type IntegrationToolEffect = "read" | "write";

export function integrationToolEffect(
  annotations: Readonly<Record<string, unknown>>,
): IntegrationToolEffect {
  return annotations.readOnlyHint === true ? "read" : "write";
}

export function accessCoversEffect(
  access: IntegrationAccess,
  effect: IntegrationToolEffect,
): boolean {
  return access === "read-write" || effect === "read";
}

/** Whether holding `held` already allows everything `wanted` asks for. */
export function integrationAccessCovers(
  held: IntegrationAccess,
  wanted: IntegrationAccess,
): boolean {
  return accessCoversEffect(held, wanted === "read-write" ? "write" : "read");
}

/** The wider of two access levels, which covers both. */
export function widerIntegrationAccess(
  first: IntegrationAccess,
  second: IntegrationAccess,
): IntegrationAccess {
  return integrationAccessCovers(first, second) ? first : second;
}
