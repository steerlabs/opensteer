import { claudeInstallGuidance } from "@opensteer/harness-claude";
import { harnessCatalog } from "@opensteer/core";
import { EngineInstallationResolver, HarnessRegistry } from "@opensteer/harness";
import {
  hostCommandPlatform,
  resolveCommand,
  resolveCommandCopies,
} from "@opensteer/shared/command";
import { redactNetworkCredentials } from "@opensteer/shared/safeMessage";
import type { AgentExecutionConfig } from "../app-config.js";
import type { RunnerLogger } from "../host/host-connection.js";
import { harnessDriverFactories, type HarnessDriverRuntime } from "./harness-drivers.js";
import { installedEngineUpdateFacts } from "./installed-engine-updates.js";

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
  logger?: RunnerLogger,
): HarnessRegistry {
  const registry = new HarnessRegistry(
    logger
      ? {
          log: (level, message, fields) => {
            const scrubbedMessage = redactNetworkCredentials(message);
            const scrubbedFields = fields
              ? Object.fromEntries(
                  Object.entries(fields).map(([key, value]) => [
                    key,
                    typeof value === "string" ? redactNetworkCredentials(value) : value,
                  ]),
                )
              : undefined;
            if (level === "warn") logger.error(scrubbedMessage, scrubbedFields);
            else logger.info(scrubbedMessage, scrubbedFields);
          },
        }
      : {},
  );
  // Reads each copy's own `--version`; the registry asks again only when a copy changes.
  const versions = new EngineInstallationResolver();
  for (const entry of harnessCatalog) {
    const factory = harnessDriverFactories[entry.kind];
    const installed =
      entry.runtime.shape === "installed"
        ? entry.runtime
        : "installed" in entry
          ? entry.installed
          : undefined;
    // The copy this Runner ships, verified at startup to print exactly this version.
    const shippedVersion =
      entry.runtime.shape === "installed" || entry.runtime.shape === "downloaded"
        ? undefined
        : /\d+\.\d+\.\d+/u.exec(entry.runtime.expectedVersion)?.[0];
    // How to update the person's copy, and how to read any copy's version.
    const installedEngine = (minimumVersion: string) => {
      const update = {
        ...installedEngineUpdateFacts[entry.kind as keyof typeof installedEngineUpdateFacts],
        minimumVersion,
      };
      return { update, version: (executable: string) => versions.readVersion(executable, update) };
    };
    registry.registerDriver(
      factory.create(executables[entry.kind], runtime),
      {
        note: `${entry.label} availability and models are inspected per configured engine`,
        status: "runtime-check",
      },
      installed && {
        ...installedEngine(installed.minimumVersion),
        // The Runner's PATH is the one every engine process inherits; on a
        // person's own computer it is their login shell's.
        locate: () =>
          resolveCommand(installed.command, {
            cwd: process.cwd(),
            environment: process.env,
            platform: hostCommandPlatform(),
          })?.path,
        copies: () =>
          resolveCommandCopies(installed.command, {
            cwd: process.cwd(),
            environment: process.env,
            platform: hostCommandPlatform(),
          }).map(({ path }) => path),
        create: (executable) => factory.create(executable, runtime),
        missing:
          entry.kind === "claude"
            ? claudeInstallGuidance
            : `${entry.label}'s CLI is not installed on this computer. Install it from ${installed.installUrl}${entry.runtime.shape === "installed" ? ". Opensteer finds it within a minute; if it doesn't, restart Opensteer." : `, or add an Opensteer-managed ${entry.label} account.`}`,
        scope: entry.runtime.shape === "installed" ? "all" : "ambient",
        ...(shippedVersion ? { shippedVersion } : {}),
      },
    );
  }
  return registry;
}
