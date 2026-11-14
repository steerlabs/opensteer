import { AgentHomeSettingsSchema, EnvironmentIdSchema, IsoDateTimeSchema } from "@opensteer/core";
import { z } from "zod";
import { RunnerConnectionFenceSchema } from "./runner-identity.js";

/** Where settings.json stopped making sense: a JSON position, or the setting that is wrong. */
export const AgentHomeSettingsErrorSchema = z.strictObject({
  path: z.string().min(1).max(4_096),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
  at: z.string().min(1).max(512).optional(),
  message: z.string().min(1).max(500),
});
export type AgentHomeSettingsError = z.infer<typeof AgentHomeSettingsErrorSchema>;
// The hosting Runner's latest read of settings.json in Agent home.
export const RunnerSettingsReportSchema = z.strictObject({
  ...RunnerConnectionFenceSchema.shape,
  environmentId: EnvironmentIdSchema,
  type: z.literal("runner.settings.report"),
  readSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  readAt: IsoDateTimeSchema,
  result: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("valid"), settings: AgentHomeSettingsSchema }),
    z.strictObject({ status: z.literal("missing") }),
    z.strictObject({ status: z.literal("invalid"), error: AgentHomeSettingsErrorSchema }),
  ]),
});
export type RunnerSettingsReport = z.infer<typeof RunnerSettingsReportSchema>;
export const AgentHomeSettingsFileViewSchema = z.object({
  status: z.enum(["valid", "missing", "invalid"]),
  error: AgentHomeSettingsErrorSchema.strip().optional(),
});
export type AgentHomeSettingsFileView = z.infer<typeof AgentHomeSettingsFileViewSchema>;

export function agentHomeSettingsErrorText(error: AgentHomeSettingsError): string {
  const where =
    error.line !== undefined
      ? ` line ${error.line}${error.column !== undefined ? `, column ${error.column}` : ""}`
      : error.at
        ? ` at ${error.at}`
        : "";
  return `${error.path}${where}: ${error.message}`;
}
