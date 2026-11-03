import { z } from "zod";
import {
  RequestIdSchema,
  RunnerIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
  WorkspaceKindSchema,
  utf8ByteLength,
} from "@opensteer/core";
import {
  IntegrationConnectionIdSchema,
  IntegrationInstallationIdSchema,
} from "@opensteer/integration-core/ids";
import {
  IntegrationGrantViewSchema,
  IntegrationAccessSchema,
  IntegrationConnectionSummarySchema,
  IntegrationConnectionStatusReasonSchema,
} from "@opensteer/integration-core/models";
import { MachineSummarySchema } from "./machines.js";

const name = z.string().min(1).max(120);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const pluginsOverviewMaxRows = 2000;
export const pluginsOverviewMaxBytes = 1024 * 1024;
export const PluginTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("service"), definitionId: z.string().min(1).max(64) }),
  z.strictObject({ kind: z.literal("device-app"), definitionId: z.string().min(1).max(64) }),
  z.strictObject({ kind: z.literal("plugin"), pluginId: name }),
  z.strictObject({ kind: z.literal("skill"), workspaceId: WorkspaceIdSchema, fullName: name }),
  z.strictObject({ kind: z.literal("specialist"), pluginId: name, ownerUserId: UserIdSchema }),
]);
export const PluginTargetViewSchema = z.discriminatedUnion("kind", [
  PluginTargetSchema.options[0].strip(),
  PluginTargetSchema.options[1].strip(),
  PluginTargetSchema.options[2].strip(),
  PluginTargetSchema.options[3].strip(),
  PluginTargetSchema.options[4].strip(),
]);
export type PluginTarget = z.infer<typeof PluginTargetSchema>;
export const PluginIssueCodeSchema = z.enum([
  "needs-sign-in",
  "needs-scopes",
  "needs-admin",
  "needs-app-approval",
  "needs-os-permission",
  "choose-resource",
  "invalid-installation",
  "removal-failed",
  "waiting-device",
  "waiting-setup",
  "unknown-source-folder",
]);
export const PluginPlacementSummarySchema = z.object({
  enabled: z.boolean(),
  mainIncluded: z.boolean(),
  projectCount: z.number().int().nonnegative(),
  personalEverywhere: z.boolean(),
  revision,
});
export const PluginRowSchema = z.object({
  target: PluginTargetViewSchema,
  title: name,
  description: z.string().max(320).nullable(),
  source: z.object({
    kind: z.enum(["built-in", "plugin", "proposed", "remote-mcp", "workspace"]),
    version: name.nullable(),
  }),
  tags: z.array(z.enum(["accounts", "devices", "skills", "specialists"])).max(4),
  placement: PluginPlacementSummarySchema,
  accountCount: z.number().int().nonnegative(),
  issues: z.array(PluginIssueCodeSchema).max(16),
  contents: z.object({
    skills: z.number().int().nonnegative(),
    tools: z.number().int().nonnegative(),
    specialists: z.number().int().nonnegative(),
  }),
  permissions: z.object({
    canEnable: z.boolean(),
    canPlace: z.boolean(),
    canRemove: z.boolean(),
    canUpdate: z.boolean(),
  }),
});
export type PluginRow = z.infer<typeof PluginRowSchema>;
export const PluginsOverviewViewSchema = z
  .object({ rows: z.array(PluginRowSchema).max(pluginsOverviewMaxRows) })
  .superRefine((value, ctx) => {
    if (utf8ByteLength(JSON.stringify(value)) > pluginsOverviewMaxBytes)
      ctx.addIssue({ code: "custom", message: "Plugins overview exceeds byte budget" });
  });
export type PluginsOverviewView = z.infer<typeof PluginsOverviewViewSchema>;
export const PluginAccountViewSchema = z.object({
  connectionId: IntegrationConnectionIdSchema,
  displayName: z.string().min(1).max(512),
  status: IntegrationConnectionSummarySchema.shape.status,
  statusReason: IntegrationConnectionStatusReasonSchema.nullable(),
  access: IntegrationAccessSchema.nullable(),
  runnerId: RunnerIdSchema.nullable(),
});
const accountSelection = z.strictObject({
  connectionId: IntegrationConnectionIdSchema,
  access: IntegrationAccessSchema,
});
export const PluginProjectSelectionSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  accounts: z.array(accountSelection).max(100),
});
export const PluginPlacementInputSchema = z.strictObject({
  target: PluginTargetSchema,
  expectedRevision: revision,
  mainIncluded: z.boolean(),
  projects: z.array(PluginProjectSelectionSchema).max(1000),
  // Personal only. The account/access ceiling is explicit consent for future Projects.
  personalEverywhere: z.strictObject({ accounts: z.array(accountSelection).max(100) }).nullable(),
});
export const PluginDetailViewSchema = z.object({
  row: PluginRowSchema,
  installationIds: z.array(IntegrationInstallationIdSchema).max(100),
  grants: z.array(IntegrationGrantViewSchema).max(1000),
  registrations: z
    .array(z.object({ id: name, workspaceId: WorkspaceIdSchema, ownerUserId: UserIdSchema }))
    .max(1000),
  accounts: z.array(PluginAccountViewSchema).max(100),
  places: z
    .array(
      z.object({
        workspaceId: WorkspaceIdSchema,
        name,
        kind: WorkspaceKindSchema,
        selected: z.boolean(),
        canSelect: z.boolean(),
        accounts: z.array(z.object(accountSelection.shape)).max(100),
      }),
    )
    .max(1000),
  personalEverywhere: z
    .object({ accounts: z.array(z.object(accountSelection.shape)).max(100) })
    .nullable(),
  devices: z
    .array(z.object({ runnerId: RunnerIdSchema, name, status: MachineSummarySchema.shape.status }))
    .max(400),
  permissions: z
    .array(
      z.object({
        label: name,
        layer: z.enum(["app-policy", "os-permission", "account-scope", "workspace-grant"]),
        state: z.enum(["allowed", "ask", "denied", "unknown"]),
      }),
    )
    .max(100),
  contents: z.array(z.object({ name, kind: z.enum(["skill", "tool", "specialist"]) })).max(500),
  sourceFolder: z.string().max(4096).nullable(),
});
export type PluginDetailView = z.infer<typeof PluginDetailViewSchema>;
export const PluginsDirectoryViewSchema = z.object({
  hasMoreRequests: z.boolean(),
  catalog: z
    .array(
      z.object({
        definitionId: z.string().min(1).max(64),
        title: name,
        description: z.string().max(320),
        added: z.boolean(),
      }),
    )
    .max(1000),
  requests: z
    .array(z.object({ requestId: RequestIdSchema, title: name, workspaceId: WorkspaceIdSchema }))
    .max(100),
});
export const DevicesOverviewViewSchema = z.object({
  devices: z
    .array(
      MachineSummarySchema.pick({
        id: true,
        name: true,
        device: true,
        ownership: true,
        ownerName: true,
        status: true,
        allowedModules: true,
        revocable: true,
      }),
    )
    .max(400),
});
export type DevicesOverviewView = z.infer<typeof DevicesOverviewViewSchema>;

export const SettingsPluginEnableCommandSchema = z.strictObject({
  type: z.literal("settings.plugin.enabled.set"),
  idempotencyKey: z.string().trim().min(1).max(255),
  target: PluginTargetSchema,
  expectedRevision: revision,
  enabled: z.boolean(),
});
export const SettingsPluginPlacementCommandSchema = PluginPlacementInputSchema.extend({
  type: z.literal("settings.plugin.placement.set"),
  idempotencyKey: z.string().trim().min(1).max(255),
});
export const SettingsPluginEnableResultSchema = z.object({
  type: z.literal("settings.plugin.enabled.set"),
  placement: PluginPlacementSummarySchema,
});
export const SettingsPluginPlacementResultSchema = z.object({
  type: z.literal("settings.plugin.placement.set"),
  placement: PluginPlacementSummarySchema,
});
