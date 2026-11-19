import { engineSigningSecret } from "apps/contracts";
import { z } from "zod";

const id = z.string().min(1);
const jsonObject = z.record(z.string(), z.json());
const date = z.iso.datetime();
export const EngineSkillCatalogSchema = z.object({
  revision: id,
  app: z.object({ id, name: z.string(), slug: id }),
  version: id,
  skills: z.array(z.object({ name: id, description: z.string() })),
});
export const EngineScheduleSettingsSchema = z.object({
  id,
  app: id,
  owner: id,
  name: id,
  actor: id.nullable(),
  enabled: z.boolean(),
  approvalMode: z.enum(["automatic", "browser"]),
  timing: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("interval"), milliseconds: z.number().int().min(60_000) }),
    z.object({ kind: z.literal("cron"), calendar: z.object({ expression: id, timezone: id }) }),
  ]),
  nextAt: date.nullable(),
  activeRun: id.nullable(),
  revision: z.string(),
  reconnectAccount: id.optional(),
  accountRequired: id.optional(),
});
export const EngineScheduleSchema = z.object({
  app: id,
  name: id,
  tool: id,
  scope: z.literal("app").optional(),
  timing: EngineScheduleSettingsSchema.shape.timing,
  input: z.json(),
  settings: EngineScheduleSettingsSchema.nullable(),
});
export const EngineScheduledRunSchema = z.object({
  id,
  scheduleId: id,
  app: id,
  owner: id,
  name: z.string(),
  status: z.enum([
    "running",
    "awaiting-approval",
    "ready",
    "succeeded",
    "failed",
    "denied",
    "cancelled",
    "expired",
    "interrupted",
  ]),
  scheduledAt: date,
  startedAt: date,
  finishedAt: date.nullable(),
  requestId: id.nullable(),
  expiresAt: date.nullable(),
  failure: z.string().nullable(),
});
export const EngineScheduledApprovalSchema = z.object({
  run: EngineScheduledRunSchema,
  invocation: z.object({ app: id, tool: id, input: z.json() }),
  expiresAt: z.number(),
});
export const EngineWorkflowSchema = z.object({
  name: id,
  description: z.string().optional(),
  inputSchema: jsonObject,
  outputSchema: jsonObject.optional(),
});
const workflow = { id, app: id, version: id, workflow: id, createdAt: z.string() };
export const EngineWorkflowRunSchema = z.discriminatedUnion("status", [
  z.object({
    ...workflow,
    status: z.enum(["queued", "running", "waiting", "paused", "waitingForPause"]),
  }),
  z.object({ ...workflow, status: z.literal("complete"), output: z.json() }),
  z.object({
    ...workflow,
    status: z.literal("errored"),
    error: id,
    failure: z
      .object({
        step: z.string().optional(),
        errorName: z.string().optional(),
        message: z.string().optional(),
      })
      .optional(),
  }),
  z.object({ ...workflow, status: z.literal("terminated") }),
]);
export const EngineWorkflowRunPageSchema = z.object({
  items: z.array(EngineWorkflowRunSchema),
  next: id.optional(),
});
export const EngineWebhookSchema = z.object({
  id,
  app: id,
  owner: id,
  actor: id.nullable(),
  key: id,
  version: id,
  name: id,
  sourceAccount: id,
  callbackUrl: z.url(),
  status: z.enum(["pending", "setup-required", "active", "stopping", "disabled", "stopped"]),
  failure: z.enum(["register", "unregister"]).nullable(),
  createdAt: date,
});
export const EngineWebhookSetupSchema = z.discriminatedUnion("step", [
  z.object({
    step: z.literal("configure"),
    subscription: EngineWebhookSchema,
    revision: z.string(),
    instructions: z.string(),
    stateSchema: jsonObject,
    signingSecret: z.union([
      z.object({ source: z.literal(engineSigningSecret), value: id }),
      z.object({ source: z.literal("provider") }),
    ]),
  }),
  z.object({
    step: z.literal("remove"),
    subscription: EngineWebhookSchema,
    instructions: z.string(),
  }),
  z.object({ step: z.literal("done"), subscription: EngineWebhookSchema }),
]);

export const ownerManagementResults = {
  "schedules.configure": EngineScheduleSettingsSchema,
  "schedules.answer": EngineScheduledRunSchema,
  "workflowRuns.start": EngineWorkflowRunSchema,
  "workflowRuns.stop": EngineWorkflowRunSchema,
  "webhooks.remove": EngineWebhookSchema,
  "webhooks.confirmRemoval": EngineWebhookSchema,
  "webhookSetup.complete": EngineWebhookSchema,
} as const;
