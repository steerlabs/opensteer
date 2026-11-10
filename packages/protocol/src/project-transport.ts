import { CorrelationIdSchema, ProtocolErrorSchema } from "./common.js";
import { HarnessInputSchema } from "./runner-execution.js";
import {
  CommandIdSchema,
  ProjectEngineResponseSchema,
  DeploymentIdSchema,
  HostInstanceIdSchema,
  IsoDateTimeSchema,
  ProjectAuthoritySchema,
  ProjectEngineRequestEventSchema,
  ProjectRunBindingSchema,
  RequestIdSchema,
  EnvironmentIdSchema,
  RunnerIdSchema,
  WorkspaceIdSchema,
  ThreadIdSchema,
  TriggerIdSchema,
  TriggerRevisionIdSchema,
  TriggerOccurrenceIdSchema,
  TriggerWatchActivationIdSchema,
  ProviderSessionIdSchema,
  HarnessInstanceIdSchema,
  LiveRunProgressSchema,
  runnerEventDataSchemas,
} from "@opensteer/core";
import { TriggerExecutionOutputSchema } from "@opensteer/triggers";
import { z } from "zod";
import {
  executionLeaseMsSchema,
  runnerCommandMaxSerializedBytes,
  pendingAgentEventMaxSerializedBytes,
} from "./runner-execution.js";
import {
  RunnerBootIdSchema,
  RunnerConnectionFenceSchema,
  type RunnerConnectionFence,
} from "./runner-identity.js";
import { RunnerAuxiliaryRequestIdSchema } from "./runner-auxiliary.js";

const generation = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const programBase = {
  authority: ProjectAuthoritySchema,
  environmentId: EnvironmentIdSchema,
  runnerId: RunnerIdSchema,
  runnerBootId: RunnerBootIdSchema,
  workspaceId: WorkspaceIdSchema,
  anchorThreadId: ThreadIdSchema,
  triggerId: TriggerIdSchema,
  revisionId: TriggerRevisionIdSchema,
  executionGeneration: generation,
};
export const ProjectTriggerBindingSchema = z
  .strictObject({
    ...programBase,
    kind: z.literal("trigger"),
    occurrenceId: TriggerOccurrenceIdSchema,
  })
  .refine(
    (binding) => binding.workspaceId === binding.authority.principal.workspaceId,
    "Program binding must name its Project",
  );
export const ProjectWatchBindingSchema = z
  .strictObject({
    ...programBase,
    kind: z.literal("watch"),
    activationId: TriggerWatchActivationIdSchema,
  })
  .refine(
    (binding) => binding.workspaceId === binding.authority.principal.workspaceId,
    "Program binding must name its Project",
  );
export const ProjectExecutionBindingSchema = z.discriminatedUnion("kind", [
  ProjectRunBindingSchema.safeExtend({ kind: z.literal("run") }),
  ProjectTriggerBindingSchema,
  ProjectWatchBindingSchema,
]);
export type ProjectExecutionBinding = z.infer<typeof ProjectExecutionBindingSchema>;
export type ProjectTriggerBinding = z.infer<typeof ProjectTriggerBindingSchema>;
export type ProjectWatchBinding = z.infer<typeof ProjectWatchBindingSchema>;

const claims = {
  deploymentId: DeploymentIdSchema,
  hostInstanceId: HostInstanceIdSchema,
  exp: z.number().int().positive(),
  iat: z.number().int().nonnegative(),
  iss: z.literal("opensteer-host"),
  jti: z.uuid(),
};
export const ProjectProgramCapabilityClaimsSchema = z.discriminatedUnion("aud", [
  ProjectTriggerBindingSchema.safeExtend({
    ...claims,
    aud: z.literal("opensteer-project-trigger-control"),
  }),
  ProjectWatchBindingSchema.safeExtend({
    ...claims,
    aud: z.literal("opensteer-project-watch-control"),
  }),
]);
export type ProjectProgramCapabilityClaims = z.infer<typeof ProjectProgramCapabilityClaimsSchema>;

const eventBase = {
  binding: ProjectRunBindingSchema,
  emittedAt: IsoDateTimeSchema,
  ordinal: z.number().int().nonnegative(),
};
function event<Type extends keyof typeof runnerEventDataSchemas>(type: Type) {
  return z.strictObject({
    ...eventBase,
    type: z.literal(type),
    data: runnerEventDataSchemas[type],
  });
}
export const ProjectPendingRunEventSchema = z
  .discriminatedUnion("type", [
    ProjectEngineRequestEventSchema.extend({
      emittedAt: IsoDateTimeSchema,
      ordinal: z.number().int().nonnegative(),
    }),
    event("request.cancelled"),
    event("assistant.message"),
    event("message.injected"),
    event("reasoning.completed"),
    event("run.completed"),
    event("run.failed"),
    event("run.interrupted"),
    event("run.started"),
    event("run.status"),
    event("run.usage"),
    event("run.phase"),
    event("node.started"),
    event("node.updated"),
    event("node.completed"),
    event("tool.started"),
    event("tool.completed"),
  ])
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength <=
      pendingAgentEventMaxSerializedBytes,
    "Project event exceeds the event byte limit",
  );
export type ProjectPendingRunEvent = z.infer<typeof ProjectPendingRunEventSchema>;

const fence = RunnerConnectionFenceSchema.shape;
const reason = z.string().trim().min(1).max(500);
const token = z.string().min(1).max(32_768);
export const ProjectCredentialsSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("run"),
    agentTools: z.string().min(1).max(4_096),
    attachments: token.optional(),
    egress: token,
  }),
  z.strictObject({
    kind: z.literal("trigger"),
    mcp: z.string().min(1).max(4_096),
    expiresAt: IsoDateTimeSchema,
  }),
  z.strictObject({
    kind: z.literal("watch"),
    mcp: z.string().min(1).max(4_096),
    expiresAt: IsoDateTimeSchema,
  }),
]);
const credentialResult = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("issued"), credentials: ProjectCredentialsSchema }),
  z.strictObject({ status: z.literal("refused") }),
  z.strictObject({ status: z.literal("unavailable") }),
]);
const binding = ProjectExecutionBindingSchema;
const tail = z
  .string()
  .max(16 * 1_024)
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= 16 * 1_024,
    "Watch log tail exceeds 16 KiB",
  );

const requestRefusalReason = z.enum([
  "no-eligible-manager",
  "unsupported-request-kind",
  "authority-revoked",
]);
const controlAddress = {
  commandId: CommandIdSchema,
  correlationId: CorrelationIdSchema,
  binding: ProjectRunBindingSchema,
};
export const ProjectRunControlSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("request.refuse"),
    requestId: RequestIdSchema,
    callId: z.string().min(1).max(512),
    reason: requestRefusalReason,
  }),
  z.strictObject({
    kind: z.literal("request.resolve"),
    requestId: RequestIdSchema,
    response: ProjectEngineResponseSchema,
  }),
  z.strictObject({ kind: z.literal("run.interrupt") }),
  z.strictObject({ kind: z.literal("run.steer"), input: HarnessInputSchema }),
]);
export type ProjectRunControl = z.infer<typeof ProjectRunControlSchema>;

const runnerMessages = z.discriminatedUnion("type", [
  z.strictObject({
    ...fence,
    ...controlAddress,
    type: z.literal("runner.project.control-result"),
    result: z.discriminatedUnion("status", [
      z.strictObject({ status: z.literal("accepted") }),
      z.strictObject({ status: z.literal("rejected"), error: ProtocolErrorSchema }),
      z.strictObject({ status: z.literal("uncertain"), message: z.string().min(1).max(2_000) }),
    ]),
  }),
  z.strictObject({
    ...fence,
    type: z.literal("runner.project.heartbeat"),
    bindings: z.array(binding).max(1_000),
    sentAt: IsoDateTimeSchema,
  }),
  z.strictObject({
    ...fence,
    type: z.literal("runner.project.grants.refresh"),
    requestId: RunnerAuxiliaryRequestIdSchema,
    binding,
  }),
  z.strictObject({
    ...fence,
    type: z.literal("runner.project.executions.attach"),
    complete: z.literal(true),
    executions: z
      .array(
        z.strictObject({
          binding,
          nextOrdinal: z.number().int().nonnegative(),
          terminal: z.boolean(),
        }),
      )
      .max(1_000),
  }),
  z.strictObject({
    ...fence,
    type: z.literal("runner.project.event"),
    event: ProjectPendingRunEventSchema,
  }),
  z.strictObject({
    ...fence,
    type: z.literal("runner.project.live"),
    binding: ProjectRunBindingSchema,
    progress: LiveRunProgressSchema,
  }),
  z.strictObject({
    ...fence,
    type: z.literal("runner.project.session-bound"),
    binding: ProjectRunBindingSchema,
    harnessInstanceId: HarnessInstanceIdSchema,
    providerSessionId: ProviderSessionIdSchema,
    providerSessionReference: z.string().min(1).max(2_048),
    engineStart: z.enum(["cold", "warm"]).optional(),
  }),
  z.strictObject({
    ...fence,
    type: z.literal("runner.project.trigger-result"),
    ordinal: z.number().int().nonnegative(),
    emittedAt: IsoDateTimeSchema,
    binding: ProjectTriggerBindingSchema,
    output: TriggerExecutionOutputSchema,
  }),
  z.strictObject({
    ...fence,
    type: z.literal("runner.project.watch-status"),
    ordinal: z.number().int().nonnegative(),
    emittedAt: IsoDateTimeSchema,
    binding: ProjectWatchBindingSchema,
    healthySince: IsoDateTimeSchema.nullable(),
    lastError: z.string().max(20_000).nullable(),
    lastExitCode: z.number().int().nullable(),
    observed: z.enum(["starting", "running", "backoff", "expired", "stopped"]),
    restartCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    stdoutTail: tail,
    stderrTail: tail,
  }),
]);

const hostMessages = z.discriminatedUnion("type", [
  z.strictObject({
    ...fence,
    ...controlAddress,
    type: z.literal("host.project.run-control"),
    control: ProjectRunControlSchema,
  }),
  z.strictObject({
    ...fence,
    type: z.literal("host.project.grants.credentials"),
    requestId: RunnerAuxiliaryRequestIdSchema,
    binding,
    result: credentialResult,
  }),
  z.strictObject({
    ...fence,
    type: z.literal("host.project.executions.attached"),
    leaseMs: executionLeaseMsSchema,
    results: z
      .array(
        z.discriminatedUnion("status", [
          z.strictObject({
            binding,
            status: z.literal("attached"),
            nextOrdinal: z.number().int().nonnegative(),
          }),
          z.strictObject({ binding, status: z.literal("revoked"), reason }),
        ]),
      )
      .max(1_000),
  }),
  z.strictObject({
    ...fence,
    type: z.literal("host.project.events.acked"),
    acks: z
      .array(
        z.strictObject({
          binding,
          throughOrdinal: z.number().int().min(-1),
          sessionBound: z.boolean(),
        }),
      )
      .min(1)
      .max(1_000),
  }),
  z.strictObject({
    ...fence,
    type: z.literal("host.project.executions.renewed"),
    heartbeatSentAt: IsoDateTimeSchema,
    leaseMs: executionLeaseMsSchema,
    bindings: z.array(binding).max(1_000),
  }),
  z.strictObject({
    ...fence,
    type: z.literal("host.project.executions.revoked"),
    revocations: z.array(z.strictObject({ binding, reason })).min(1).max(1_000),
  }),
]);

function matchingFences(
  message: z.infer<typeof runnerMessages> | z.infer<typeof hostMessages>,
): boolean {
  const same = (value: { runnerId: string; runnerBootId: string }) =>
    value.runnerId === message.runnerId && value.runnerBootId === message.bootId;
  switch (message.type) {
    case "runner.project.heartbeat":
    case "host.project.executions.renewed":
      return message.bindings.every(same);
    case "runner.project.executions.attach":
      return message.executions.every((item) => same(item.binding));
    case "runner.project.event":
      return same(message.event.binding);
    case "host.project.executions.attached":
      return message.results.every((item) => same(item.binding));
    case "host.project.events.acked":
      return message.acks.every(
        (item) => same(item.binding) && (item.binding.kind === "run" || !item.sessionBound),
      );
    case "host.project.executions.revoked":
      return message.revocations.every((item) => same(item.binding));
    default:
      return same(message.binding);
  }
}
export const ProjectRunnerToHostMessageSchema = runnerMessages
  .refine(
    (message) =>
      message.type !== "runner.project.live" ||
      (message.progress.runId === message.binding.runId &&
        message.progress.threadId === message.binding.threadId &&
        message.progress.workspaceId === message.binding.workspaceId),
    "Live progress must match its Project binding",
  )
  .refine(matchingFences, "Project binding must match the authenticated Runner incarnation")
  .refine(
    (message) =>
      message.type !== "runner.project.trigger-result" ||
      message.output.occurrenceId === message.binding.occurrenceId,
    "Trigger result must match its source",
  )
  .refine(
    (message) =>
      new TextEncoder().encode(JSON.stringify(message)).byteLength <=
      runnerCommandMaxSerializedBytes,
    "Project frame exceeds the frame byte limit",
  );
export const ProjectHostToRunnerMessageSchema = hostMessages
  .refine(matchingFences, "Project binding must match the authenticated Runner incarnation")
  .refine(
    (message) =>
      message.type !== "host.project.grants.credentials" ||
      message.result.status !== "issued" ||
      message.result.credentials.kind === message.binding.kind,
    "Credentials must match their execution family",
  )
  .refine(
    (message) =>
      new TextEncoder().encode(JSON.stringify(message)).byteLength <=
      runnerCommandMaxSerializedBytes,
    "Project frame exceeds the frame byte limit",
  );
export type ProjectRunnerToHostMessage = z.infer<typeof ProjectRunnerToHostMessageSchema>;
export type ProjectHostToRunnerMessage = z.infer<typeof ProjectHostToRunnerMessageSchema>;

export type ProjectRunnerOperationalReport = {
  [Kind in ProjectRunnerToHostMessage["type"]]: Omit<
    Extract<ProjectRunnerToHostMessage, { type: Kind }>,
    keyof RunnerConnectionFence
  >;
}[ProjectRunnerToHostMessage["type"]];
