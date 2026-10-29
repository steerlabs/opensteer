import { harnessMinimumVersion, harnessRuntimeVersion } from "@opensteer/core";
import { withoutRetiredConfigKeys } from "@opensteer/harness";
import { z } from "zod";

/**
 * The one place the Codex pin lives is the harness catalog, which is also what
 * every packager asserts the shipped executable's `--version` against.
 */
export const TESTED_CODEX_CLI_VERSION = harnessRuntimeVersion("codex");

/** The oldest Codex the driver runs, the person's own CLI included. */
export const MINIMUM_CODEX_CLI_VERSION = harnessMinimumVersion("codex");

/**
 * The base URL decides where the account's API key travels, so it must name a
 * network endpoint and nothing else: a `file:` or `javascript:` URL is not one,
 * embedded credentials would put a second secret into the profile's config.toml
 * where the key deliberately is not, and a fragment is never sent to a server
 * yet would change the string the endpoint is compared and displayed by.
 */
function isCompatibleEndpointUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.username === "" &&
    url.password === "" &&
    url.hash === ""
  );
}

/**
 * `model` and `reasoningEffort` once named an account's defaults; the engine
 * reports those now (migration 0052 removes the stored keys).
 */
export const CodexHarnessConfigSchema = z.preprocess(
  withoutRetiredConfigKeys(["model", "reasoningEffort"]),
  z.strictObject({
    /** The `baseUrl` field of the `openai-compatible` source; unset for OpenAI. */
    baseUrl: z
      .string()
      .url()
      .refine(isCompatibleEndpointUrl, {
        message: "baseUrl must be an http(s) URL without embedded credentials or a fragment",
      })
      .optional(),
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
      .default(1 * 1_024 * 1_024),
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
      .default(15_000),
  }),
);

export type CodexHarnessConfig = z.infer<typeof CodexHarnessConfigSchema>;
