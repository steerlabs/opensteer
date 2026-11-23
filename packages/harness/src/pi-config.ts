import { nodeErrorCode } from "@opensteer/shared/nodeError";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Result of checking whether Opensteer can link the person's Pi credential
 * files (`auth.json`, `models.json`) into an others'-tasks agent folder.
 */
export type PiOthersHomeCheck =
  | { readonly ok: true; readonly mode: "isolated" }
  | {
      readonly ok: true;
      readonly mode: "ambient";
      readonly sourceDirectory: string;
      readonly modelsJsonText?: string;
    }
  | { readonly ok: false; readonly message: string };

export const PI_SHELL_COMMAND_REFUSAL_MESSAGE =
  'Your Pi configuration runs a local shell command to fetch a credential (a "!" value in models.json or auth.json), which Opensteer does not run for tasks a connected agent or chat started.';

export const PI_MISSING_HOME_REFUSAL_MESSAGE =
  "Opensteer could not locate your Pi configuration folder (HOME or PI_CODING_AGENT_DIR is unset), so Pi runs only tasks you started yourself.";

/**
 * The person's ambient Pi agent directory from the process environment. Never
 * falls back to `os.homedir()` when no environment is supplied, so tests and
 * callers without an environment never read the host's `~/.pi/agent`.
 */
export function piAmbientAgentDirectory(
  environment?: Readonly<Record<string, string>>,
): string | undefined {
  const configured = environment?.PI_CODING_AGENT_DIR?.trim();
  if (configured) return configured;
  const home = environment?.HOME?.trim();
  if (home) return join(home, ".pi", "agent");
  return undefined;
}

function containsPiCommandValue(value: unknown): boolean {
  if (typeof value === "string") return value.startsWith("!");
  if (Array.isArray(value)) return value.some((entry) => containsPiCommandValue(entry));
  if (value !== null && typeof value === "object") {
    return Object.values(value).some((entry) => containsPiCommandValue(entry));
  }
  return false;
}

function checkPiConfigFile(
  sourceDirectory: string,
  name: "models.json" | "auth.json",
):
  { readonly ok: true; readonly text?: string } | { readonly ok: false; readonly message: string } {
  const filePath = join(sourceDirectory, name);
  let isFile = false;
  try {
    isFile = statSync(filePath).isFile();
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return { ok: true };
    return {
      ok: false,
      message: `Opensteer could not read your Pi ${name} to check it for tasks a connected agent or chat started. Fix your Pi ${name} or run this task on another engine.`,
    };
  }
  if (!isFile) return { ok: true };
  let text: string;
  let parsed: unknown;
  try {
    // Match Pi's auth-storage.js, which strips a leading UTF-8 BOM before JSON.parse.
    text = readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "");
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      message: `Opensteer could not read your Pi ${name} to check it for tasks a connected agent or chat started. Fix your Pi ${name} or run this task on another engine.`,
    };
  }
  if (containsPiCommandValue(parsed)) {
    return { ok: false, message: PI_SHELL_COMMAND_REFUSAL_MESSAGE };
  }
  return { ok: true, text };
}

/**
 * Re-checks the person's symlinked `auth.json` before a turn on an others'
 * task. `models.json` is copied once at session startup, so only `auth.json`
 * can change between turns through the live symlink.
 */
export function checkPiOthersAuthFile(context: {
  readonly environment?: Readonly<Record<string, string>>;
  readonly providerState?: { readonly kind: "ambient" | "isolated" };
}): { readonly ok: true } | { readonly ok: false; readonly message: string } {
  if (context.providerState?.kind === "isolated") return { ok: true };
  const sourceDirectory = piAmbientAgentDirectory(context.environment);
  if (!sourceDirectory) {
    return { ok: false, message: PI_MISSING_HOME_REFUSAL_MESSAGE };
  }
  const result = checkPiConfigFile(sourceDirectory, "auth.json");
  return result.ok ? { ok: true } : result;
}

/**
 * Decides whether Pi can run a task that is not the person's own (or
 * background text) from an Opensteer-owned agent folder that copies their
 * checked `models.json` and links their `auth.json`.
 *
 * Pi 0.87.1 (`resolve-config-value.js`) executes any config value starting
 * with `"!"` through `execSync` (shell command) when resolving `apiKey` or
 * `headers` in `models.json` or `key` in `auth.json`. Nothing of the person's
 * runs on an others' task, so Opensteer refuses before spawning Pi whenever
 * either file contains a `"!"` value, cannot be read and parsed, or the
 * ambient Pi folder cannot be located from the environment.
 */
export function checkPiOthersHome(context: {
  readonly environment?: Readonly<Record<string, string>>;
  readonly providerState?: { readonly kind: "ambient" | "isolated" };
}): PiOthersHomeCheck {
  if (context.providerState?.kind === "isolated") {
    return { ok: true, mode: "isolated" };
  }
  const sourceDirectory = piAmbientAgentDirectory(context.environment);
  if (!sourceDirectory) {
    return { ok: false, message: PI_MISSING_HOME_REFUSAL_MESSAGE };
  }
  const modelsCheck = checkPiConfigFile(sourceDirectory, "models.json");
  if (!modelsCheck.ok) return modelsCheck;
  const authCheck = checkPiConfigFile(sourceDirectory, "auth.json");
  if (!authCheck.ok) return authCheck;
  return {
    ok: true,
    mode: "ambient",
    sourceDirectory,
    ...(modelsCheck.text !== undefined ? { modelsJsonText: modelsCheck.text } : {}),
  };
}
