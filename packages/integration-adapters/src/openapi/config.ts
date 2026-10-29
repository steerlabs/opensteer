// Derived from github.com/UsefulSoftwareCo/executor packages/plugins/openapi/src/sdk/config.ts (MIT).
import { z } from "zod";

const HttpMethodSchema = z.enum([
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "trace",
]);

/** What one OpenAPI tool runs: its operation's method and path template in the stored document. */
export const OpenApiToolTargetSchema = z.strictObject({
  method: HttpMethodSchema,
  path: z.string().min(1),
});
export type OpenApiToolTarget = z.infer<typeof OpenApiToolTargetSchema>;

export const OperationSelectorSchema = z.strictObject({
  method: z.union([HttpMethodSchema, z.array(HttpMethodSchema).min(1)]).optional(),
  operationId: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
  path: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
  tag: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
});

const JsonPatchOperationSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("add"), path: z.string(), value: z.unknown() }),
  z.strictObject({ op: z.literal("remove"), path: z.string() }),
  z.strictObject({ op: z.literal("replace"), path: z.string(), value: z.unknown() }),
  z.strictObject({ from: z.string(), op: z.literal("move"), path: z.string() }),
  z.strictObject({ from: z.string(), op: z.literal("copy"), path: z.string() }),
  z.strictObject({ op: z.literal("test"), path: z.string(), value: z.unknown() }),
]);

const HealthCheckSchema = z
  .strictObject({
    accountIdentifierPath: z.string().min(1).optional(),
    args: z.record(z.string(), z.unknown()).optional(),
    displayNamePath: z.string().min(1).optional(),
    identityPath: z.string().min(1).optional(),
    method: HttpMethodSchema.optional(),
    operationId: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    tenantPath: z.string().min(1).optional(),
  })
  .refine(
    (value) =>
      value.operationId !== undefined || (value.method !== undefined && value.path !== undefined),
    "healthCheck requires operationId or method+path",
  );

const GoogleDiscoverySchema = z.strictObject({
  services: z
    .array(
      z.strictObject({
        blockedMethodIds: z.array(z.string().min(1)).optional(),
        blockedMethodPrefixes: z.array(z.string().min(1)).optional(),
        blockedMethodSubstrings: z.array(z.string().min(1)).optional(),
        consentScopes: z.array(z.string().min(1)).optional(),
        hiddenParameters: z.array(z.string().min(1)).optional(),
        hiddenSchemaProperties: z.record(z.string(), z.array(z.string().min(1))).optional(),
        requiredParameters: z.record(z.string(), z.array(z.string().min(1))).optional(),
        requiredRequestBodies: z.array(z.string().min(1)).optional(),
        requiredSchemaProperties: z.record(z.string(), z.array(z.string().min(1))).optional(),
        service: z.string().min(1),
        url: z.url().optional(),
        version: z.string().min(1),
      }),
    )
    .min(1),
});

export const OpenApiAdapterConfigSchema = z
  .strictObject({
    baseUrl: z.url().optional(),
    credentialDestinations: z.array(z.url()).optional(),
    googleDiscovery: GoogleDiscoverySchema.optional(),
    healthCheck: HealthCheckSchema.optional(),
    inline: z.union([z.string().min(1), z.record(z.string(), z.unknown())]).optional(),
    operationFilter: z
      .strictObject({
        exclude: z.array(OperationSelectorSchema).optional(),
        include: z.array(OperationSelectorSchema).optional(),
      })
      .optional(),
    readOnlyOperationIds: z.array(z.string().min(1)).optional(),
    responseProfile: z.literal("slack").optional(),
    specOverrides: z.array(JsonPatchOperationSchema).optional(),
    specUrl: z.url().optional(),
    timeoutMs: z.number().int().positive().max(120_000).default(30_000),
  })
  .refine(
    (value) =>
      Number(value.specUrl !== undefined) +
        Number(value.inline !== undefined) +
        Number(value.googleDiscovery !== undefined) ===
      1,
    "exactly one of specUrl, inline, or googleDiscovery is required",
  );

export type OpenApiAdapterConfig = z.infer<typeof OpenApiAdapterConfigSchema>;
export type JsonPatchOperation = z.infer<typeof JsonPatchOperationSchema>;
export type OperationSelector = z.infer<typeof OperationSelectorSchema>;
