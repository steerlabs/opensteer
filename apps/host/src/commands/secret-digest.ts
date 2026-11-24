import { createHmac, randomBytes } from "node:crypto";
import { canonicalJson } from "@opensteer/shared/canonicalJson";
import type { CommandType } from "@opensteer/protocol/command-table";

const DIGEST_KEY_DOMAIN = "opensteer:command-secret-digest:v1";
const COMMAND_FIELD_DOMAIN = "opensteer:command-secret-field:v1";
const TOOL_ARGUMENTS_DOMAIN = "opensteer:tool-arguments:v1";

/**
 * Process-local fallback key used only by tests that construct a command door or tool relay
 * without a full Host runtime. Production always derives the key from the Home's credential key
 * via `deriveCommandSecretDigestKey(credentialKey)` so replays survive restarts.
 */
const processFallbackKey = randomBytes(32);

export function defaultCommandSecretDigestKey(): Buffer {
  return processFallbackKey;
}

/**
 * Derives a dedicated 32-byte HMAC key from the Home's private credential key with a fixed domain
 * label. This key never enters PostgreSQL, so ledger rows cannot be used to test guesses offline.
 */
export function deriveCommandSecretDigestKey(credentialKey: Buffer): Buffer {
  return createHmac("sha256", credentialKey).update(DIGEST_KEY_DOMAIN).digest();
}

/**
 * Domain-separated HMAC-SHA256 hex digest for one secret field of a command request, keyed by the
 * Home's private digest key.
 */
export function digestCommandSecretFieldHex(
  key: Buffer,
  input: {
    readonly commandType: CommandType;
    readonly fieldPath: string;
    readonly idempotencyKey: string;
    readonly userId: string;
    readonly value: unknown;
  },
): string {
  return createHmac("sha256", key)
    .update(
      canonicalJson([
        COMMAND_FIELD_DOMAIN,
        input.commandType,
        input.fieldPath,
        input.userId,
        input.idempotencyKey,
        input.value,
      ]),
    )
    .digest("hex");
}

/**
 * Domain-separated 32-byte HMAC-SHA256 digest of unredacted tool arguments, stored in
 * `tool_calls.argument_digest` so replay conflict checks still compare secret values without
 * storing plaintext or an unkeyed hash in PostgreSQL.
 */
export function digestToolArgumentsWithSecrets(
  key: Buffer,
  input: {
    readonly args: unknown;
    readonly toolName: string;
  },
): Buffer {
  return createHmac("sha256", key)
    .update(canonicalJson([TOOL_ARGUMENTS_DOMAIN, input.toolName, input.args]))
    .digest();
}

/**
 * Strips every declared secret field path from `request` and records its private Host-keyed
 * HMAC-SHA256 digest under `__secretDigests` so both the person and agent command entry points
 * produce the exact same value-free ledger fingerprint.
 */
export function sanitizeCommandRequestWithSecretDigests(input: {
  readonly commandType: CommandType;
  readonly idempotencyKey: string;
  readonly key?: Buffer | undefined;
  readonly request: Readonly<Record<string, unknown>>;
  readonly secretFields: readonly string[];
  readonly userId: string;
}): Record<string, unknown> {
  const sanitized = JSON.parse(JSON.stringify(input.request)) as Record<string, unknown>;
  const digestKey = input.key ?? processFallbackKey;
  const secretDigests: Record<string, string> = {};
  for (const path of input.secretFields) {
    const keys = path.split(".");
    let at: unknown = sanitized;
    for (const segment of keys.slice(0, -1)) {
      at =
        typeof at === "object" && at !== null && Object.hasOwn(at, segment)
          ? (at as Record<string, unknown>)[segment]
          : undefined;
    }
    const leaf = keys.at(-1)!;
    if (typeof at === "object" && at !== null && Object.hasOwn(at, leaf)) {
      const value = (at as Record<string, unknown>)[leaf];
      if (value !== undefined) {
        secretDigests[path] = digestCommandSecretFieldHex(digestKey, {
          commandType: input.commandType,
          fieldPath: path,
          idempotencyKey: input.idempotencyKey,
          userId: input.userId,
          value,
        });
      }
      delete (at as Record<string, unknown>)[leaf];
    }
  }
  if (Object.keys(secretDigests).length > 0) {
    sanitized.__secretDigests = secretDigests;
  }
  return sanitized;
}
