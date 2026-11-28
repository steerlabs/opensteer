import { z } from "zod";
import {
  AgentGrantAppIdentitySchema,
  AgentGrantPluginTargetSchema,
  AgentGrantPluginTargetViewSchema,
} from "./agent-grants.js";
import { DeviceIdSchema } from "./devices.js";
import {
  AgentOperationIdSchema,
  AgentSessionIdSchema,
  BrowserSourceIdSchema,
  RequestIdSchema,
  TabIdSchema,
  ThreadIdSchema,
} from "./ids.js";
import { ThreadAccessModeSchema } from "./models.js";
import { AgentOperationEndingSchema } from "./agent-operation-endings.js";

export const AgentSessionStatusSchema = z.enum(["active", "ended"]);
export type AgentSessionStatus = z.infer<typeof AgentSessionStatusSchema>;
/** `stopped` is the person's Stop; the others are authority ending or the session going quiet. */
export const AgentSessionEndReasonSchema = z.enum([
  "done",
  "stopped",
  "revoked",
  "expired",
  "narrowed",
  "idle",
]);
export type AgentSessionEndReason = z.infer<typeof AgentSessionEndReasonSchema>;

/** A session's quiet limit: long enough for an agent's own thinking between calls. */
export const agentSessionIdleMs = 15 * 60_000;
/** How long a direct call waits for a person's decision before it returns pending. */
export const agentOperationHoldMs = 25_000;

/** A concrete thing an operation touches, exactly as the grant names it. */
export const AgentGrantTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("browser-profile"), profileId: z.string().min(1).max(255) }),
  z.strictObject({ kind: z.literal("chrome-tabs"), sourceId: BrowserSourceIdSchema }),
  z.strictObject({
    kind: z.literal("computer-app"),
    approvalId: z.string().min(1).max(255),
    deviceId: z.string().min(1).max(255),
    app: z.union([
      z.strictObject({
        kind: z.literal("mac-app"),
        bundleId: z.string().min(1).max(255),
        teamId: z.string().max(32).nullable(),
      }),
      AgentGrantAppIdentitySchema.options[1],
    ]),
  }),
  z.strictObject({ kind: z.literal("plugin"), target: AgentGrantPluginTargetSchema }),
  z.strictObject({ kind: z.literal("device") }),
]);

/** The target and the names the Home resolved to describe it to a person. */
export const AgentOperationTargetSchema = z.strictObject({
  grant: AgentGrantTargetSchema,
  name: z.string().min(1).max(255),
  untrustedTitle: z.string().max(1024).optional(),
  device: z.strictObject({ id: DeviceIdSchema, name: z.string().min(1).max(255) }).nullable(),
});
export type AgentOperationTarget = z.infer<typeof AgentOperationTargetSchema>;

const [profileTarget, chromeTarget, appTarget, pluginTarget, deviceTarget] =
  AgentGrantTargetSchema.options;
const AgentGrantTargetViewSchema = z.discriminatedUnion("kind", [
  z.object(profileTarget.shape),
  z.object(chromeTarget.shape),
  z.object({
    ...appTarget.shape,
    app: z.union([
      z.object(appTarget.shape.app.options[0].shape),
      z.object(appTarget.shape.app.options[1].shape),
    ]),
  }),
  z.object({ ...pluginTarget.shape, target: AgentGrantPluginTargetViewSchema }),
  z.object(deviceTarget.shape),
]);
export const AgentOperationTargetViewSchema = z.object({
  ...AgentOperationTargetSchema.shape,
  grant: AgentGrantTargetViewSchema,
  device: z.object(AgentOperationTargetSchema.shape.device.unwrap().shape).nullable(),
});

export const AgentOperationStateSchema = z.enum([
  "admitted",
  "pending",
  "approved",
  "refused",
  "handed-off",
  "completed",
  "failed",
  "unknown",
]);
export type AgentOperationState = z.infer<typeof AgentOperationStateSchema>;
export const AgentOperationOutcomeSchema = z.enum(["completed", "failed", "refused", "unknown"]);
export type AgentOperationOutcome = z.infer<typeof AgentOperationOutcomeSchema>;

/** Who allowed an operation, or why it was refused. */
export const AgentOperationDecisionSchema = z.discriminatedUnion("by", [
  z.strictObject({ by: z.literal("structural-read") }),
  z.strictObject({ by: z.literal("full-access") }),
  z.strictObject({ by: z.literal("reviewer") }),
  z.strictObject({ by: z.literal("person"), requestId: RequestIdSchema }),
  z.strictObject({
    by: z.literal("refused"),
    reason: z.enum(["person", "authority", "changed", "stopped"]),
    message: z.string().min(1).max(500),
  }),
]);
export type AgentOperationDecision = z.infer<typeof AgentOperationDecisionSchema>;

const AgentOperationDecisionViewSchema = z.discriminatedUnion("by", [
  z.object(AgentOperationDecisionSchema.options[0].shape),
  z.object(AgentOperationDecisionSchema.options[1].shape),
  z.object(AgentOperationDecisionSchema.options[2].shape),
  z.object(AgentOperationDecisionSchema.options[3].shape),
  z.object(AgentOperationDecisionSchema.options[4].shape),
]);

/** One operation as the person's activity list shows it. */
export const AgentOperationViewSchema = z.object({
  id: AgentOperationIdSchema,
  sessionId: AgentSessionIdSchema,
  taskId: ThreadIdSchema,
  tool: z.string().min(1).max(100),
  target: AgentOperationTargetViewSchema,
  mode: ThreadAccessModeSchema,
  effect: z.enum(["read", "write"]),
  state: AgentOperationStateSchema,
  decision: AgentOperationDecisionViewSchema.nullable(),
  outcome: AgentOperationOutcomeSchema.nullable(),
  /** The known cause of an interruption, whether or not anything was sent. */
  ending: AgentOperationEndingSchema.nullable().optional(),
  requestId: RequestIdSchema.nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  handedOffAt: z.iso.datetime({ offset: true }).nullable(),
  completedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type AgentOperationView = z.infer<typeof AgentOperationViewSchema>;

/**
 * Where a connected agent's session on a task is working now, for the person who owns the Home
 * only: the tab or device its last command targeted. Neither: the place has ended.
 */
export const AgentWorkingInSchema = z.object({
  threadId: ThreadIdSchema,
  sessionId: AgentSessionIdSchema,
  tabId: TabIdSchema.nullable(),
  computerId: DeviceIdSchema.optional(),
  target: AgentOperationTargetViewSchema.optional(),
});
export type AgentWorkingIn = z.infer<typeof AgentWorkingInSchema>;

/**
 * One command an agent sent through the door, as the person's activity list shows it beside the
 * operations: the Home's sentence naming the agent, and what became of it. A command that asked
 * is listed as its Request (asked, then approved, declined, or ended otherwise).
 */
export const AgentCommandActivitySchema = z.object({
  /** The ledger row's id, or the Request's for one that asked. */
  id: z.string().min(1).max(200),
  type: z.string().min(1).max(100),
  /** "Claude Code, from the task “Tidy up”, renamed a task: “Notes”", in the Home's words. */
  sentence: z.string().min(1).max(600),
  status: z.enum([
    "running",
    "done",
    "failed",
    "unknown",
    "asked",
    "approved",
    "declined",
    "withdrawn",
    "closed",
  ]),
  /** For one the person approved: what the command came to once it ran. */
  outcome: z.enum(["running", "done", "failed", "unknown"]).nullable(),
  requestId: RequestIdSchema.nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type AgentCommandActivity = z.infer<typeof AgentCommandActivitySchema>;
