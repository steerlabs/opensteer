import { posix, win32 } from "node:path";
import { meetsMinimumVersion, runSupervisedCommand } from "@opensteer/harness";
import {
  hostCommandPlatform,
  nodeCommandProbes,
  resolveCommand,
  type CommandPlatform,
  type CommandProbes,
} from "@opensteer/shared/command";
import { MINIMUM_CLAUDE_CODE_VERSION } from "./config.js";
export const claudeInstallGuidance =
  "Install Claude Code from https://code.claude.com/docs/en/setup. Opensteer finds it within a minute; if it doesn't, restart Opensteer.";

/**
 * The Runner supplies its login-shell environment; never consult an SDK
 * platform package. npm's Windows launchers are scripts, so Claude runs the
 * package's own entry beside them instead.
 */
export function resolveClaudeExecutable(
  executable = "claude",
  environment: NodeJS.ProcessEnv = process.env,
  platform: CommandPlatform = hostCommandPlatform(),
  probes: CommandProbes = nodeCommandProbes,
): string | undefined {
  // A legacy JavaScript CLI runs through Node, so it needs no execute permission.
  const absolute = (platform === "win32" ? win32 : posix).isAbsolute(executable);
  if (absolute && executable.endsWith(".js"))
    return probes.isFile(executable) ? executable : undefined;
  const resolved = resolveCommand(executable, {
    cwd: process.cwd(),
    environment,
    platform,
    probes,
  });
  if (!resolved || resolved.kind === "native") return resolved?.path;
  for (const entry of [["bin", "claude.exe"], ["cli.js"]]) {
    const candidate = win32.join(
      win32.dirname(resolved.path),
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      ...entry,
    );
    if (probes.isFile(candidate)) return candidate;
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
    const stdout = await claudeVersionOutput(
      script ? nodeExecutable : resolved,
      script ? [resolved, "--version"] : ["--version"],
      environment,
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

const versionTimeoutMs = 10_000;

/** `--version` under the process supervisor, which ends the whole tree on timeout. */
async function claudeVersionOutput(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const { code, signal, stderr, stdout } = await runSupervisedCommand({
    args,
    cwd: process.cwd(),
    environment: Object.fromEntries(
      Object.entries(environment).filter((entry): entry is [string, string] => !!entry[1]),
    ),
    executable,
    maxOutputBytes: 64 * 1_024,
    timeoutMs: versionTimeoutMs,
  });
  if (code !== 0) {
    const detail = stderr.trim().slice(-1_024);
    throw new Error(
      `--version exited with ${signal ?? `code ${code}`}${detail ? `: ${detail}` : ""}`,
    );
  }
  return stdout;
}
