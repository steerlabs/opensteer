import { integrationSchemaDigest } from "./digest.js";
import { accessCoversEffect } from "./effect.js";
import { createIntegrationId, type IntegrationConnectionId } from "./ids.js";
import type { ComputerAppDefinition, ComputerAppOperation } from "./computer-app.js";
import type { IntegrationAccess, IntegrationToolMaterial } from "./models.js";

/**
 * The digest the Host and the Runner compare before an operation runs.
 *
 * A tool row's `schemaDigest` covers schemas only, so an operation that changed
 * from read to write would keep it; this one covers the effect too, which is
 * what makes two builds unable to disagree about whether an operation writes.
 */
export function computerAppOperationContract(operation: ComputerAppOperation): string {
  return integrationSchemaDigest({
    effect: operation.effect,
    inputSchema: operation.inputSchema,
    name: operation.name,
    outputSchema: operation.outputSchema,
  });
}

/** Produces the same connection-scoped rows the Host persists for discovered adapter tools. */
export function computerAppTools(
  definition: ComputerAppDefinition,
  access: IntegrationAccess,
  connectionId: IntegrationConnectionId,
  blockedAt: string | null = null,
): readonly IntegrationToolMaterial[] {
  if (blockedAt !== null) return [];
  return definition.config.operations
    .filter((operation) => accessCoversEffect(access, operation.effect))
    .map((operation) => ({
      annotations: { readOnlyHint: operation.effect === "read" },
      connectionId,
      description: operation.description,
      id: createIntegrationId("tool"),
      inputSchema: operation.inputSchema,
      name: operation.name,
      outputSchema: operation.outputSchema,
      status: "active",
      title: operation.title,
    }));
}
