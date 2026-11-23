import { nodeErrorCode } from "@opensteer/shared/nodeError";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Result of checking whether Opensteer can link the person's Pi credential
 * files (`auth.json`, `models.json`) into an others'-tasks agent folder.
 */
export type PiOthersHomeCheck =
  | { readonly ok: true; readonly mode: "isolated" }
  | { readonly ok: true; readonly mode: "ambient"; readonly sourceDirectory?: string }
  | { readonly ok: false; readonly message: string };

export const PI_SHELL_COMMAND_REFUSAL_MESSAGE =
  'Your Pi configuration runs a local shell command to fetch a credential (a "!" value in models.json or auth.json), which Opensteer does not run for tasks a connected agent or chat started.';

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

/**
 * Decides whether Pi can run a task that is not the person's own (or
 * background text) from an Opensteer-owned agent folder that links their
 * `auth.json` and `models.json`.
 *
 * Pi 0.87.1 (`resolve-config-value.js`) executes any config value starting
 * with `"!"` through `execSync` (shell command) when resolving `apiKey` or
 * `headers` in `models.json` or `key` in `auth.json`. Nothing of the person's
 * runs on an others' task, so Opensteer refuses before spawning Pi whenever
 * either file contains a `"!"` value or cannot be read and parsed.
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
    return { ok: true, mode: "ambient" };
  }
  for (const name of ["models.json", "auth.json"] as const) {
    const filePath = join(sourceDirectory, name);
    let isFile = false;
    try {
      isFile = statSync(filePath).isFile();
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") continue;
      return {
        ok: false,
        message: `Opensteer could not read your Pi ${name} to check it for tasks a connected agent or chat started. Fix your Pi ${name} or run this task on another engine.`,
      };
    }
    if (!isFile) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, "utf8"));
    } catch {
      return {
        ok: false,
        message: `Opensteer could not read your Pi ${name} to check it for tasks a connected agent or chat started. Fix your Pi ${name} or run this task on another engine.`,
      };
    }
    if (containsPiCommandValue(parsed)) {
      return { ok: false, message: PI_SHELL_COMMAND_REFUSAL_MESSAGE };
    }
  }
  return { ok: true, mode: "ambient", sourceDirectory };
}
