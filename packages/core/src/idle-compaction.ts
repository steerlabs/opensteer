import { z } from "zod";
import { ProviderSessionIdSchema, RunIdSchema, MessageIdSchema } from "./ids.js";

export const IdleCompactionPolicySchema = z.strictObject({
  mode: z.enum(["onReturn", "beforeCacheExpires", "off"]),
});
export type IdleCompactionPolicy = z.infer<typeof IdleCompactionPolicySchema>;
export const defaultIdleCompactionPolicy: IdleCompactionPolicy = { mode: "onReturn" };
const milliseconds = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const ProviderContextMeasurementSchema = z.strictObject({
  usedTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  measuredAt: milliseconds,
  requestStartedAt: milliseconds.nullable(),
  promptCacheTtlMs: z.union([z.literal(300_000), z.literal(3_600_000)]).nullable(),
});
export type ProviderContextMeasurement = z.infer<typeof ProviderContextMeasurementSchema>;
export const ProviderContextSnapshotSchema = ProviderContextMeasurementSchema.extend({
  sourceRunId: RunIdSchema,
  bindingGeneration: z.number().int().positive(),
  ordinal: z.number().int().nonnegative(),
});
export type ProviderContextSnapshot = z.infer<typeof ProviderContextSnapshotSchema>;
export const RunMaintenanceSchema = z.strictObject({
  pairedInputId: MessageIdSchema.optional(),
  kind: z.literal("claude-compaction"),
  reason: z.enum(["idle", "before-send"]),
  sourceRunId: RunIdSchema,
  providerSessionId: ProviderSessionIdSchema,
});
export type RunMaintenance = z.infer<typeof RunMaintenanceSchema>;
export const CompactionSendChoiceSchema = z.enum(["compactFirst", "keepFullHistory"]);
export type CompactionSendChoice = z.infer<typeof CompactionSendChoiceSchema>;
export const CompactionReturnHintSchema = z.object({
  eligible: z.boolean(),
  sessionRevision: z.string(),
  sourceRunId: RunIdSchema,
  eligibleAt: milliseconds,
});
export type CompactionReturnHint = z.infer<typeof CompactionReturnHintSchema>;
export const NativeCompactionActivitySchema = z.strictObject({
  status: z.enum(["running", "created", "failed", "stopped"]),
  reason: z.enum(["idle", "before-send", "manual", "automatic"]),
});

export type NativeCompactionActivity = z.infer<typeof NativeCompactionActivitySchema>;

export function promptCacheExpiresAt(snapshot: ProviderContextMeasurement): number | null {
  return snapshot.requestStartedAt === null || snapshot.promptCacheTtlMs === null
    ? null
    : snapshot.requestStartedAt + snapshot.promptCacheTtlMs;
}
export function idleCompactionWindow(snapshot: ProviderContextMeasurement, nowMs: number) {
  const endMs = promptCacheExpiresAt(snapshot);
  if (snapshot.usedTokens < 200_000 || endMs === null || nowMs >= endMs) return null;
  return { startMs: endMs - 120_000, endMs };
}
export function compactionReturnEligibleAt(snapshot: ProviderContextMeasurement): number {
  return promptCacheExpiresAt(snapshot) ?? snapshot.measuredAt + 70 * 60_000;
}
