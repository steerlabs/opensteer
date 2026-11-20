import { z } from "zod";
import { AgentGrantAppIdentitySchema, AgentGrantPluginTargetSchema } from "./agent-grants.js";
import { DeviceIdSchema } from "./devices.js";
import {
  AgentOperationIdSchema,
  AgentSessionIdSchema,
  BrowserSourceIdSchema,
  RequestIdSchema,
  ThreadIdSchema,
} from "./ids.js";
import { ThreadAccessModeSchema } from "./models.js";

export const AgentSessionStatusSchema = z.enum(["active", "ended"]);
export type AgentSessionStatus = z.infer<typeof AgentSessionStatusSchema>;
/** `stopped` is the person's Stop; the others are authority ending or the session going quiet. */
export const AgentSessionEndReasonSchema = z.enum([
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
  device: z.strictObject({ id: DeviceIdSchema, name: z.string().min(1).max(255) }).nullable(),
});
export type AgentOperationTarget = z.infer<typeof AgentOperationTargetSchema>;

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

/** One operation as the person's activity list shows it. */
export const AgentOperationViewSchema = z.object({
  id: AgentOperationIdSchema,
  sessionId: AgentSessionIdSchema,
  taskId: ThreadIdSchema,
  tool: z.string().min(1).max(100),
  target: AgentOperationTargetSchema,
  mode: ThreadAccessModeSchema,
  effect: z.enum(["read", "write"]),
  state: AgentOperationStateSchema,
  decision: AgentOperationDecisionSchema.nullable(),
  outcome: AgentOperationOutcomeSchema.nullable(),
  requestId: RequestIdSchema.nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  handedOffAt: z.iso.datetime({ offset: true }).nullable(),
  completedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type AgentOperationView = z.infer<typeof AgentOperationViewSchema>;
