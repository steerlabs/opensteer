import { z } from "zod";
import {
  EnvironmentIdSchema,
  GrantIdSchema,
  RequestIdSchema,
  RunIdSchema,
  RunnerIdSchema,
  ThreadIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
  ExecutionNodeIdSchema,
} from "./ids.js";
import { IsoDateTimeSchema } from "./models.js";
import {
  type PendingRequest,
  RequestResponseSchema,
  RequestPresentationSchema,
} from "./requests.js";
import { ProjectAuthoritySchema } from "./work-authority.js";

const generation = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const ProjectRunBindingSchema = z
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
  .refine(
    (binding) => binding.workspaceId === binding.authority.principal.workspaceId,
    "Project binding must name its authority's Workspace",
  );
export type ProjectRunBinding = z.infer<typeof ProjectRunBindingSchema>;

export const HarnessExecutionAuthoritySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("person"), requestedBy: UserIdSchema }),
  z.strictObject({ kind: z.literal("project"), binding: ProjectRunBindingSchema }),
]);
export type HarnessExecutionAuthority = z.infer<typeof HarnessExecutionAuthoritySchema>;
export type PersonHarnessExecutionAuthority = Extract<
  HarnessExecutionAuthority,
  { kind: "person" }
>;
export type ProjectHarnessExecutionAuthority = Extract<
  HarnessExecutionAuthority,
  { kind: "project" }
>;

const presentation = z.discriminatedUnion("kind", [
  RequestPresentationSchema.options[0],
  RequestPresentationSchema.options[1],
]);
const requestBase = {
  id: RequestIdSchema,
  callId: z
    .string()
    .min(1)
    .max(512)
    .refine((id) => !id.includes("\0"), "Request identifiers cannot contain a null byte"),
  createdAt: IsoDateTimeSchema,
  mode: z.literal("live"),
  originatingNodeId: ExecutionNodeIdSchema.optional(),
  presentation,
};
export const ProjectEngineRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...requestBase,
    kind: z.literal("harness.input"),
    requestClass: z.literal("question"),
    payload: z.strictObject({ kind: z.literal("harness.input") }),
  }),
  z.strictObject({
    ...requestBase,
    kind: z.literal("harness.approval"),
    requestClass: z.literal("harness-approval"),
    payload: z.strictObject({ kind: z.literal("harness.approval") }),
  }),
]);
export type ProjectEngineRequest = z.infer<typeof ProjectEngineRequestSchema>;

/** An engine proposes a Request; only the Host can assign its audience. */
export const ProjectEngineRequestEventSchema = z.strictObject({
  type: z.literal("request.proposed.project"),
  binding: ProjectRunBindingSchema,
  data: z.strictObject({ request: ProjectEngineRequestSchema }),
});
export type ProjectEngineRequestEvent = z.infer<typeof ProjectEngineRequestEventSchema>;

export type ProjectRequestAudienceAssignment =
  | { readonly requestedBy: z.infer<typeof UserIdSchema>; readonly requiredActor: "requester" }
  | { readonly requestedBy: null; readonly requiredActor: "workspace-owner" };

export const ProjectEngineResponseSchema = z.discriminatedUnion("kind", [
  RequestResponseSchema.options[0],
  RequestResponseSchema.options[1],
]);
export type ProjectEngineResponse = z.infer<typeof ProjectEngineResponseSchema>;

/** Host-internal; never a public Request DTO. */
export type ProjectPendingEngineRequest = Omit<PendingRequest, "requestedBy" | "requiredActor"> &
  ProjectEngineRequest &
  ProjectRequestAudienceAssignment & {
    readonly originatingRunId: z.infer<typeof RunIdSchema>;
    readonly originatingOccurrenceId: null;
    readonly originatingGrantId: z.infer<typeof GrantIdSchema>;
  };
