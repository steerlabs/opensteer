import { z } from "zod";

/**
 * Cursor's CLI is installed by the person and updates itself, so nothing in
 * this package pins a version: the oldest release the driver was written
 * against is `minimumVersion` on the catalog entry, and inspection compares
 * the installed `agent --version` against that (cursor-facts §A.1, open risk 1).
 */
export const CursorHarnessConfigSchema = z.strictObject({
  /**
   * How long a hook waits for the person to answer, in whole seconds — the
   * unit Cursor's hook runner multiplies by 1000 before handing it to a Node
   * timer (`1e3 * (timeout ?? default)` in the shipped `@anysphere/hooks`
   * bundle). A Node timer silently fires immediately above 2^31-1 ms, which
   * with `failClosed` would deny every tool call, so the ceiling here is the
   * largest whole second that stays inside that range.
   */
  hookTimeoutSeconds: z.int().min(1).max(2_147_483).default(2_147_483),
  maxEventBytes: z
    .int()
    .min(64 * 1_024)
    .max(256 * 1_024 * 1_024)
    .default(16 * 1_024 * 1_024),
  maxEventItems: z.int().min(16).max(65_536).default(4_096),
  /** One stream-json frame. Cursor emits whole tool results on a single line. */
  maxStreamLineBytes: z
    .int()
    .min(16 * 1_024)
    .max(64 * 1_024 * 1_024)
    .default(8 * 1_024 * 1_024),
  maxStderrBytes: z
    .int()
    .min(1_024)
    .max(16 * 1_024 * 1_024)
    .default(256 * 1_024),
  maxTurnInputBytes: z
    .int()
    .min(1_024)
    .max(64 * 1_024 * 1_024)
    .default(4 * 1_024 * 1_024),
  /** `agent status`, `agent about`, `agent models`, `agent create-chat`. */
  subcommandTimeoutMs: z
    .int()
    .min(1_000)
    .max(5 * 60_000)
    .default(30_000),
  shutdownGraceMs: z.int().min(0).max(60_000).default(5_000),
  /** How long the CLI may take to print its `system/init` frame. */
  startupTimeoutMs: z
    .int()
    .min(1_000)
    .max(5 * 60_000)
    .default(60_000),
});

export type CursorHarnessConfig = z.infer<typeof CursorHarnessConfigSchema>;
