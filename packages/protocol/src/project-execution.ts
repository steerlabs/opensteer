import {
  EnvironmentIdSchema,
  DeploymentIdSchema,
  HostInstanceIdSchema,
  GrantIdSchema,
  ProjectAuthoritySchema,
  RunIdSchema,
  RunnerIdSchema,
  ThreadIdSchema,
  WorkspaceIdSchema,
} from "@opensteer/core";
import { z } from "zod";
import {
  RunExecutionContextSchema,
  ExecuteRunSchema,
  ExecuteTriggerSchema,
  ReconcileWatchesSchema,
  TriggerExecutionContextSchema,
  WatchReconcileActivationSchema,
  WatchCapabilityPlanSchema,
  runnerCommandMaxSerializedBytes,
} from "./runner-execution.js";

const generation = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const ProjectCapabilityScopeSchema = z
  .strictObject({
    authority: ProjectAuthoritySchema,
    bindingGeneration: generation,
    environmentId: EnvironmentIdSchema,
    grantId: GrantIdSchema,
    runId: RunIdSchema,
    runnerBootId: z.string().min(1).max(255),
    runnerId: RunnerIdSchema,
    threadId: ThreadIdSchema,
    workspaceId: WorkspaceIdSchema,
  })
  .refine((scope) => scope.workspaceId === scope.authority.principal.workspaceId, {
    message: "Project capability must bind its authority's Workspace",
    path: ["workspaceId"],
  });
export type ProjectCapabilityScope = z.infer<typeof ProjectCapabilityScopeSchema>;

export const ProjectCapabilityClaimsSchema = ProjectCapabilityScopeSchema.safeExtend({
  deploymentId: DeploymentIdSchema,
  hostInstanceId: HostInstanceIdSchema,
  aud: z.enum([
    "opensteer-project-run-tools",
    "opensteer-project-run-attachments",
    "opensteer-project-egress",
  ]),
  exp: z.number().int().positive(),
  iat: z.number().int().nonnegative(),
  iss: z.literal("opensteer-host"),
  jti: z.uuid(),
});
export type ProjectCapabilityClaims = z.infer<typeof ProjectCapabilityClaimsSchema>;

export const ProjectExecutionEnvelopeSchema = z.strictObject({
  authority: ProjectAuthoritySchema,
  projectSettingsRevision: generation,
  projectTimeZone: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_+:/-]+$/u),
});
export type ProjectExecutionEnvelope = z.infer<typeof ProjectExecutionEnvelopeSchema>;

export const ProjectRunExecutionContextSchema = RunExecutionContextSchema.omit({
  requestedBy: true,
  requesterTimeZone: true,
  membershipGeneration: true,
  machineAccess: true,
  voiceCall: true,
  browserCdp: true,
  plugins: true,
  specialistId: true,
})
  .extend({
    ...ProjectExecutionEnvelopeSchema.shape,
    workspaceKind: z.literal("project"),
    harness: RunExecutionContextSchema.shape.harness.extend({
      driverKind: z.enum(["codex", "claude"]),
      stateKind: z.literal("isolated"),
    }),
  })
  .refine(
    (context) =>
      context.workspaceId === context.authority.principal.workspaceId &&
      context.workspaceAccess.workspaceId === context.workspaceId &&
      context.workspaceAccess.ownerEnvironmentId === context.environmentId,
    "Project authority and storage must bind the execution Workspace and environment",
  );

export type ProjectRunExecutionContext = z.infer<typeof ProjectRunExecutionContextSchema>;

const commandLimitMessage = `Runner command must not exceed ${runnerCommandMaxSerializedBytes} serialized bytes`;
function withinCommandLimit(command: unknown): boolean {
  return (
    new TextEncoder().encode(JSON.stringify(command)).byteLength <= runnerCommandMaxSerializedBytes
  );
}

export const ProjectExecuteRunSchema = ExecuteRunSchema.extend({
  type: z.literal("run.execute.project"),
  context: ProjectRunExecutionContextSchema,
})
  .refine(
    (command) => command.environmentId === command.context.environmentId,
    "Project command environment must match its execution context",
  )
  .refine(withinCommandLimit, commandLimitMessage);
export type ProjectExecuteRun = z.infer<typeof ProjectExecuteRunSchema>;

export const ProjectTriggerExecutionContextSchema = TriggerExecutionContextSchema.omit({
  browserCdp: true,
})
  .extend(ProjectExecutionEnvelopeSchema.shape)
  .refine(
    (context) =>
      context.workspaceId === context.authority.principal.workspaceId &&
      context.workspaceAccess.workspaceId === context.workspaceId &&
      context.event.id === context.occurrenceId &&
      context.event.trigger.id === context.triggerId &&
      context.event.trigger.revisionId === context.revisionId &&
      context.event.trigger.anchorThreadId === context.anchorThreadId &&
      context.event.trigger.workspaceId === context.workspaceId,
    "Project program authority, storage and event must bind the same source and Workspace",
  );
export type ProjectTriggerExecutionContext = z.infer<typeof ProjectTriggerExecutionContextSchema>;

export const ProjectExecuteTriggerSchema = ExecuteTriggerSchema.extend({
  type: z.literal("trigger.execute.project"),
  context: ProjectTriggerExecutionContextSchema,
})
  .refine(
    (command) => command.environmentId === command.context.workspaceAccess.ownerEnvironmentId,
    "Project program storage must bind the command environment",
  )
  .refine(withinCommandLimit, commandLimitMessage);
export type ProjectExecuteTrigger = z.infer<typeof ProjectExecuteTriggerSchema>;

export const ProjectWatchReconcileActivationSchema = WatchReconcileActivationSchema.omit({
  capabilities: true,
})
  .extend({
    ...ProjectExecutionEnvelopeSchema.shape,
    capabilities: z.strictObject({ mcp: WatchCapabilityPlanSchema }),
  })
  .refine(
    (activation) =>
      activation.workspaceId === activation.authority.principal.workspaceId &&
      activation.workspaceAccess.workspaceId === activation.workspaceId,
    "Project Watch authority and storage must bind the same Workspace",
  );
export type ProjectWatchReconcileActivation = z.infer<typeof ProjectWatchReconcileActivationSchema>;

export const ProjectReconcileWatchesSchema = ReconcileWatchesSchema.extend({
  type: z.literal("watch.reconcile.project"),
  desired: z.array(ProjectWatchReconcileActivationSchema).max(32),
})
  .refine(
    (command) =>
      command.desired.every(
        (activation) => activation.workspaceAccess.ownerEnvironmentId === command.environmentId,
      ),
    "Project Watch storage must bind the command environment",
  )
  .refine(
    (command) =>
      new Set(command.desired.map((activation) => activation.activationId)).size ===
      command.desired.length,
    "Each Project Watch activation occurs once",
  )
  .refine(withinCommandLimit, commandLimitMessage);
export type ProjectReconcileWatches = z.infer<typeof ProjectReconcileWatchesSchema>;

export const ProjectExecutableCommandSchema = z.discriminatedUnion("type", [
  ProjectExecuteRunSchema,
  ProjectExecuteTriggerSchema,
  ProjectReconcileWatchesSchema,
]);
export type ProjectExecutableCommand = z.infer<typeof ProjectExecutableCommandSchema>;
