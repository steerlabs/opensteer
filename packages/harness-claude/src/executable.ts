import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute, win32 } from "node:path";
import { promisify } from "node:util";
import { findExecutableOnPath, meetsMinimumVersion } from "@opensteer/harness";
import { MINIMUM_CLAUDE_CODE_VERSION } from "./config.js";
export const claudeInstallGuidance =
  "Install Claude Code from https://code.claude.com/docs/en/setup, then restart Opensteer.";

interface ClaudeExecutablePorts {
  readonly locate: typeof findExecutableOnPath;
  readonly isFile: (path: string) => boolean;
}
const executablePorts: ClaudeExecutablePorts = {
  locate: findExecutableOnPath,
  isFile: (path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
};

/** The Runner supplies its login-shell environment; never consult an SDK platform package. */
export function resolveClaudeExecutable(
  executable = "claude",
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  ports: ClaudeExecutablePorts = executablePorts,
): string | undefined {
  const absolute = platform === "win32" ? win32.isAbsolute(executable) : isAbsolute(executable);
  const resolved = absolute ? executable : ports.locate(executable, environment.PATH, platform);
  if (!resolved || platform !== "win32") return resolved;
  if (![".cmd", ".bat", ".ps1"].includes(win32.extname(resolved).toLowerCase())) return resolved;
  for (const entry of [["bin", "claude.exe"], ["cli.js"]]) {
    const candidate = win32.join(
      win32.dirname(resolved),
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      ...entry,
    );
    if (ports.isFile(candidate)) return candidate;
  }
  return undefined;
}

export type ClaudeExecutableInspection =
  | {
      readonly status: "available";
      readonly executable: string;
      readonly version: string;
      readonly detail?: never;
    }
  | { readonly status: "unavailable" | "unsupported"; readonly detail: string };

export async function inspectClaudeExecutable(
  executable: string,
  environment: NodeJS.ProcessEnv,
  nodeExecutable: string = process.execPath,
): Promise<ClaudeExecutableInspection> {
  const resolved = resolveClaudeExecutable(executable, environment);
  if (!resolved) return { status: "unavailable", detail: claudeInstallGuidance };
  try {
    // The SDK also runs legacy cli.js through Node; auth uses the same target.
    const script = resolved.endsWith(".js");
    const { stdout } = await promisify(execFile)(
      script ? nodeExecutable : resolved,
      script ? [resolved, "--version"] : ["--version"],
      { env: environment, timeout: 10_000 },
    );
    const version = /^(\d+\.\d+\.\d+)(?:\s|$)/u.exec(stdout.trim())?.[1];
    if (!version || !meetsMinimumVersion(version, MINIMUM_CLAUDE_CODE_VERSION)) {
      return {
        status: "unsupported",
        detail: `Claude Code ${version ?? stdout.trim()} is older than Opensteer supports; update it to ${MINIMUM_CLAUDE_CODE_VERSION} or newer`,
      };
    }
    return { status: "available", executable: resolved, version };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return { status: "unavailable", detail: claudeInstallGuidance };
    return {
      status: "unavailable",
      detail: `Claude Code could not start: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
