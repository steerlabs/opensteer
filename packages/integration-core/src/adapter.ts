import { z } from "zod";
import { AuthMethodSchema, AuthMethodViewSchema } from "./auth-method.js";
import {
  IntegrationAdapterKindSchema,
  IntegrationDefinitionIdSchema,
  type IntegrationAdapterKind,
} from "./adapter-kind.js";
import { IntegrationProviderSchema } from "./identifiers.js";
import {
  ComputerAppConfigSchema,
  ComputerAppPresentationSchema,
  ComputerAppPresentationViewSchema,
  computerAppPresentation,
} from "./computer-app.js";

export { IntegrationAdapterKindSchema, IntegrationDefinitionIdSchema, type IntegrationAdapterKind };

/** Native device definitions and their shared presentation contract. */
const IntegrationDefinitionBaseSchema = z.strictObject({
  adapter: IntegrationAdapterKindSchema,
  authMethods: z.array(AuthMethodSchema).min(1).max(8),
  config: z.unknown(),
  description: z.string().min(1).max(240),
  icon: z.string().min(1).max(2_048).optional(),
  id: IntegrationDefinitionIdSchema,
  name: z.string().min(1).max(80),
  provider: IntegrationProviderSchema,
  setupSteps: z.array(z.string().min(1).max(240)).max(8).optional(),
  setupUrl: z.url().optional(),
});

export const IntegrationDefinitionSchema = IntegrationDefinitionBaseSchema.superRefine(
  (definition, context) => {
    const hasComputerMethod = definition.authMethods.some(({ kind }) => kind === "computer");
    const hasSingleComputerMethod =
      definition.authMethods.length === 1 && definition.authMethods[0]?.kind === "computer";
    if (
      (definition.adapter === "computer" && !hasSingleComputerMethod) ||
      (definition.adapter !== "computer" && hasComputerMethod)
    ) {
      context.addIssue({
        code: "custom",
        message: "A computer definition must declare exactly one computer auth method",
        path: ["authMethods"],
      });
    }
    if (definition.adapter !== "computer") return;
    const parsed = ComputerAppConfigSchema.safeParse(definition.config);
    if (parsed.success) return;
    for (const issue of parsed.error.issues) {
      context.addIssue({ ...issue, path: ["config", ...issue.path] });
    }
  },
);
export type IntegrationDefinition = z.infer<typeof IntegrationDefinitionSchema>;

/**
 * Browser-safe catalog facts. Adapter configuration is deliberately absent:
 * it is an internal execution artifact, not part of the installation view.
 */
export const IntegrationDefinitionSummarySchema = IntegrationDefinitionBaseSchema.omit({
  config: true,
})
  .extend({
    computerApp: ComputerAppPresentationSchema.optional(),
  })
  .strict();

/** Older Hosts stored a null service credential disclosure on every computer definition. */
export const StoredIntegrationDefinitionSummarySchema = IntegrationDefinitionSummarySchema.extend({
  apiKey: z.null().optional(),
}).transform(({ apiKey: _apiKey, ...definition }) => definition);

export const IntegrationDefinitionSummaryViewSchema = z.object({
  ...IntegrationDefinitionSummarySchema.shape,
  // API 62 pins this response vocabulary; native definitions only produce computer entries.
  adapter: z.enum(["computer", "graphql", "mcp", "openapi"]),
  hostedOAuth: z
    .object({
      providerApplicationRevision: z.number().int().positive(),
      qualification: z.object({
        authorizationCodeExchange: z.literal(true),
        refresh: z.literal(true),
      }),
    })
    .optional(),
  authMethods: z.array(AuthMethodViewSchema).min(1).max(8),
  computerApp: ComputerAppPresentationViewSchema.optional(),
});
export type IntegrationDefinitionSummary = z.infer<typeof IntegrationDefinitionSummarySchema>;
export type IntegrationDefinitionSummaryView = z.infer<
  typeof IntegrationDefinitionSummaryViewSchema
>;

export function integrationDefinitionSummary(
  definition: IntegrationDefinition,
): IntegrationDefinitionSummary {
  const { config, ...summary } = definition;
  return {
    ...summary,
    ...(definition.adapter === "computer"
      ? { computerApp: computerAppPresentation(ComputerAppConfigSchema.parse(config)) }
      : {}),
  };
}
