// Derived from github.com/UsefulSoftwareCo/executor packages/plugins/graphql/src/sdk/types.ts (MIT).
import { z } from "zod";

export const GraphqlAdapterConfigSchema = z.strictObject({
  endpoint: z.url(),
  healthCheck: z
    .strictObject({
      accountIdentifierPath: z.string().min(1).optional(),
      displayNamePath: z.string().min(1).optional(),
      identityPath: z.string().min(1).optional(),
      query: z.string().min(1),
      tenantPath: z.string().min(1).optional(),
      variables: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  introspection: z.record(z.string(), z.unknown()).optional(),
  operationFilter: z
    .strictObject({
      include: z.array(z.string().min(1).max(256)).min(1).max(2_000),
    })
    .optional(),
  timeoutMs: z.number().int().positive().max(120_000).default(30_000),
});

export type GraphqlAdapterConfig = z.infer<typeof GraphqlAdapterConfigSchema>;
