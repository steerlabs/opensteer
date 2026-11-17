import { z } from "zod";
import {
  IntegrationDefinitionSummarySchema,
  IntegrationDefinitionSummaryViewSchema,
} from "./adapter.js";
import { IntegrationInstallationIdSchema } from "./ids.js";
import {
  IntegrationAuthorizationSurfaceSchema,
  IntegrationConnectionSummarySchema,
  IntegrationConnectionSummaryViewSchema,
  IntegrationInstallationSchema,
  IntegrationInstallationViewSchema,
  IntegrationServerSummarySchema,
  IntegrationServerSummaryViewSchema,
  IntegrationToolSchema,
  IntegrationToolViewSchema,
} from "./models.js";

/** The device apps and computers a person has connected, as every client lists them. */
export const IntegrationDashboardSchema = z.strictObject({
  authorizationSurface: IntegrationAuthorizationSurfaceSchema,
  connections: z.array(IntegrationConnectionSummarySchema).max(500),
  isAdministrator: z.boolean(),
});
export const IntegrationDashboardViewSchema = z.object({
  ...IntegrationDashboardSchema.shape,
  connections: z.array(IntegrationConnectionSummaryViewSchema).max(500),
});
export type IntegrationDashboard = z.infer<typeof IntegrationDashboardSchema>;

/**
 * The one install an access Request can carry: a device app from the definitions this Host ships,
 * pinned by its full-definition digest so approval never drifts to a newer definition silently.
 */
export const IntegrationInstallManifestSchema = z.strictObject({
  definition: IntegrationDefinitionSummarySchema,
  digest: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  kind: z.literal("catalog"),
});
export const IntegrationInstallManifestViewSchema = z.object({
  ...IntegrationInstallManifestSchema.shape,
  definition: IntegrationDefinitionSummaryViewSchema,
});
export type IntegrationInstallManifest = z.infer<typeof IntegrationInstallManifestSchema>;

export const IntegrationCatalogEntrySchema = z.strictObject({
  definition: IntegrationDefinitionSummarySchema,
  digest: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  installationId: IntegrationInstallationIdSchema.nullable(),
});
const IntegrationCatalogEntryViewSchema = z.object({
  ...IntegrationCatalogEntrySchema.shape,
  definition: IntegrationDefinitionSummaryViewSchema,
});
export type IntegrationCatalogEntry = z.infer<typeof IntegrationCatalogEntrySchema>;
export type IntegrationCatalogEntryView = z.infer<typeof IntegrationCatalogEntryViewSchema>;

/** The device definitions, and every installation with its servers and tools. */
export const IntegrationPlatformDashboardSchema = z.strictObject({
  authorizationSurface: IntegrationAuthorizationSurfaceSchema,
  catalog: z.array(IntegrationCatalogEntrySchema).max(1_000),
  installations: z
    .array(
      z.strictObject({
        installation: IntegrationInstallationSchema,
        servers: z.array(IntegrationServerSummarySchema).max(100),
        tools: z.array(IntegrationToolSchema).max(5_000),
      }),
    )
    .max(1_000),
});
export const IntegrationPlatformDashboardViewSchema = z.object({
  ...IntegrationPlatformDashboardSchema.shape,
  catalog: z.array(IntegrationCatalogEntryViewSchema).max(1_000),
  installations: z
    .array(
      z.object({
        ...IntegrationPlatformDashboardSchema.shape.installations.element.shape,
        installation: IntegrationInstallationViewSchema,
        servers: z.array(IntegrationServerSummaryViewSchema).max(100),
        tools: z.array(IntegrationToolViewSchema).max(5_000),
      }),
    )
    .max(1_000),
});
export type IntegrationPlatformDashboard = z.infer<typeof IntegrationPlatformDashboardSchema>;
export type IntegrationPlatformDashboardView = z.infer<
  typeof IntegrationPlatformDashboardViewSchema
>;
