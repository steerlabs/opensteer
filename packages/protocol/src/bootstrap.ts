import { MachineSummarySchema } from "./machines.js";
import { HostedBrowserBootstrapSchema } from "./browser.js";
import { TabBootstrapSchema } from "./tabs.js";
import { IdleCompactionPolicyViewSchema, PersonalSettingsSchema } from "@opensteer/core";
import { AuthSessionIdSchema, PersonNameSchema, QuietTaskDaysSchema } from "@opensteer/core";
import {
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

import {
  HarnessModelSettingsMapViewSchema,
  HarnessInstanceCatalogViewSchema,
  RunnerHarnessDriverViewSchema,
} from "./runner.js";

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
  /** When the person stopped agents on this environment's computer, while that holds. */
  agentsStoppedSince: z.string().nullable().optional(),
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

/**
 * The personal owner's name: null shows as "You". While `accountBacked`, the linked Opensteer
 * Account owns it and a name is required.
 */
export const OwnerProfileViewSchema = z.object({
  name: PersonNameSchema.nullable(),
  accountBacked: z.boolean(),
  /** Opaque, while `accountBacked`: the Account and revision of `name`. An edit sends the one it began from. */
  version: z.string().min(1).max(256).nullable(),
});
export type OwnerProfileView = z.infer<typeof OwnerProfileViewSchema>;

export const PersonalSettingsViewSchema = z
  .object({
    ...PersonalSettingsSchema.shape,
    agentHome: z.object(PersonalSettingsSchema.shape.agentHome.shape),
    idleCompactionPolicy: IdleCompactionPolicyViewSchema.optional(),
  })
  .nullable();
export const PersonalCapabilitiesViewSchema = z.object({
  createTasks: z.boolean(),
  useVoice: z.boolean(),
  manageComputers: z.boolean(),
  managePrivateResources: z.boolean(),
});
export const PersonalSessionSurfaceSchema = z.enum(["canonical", "personal-remote"]);
export const PersonalEnvironmentsViewSchema = z.array(HostBootstrapEnvironmentSchema).max(400);
export const PersonalHarnessesViewSchema = z.array(HostBootstrapHarnessSchema).max(400);
export const PersonalMachinesViewSchema = z.array(MachineSummarySchema).max(400);

export const HostBootstrapSchema = z.object({
  /**
   * The personal API version this caller is served. A Host from before the
   * window omits it: it admits a caller only at the caller's minimum.
   */
  apiVersion: z.number().int().positive().optional(),
  deploymentId: DeploymentIdSchema,
  sessionId: AuthSessionIdSchema,
  personalSettings: PersonalSettingsViewSchema,
  can: PersonalCapabilitiesViewSchema,
  tabs: TabBootstrapSchema,
  browser: HostedBrowserBootstrapSchema,
  latestPlaces: z.array(ThreadPlaceReferenceSchema).max(4096),
  environments: PersonalEnvironmentsViewSchema,
  executionPreferences: ExecutionPreferencesViewSchema,
  quietTaskDays: QuietTaskDaysSchema,
  /** Absent from Hosts before `viewer.name.update`; its presence is the capability. */
  ownerProfile: OwnerProfileViewSchema.optional(),
  harnesses: PersonalHarnessesViewSchema,
  identityConfig: IdentityConfigViewSchema,
  machines: PersonalMachinesViewSchema,
  sessionSurface: PersonalSessionSurfaceSchema,
  user: AuthenticatedUserViewSchema,
});

export type HostBootstrap = z.infer<typeof HostBootstrapSchema>;
