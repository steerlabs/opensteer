import { utf8ByteLength } from "@opensteer/core";
import { basename } from "node:path";
import { z } from "zod";
import { MAX_AUTOMATION_SECRET_VALUE_BYTES, MAX_SCRIPT_BYTES } from "./fuses.js";
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

export const AutomationScriptSchema = z.strictObject({
  interpreter: z.array(InterpreterArgSchema).min(1).max(16).nullable().default(null),
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

const FORBIDDEN_SECRET_NAMES = new Set([
  "PATH",
  "PATHEXT",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "IFS",
  "ENV",
  "BASH_ENV",
  "CDPATH",
  "GLOBIGNORE",
  "PS4",
  "COMSPEC",
  "SYSTEMROOT",
  "WINDIR",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "LD_DEBUG",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_EXTRA_CA_CERTS",
  "PYTHONSTARTUP",
  "PYTHONPATH",
  "PYTHONHOME",
  "RUBYOPT",
  "PERL5OPT",
  "PERL5LIB",
]);

function isForbiddenSecretName(name: string): boolean {
  const upper = name.toUpperCase();
  if (upper.startsWith("OPENSTEER_")) return true;
  if (upper.startsWith("DYLD_")) return true;
  if (upper.startsWith("LD_")) return true;
  return FORBIDDEN_SECRET_NAMES.has(upper);
}

export const AutomationSecretNameSchema = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u,
    "Secret name must be a valid environment variable name (letters, digits, and underscores).",
  )
  .refine(
    (name) => !isForbiddenSecretName(name),
    "That environment variable name is reserved by Opensteer or the operating system.",
  );

export const AutomationSecretValueSchema = z
  .string()
  .refine((value) => !value.includes("\0"), "Secret value cannot contain a NUL byte.")
  .refine(
    (value) => utf8ByteLength(value) <= MAX_AUTOMATION_SECRET_VALUE_BYTES,
    `Secret value exceeds ${MAX_AUTOMATION_SECRET_VALUE_BYTES} bytes.`,
  );
