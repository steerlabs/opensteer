import { deviceAccess, type MachineAccessPolicy, type MachineSummary } from "@opensteer/protocol";
import { hostsDeployment } from "@opensteer/client/computers";
import { isAgentPhone } from "@opensteer/client/integrations";

export type DeviceCapability = "browser" | "apps" | "files";

export const deviceCapabilities: readonly DeviceCapability[] = ["browser", "apps", "files"];

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

export const homeFixedDetail = "Always on. Your agent runs here.";

export type DeviceSwitch =
  | { readonly capability: DeviceCapability; readonly kind: "fixed" }
  | {
      readonly capability: DeviceCapability;
      readonly kind: "switch";
      readonly on: boolean;
      /** On, but macOS has not granted what it needs yet. */
      readonly needsMacos: boolean;
    };

/**
 * The "Your agent can use" rows a device page shows, in order.
 *
 * What a device can offer at all is its enrollment's fixed ceiling, so a
 * capability its grant never allowed has no row rather than a switch that
 * cannot work. Home runs the agent, so its browser and files are fixed.
 */
export function deviceSwitches(machine: MachineSummary): readonly DeviceSwitch[] {
  const policy = machine.access?.policy ?? null;
  const switches = policy ? deviceAccess(policy) : null;
  const home = hostsDeployment(machine);
  const offered: Record<DeviceCapability, boolean> = {
    browser: home || machine.allowedModules.includes("browser"),
    apps:
      isAgentPhone(machine) ||
      (machine.allowedModules.includes("integrations") &&
        (machine.device?.platform === "macos" || machine.device?.platform === "ios")),
    files: home || (machine.allowedModules.includes("shell") && machine.device?.form !== "phone"),
  };
  return deviceCapabilities
    .filter((capability) => offered[capability])
    .flatMap((capability): DeviceSwitch[] => {
      if (home && capability !== "apps") return [{ capability, kind: "fixed" }];
      if (!switches) return [];
      const on = switches[capability];
      return [
        { capability, kind: "switch", needsMacos: on && needsMacos(machine, capability), on },
      ];
    });
}

function needsMacos(machine: MachineSummary, capability: DeviceCapability): boolean {
  if (machine.device?.platform !== "macos") return false;
  if (capability === "apps") return machine.computerUse?.state === "permission-required";
  if (capability === "files") return machine.fullDiskAccess === false;
  return false;
}

export function deviceSwitchDetail(item: DeviceSwitch, thisDevice: boolean): string {
  if (item.kind === "fixed") return homeFixedDetail;
  if (item.needsMacos) return "On · needs macOS permission";
  return (thisDevice ? capabilityDetailHere : capabilityDetail)[item.capability];
}

/**
 * The policy one switch writes. Only the changed switch rides along of the two
 * optional ones, so the Host keeps whatever the other is now; the required
 * fields are the revision the editor read, which the Host checks.
 */
export function switchPolicy(
  policy: MachineAccessPolicy,
  capability: DeviceCapability,
  on: boolean,
): MachineAccessPolicy {
  const base = {
    reach: policy.reach,
    commands: policy.commands,
    forwarding: policy.forwarding,
    shares: policy.shares,
  };
  if (capability === "browser") return { ...base, browser: on };
  if (capability === "apps") return { ...base, apps: on };
  return on
    ? { ...base, reach: "owner", commands: true, forwarding: true }
    : { ...base, reach: "nobody" };
}

/** A one-line summary for a Devices row: what the agent can use there. */
export function deviceUsesLine(machine: MachineSummary): string | null {
  const items = deviceSwitches(machine).filter((item) => item.kind === "fixed" || item.on);
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
  if (machine.status === "pending") return "Setting up";
  if (machine.status !== "offline") return "Needs an update";
  if (!machine.lastSeenAt) return "Offline";
  return `Offline · last seen ${lastSeenWords(new Date(machine.lastSeenAt), now)}`;
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
