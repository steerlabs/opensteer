import { PersonalSettingsSchema } from "@opensteer/core";
import { AuthSessionIdSchema, QuietTaskDaysSchema } from "@opensteer/core";
import {
  AppIdSchema,
  AppTitleSchema,
  ThreadIdSchema,
  AuthenticatedUserSchema,
  DeploymentIdSchema,
  ExecutionEnvironmentKindSchema,
  ExecutionPreferencesViewSchema,
  HarnessInstanceStateKindSchema,
  HarnessRuntimeRevisionSchema,
  IdentityConfigSchema,
} from "@opensteer/core";
import { z } from "zod";
import { ThreadPlaceReferenceSchema } from "./places.js";
import { HostedBrowserBootstrapSchema } from "./browser.js";

import {
  HarnessModelSettingsMapViewSchema,
  HarnessInstanceCatalogViewSchema,
  RunnerHarnessDriverViewSchema,
} from "./runner.js";
import { MachineSummarySchema } from "./machines.js";

export const HostEnvironmentStatusSchema = z.enum(["connected", "disconnected"]);
export type HostEnvironmentStatus = z.infer<typeof HostEnvironmentStatusSchema>;

export const HostBootstrapEnvironmentSchema = z.object({
  capabilities: z.array(z.string()),
  connected: z.boolean(),
  harnessAuthenticationAllowed: z.boolean(),
  harnessDrivers: z.array(RunnerHarnessDriverViewSchema).max(100),
  harnessCatalogs: z.array(HarnessInstanceCatalogViewSchema).max(100),
  id: z.string().min(1),
  kind: ExecutionEnvironmentKindSchema,
  name: z.string().min(1),
  providerStateModes: z.array(HarnessInstanceStateKindSchema).max(2),
  runnerId: z.string().min(1).nullable(),
  status: HostEnvironmentStatusSchema,
  can: z.object({ executeTasks: z.boolean() }),
});

export const HostBootstrapHarnessSchema = z.object({
  modelSettings: HarnessModelSettingsMapViewSchema.optional(),
  config: z.unknown(),
  driverKind: z.string().min(1),
  enabled: z.boolean(),
  environmentId: z.string().min(1),
  id: z.string().min(1),
  /** Which account of this driver the work location means when nobody names one. */
  isDefault: z.boolean(),
  name: z.string().min(1),
  runtimeRevision: HarnessRuntimeRevisionSchema,
  /** Who this account talks to; one of the sources its engine declares. */
  sourceId: z.string().min(1).max(100),
  stateKind: HarnessInstanceStateKindSchema,
  /** Whether this viewer's defaults may use it unasked; absent means they may. */
  automaticEligible: z.boolean().optional(),
});
export type HostBootstrapHarness = z.infer<typeof HostBootstrapHarnessSchema>;

/**
 * One wire contract imported by the Host and every client. The Host validates
 * it before sending, so a successful response cannot be structurally invalid.
 */
export const AuthenticatedUserViewSchema = z.object(AuthenticatedUserSchema.shape);
export const IdentityConfigViewSchema = z.object({
  ...IdentityConfigSchema.shape,
  deployment: z.object({
    ...IdentityConfigSchema.shape.deployment.shape,
  }),
  oidcProviders: z.array(z.object(IdentityConfigSchema.shape.oidcProviders.element.shape)).max(16),
});

export const AppTabSchema = z.object({
  appId: AppIdSchema,
  title: AppTitleSchema,
  threadId: ThreadIdSchema,

  openedAt: z.iso.datetime({ offset: true }),
  latestVersion: z.number().int().positive(),
});
export const AppTabsSchema = z.array(AppTabSchema).max(500);
export type AppTab = z.infer<typeof AppTabSchema>;

export const HostBootstrapSchema = z.object({
  deploymentId: DeploymentIdSchema,
  sessionId: AuthSessionIdSchema,
  personalSettings: z
    .object({
      ...PersonalSettingsSchema.shape,
      agentHome: z.object(PersonalSettingsSchema.shape.agentHome.shape),
    })
    .nullable(),
  can: z.object({
    createTasks: z.boolean(),
    useVoice: z.boolean(),
    manageComputers: z.boolean(),
    managePrivateResources: z.boolean(),
  }),
  appTabs: AppTabsSchema,
  browser: HostedBrowserBootstrapSchema,
  latestPlaces: z.array(ThreadPlaceReferenceSchema).max(4096),
  environments: z.array(HostBootstrapEnvironmentSchema).max(400),
  executionPreferences: ExecutionPreferencesViewSchema,
  quietTaskDays: QuietTaskDaysSchema,
  harnesses: z.array(HostBootstrapHarnessSchema).max(400),
  identityConfig: IdentityConfigViewSchema,
  machines: z.array(MachineSummarySchema).max(400),
  sessionSurface: z.enum(["canonical", "personal-remote"]),
  user: AuthenticatedUserViewSchema,
});
