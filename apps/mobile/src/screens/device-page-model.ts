import {
  deviceAccessRows,
  deviceRemovalProfiles,
  isHomeDevice,
  type DeviceCapability,
} from "@opensteer/client/computers";
import type { MachineSummary } from "@opensteer/protocol";

export { isHomeDevice as isHome };
export type { DeviceCapability as DeviceSwitchKey };

interface DeviceSwitchRow {
  readonly key: DeviceCapability;
  readonly title: string;
  readonly detail: string;
  readonly fixed: boolean;
  readonly value: boolean;
  readonly disabled: boolean;
}

const copy: Readonly<
  Record<DeviceCapability, { readonly title: string; readonly detail: string }>
> = {
  browser: { title: "Browser", detail: "Open and use tabs" },
  apps: { title: "Apps", detail: "See and control apps" },
  files: { title: "Files and commands", detail: "Read files and run commands" },
};

export const homeFixed = "Always on. Your agent runs here.";
const homeFooter = "Your Opensteer lives on this Mac, so it can't be removed.";

export function deviceSwitches(
  machine: MachineSummary,
  options: { readonly devicesAvailable: boolean; readonly noun?: string },
): { readonly rows: readonly DeviceSwitchRow[]; readonly footer: string | null } {
  const rows = deviceAccessRows(machine, options.devicesAvailable).map((row): DeviceSwitchRow => {
    const home = row.kind === "fixed" && row.reason === "home";
    return {
      key: row.capability,
      title: copy[row.capability].title,
      detail: home
        ? homeFixed
        : row.capability === "browser" && options.noun !== undefined
          ? `Open and use tabs on this ${options.noun}`
          : copy[row.capability].detail,
      fixed: home,
      value: row.kind === "fixed" || (row.on ?? false),
      disabled: row.kind === "fixed" || row.on === null,
    };
  });
  const footer = isHomeDevice(machine)
    ? homeFooter
    : !machine.access?.policy
      ? machine.status === "pending"
        ? "These switches appear once this device has connected."
        : "Update Opensteer on your Mac to change what your agent can use here."
      : !options.devicesAvailable && rows.some(({ key }) => key !== "files")
        ? "Update Opensteer on your Mac to change Browser and Apps."
        : null;
  return { rows, footer };
}

/** The destructive action alone in the last section, and its confirmation, as on web. */
export function deviceRemoval(
  machine: MachineSummary,
  options: {
    readonly thisDevice: boolean;
    readonly noun: string;
    readonly profiles: Parameters<typeof deviceRemovalProfiles>[1];
  },
): { readonly label: string; readonly title: string; readonly message: string } | null {
  if (isHomeDevice(machine) || !machine.revocable) return null;
  if (options.thisDevice)
    return {
      label: `Sign out and remove this ${options.noun}`,
      title: `Sign out and remove this ${options.noun}?`,
      message: `Your agent can no longer use this ${options.noun}. Browser profiles kept here are deleted.`,
    };
  return {
    label: "Remove",
    title: `Remove ${machine.name}?`,
    message: [
      "It is signed out and your agent can't use it.",
      machine.status === "online" ? null : "It finishes the next time it connects.",
      deviceRemovalProfiles(machine, options.profiles) ??
        "Browser profiles kept on it are deleted.",
    ]
      .filter((part): part is string => part !== null)
      .join(" "),
  };
}

/** What this phone leaving an Opensteer deletes, for every way it can leave. */
export function phoneLeaves(noun: string, deploymentName: string): string {
  return `This ${noun} is removed from ${deploymentName}. Browser profiles kept on this ${noun} for it are deleted.`;
}
