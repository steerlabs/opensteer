import { utf8ByteLength } from "@opensteer/core";
import { basename } from "node:path";
import { z } from "zod";
import {
  MAX_AUTOMATION_SECRET_VALUE_BYTES,
  MAX_AUTOMATION_SECRETS_TOTAL_BYTES,
  MAX_SCRIPT_BYTES,
} from "./fuses.js";
import type { StoredTriggerProgram } from "./models.js";

/**
 * Positive toolContractVersion written into the legacy `program` column for script
 * revisions so the previous release's Host can still read the row, display its source,
 * and treat it as "needs an update" without executing it (Y8).
 */
export const AUTOMATION_SCRIPT_STUB_CONTRACT_VERSION = 6;

const InterpreterArgSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => !value.includes("\0"), "Interpreter argument cannot contain a NUL byte");

/** Whether an interpreter executable is an absolute POSIX or Windows drive path (Z11). */
export function isAbsoluteInterpreterPath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value);
}

/** Whether an interpreter executable is a bare command name resolved through PATH (Z11). */
export function isBareInterpreterName(value: string): boolean {
  return value.length > 0 && value !== "." && value !== ".." && !/[\\/:]/u.test(value);
}

/** Whether `interpreter[0]` is a bare command name or an absolute path, never relative (Z11). */
export function isValidInterpreterExecutable(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes("\0") &&
    (isAbsoluteInterpreterPath(value) || isBareInterpreterName(value))
  );
}

export function assertValidInterpreterExecutable(value: string): void {
  if (!isValidInterpreterExecutable(value)) {
    throw new Error(
      `Interpreter "${value}" must be a bare command name on PATH or an absolute path; relative paths are not allowed.`,
    );
  }
}

export const AutomationScriptSchema = z.strictObject({
  interpreter: z
    .array(InterpreterArgSchema)
    .min(1)
    .max(16)
    .refine(
      (argv) => argv.length > 0 && isValidInterpreterExecutable(argv[0]!),
      "Interpreter executable must be a bare command name on PATH or an absolute path, never a relative path.",
    )
    .nullable()
    .default(null),
  text: z
    .string()
    .min(1)
    .max(MAX_SCRIPT_BYTES)
    .refine(
      (value) => utf8ByteLength(value) <= MAX_SCRIPT_BYTES,
      `Script text exceeds ${MAX_SCRIPT_BYTES} bytes`,
    ),
});
export type AutomationScript = z.infer<typeof AutomationScriptSchema>;

export const AutomationOutcomeSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "canceled",
  "unknown",
]);
export type AutomationOutcome = z.infer<typeof AutomationOutcomeSchema>;

export const AutomationPausedBySchema = z.enum(["person", "agent", "system"]);
export type AutomationPausedBy = z.infer<typeof AutomationPausedBySchema>;

/** Legacy `trigger_revisions.program` stub for script revisions (Y8). */
export function scriptProgramStub(script: Pick<AutomationScript, "text">): StoredTriggerProgram {
  return {
    language: "javascript",
    source: script.text,
    toolContractVersion: AUTOMATION_SCRIPT_STUB_CONTRACT_VERSION,
  };
}

/** Normalizes phone/web CRLF/CR line endings on POSIX so shell/script interpreters never choke on `\r`. */
export function normalizeScriptText(text: string, platform: NodeJS.Platform): string {
  if (platform === "win32") return text;
  return text.replace(/\r\n?/gu, "\n");
}

/** Infers an appropriate file extension from an interpreter argv array (defaulting to Node ESM). */
export function scriptFileExtension(interpreter: readonly string[] | null | undefined): string {
  if (!interpreter || interpreter.length === 0) return ".mjs";
  const first = basename(interpreter[0]!).toLowerCase();
  const executable =
    first === "env" && interpreter.length > 1
      ? basename(
          interpreter.slice(1).find((arg) => !arg.startsWith("-") && !arg.includes("=")) ?? "",
        ).toLowerCase()
      : first;
  const stem = executable.replace(/\.exe$/u, "");
  if (stem === "node" || stem === "nodejs") return ".mjs";
  if (stem.startsWith("python")) return ".py";
  if (stem === "sh" || stem === "bash" || stem === "zsh" || stem === "dash" || stem === "ksh") {
    return ".sh";
  }
  if (stem === "pwsh" || stem === "powershell") return ".ps1";
  if (stem === "ruby") return ".rb";
  if (stem === "perl") return ".pl";
  return ".txt";
}

/**
 * Prefix applied to every per-automation sealed secret in the script's environment (Z10).
 * Nothing read by an OS loader, shell, or runtime starts with `OPENSTEER_SECRET_`, so
 * sealed values can never shadow `PATH`, `LD_*`, `DYLD_*`, `ZDOTDIR`, `HTTP_PROXY`, etc.
 */
export const AUTOMATION_SECRET_ENV_PREFIX = "OPENSTEER_SECRET_" as const;

export const AutomationSecretNameSchema = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u,
    "Secret name must be 1 to 64 letters, digits, or underscores starting with a letter or underscore.",
  );

export const AutomationSecretValueSchema = z
  .string()
  .refine((value) => !value.includes("\0"), "Secret value cannot contain a NUL byte.")
  .refine(
    (value) => utf8ByteLength(value) <= MAX_AUTOMATION_SECRET_VALUE_BYTES,
    `Secret value exceeds ${MAX_AUTOMATION_SECRET_VALUE_BYTES} bytes.`,
  );

/** Returns the prefixed environment variable name (`OPENSTEER_SECRET_<name>`) for a sealed secret. */
export function automationSecretEnvName(name: string): string {
  const parsed = AutomationSecretNameSchema.parse(name);
  return `${AUTOMATION_SECRET_ENV_PREFIX}${parsed}`;
}

/** Combined UTF-8 byte size of all secret names and values, bounded so execve never hits E2BIG. */
export function automationSecretsTotalBytes(secrets: Readonly<Record<string, string>>): number {
  let total = 0;
  for (const [name, value] of Object.entries(secrets)) {
    total += utf8ByteLength(AUTOMATION_SECRET_ENV_PREFIX) + utf8ByteLength(name) + utf8ByteLength(value);
  }
  return total;
}

export function assertAutomationSecretsWithinBounds(
  secrets: Readonly<Record<string, string>>,
): void {
  const total = automationSecretsTotalBytes(secrets);
  if (total > MAX_AUTOMATION_SECRETS_TOTAL_BYTES) {
    throw new Error(
      `Automation secrets total size (${total} bytes) exceeds ${MAX_AUTOMATION_SECRETS_TOTAL_BYTES} bytes.`,
    );
  }
}
