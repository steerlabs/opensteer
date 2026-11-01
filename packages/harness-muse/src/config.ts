import { z } from "zod";

export const MuseHarnessConfigSchema = z.strictObject({
  commandTimeoutMs: z
    .number()
    .int()
    .positive()
    .max(10 * 60_000)
    .default(30_000),
  maxEventBytes: z
    .number()
    .int()
    .min(64 * 1_024)
    .max(256 * 1_024 * 1_024)
    .default(16 * 1_024 * 1_024),
  maxEventItems: z.number().int().min(16).max(65_536).default(4_096),
  startupTimeoutMs: z.number().int().positive().max(120_000).default(20_000),
});

export type MuseHarnessConfig = z.infer<typeof MuseHarnessConfigSchema>;
