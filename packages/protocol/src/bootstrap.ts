import { WorkspaceNotificationPreferenceSchema } from "@opensteer/core";
import {
  AuthenticatedUserSchema,
  DeploymentIdSchema,
  ExecutionEnvironmentKindSchema,
  ExecutionPreferencesViewSchema,
  WorkspaceBackingKindSchema,
  HarnessInstanceStateKindSchema,
  HarnessRuntimeRevisionSchema,
  IdentityConfigSchema,
  DeploymentShapeViewSchema,
} from "@opensteer/core";
import { z } from "zod";
import { ThreadPlaceReferenceSchema } from "./places.js";
import { HostedBrowserBootstrapSchema } from "./browser.js";
import { DurableWindowSchema, WorkspaceViewSchema } from "./client.js";
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
  // What this machine can actually store, so a caller choosing where to put a
  // new Workspace is choosing from real options rather than guessing.
  workspaceBackings: z.array(WorkspaceBackingKindSchema).max(2),
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
    // A Host from before Opensteer Cloud said so describes itself as a server.
    cloud: z.boolean().default(false),
  }),
  oidcProviders: z.array(z.object(IdentityConfigSchema.shape.oidcProviders.element.shape)).max(16),
});

export const HostBootstrapSchema = z.object({
  notificationPreferences: z.array(WorkspaceNotificationPreferenceSchema).max(101),
  /** Stable identity for client drafts; a route or public origin is not an identity. */
  deploymentId: DeploymentIdSchema,
  browser: HostedBrowserBootstrapSchema,
  latestPlaces: z.array(ThreadPlaceReferenceSchema).max(4096).optional(),
  /**
   * The Deployment's declared axes. `defaultWorkspaceBacking` is what a new
   * Workspace gets when nobody chooses, and — because PortableFS is allowed
   * only where the Host has a Manager — whether shared storage is an option
   * at all.
   */
  deploymentShape: DeploymentShapeViewSchema,
  environments: z.array(HostBootstrapEnvironmentSchema),
  /**
   * What this person chose last, kept by the Host so every app they open
   * starts a Thread from the same place. Optional only because an added
   * response field is not a protocol epoch; a Host that predates it has
   * nothing remembered, and the client reads absence as exactly that.
   */
  executionPreferences: ExecutionPreferencesViewSchema.optional(),
  harnesses: z.array(HostBootstrapHarnessSchema),
  homeWorkspace: WorkspaceViewSchema.nullable(),
  identityConfig: IdentityConfigViewSchema,
  machines: z.array(MachineSummarySchema).max(400),
  /**
   * How this authenticated request reached the Host. Optional for compatibility
   * with older Hosts; clients must treat absence as unknown rather than
   * inferring local authority.
   */
  sessionSurface: z.enum(["canonical", "personal-remote"]).optional(),
  user: AuthenticatedUserViewSchema,
  workspaceSharingAvailable: z.boolean(),
  workspaces: z.array(WorkspaceViewSchema),
  workspaceWindow: DurableWindowSchema,
});
