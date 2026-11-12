import { z } from "zod";
import {
  BrowserProfileIdSchema,
  EnvironmentIdSchema,
  ExecutionPreferencesViewSchema,
  ExecutionSelectionSchema,
  HarnessInstanceIdSchema,
  RunnerIdSchema,
  TimeZoneSchema,
  ThreadAccessModeSchema,
} from "@opensteer/core";
import {
  IntegrationConnectionIdSchema,
  IntegrationGrantIdSchema,
  IntegrationInstallationIdSchema,
} from "@opensteer/integration-core";
import { defineAgentTool } from "../registry.js";
import { OperationKeySchema } from "./inputs.js";
import { BrowserProfileOutputSchema } from "./outputs.js";

const operationKey = OperationKeySchema.optional();
const callers = ["run", "connection"] as const;
const id = z.string().min(1).max(256);
const name = z.string().trim().min(1).max(120);
const ok = { ok: z.literal(true) };
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
});
const specialist = z.object({
  id: z.string(),
  pluginId: z.string(),
  plugin: z.string(),
  status: z.string(),
});

export const settings_read = defineAgentTool({
  name: "settings_read",
  title: "Read settings",
  description:
    "Read non-secret engine accounts, remembered execution choices and time zone. Use orchestrator_capabilities for live models.",
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
    "Set engine defaults/limits/enabled state/name, execution preferences or time zone. Full-access. Returns ok/changed settings. remember_execution cannot exceed your ceiling or change a Thread’s mode. Authentication/new accounts/credentials need the person.",
  input: z.strictObject({
    action: z.enum([
      "set_default",
      "configure_model",
      "set_enabled",
      "rename",
      "remember_execution",
      "set_time_zone",
    ]),
    environmentId: EnvironmentIdSchema.optional().describe(
      "Engine actions: computer containing the engine account.",
    ),
    harnessInstanceId: HarnessInstanceIdSchema.optional().describe(
      "Engine actions: exact account ID.",
    ),
    nativeModelId: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe("configure_model: native model ID, not display name."),
    settings: modelSettings
      .nullable()
      .optional()
      .describe("configure_model: limits, or null to clear overrides."),
    enabled: z.boolean().optional().describe("set_enabled: whether the account may execute."),
    name: name.optional().describe("rename: new engine-account label."),
    selection: ExecutionSelectionSchema.optional().describe(
      "remember_execution: saved engine/model selectors.",
    ),
    accessMode: ThreadAccessModeSchema.optional().describe(
      "remember_execution: preference no higher than your ceiling; does not change a Thread.",
    ),
    timeZone: TimeZoneSchema.optional().describe(
      "set_time_zone: IANA zone, such as America/New_York.",
    ),
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
  description:
    "List enrolled computers, online/revoked state and active access-session IDs. Returns machines/nextCursor; pass cursor as after. Grants no shell/app access.",
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
  title: "Manage a computer",
  description:
    "Rename/revoke a computer or stop an access session. Full-access. rename: machineId/name; revoke: machineId; stop_session: sessionId. Returns ok/ended. Enrollment/pairing/grants need the person.",
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
    "List connections/installations/grants; disconnect, uninstall or revoke_grant directly. Full-access. Returns ok and non-secret inventory for list. New accounts/credentials/grants need integration_request/the person.",
  input: z.strictObject({
    action: z.enum(["list", "disconnect", "uninstall", "revoke_grant"]),

    connectionId: IntegrationConnectionIdSchema.optional().describe(
      "disconnect: account connection ID.",
    ),
    installationId: IntegrationInstallationIdSchema.optional().describe(
      "uninstall: installed integration ID.",
    ),
    grantId: IntegrationGrantIdSchema.optional().describe("revoke_grant: grant to remove."),
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
  title: "Manage messaging bridges",
  description:
    "List messaging connections/bindings, revoke_binding, or pause/resume an existing connection. Full-access. Returns ok/inventory. New messaging bridges, identity links, credentials and binding grants need the person.",
  input: z.strictObject({
    action: z.enum(["list", "revoke_binding", "pause", "resume"]),
    connectionId: IntegrationConnectionIdSchema.optional().describe(
      "pause/resume: existing channel connection.",
    ),
    bindingId: id.optional().describe("revoke_binding: existing binding to remove."),
    operationKey,
  }),
  output: z.object({
    ...ok,
    connections: z.array(connection).optional(),
    bindings: z
      .array(
        z.object({
          id: z.string(),
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
    "List plugins/specialists; update (person-installed only), enable/disable, remove or remove_specialist. Full-access. Returns ok/inventory. Enabling grants no resource access; local MCP launch approval needs the person.",
  input: z.strictObject({
    action: z.enum(["list", "update", "enable", "disable", "remove", "remove_specialist"]),

    pluginId: id.optional().describe("Plugin to update, enable/disable or remove."),
    specialistId: id.optional().describe("remove_specialist: registration to remove."),
    directory: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe("update: replacement plugin source folder on its computer."),
    runnerId: RunnerIdSchema.optional().describe(
      "update: computer holding the source; omit for existing placement.",
    ),
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
  title: "Manage browser profiles",
  description:
    "List profiles/sites; rename/delete, clear/remove history, remove_site directly. Full-access. Returns ok/inventory/deletion state. New profiles and grants need browser_profile_request/the person; pairing/sign-in need the person.",
  input: z.strictObject({
    action: z.enum(["list", "rename", "delete", "clear_history", "remove_history", "remove_site"]),
    profileId: BrowserProfileIdSchema.optional().describe(
      "rename/delete/clear_history/remove_history: profile ID.",
    ),
    name: name.optional().describe("rename: new profile label."),
    url: z.string().min(1).max(2048).optional().describe("remove_history: exact history URL."),
    site: z
      .string()
      .min(1)
      .max(2048)
      .optional()
      .describe("remove_site: remembered site to remove."),

    operationKey,
  }),
  output: z.object({
    ...ok,
    profile: z.object({ id: BrowserProfileIdSchema, name: z.string() }).optional(),
    profiles: z.array(BrowserProfileOutputSchema).optional(),
    sites: z.array(z.object({ site: z.string() })).optional(),
    deletion: z.object({ profileId: BrowserProfileIdSchema, state: z.string() }).optional(),
  }),
  access: "settings",
  callers,
  destructive: true,
});
export const administrationTools = [
  settings_read,
  settings_write,
  computer_list,
  computer_write,
  integration_manage,
  channel_manage,
  plugin_manage,
  browser_profile_write,
] as const;
