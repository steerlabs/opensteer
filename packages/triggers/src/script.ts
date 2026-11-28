import { utf8ByteLength } from "@opensteer/core";
import { z } from "zod";
import {
  MAX_AUTOMATION_SECRET_VALUE_BYTES,
  MAX_AUTOMATION_SECRETS_TOTAL_BYTES,
  MAX_SCRIPT_BYTES,
} from "./bounds.js";

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

const AutomationScriptInterpreterSchema = z
  .array(InterpreterArgSchema)
  .min(1)
  .max(16)
  .refine(
    (argv) => argv.length > 0 && isValidInterpreterExecutable(argv[0]!),
    "Interpreter executable must be a bare command name on PATH or an absolute path, never a relative path.",
  );

const AutomationScriptTextSchema = z
  .string()
  .min(1)
  .max(MAX_SCRIPT_BYTES)
  .refine(
    (value) => utf8ByteLength(value) <= MAX_SCRIPT_BYTES,
    `Script text exceeds ${MAX_SCRIPT_BYTES} bytes`,
  );

/** Union-free input schema for MCP tool definitions: omit `interpreter` for default Node. */
export const AutomationScriptInputSchema = z.strictObject({
  interpreter: AutomationScriptInterpreterSchema.optional(),
  text: AutomationScriptTextSchema,
});
export type AutomationScriptInput = z.infer<typeof AutomationScriptInputSchema>;

export const AutomationScriptSchema = z.strictObject({
  interpreter: AutomationScriptInterpreterSchema.nullable().default(null),
  text: AutomationScriptTextSchema,
});
export type AutomationScript = z.infer<typeof AutomationScriptSchema>;
export const AutomationScriptViewSchema = z.object(AutomationScriptSchema.shape);

export const AutomationOutcomeSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "canceled",
  "unknown",
]);
export type AutomationOutcome = z.infer<typeof AutomationOutcomeSchema>;

export const AutomationPausedBySchema = z.enum(["person", "agent", "connection", "system"]);
export type AutomationPausedBy = z.infer<typeof AutomationPausedBySchema>;

/** Normalizes phone/web CRLF/CR line endings on POSIX so shell/script interpreters never choke on `\r`. */
export function normalizeScriptText(text: string, platform: string): string {
  if (platform === "win32") return text;
  return text.replace(/\r\n?/gu, "\n");
}

function executableBasename(value: string): string {
  const normalized = value.replace(/[\\/]+$/u, "");
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return (index === -1 ? normalized : normalized.slice(index + 1)).toLowerCase();
}

/** Infers an appropriate file extension from an interpreter argv array (defaulting to Node ESM). */
export function scriptFileExtension(interpreter: readonly string[] | null | undefined): string {
  if (!interpreter || interpreter.length === 0) return ".mjs";
  const first = executableBasename(interpreter[0]!);
  const executable =
    first === "env" && interpreter.length > 1
      ? executableBasename(
          interpreter.slice(1).find((arg) => !arg.startsWith("-") && !arg.includes("=")) ?? "",
        )
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

const RESERVED_AUTOMATION_SECRET_NAMES = new Set(["__proto__", "constructor", "prototype"]);

export const AUTOMATION_SECRET_NAME_ERROR =
  "Secret name must be 1 to 64 letters, digits, or underscores starting with a letter or underscore.";

export const AutomationSecretNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u, AUTOMATION_SECRET_NAME_ERROR)
  .refine((value) => !RESERVED_AUTOMATION_SECRET_NAMES.has(value), {
    message: "Secret name cannot use a reserved property name.",
    params: { reason: "automation-secret-invalid-name" },
  });

export const AutomationSecretValueSchema = z
  .string()
  .refine((value) => !value.includes("\0"), {
    message: "Secret value cannot contain a NUL byte.",
    params: { reason: "automation-secret-invalid-value" },
  })
  .refine((value) => utf8ByteLength(value) <= MAX_AUTOMATION_SECRET_VALUE_BYTES, {
    message: `Secret value exceeds ${MAX_AUTOMATION_SECRET_VALUE_BYTES} bytes.`,
    params: { reason: "automation-secret-invalid-value" },
  });

/**
 * Record of secret names to values. `z.record` skips own `"__proto__"` keys before validating
 * keys, so `preprocess` detects an own `"__proto__"` key and forces it through the reserved-name
 * rejection rather than silently dropping it to `{}`.
 */
export const AutomationSecretMapSchema = z.preprocess(
  (value, ctx) => {
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.hasOwn(value, "__proto__")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["__proto__"],
        message: "Secret name cannot use a reserved property name.",
        params: { reason: "automation-secret-invalid-name" },
      });
      return z.NEVER;
    }
    return value;
  },
  z.record(AutomationSecretNameSchema, AutomationSecretValueSchema),
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
    total +=
      utf8ByteLength(AUTOMATION_SECRET_ENV_PREFIX) + utf8ByteLength(name) + utf8ByteLength(value);
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
