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
  RunnerCommandSchema,
  runnerCommandMaxSerializedBytes,
} from "./runner.js";

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

export const ProjectRunExecutionContextSchema = RunExecutionContextSchema.omit({
  requestedBy: true,
  requesterTimeZone: true,
  membershipGeneration: true,
  machineAccess: true,
  voiceCall: true,
})
  .extend({
    authority: ProjectAuthoritySchema,
    projectSettingsRevision: generation,
    projectTimeZone: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_+:/-]+$/u),
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

export const ProjectExecuteRunSchema = RunnerCommandSchema.options[0]
  .extend({
    type: z.literal("run.execute.project"),
    context: ProjectRunExecutionContextSchema,
  })
  .refine(
    (command) => command.environmentId === command.context.environmentId,
    "Project command environment must match its execution context",
  )
  .refine(
    (command) =>
      new TextEncoder().encode(JSON.stringify(command)).byteLength <=
      runnerCommandMaxSerializedBytes,
    `Runner command must not exceed ${runnerCommandMaxSerializedBytes} serialized bytes`,
  );
export type ProjectExecuteRun = z.infer<typeof ProjectExecuteRunSchema>;
