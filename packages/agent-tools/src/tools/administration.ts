import { z } from "zod";
import {
  BrowserProfileIdSchema,
  BrowserProfileGrantIdSchema,
  EnvironmentIdSchema,
  ExecutionPreferencesViewSchema,
  ExecutionSelectionSchema,
  HarnessInstanceIdSchema,
  MarkColorSchema,
  RunnerIdSchema,
  TimeZoneSchema,
  ThreadAccessModeSchema,
  WorkspaceIconNameSchema,
  WorkspaceIdSchema,
} from "@opensteer/core";
import {
  IntegrationConnectionIdSchema,
  IntegrationGrantIdSchema,
  IntegrationInstallationIdSchema,
} from "@opensteer/integration-core";
import { defineAgentTool } from "../registry.js";
import { OperationKeySchema } from "./inputs.js";

const operationKey = OperationKeySchema.optional();
const callers = ["run", "connection"] as const;
const id = z.string().min(1).max(256);
const name = z.string().trim().min(1).max(120);
const ok = { ok: z.literal(true) };
const workspace = z.object({
  id: WorkspaceIdSchema,
  name: z.string(),
  kind: z.string(),
  status: z.string(),
  icon: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
});
const modelSettings = z.strictObject({
  contextWindow: z.number().int().positive().max(10_000_000),
  maxOutputTokens: z.number().int().positive().max(10_000_000).optional(),
});
const harness = z.object({
  id: HarnessInstanceIdSchema,
  environmentId: EnvironmentIdSchema,
  name: z.string(),
  driverKind: z.string(),
  enabled: z.boolean(),
  isDefault: z.boolean(),
  modelSettings: z.record(z.string(), modelSettings.strip()).optional(),
});
const connection = z.object({
  id: z.string(),
  displayName: z.string(),
  status: z.string(),
  provider: z.string().optional(),
  definitionId: z.string().optional(),
});
const grant = z.object({
  id: z.string(),
  workspaceId: WorkspaceIdSchema,
  connectionId: z.string().nullable(),
  installationId: z.string(),
  alias: z.string(),
  access: z.string(),
  status: z.string(),
});
const plugin = z.object({
  id: z.string(),
  name: z.string(),
  currentVersionId: z.string().nullable().optional(),
  activations: z.array(z.object({ workspaceId: WorkspaceIdSchema })).optional(),
});
const specialist = z.object({
  id: z.string(),
  workspaceId: WorkspaceIdSchema,
  pluginId: z.string(),
  plugin: z.string(),
  status: z.string(),
});

export const project_write = defineAgentTool({
  name: "project_write",
  title: "Manage Project",
  description:
    "Change a Project's mark or notifications, delete or recover it, or retry its storage. Main cannot be deleted.",
  input: z.strictObject({
    action: z.enum([
      "set_icon",
      "set_color",
      "set_notifications",
      "delete",
      "recover",
      "retry_storage",
    ]),
    workspaceId: WorkspaceIdSchema,
    icon: WorkspaceIconNameSchema.nullable().optional(),
    color: MarkColorSchema.optional(),
    muted: z.boolean().optional(),
    operationKey,
  }),
  output: z.object({ ...ok, workspace: workspace.optional(), muted: z.boolean().optional() }),
  access: "settings",
  callers,
  destructive: true,
});
export const settings_read = defineAgentTool({
  name: "settings_read",
  title: "Read settings",
  description: "Read engines, remembered execution choices and the viewer's time zone.",
  input: z.strictObject({}),
  output: z.object({
    harnesses: z.array(harness),
    preferences: ExecutionPreferencesViewSchema,
    timeZone: TimeZoneSchema.nullable(),
  }),
  access: "read",
  callers,
});
export const settings_write = defineAgentTool({
  name: "settings_write",
  title: "Change settings",
  description:
    "Set an engine default, model limits, enabled state or name; remember a model/access choice or set the viewer's time zone.",
  input: z.strictObject({
    action: z.enum([
      "set_default",
      "configure_model",
      "set_enabled",
      "rename",
      "remember_execution",
      "set_time_zone",
    ]),
    environmentId: EnvironmentIdSchema.optional(),
    harnessInstanceId: HarnessInstanceIdSchema.optional(),
    nativeModelId: z.string().min(1).max(255).optional(),
    settings: modelSettings.nullable().optional(),
    enabled: z.boolean().optional(),
    name: name.optional(),
    selection: ExecutionSelectionSchema.optional(),
    accessMode: ThreadAccessModeSchema.optional(),
    timeZone: TimeZoneSchema.optional(),
    operationKey,
  }),
  output: z.object({
    ...ok,
    harness: harness.optional(),
    preferences: ExecutionPreferencesViewSchema.optional(),
    timeZone: TimeZoneSchema.optional(),
  }),
  access: "settings",
  callers,
});
export const computer_list = defineAgentTool({
  name: "computer_list",
  title: "List computers",
  description: "List enrolled computers and active access sessions.",
  input: z.strictObject({ after: RunnerIdSchema.optional() }),
  output: z.object({
    machines: z.array(
      z.object({
        id: RunnerIdSchema,
        name: z.string(),
        connected: z.boolean(),
        revoked: z.boolean(),
        sessions: z.array(z.object({ id: z.string() })),
      }),
    ),
    nextCursor: z.string().nullable(),
  }),
  access: "read",
  callers,
});
export const computer_write = defineAgentTool({
  name: "computer_write",
  title: "Manage computer",
  description: "Rename or revoke an enrolled computer, or stop one of its access sessions.",
  input: z.strictObject({
    action: z.enum(["rename", "revoke", "stop_session"]),
    machineId: RunnerIdSchema.optional(),
    name: name.optional(),
    sessionId: id.optional(),
    operationKey,
  }),
  output: z.object({ ...ok, ended: z.boolean().optional() }),
  access: "settings",
  callers,
  destructive: true,
});
export const integration_manage = defineAgentTool({
  name: "integration_manage",
  title: "Manage integrations",
  description:
    "List connections and Workspace grants; disconnect an account, uninstall an integration or revoke a grant.",
  input: z.strictObject({
    action: z.enum(["list", "disconnect", "uninstall", "revoke_grant"]),
    workspaceId: WorkspaceIdSchema.optional(),
    connectionId: IntegrationConnectionIdSchema.optional(),
    installationId: IntegrationInstallationIdSchema.optional(),
    grantId: IntegrationGrantIdSchema.optional(),
    operationKey,
  }),
  output: z.object({
    ...ok,
    connections: z.array(connection).optional(),
    grants: z.array(grant).optional(),
    installations: z
      .array(
        z.object({
          id: z.string(),
          name: z.string().optional(),
          definitionId: z.string().optional(),
        }),
      )
      .optional(),
  }),
  access: "settings",
  callers,
  destructive: true,
});
export const channel_manage = defineAgentTool({
  name: "channel_manage",
  title: "Manage channels",
  description:
    "List messaging channels and bindings; revoke a binding or pause/resume an existing connection.",
  input: z.strictObject({
    action: z.enum(["list", "revoke_binding", "pause", "resume"]),
    connectionId: IntegrationConnectionIdSchema.optional(),
    bindingId: id.optional(),
    operationKey,
  }),
  output: z.object({
    ...ok,
    connections: z.array(connection).optional(),
    bindings: z
      .array(
        z.object({
          id: z.string(),
          workspaceId: WorkspaceIdSchema,
          accountId: z.string(),
          status: z.string(),
        }),
      )
      .optional(),
  }),
  access: "settings",
  callers,
  destructive: true,
});
export const plugin_manage = defineAgentTool({
  name: "plugin_manage",
  title: "Manage plugins",
  description:
    "List plugins and specialists; update, activate, deactivate or remove a plugin, or remove a specialist.",
  input: z.strictObject({
    action: z.enum(["list", "update", "activate", "deactivate", "remove", "remove_specialist"]),
    workspaceId: WorkspaceIdSchema.optional(),
    pluginId: id.optional(),
    specialistId: id.optional(),
    directory: z.string().min(1).max(4096).optional(),
    runnerId: RunnerIdSchema.optional(),
    operationKey,
  }),
  output: z.object({
    ...ok,
    plugins: z.array(plugin).optional(),
    specialists: z.array(specialist).optional(),
  }),
  access: "settings",
  callers,
  destructive: true,
});
export const browser_profile_write = defineAgentTool({
  name: "browser_profile_write",
  title: "Manage browser profile",
  description:
    "List profiles, grants and remembered sites; rename/delete a profile, clear/remove history, remove a site or revoke a grant.",
  input: z.strictObject({
    action: z.enum([
      "list",
      "rename",
      "delete",
      "clear_history",
      "remove_history",
      "remove_site",
      "revoke_grant",
    ]),
    profileId: BrowserProfileIdSchema.optional(),
    name: name.optional(),
    url: z.string().min(1).max(2048).optional(),
    site: z.string().min(1).max(2048).optional(),
    workspaceId: WorkspaceIdSchema.optional(),
    grantId: BrowserProfileGrantIdSchema.optional(),
    operationKey,
  }),
  output: z.object({
    ...ok,
    profile: z.object({ id: BrowserProfileIdSchema, name: z.string() }).optional(),
    profiles: z.array(z.object({ id: BrowserProfileIdSchema, name: z.string() })).optional(),
    grants: z
      .array(
        z.object({
          grantId: BrowserProfileGrantIdSchema,
          profileId: BrowserProfileIdSchema,
          workspaceId: WorkspaceIdSchema,
          access: z.string(),
        }),
      )
      .optional(),
    sites: z.array(z.object({ workspaceId: WorkspaceIdSchema, site: z.string() })).optional(),
    deletion: z.object({ profileId: BrowserProfileIdSchema, state: z.string() }).optional(),
  }),
  access: "settings",
  callers,
  destructive: true,
});
export const administrationTools = [
  project_write,
  settings_read,
  settings_write,
  computer_list,
  computer_write,
  integration_manage,
  channel_manage,
  plugin_manage,
  browser_profile_write,
] as const;
