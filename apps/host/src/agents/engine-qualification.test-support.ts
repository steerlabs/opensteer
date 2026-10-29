import { inspectClaudeExecutable } from "@opensteer/harness-claude";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import {
  harnessCatalog,
  harnessRuntimeExpectedVersion,
  shippedHarnessCatalogEntry,
  type HarnessKind,
} from "@opensteer/core";
import { findExecutableOnPath } from "@opensteer/harness";
import { parseAgentExecutionConfig } from "@opensteer/runner";
import { setFileMode } from "@opensteer/shared/privateFiles";

export interface QualifiedEngine {
  readonly driverKind: HarnessKind;
  /** Which executable an account on the machine's own sign-in runs. */
  readonly executable: "installed" | "shipped";
  readonly label: string;
  readonly sourceId: string;
  /** The account's state without a key: the engine's own sign-in, or OpenCode's private one. */
  readonly stateKind: "ambient" | "isolated";
  /** The key that signs an isolated account in, and the setup method it goes through. */
  readonly apiKey?: { readonly methodId: string; readonly variable: string };
}

export function installedCommand(kind: HarnessKind): string | undefined {
  const entry = shippedHarnessCatalogEntry(kind);
  return entry.runtime.shape === "installed" ? entry.runtime.command : entry.installed?.command;
}

/**
 * Puts each shipped engine first on PATH under its installed command, so an
 * account on the machine's own sign-in runs the bytes this tree ships. A
 * wrapper that execs the shipped executable keeps the engine's own path
 * intact, which a `tree` runtime resolves its siblings against.
 */
export async function shippedEnginesFirstOnPath(): Promise<() => Promise<void>> {
  const directory = await mkdtemp(join(tmpdir(), "opensteer-shipped-engines-"));
  const executables = parseAgentExecutionConfig(process.env).harnessExecutables;
  for (const entry of harnessCatalog) {
    const command = "installed" in entry ? entry.installed?.command : undefined;
    if (!command) continue;
    const wrapper = join(directory, command);
    const quotedExecutable = `'${executables[entry.kind].replaceAll("'", "'\\''")}'`;
    await writeFile(wrapper, `#!/bin/sh\nexec ${quotedExecutable} "$@"\n`);
    await setFileMode(wrapper, 0o755);
  }
  const previous = process.env.PATH;
  process.env.PATH = `${directory}${delimiter}${previous ?? ""}`;
  return async () => {
    process.env.PATH = previous;
    await rm(directory, { force: true, recursive: true });
  };
}

/** What `--version` says for the executable an account on this engine runs. */
export async function qualifiedVersion(engine: QualifiedEngine): Promise<string> {
  const command = installedCommand(engine.driverKind);
  const account = qualificationAccount(engine);
  const executable =
    command && account.stateKind === "ambient"
      ? findExecutableOnPath(command, process.env.PATH)
      : undefined;
  if (engine.driverKind === "claude") {
    const result = await inspectClaudeExecutable(
      parseAgentExecutionConfig(process.env).harnessExecutables.claude,
      process.env,
    );
    if (result.status !== "available") throw new Error(result.detail);
    return `${result.version} (Claude Code)`;
  }
  if (!executable) return harnessRuntimeExpectedVersion(engine.driverKind);
  return (await promisify(execFile)(executable, ["--version"])).stdout.trim();
}

export function qualificationAccount(engine: QualifiedEngine) {
  const key = engine.apiKey ? process.env[engine.apiKey.variable] : undefined;
  // The person's own CLI only ever runs on the person's own sign-in.
  if (engine.executable === "shipped" && engine.apiKey && key) {
    return {
      apiKey: { methodId: engine.apiKey.methodId, value: key },
      config: {},
      driverKind: engine.driverKind,
      sourceId: engine.sourceId,
      stateKind: "isolated" as const,
    };
  }
  return {
    config: {},
    driverKind: engine.driverKind,
    sourceId: engine.sourceId,
    stateKind: engine.stateKind,
  };
}
