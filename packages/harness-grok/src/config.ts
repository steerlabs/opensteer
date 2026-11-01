import { z } from "zod";

export const GrokHarnessConfigSchema = z.strictObject({
  commandTimeoutMs: z
    .int()
    .min(1_000)
    .max(5 * 60_000)
    .default(30_000),
  initializeTimeoutMs: z.int().min(1_000).max(60_000).default(20_000),
  maxEventBytes: z
    .int()
    .min(64 * 1_024)
    .max(256 * 1_024 * 1_024)
    .default(16 * 1_024 * 1_024),
  maxEventItems: z.int().min(16).max(65_536).default(4_096),
});

export type GrokHarnessConfig = z.infer<typeof GrokHarnessConfigSchema>;
