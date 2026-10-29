import { harnessMinimumVersion } from "@opensteer/core";
import { withoutRetiredConfigKeys } from "@opensteer/harness";
import { z } from "zod";

/** The oldest Claude Code the driver runs, the person's own CLI included. */
export const MINIMUM_CLAUDE_CODE_VERSION = harnessMinimumVersion("claude");

/** Version used by protocol fixtures; installed releases may be newer. */
export const TESTED_CLAUDE_CODE_VERSION = MINIMUM_CLAUDE_CODE_VERSION;

/**
 * `model` and `effort` once named an account's defaults; the engine reports
 * those now (migration 0052 removes the stored keys).
 */
export const ClaudeHarnessConfigSchema = z.preprocess(
  withoutRetiredConfigKeys(["effort", "model"]),
  z
    .strictObject({
      maxBudgetUsd: z.number().positive().max(100_000).optional(),
      maxErrorMessageBytes: z
        .number()
        .int()
        .min(1_024)
        .max(1_024 * 1_024)
        .default(32 * 1_024),
      maxEventBytes: z
        .number()
        .int()
        .min(64 * 1_024)
        .max(256 * 1_024 * 1_024)
        .default(16 * 1_024 * 1_024),
      maxEventItems: z.number().int().min(16).max(65_536).default(4_096),
      maxStderrBytes: z
        .number()
        .int()
        .min(1_024)
        .max(16 * 1_024 * 1_024)
        .default(256 * 1_024),
      maxTurnDurationMs: z
        .number()
        .int()
        .min(1_000)
        .max(24 * 60 * 60_000)
        .default(6 * 60 * 60_000),
      maxTurnInputBytes: z
        .number()
        .int()
        .min(1_024)
        .max(64 * 1_024 * 1_024)
        .default(4 * 1_024 * 1_024),
      maxTurns: z.number().int().min(1).max(1_000).default(64),
      /**
       * The route Claude Code takes. It is derived from the account's source and
       * never chosen on its own; the field persists only so the value one Run
       * used stays readable in the stored config.
       */
      provider: z.enum(["anthropic", "bedrock", "vertex", "foundry"]).default("anthropic"),
      startupTimeoutMs: z
        .number()
        .int()
        .min(1_000)
        .max(5 * 60_000)
        .default(30_000),
      systemPrompt: z.string().max(500_000).optional(),
    })
    .superRefine((config, context) => {
      if (config.startupTimeoutMs > config.maxTurnDurationMs) {
        context.addIssue({
          code: "custom",
          message: "startupTimeoutMs must not exceed maxTurnDurationMs",
          path: ["startupTimeoutMs"],
        });
      }
      if (config.maxErrorMessageBytes + 4_096 > config.maxEventBytes) {
        context.addIssue({
          code: "custom",
          message: "maxEventBytes must leave at least 4096 bytes beyond maxErrorMessageBytes",
          path: ["maxEventBytes"],
        });
      }
    }),
);

export type ClaudeHarnessConfig = z.infer<typeof ClaudeHarnessConfigSchema>;
