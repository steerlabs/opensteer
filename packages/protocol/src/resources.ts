import {
  ExecutionPreferencesViewSchema,
  QuietTaskDaysSchema,
  utf8ByteLength,
} from "@opensteer/core";
import { z } from "zod";
import { MachineInventoryEntrySchema } from "./machines.js";
import {
  EnvironmentInventoryEntrySchema,
  HostBootstrapEnvironmentSchema,
  IdentityConfigViewSchema,
  OwnerProfileViewSchema,
  PersonalHarnessesViewSchema,
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
  "tab",
  "tab-layout",
  "browser-profile",
  "browser-placement",
  "browser-home",
  "browser-availability",
  ...pluginChangeResources,
  "plugin-engine",
  /** An accepted team reply was published; a client waiting on one rereads it. */
  "team-replies",
] as const;

const mebibyte = 1024 * 1024;
/**
 * The most a complete inventory of each kind may hold, as the serialized `data` of every page of
 * one `resources.detail.get` read added together. A client refuses a read past it; a Host admits
 * nothing that would take a kind past it. One place, so the two cannot drift.
 */
export const personalInventoryBytes: Readonly<Partial<Record<string, number>>> = {
  "harness-catalog": 8 * mebibyte,
  tab: 4 * mebibyte,
  "tab-layout": mebibyte,
  machine: 4 * mebibyte,
  environment: 2 * mebibyte,
  harness: 2 * mebibyte,
  "browser-profile": 2 * mebibyte,
  "browser-placement": mebibyte,
  "browser-home": mebibyte,
};
/** Settings, identity, profile, availability and every plugin signal are a single small value. */
export const personalSmallInventoryBytes = 256 * 1024;
export function personalInventoryBound(kind: string): number {
  return personalInventoryBytes[kind] ?? personalSmallInventoryBytes;
}

export const PersonalRevisionSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/u)
  .refine((value) => value.length < 19 || value <= "9223372036854775807");
export const PersonalResourceKindSchema = z.enum(personalResourceKinds);
/** Kinds whose revision a personal commit bumps; the rest change only at runtime. */
export const durablePersonalResourceKinds = personalResourceKinds.filter(
  (kind) => kind === "plugin" || !kind.startsWith("plugin-"),
);
export type DurablePersonalResourceKind = (typeof durablePersonalResourceKinds)[number];
export type DurablePersonalResourceRevisions = Record<DurablePersonalResourceKind, string>;

/**
 * Compared only for equality. A kind's durable revision, followed by the Host
 * boot and a counter once a runtime fact (a Runner, a browser placement, a
 * plugin) has changed it during that boot, so a restarted Host never repeats one.
 */
export const PersonalResourceRevisionSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})(\.[0-9a-f]{16}\.[1-9][0-9]{0,15})?$/u)
  .refine((value) => {
    const durable = value.split(".", 1)[0]!;
    return durable.length < 19 || durable <= "9223372036854775807";
  });
export const PersonalResourceRevisionsSchema = z
  .partialRecord(PersonalResourceKindSchema, PersonalResourceRevisionSchema)
  .refine((value) => Object.keys(value).length > 0);
export const InstalledResourceRevisionsSchema = z.partialRecord(
  PersonalResourceKindSchema,
  PersonalResourceRevisionSchema,
);
export const PersonalResourceInterestsSchema = z
  .array(PersonalResourceKindSchema)
  .max(personalResourceKinds.length)
  .refine((kinds) => new Set(kinds).size === kinds.length);

export type PersonalResourceKind = z.infer<typeof PersonalResourceKindSchema>;
export type PersonalResourceRevisions = z.infer<typeof InstalledResourceRevisionsSchema>;

export const PersonalEnvironmentCatalogsViewSchema = z
  .array(
    z.object({
      id: HostBootstrapEnvironmentSchema.shape.id,
      harnessCatalogs: HostBootstrapEnvironmentSchema.shape.harnessCatalogs,
    }),
  )
  .max(400);

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
  /** Each environment's bounded summary; its engines are `environment.detail.get`. */
  z.object({
    kind: z.literal("environment"),
    environments: z.array(EnvironmentInventoryEntrySchema).max(400),
  }),
  /** Each computer's bounded summary; its heavy sections are `machine.detail.get`. */
  z.object({
    kind: z.literal("machine"),
    machines: z.array(MachineInventoryEntrySchema).max(400),
  }),
  z.object({ kind: z.literal("harness"), harnesses: PersonalHarnessesViewSchema }),
  z.object({
    kind: z.literal("harness-catalog"),
    /**
     * Each environment's account catalogs, by environment id only: the environment's own detail is
     * the `environment` resource, so a catalog page carries nothing that is not a catalog.
     */
    environments: PersonalEnvironmentCatalogsViewSchema,
  }),
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
  z.object({ kind: z.enum([...pluginChangeResources, "team-replies"]) }),
  z.object({ kind: z.literal("plugin-engine"), engine: PluginEngineStateViewSchema }),
]);

export const PersonalResourceDetailSchema = z
  .object({
    revision: PersonalResourceRevisionSchema,
    data: PersonalResourceDataSchema,
    next: z.string().max(4096).nullable(),
  })
  .refine((value) => utf8ByteLength(JSON.stringify(value)) <= 64 * 1024);
