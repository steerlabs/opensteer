import { z } from "zod";

/** Closed set of execution families an integration definition may use. */
export const IntegrationAdapterKindSchema = z.enum(["computer", "graphql", "mcp", "openapi"]);
export type IntegrationAdapterKind = z.infer<typeof IntegrationAdapterKindSchema>;

export const IntegrationDefinitionIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/);
