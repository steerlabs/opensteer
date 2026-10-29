import { harnessRuntimeVersion } from "@opensteer/core";
import { CompatibleEndpointConfigSchema } from "@opensteer/harness";
import { z } from "zod";

/**
 * The one place the OpenCode pin lives is the harness catalog, which is also
 * what every packager asserts the shipped executable's `--version` against.
 * `GET /global/health` answers with the same bare semver (verified 1.18.31:
 * `{"healthy":true,"version":"1.18.31"}`), so the running server is checked
 * against this pin before anything else is asked of it.
 */
export const TESTED_OPENCODE_VERSION = harnessRuntimeVersion("opencode");

/**
 * The base URL decides where the account's API key travels, so it must name a
 * network endpoint and nothing else: a `file:` or `javascript:` URL is not one,
 * embedded credentials would put a second secret into the profile's
 * configuration where the key deliberately is not, and a fragment is never sent
 * to a server yet would change the string the endpoint is compared and
 * displayed by.
 */
export const OpencodeHarnessConfigSchema = z.strictObject({
  ...CompatibleEndpointConfigSchema.shape,
  /**
   * How long an aborted turn has to wind down before the Run is declared
   * interrupted anyway. It is its own budget rather than `requestTimeoutMs`
   * because the two measure unrelated things: one bounds a single HTTP
   * round trip, this one bounds a model finishing whatever tool call it was in
   * the middle of when the person pressed stop.
   */
  interruptTimeoutMs: z
    .int()
    .min(100)
    .max(5 * 60_000)
    .default(30_000),
  maxEventBytes: z
    .int()
    .min(64 * 1_024)
    .max(256 * 1_024 * 1_024)
    .default(16 * 1_024 * 1_024),
  maxEventItems: z.int().min(16).max(65_536).default(4_096),
  /** One SSE `data:` line the driver will parse; anything larger fails the session. */
  maxEventLineBytes: z
    .int()
    .min(16 * 1_024)
    .max(64 * 1_024 * 1_024)
    .default(8 * 1_024 * 1_024),
  /** The largest ordinary (non-stream) response body this driver will read. */
  maxResponseBytes: z
    .int()
    .min(64 * 1_024)
    .max(256 * 1_024 * 1_024)
    .default(32 * 1_024 * 1_024),
  /** How much of the server's stderr is retained for a failure message. */
  maxStderrBytes: z
    .int()
    .min(1_024)
    .max(16 * 1_024 * 1_024)
    .default(256 * 1_024),
  requestTimeoutMs: z
    .int()
    .min(100)
    .max(5 * 60_000)
    .default(30_000),
  shutdownGraceMs: z.int().min(0).max(60_000).default(5_000),
  /**
   * How long `opencode serve` has to print its single stdout listening line.
   * A cold profile downloads the models.dev catalogue first, which the fact
   * sheet measured at 8–10 s against ~0.5 s warm (opencode-facts §10).
   */
  startupTimeoutMs: z
    .int()
    .min(100)
    .max(5 * 60_000)
    .default(60_000),
});

export type OpencodeHarnessConfig = z.infer<typeof OpencodeHarnessConfigSchema>;
