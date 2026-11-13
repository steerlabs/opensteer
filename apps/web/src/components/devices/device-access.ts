export { cancelDeviceSetup } from "@opensteer/client/computers";
import { deviceAccess, type DeviceInitialAccess, type MachineSummary } from "@opensteer/protocol";
import {
  deviceAccessRows,
  hostsDeployment,
  type DeviceAccessRow,
  type DeviceCapability,
} from "@opensteer/client/computers";
import { isAgentPhone } from "@opensteer/client/integrations";

export type { DeviceCapability };

export const capabilityLabel: Readonly<Record<DeviceCapability, string>> = {
  browser: "Browser",
  apps: "Apps",
  files: "Files and commands",
};

/** The setup screen's words, about the Mac the person is sitting at. */
export const capabilityDetailHere: Readonly<Record<DeviceCapability, string>> = {
  browser: "Open and use tabs on this Mac",
  apps: "See and control apps",
  files: "Read files and run commands",
};

const capabilityDetail: Readonly<Record<DeviceCapability, string>> = {
  browser: "Open and use tabs",
  apps: "See and control apps",
  files: "Read files and run commands",
};

const homeFixedDetail = "Always on. Your agent runs here.";
const olderHostDetail = "Always on. Update Opensteer on your Home Mac to switch it off.";

export type DeviceSwitch =
  | Extract<DeviceAccessRow, { kind: "fixed" }>
  | {
      readonly capability: DeviceCapability;
      readonly kind: "switch";
      readonly on: boolean;
      readonly needsMacos: boolean;
    };

export function deviceSwitches(
  machine: MachineSummary,
  devicesAvailable: boolean,
): readonly DeviceSwitch[] {
  return deviceAccessRows(machine, devicesAvailable).flatMap((row): DeviceSwitch[] => {
    if (row.kind === "fixed") return [row];
    if (row.on === null) return [];
    const { capability, on } = row;
    return [{ capability, kind: "switch", needsMacos: on && needsMacos(machine, capability), on }];
  });
}

function needsMacos(machine: MachineSummary, capability: DeviceCapability): boolean {
  if (machine.device?.platform !== "macos") return false;
  if (capability === "apps") return machine.computerUse?.state === "permission-required";
  if (capability === "files") return machine.fullDiskAccess === false;
  return false;
}

function appsDetail(machine: MachineSummary): string {
  if (isAgentPhone(machine)) return "See and control the phone";
  if (machine.device?.platform === "ios") return "Calendar, Contacts and other iPhone apps";
  if (machine.device?.platform === "macos") return capabilityDetail.apps;
  return "Apps and tools it hosts";
}

export function deviceSwitchDetail(
  item: DeviceSwitch,
  machine: MachineSummary,
  thisDevice: boolean,
): string {
  if (item.kind === "fixed") return item.reason === "home" ? homeFixedDetail : olderHostDetail;
  if (item.needsMacos) return "On · needs macOS permission";
  if (thisDevice) return capabilityDetailHere[item.capability];
  return item.capability === "apps" ? appsDetail(machine) : capabilityDetail[item.capability];
}

/**
 * What setup actually left switched on: the Host's stored policy once it lists
 * this device, else the person's choices only where the Host took them. Null
 * while that is unknown, so Ready never claims a choice an older Host dropped.
 */
export function appliedSetupAccess(input: {
  readonly machine: MachineSummary | null;
  readonly chosen: DeviceInitialAccess | null;
  readonly devicesAvailable: boolean;
}): DeviceInitialAccess | null {
  const policy = input.machine?.access?.policy;
  if (policy) return deviceAccess(policy);
  return input.devicesAvailable ? input.chosen : null;
}

/** A one-line summary for a Devices row: what the agent can use there. */
export function deviceUsesLine(machine: MachineSummary, devicesAvailable: boolean): string | null {
  if (pendingEnrollmentId(machine)) return null;
  const items = deviceSwitches(machine, devicesAvailable).filter(
    (item) => item.kind === "fixed" || item.on,
  );
  if (items.length === 0) return machine.access ? "Your agent can’t use it" : null;
  return items
    .map((item) =>
      item.kind === "switch" && item.needsMacos
        ? `${capabilityLabel[item.capability]} waiting for macOS`
        : capabilityLabel[item.capability],
    )
    .join(" · ");
}

/** "Online", "Offline · last seen Tuesday", or Home's role, in one line. */
export function deviceStatusLine(machine: MachineSummary, now = new Date()): string {
  if (hostsDeployment(machine)) return "Home · your agent runs here";
  if (machine.status === "online") return "Online";
  if (machine.status === "pending")
    return machine.expiresAt
      ? `Setting up · expires ${expiryWords(new Date(machine.expiresAt), now)}`
      : "Setting up";
  if (machine.status !== "offline") return "Needs an update";
  if (!machine.lastSeenAt) return "Offline";
  return `Offline · last seen ${lastSeenWords(new Date(machine.lastSeenAt), now)}`;
}

function expiryWords(at: Date, now: Date): string {
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (at.toDateString() === now.toDateString()) return `at ${time}`;
  return `${at.toLocaleDateString(undefined, { weekday: "long" })} at ${time}`;
}

/** A row the Host lists before any device redeemed its token: only its setup can be cancelled. */
export function pendingEnrollmentId(machine: MachineSummary): string | null {
  return machine.status === "pending" ? machine.enrollmentId : null;
}

function lastSeenWords(seen: Date, now: Date): string {
  const day = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((day(now) - day(seen)) / 86_400_000);
  if (days <= 0)
    return `at ${seen.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  if (days === 1) return "yesterday";
  if (days < 7) return seen.toLocaleDateString(undefined, { weekday: "long" });
  return seen.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
