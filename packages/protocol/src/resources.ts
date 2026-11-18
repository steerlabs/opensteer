import {
  ExecutionPreferencesViewSchema,
  QuietTaskDaysSchema,
  utf8ByteLength,
} from "@opensteer/core";
import { z } from "zod";
import {
  IdentityConfigViewSchema,
  OwnerProfileViewSchema,
  PersonalEnvironmentsViewSchema,
  PersonalHarnessesViewSchema,
  PersonalMachinesViewSchema,
  PersonalSettingsViewSchema,
} from "./bootstrap.js";
import {
  BrowserPlacementsViewSchema,
  BrowserProfileDeletionsViewSchema,
  BrowserProfileHomesViewSchema,
  BrowserProfilesViewSchema,
} from "./browser.js";
import { PluginEngineStateViewSchema, type PluginResourceCategory } from "./plugins.js";
import { TabBootstrapSchema } from "./tabs.js";

export const pluginCategoryResources = {
  scheduledRuns: "plugin-scheduled-runs",
  workflowRuns: "plugin-workflow-runs",
  webhooks: "plugin-webhooks",
  webhookSources: "plugin-webhook-sources",
  schedules: "plugin-schedules",
} as const satisfies Record<PluginResourceCategory, string>;

export const pluginChangeResources = ["plugin", ...Object.values(pluginCategoryResources)] as const;

export const personalResourceKinds = [
  "settings",
  "identity",
  "owner-profile",
  "environment",
  "machine",
  "harness",
  "harness-catalog",
  "harness-auth",
  "agent-home-settings",
  "tab",
  "tab-layout",
  "browser-profile",
  "browser-placement",
  "browser-home",
  "browser-availability",
  ...pluginChangeResources,
  "plugin-engine",
] as const;

export const PersonalRevisionSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/u)
  .refine((value) => value.length < 19 || value <= "9223372036854775807");
export const PersonalResourceKindSchema = z.enum(personalResourceKinds);
export const PersonalResourceRevisionsSchema = z.record(
  PersonalResourceKindSchema,
  PersonalRevisionSchema,
);
export const InstalledResourceRevisionsSchema = z.partialRecord(
  PersonalResourceKindSchema,
  PersonalRevisionSchema,
);
export const PersonalResourceInterestsSchema = z
  .array(PersonalResourceKindSchema)
  .max(personalResourceKinds.length)
  .refine((kinds) => new Set(kinds).size === kinds.length);

export const PersonalResourceSummarySchema = z.object({
  id: z.string().min(1).max(255),
  label: z.string().max(256).optional(),
  status: z.string().max(80).optional(),
  capabilities: z.array(z.string().min(1).max(80)).max(16).optional(),
  detailId: z.string().min(1).max(255).optional(),
  observedAt: z.iso.datetime().optional(),
});
export const PersonalResourceViewSchema = z
  .object({
    entries: z.array(PersonalResourceSummarySchema).max(32),
    complete: z.boolean(),
    hasMore: z.boolean(),
    selectedId: z.string().min(1).max(255).nullable().optional(),
  })
  .refine(
    (value) =>
      value.complete !== value.hasMore && utf8ByteLength(JSON.stringify(value)) <= 32 * 1024,
  );

export type PersonalResourceKind = z.infer<typeof PersonalResourceKindSchema>;
export type PersonalResourceRevisions = z.infer<typeof PersonalResourceRevisionsSchema>;
export type PersonalResourceView = z.infer<typeof PersonalResourceViewSchema>;

export const PersonalResourceDataSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("settings"),
    settings: PersonalSettingsViewSchema,
    quietTaskDays: QuietTaskDaysSchema,
    executionPreferences: ExecutionPreferencesViewSchema,
  }),
  z.object({ kind: z.literal("identity"), identity: IdentityConfigViewSchema }),
  z.object({
    kind: z.literal("owner-profile"),
    ownerProfile: OwnerProfileViewSchema.nullable(),
  }),
  z.object({ kind: z.literal("environment"), environments: PersonalEnvironmentsViewSchema }),
  z.object({ kind: z.literal("machine"), machines: PersonalMachinesViewSchema }),
  z.object({ kind: z.literal("harness"), harnesses: PersonalHarnessesViewSchema }),
  z.object({
    kind: z.literal("harness-catalog"),
    environments: PersonalEnvironmentsViewSchema,
  }),
  z.object({ kind: z.literal("harness-auth"), environments: PersonalEnvironmentsViewSchema }),
  z.object({ kind: z.literal("agent-home-settings"), settings: PersonalSettingsViewSchema }),
  z.object({ kind: z.enum(["tab", "tab-layout"]), tabs: TabBootstrapSchema }),
  z.object({
    kind: z.literal("browser-profile"),
    profiles: BrowserProfilesViewSchema,
    deletions: BrowserProfileDeletionsViewSchema,
  }),
  z.object({
    kind: z.literal("browser-placement"),
    placements: BrowserPlacementsViewSchema,
  }),
  z.object({ kind: z.literal("browser-home"), homes: BrowserProfileHomesViewSchema }),
  z.object({ kind: z.literal("browser-availability"), available: z.boolean() }),
  z.object({ kind: z.enum(pluginChangeResources) }),
  z.object({ kind: z.literal("plugin-engine"), engine: PluginEngineStateViewSchema }),
]);

export const PersonalResourceDetailSchema = z
  .object({
    revision: PersonalRevisionSchema,
    data: PersonalResourceDataSchema,
    next: z.string().max(4096).nullable(),
  })
  .refine((value) => utf8ByteLength(JSON.stringify(value)) <= 64 * 1024);
