import type { DeviceCapabilityReason, MachineSummary } from "@opensteer/protocol";
import type {
  DeviceIntegrationConnectionSummary,
  IntegrationConnectionSummary,
  IntegrationDashboard,
  DeviceComputerAppSetupRequestViewSchema,
  ComputerAppSetupSummary,
} from "@opensteer/integration-core";

export type ClientMachineSummary = MachineSummary;
export type ClientComputerConnection =
  IntegrationConnectionSummary | DeviceIntegrationConnectionSummary;
export type ClientComputerSetupRequest =
  ComputerAppSetupSummary | import("zod").output<typeof DeviceComputerAppSetupRequestViewSchema>;

export type ClientIntegrationDashboard = Omit<IntegrationDashboard, "connections"> & {
  connections: ClientComputerConnection[];
};

export function computerTargetId(
  target: { readonly deviceId: string } | { readonly runnerId: string } | null | undefined,
): string | null {
  return target ? ("deviceId" in target ? target.deviceId : target.runnerId) : null;
}

export function machineSelfRunnerId(machine: Pick<MachineSummary, "selfRunnerId">) {
  return machine.selfRunnerId ?? null;
}

export function deviceDriverKey(machine: ClientMachineSummary): string | null {
  const driver =
    machine.phoneDisplay?.driver ?? machine.drivers?.find(({ role }) => role === "self");
  if (!driver && !machine.phoneDisplay) return null;
  return JSON.stringify([
    machine.id,
    driver?.runnerId ?? null,
    driver?.generation ?? null,
    driver?.attached ?? false,
  ]);
}

export function deviceReasonLabel(reason: DeviceCapabilityReason | null): string {
  switch (reason?.kind) {
    case undefined:
      return "Ready";
    case "not-connected":
      return "Not connected";
    case "driver-offline":
      return "Its Mac is offline";
    case "driver-asleep":
      return "Asleep";
    case "driver-stopped":
      return "Stopped on its Mac";
    case "connecting":
    case "unreported":
      return "Connecting…";
    case "locked":
      return "Locked";
    case "protected":
      return "Protected";
    case "paused":
      return "Paused";
    case "access-off":
      return "Apps off";
    case "approval-required":
      return "Access needed";
    case "driver-update-required":
      return "Update Opensteer on its Mac";
    case "setup-required":
    case "trust-required":
    case "developer-mode-required":
    case "permission-required":
      return "Needs setup";
    case "unsupported":
      return "Not available";
    case "helper-unavailable":
    case "runtime-failed":
      return "Unavailable";
  }
}
