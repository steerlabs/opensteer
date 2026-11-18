import { z } from "zod";
import type { IntegrationToolEffect } from "./effect.js";

/** How much one grant, connection or Run may do: read only, or read and write. */
export const IntegrationAccessSchema = z.enum(["read", "read-write"]);
export type IntegrationAccess = z.infer<typeof IntegrationAccessSchema>;

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
