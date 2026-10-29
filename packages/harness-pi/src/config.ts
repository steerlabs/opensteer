import { harnessRuntimeVersion } from "@opensteer/core";
import { CompatibleEndpointConfigSchema } from "@opensteer/harness";
import { z } from "zod";

/**
 * The one place the Pi pin lives is the harness catalog, which is also what
 * every packager asserts the staged tree's `node <path> --version` against.
 * Pi reports exactly `0.85.1\n` and nothing else (pi-facts §1).
 */
export const TESTED_PI_VERSION = harnessRuntimeVersion("pi");

/**
 * The base URL decides where the account's API key travels, so it must name a
 * network endpoint and nothing else: a `file:` or `javascript:` URL is not one,
 * embedded credentials would put a second secret into the profile's
 * `models.json` where the key deliberately is not, and a fragment is never sent
 * to a server yet would change the string the endpoint is compared by.
 */
export const PiHarnessConfigSchema = z.strictObject({
  ...CompatibleEndpointConfigSchema.shape,
  /**
   * How long an interrupt waits for `agent_settled` after `clear_queue` +
   * `abort`. Pi drains the in-flight tool call first, so this is a tool
   * deadline rather than a protocol round trip (pi-facts §2, §12).
   */
  interruptTimeoutMs: z
    .int()
    .min(1_000)
    .max(5 * 60_000)
    .default(60_000),
  maxEventBytes: z
    .int()
    .min(64 * 1_024)
    .max(256 * 1_024 * 1_024)
    .default(16 * 1_024 * 1_024),
  maxEventItems: z.int().min(16).max(65_536).default(4_096),
  maxProtocolLineBytes: z
    .int()
    .min(16 * 1_024)
    .max(64 * 1_024 * 1_024)
    .default(8 * 1_024 * 1_024),
  maxStderrBytes: z
    .int()
    .min(1_024)
    .max(16 * 1_024 * 1_024)
    .default(256 * 1_024),
  maxWriteBufferBytes: z
    .int()
    .min(16 * 1_024)
    .max(16 * 1_024 * 1_024)
    .default(4 * 1_024 * 1_024),
  requestTimeoutMs: z
    .int()
    .min(100)
    .max(5 * 60_000)
    .default(30_000),
  shutdownGraceMs: z.int().min(0).max(60_000).default(5_000),
  startupTimeoutMs: z
    .int()
    .min(100)
    .max(2 * 60_000)
    .default(20_000),
});

export type PiHarnessConfig = z.infer<typeof PiHarnessConfigSchema>;
