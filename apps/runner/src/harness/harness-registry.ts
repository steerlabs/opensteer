import { claudeInstallGuidance } from "@opensteer/harness-claude";
import { harnessCatalog } from "@opensteer/core";
import { HarnessRegistry, findExecutableOnPath } from "@opensteer/harness";
import type { AgentExecutionConfig } from "../app-config.js";
import { harnessDriverFactories, type HarnessDriverRuntime } from "./harness-drivers.js";

/**
 * The Runner composes exactly one registry. It is passed to the runtime
 * directly: an indirection whose reconciliation hook was optional let a
 * mis-composed Runner silently never reconcile, and a run must never be the
 * thing that creates or mutates a profile.
 *
 * Catalog order is registration order, so the engines advertise in the order
 * every surface displays them.
 */
export function createHarnessRegistry(
  executables: AgentExecutionConfig["harnessExecutables"],
  runtime: HarnessDriverRuntime,
): HarnessRegistry {
  const registry = new HarnessRegistry();
  for (const entry of harnessCatalog) {
    const factory = harnessDriverFactories[entry.kind];
    const installed = "installed" in entry ? entry.installed : undefined;
    registry.registerDriver(
      factory.create(executables[entry.kind], runtime),
      {
        note: `${entry.label} availability and models are inspected per configured engine`,
        status: "runtime-check",
      },
      installed && {
        // The Runner's PATH is the one every engine process inherits; on a
        // person's own computer it is their login shell's.
        locate: () => findExecutableOnPath(installed.command, process.env.PATH),
        create: (executable) => factory.create(executable, runtime),
        missing:
          entry.kind === "claude"
            ? claudeInstallGuidance
            : `${entry.label}'s CLI is not installed on this computer. Install it from ${installed.installUrl}, or add an Opensteer-managed ${entry.label} account.`,
      },
    );
  }
  return registry;
}
