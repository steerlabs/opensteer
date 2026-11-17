import { z } from "zod";
import { RunnerIdSchema, ThreadIdSchema, utf8ByteLength } from "@opensteer/core";
import { PluginDeviceViewSchema } from "@opensteer/integration-core/models";
import { MachineSummarySchema } from "./machines.js";

const name = z.string().min(1).max(120);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const pluginsOverviewMaxRows = 2000;
export const pluginsOverviewMaxBytes = 1024 * 1024;
export const PluginTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("device-app"), definitionId: z.string().min(1).max(64) }),
  z.strictObject({ kind: z.literal("plugin"), pluginId: name }),
  z.strictObject({ kind: z.literal("skill"), fullName: name }),
]);
export const PluginTargetViewSchema = z.discriminatedUnion("kind", [
  PluginTargetSchema.options[0].strip(),
  PluginTargetSchema.options[1].strip(),
  PluginTargetSchema.options[2].strip(),
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
  revision,
});
export const PluginRowSchema = z.object({
  target: PluginTargetViewSchema,
  title: name,
  description: z.string().max(320).nullable(),
  source: z.object({
    kind: z.enum(["built-in", "plugin", "folder"]),
    version: name.nullable(),
  }),
  tags: z.array(z.enum(["accounts", "devices", "skills"])).max(4),
  placement: PluginPlacementSummarySchema,
  accountCount: z.number().int().nonnegative(),
  issues: z.array(PluginIssueCodeSchema).max(16),
  contents: z.object({
    skills: z.number().int().nonnegative(),
    tools: z.number().int().nonnegative(),
  }),
  permissions: z.object({
    canEnable: z.boolean(),
    canPlace: z.boolean(),
    canRemove: z.boolean(),
    canUpdate: z.boolean(),
  }),
  /**
   * The physical thing a plugin package declares it controls. Such a plugin is
   * listed under Devices rather than Plugins; a Host before devices sends none.
   */
  device: PluginDeviceViewSchema.nullable().optional(),
});
export type PluginRow = z.infer<typeof PluginRowSchema>;
export const PluginsOverviewViewSchema = z
  .object({ rows: z.array(PluginRowSchema).max(pluginsOverviewMaxRows) })
  .superRefine((value, ctx) => {
    if (utf8ByteLength(JSON.stringify(value)) > pluginsOverviewMaxBytes)
      ctx.addIssue({ code: "custom", message: "Plugins overview exceeds byte budget" });
  });
export type PluginsOverviewView = z.infer<typeof PluginsOverviewViewSchema>;
/**
 * One device a plugin package declares. Everything but the label comes from the
 * Host's own records: the computer its server runs on and that server's state.
 */
const OtherDeviceShape = {
  pluginId: name,
  name: PluginDeviceViewSchema.shape.name,
  kind: PluginDeviceViewSchema.shape.kind,
  computer: z
    .object({ id: RunnerIdSchema, name, status: MachineSummarySchema.shape.status })
    .nullable(),
  /** Why its server is not running, in the server's own status words; null when it is. */
  issue: z.string().max(1_000).nullable(),
  setupThreadId: ThreadIdSchema.nullable(),
} as const;
export const DevicesOverviewViewSchema = z.object({
  devices: z
    .array(
      MachineSummarySchema.pick({
        id: true,
        name: true,
        device: true,
        ownership: true,
        status: true,
        allowedModules: true,
        kind: true,
        access: true,
        selfRunnerId: true,
        drivers: true,
        capabilities: true,
        phoneDisplay: true,
        revocable: true,
      }).extend({
        access: MachineSummarySchema.shape.access
          .unwrap()
          .pick({ policy: true, revision: true })
          .nullable()
          .optional(),
      }),
    )
    .max(400),
  /** Devices that run no Opensteer, reached through a plugin's server; a Host before devices sends none. */
  otherDevices: z.array(z.object(OtherDeviceShape)).max(400).optional(),
});
export type DevicesOverviewView = z.infer<typeof DevicesOverviewViewSchema>;
export type OtherDevice = NonNullable<DevicesOverviewView["otherDevices"]>[number];

export const SettingsPluginEnableCommandSchema = z.strictObject({
  type: z.literal("settings.plugin.enabled.set"),
  idempotencyKey: z.string().trim().min(1).max(255),
  target: PluginTargetSchema,
  expectedRevision: revision,
  enabled: z.boolean(),
});

export const SettingsPluginEnableResultSchema = z.object({
  type: z.literal("settings.plugin.enabled.set"),
  placement: PluginPlacementSummarySchema,
});
