import {
  DesktopLocalExecutionStatusSchema,
  type DesktopLocalExecutionStatus,
} from "@opensteer/protocol/desktop";

export function localExecutionPlatform(
  platform: NodeJS.Platform,
): DesktopLocalExecutionStatus["platform"] {
  if (platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  if (platform === "win32") return "windows";
  return "unsupported";
}

export function localExecutionStatus(
  deploymentId: DesktopLocalExecutionStatus["deploymentId"],
  runner: DesktopLocalExecutionStatus["runner"],
  computer: {
    readonly computerName: string;
    readonly mayRunAgents: boolean;
    readonly runAgents: boolean;
  },
  platform: NodeJS.Platform = process.platform,
): DesktopLocalExecutionStatus {
  return DesktopLocalExecutionStatusSchema.parse({
    available: true,
    computerName: computer.computerName,
    deploymentId,
    mayRunAgents: computer.mayRunAgents,
    platform: localExecutionPlatform(platform),
    runAgents: computer.runAgents,
    runner,
    schemaVersion: 4,
  });
}

export function unavailableLocalExecutionStatus(
  deploymentId: DesktopLocalExecutionStatus["deploymentId"],
  computerName: string,
  platform: NodeJS.Platform = process.platform,
): DesktopLocalExecutionStatus {
  const detail = "This Opensteer release does not include local agent support.";
  return DesktopLocalExecutionStatusSchema.parse({
    available: false,
    computerName,
    deploymentId,
    mayRunAgents: false,
    platform: localExecutionPlatform(platform),
    runner: {
      detail,
      enrolled: false,
      environmentId: null,
      runnerId: null,
      state: "disabled",
    },
    runAgents: false,
    schemaVersion: 4,
  });
}
