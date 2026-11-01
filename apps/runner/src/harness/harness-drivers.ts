import type { HarnessKind } from "@opensteer/core";
import type { HarnessDriver } from "@opensteer/harness";
import {
  ClaudeHarnessDriver,
  claudeAgentSdk,
  inspectClaudeExecutable,
} from "@opensteer/harness-claude";
import { CodexHarnessDriver, packagedCodexExecutable } from "@opensteer/harness-codex";
import { CursorHarnessDriver, installedCursorExecutable } from "@opensteer/harness-cursor";
import { MuseHarnessDriver, installedMuseExecutable } from "@opensteer/harness-muse";
import { OpencodeHarnessDriver, packagedOpencodeExecutable } from "@opensteer/harness-opencode";
import { PiHarnessDriver, packagedPiExecutable } from "@opensteer/harness-pi";

/**
 * What every driver may need from the Runner itself, as opposed to from the
 * distribution that named its executable.
 */
export interface HarnessDriverRuntime {
  /**
   * The Node interpreter this Runner verified at startup. An engine published
   * as JavaScript is run with it, and so is a helper program a driver writes
   * for an engine to call: `process.execPath` is Electron when the Desktop
   * hosts the Runner, and Electron is not a Node interpreter.
   */
  readonly nodeExecutable: string;
  /**
   * Where model server apps keep their own settings — the person's home on
   * their own computer. Tests point it at a temporary home.
   */
  readonly modelServerHome?: string;
}

export interface HarnessDriverFactory {
  /** Construct the driver for the executable this distribution named. */
  readonly create: (executable: string, runtime: HarnessDriverRuntime) => HarnessDriver;
  /**
   * Where the Runner looks when no distribution named an executable: the
   * package this Runner declares for an engine whose bytes it ships, or the
   * documented install location for one the person installs themselves. Only
   * the driver package knows it, so it is declared beside the factory rather
   * than restated in the configuration.
   */
  readonly defaultExecutable: () => string;
}

/**
 * The Runner's half of the harness catalog: one factory per catalog kind.
 * `Record<HarnessKind, …>` is what makes a catalog entry with no driver on
 * this side a compile error rather than a kind that silently never registers.
 */
export const harnessDriverFactories: Record<HarnessKind, HarnessDriverFactory> = {
  claude: {
    create: (executable, runtime) =>
      new ClaudeHarnessDriver({
        executable,
        sdk: claudeAgentSdk,
        nodeExecutable: runtime.nodeExecutable,
        inspectExecutable: (path, environment) =>
          inspectClaudeExecutable(path, environment, runtime.nodeExecutable),
      }),
    defaultExecutable: () => "claude",
  },
  codex: {
    create: (executable) => new CodexHarnessDriver({ launch: { arguments: [], executable } }),
    defaultExecutable: packagedCodexExecutable,
  },
  cursor: {
    // The hook program the plugin directory points at is a Node script.
    create: (executable, runtime) =>
      new CursorHarnessDriver({ executable, nodeExecutable: runtime.nodeExecutable }),
    defaultExecutable: installedCursorExecutable,
  },
  muse: {
    create: (executable) => new MuseHarnessDriver({ executable }),
    defaultExecutable: installedMuseExecutable,
  },
  opencode: {
    create: (executable, runtime) =>
      new OpencodeHarnessDriver({
        executable,
        ...(runtime.modelServerHome ? { modelServerHome: runtime.modelServerHome } : {}),
      }),
    defaultExecutable: packagedOpencodeExecutable,
  },
  pi: {
    // Pi's executable is a script, so the interpreter is half of the launch.
    create: (executable, runtime) =>
      new PiHarnessDriver({
        executable,
        nodeExecutable: runtime.nodeExecutable,
        ...(runtime.modelServerHome ? { modelServerHome: runtime.modelServerHome } : {}),
      }),
    defaultExecutable: packagedPiExecutable,
  },
};
