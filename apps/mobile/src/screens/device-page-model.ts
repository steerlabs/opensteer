import {
  deviceAccessRows,
  deviceAsleepDetail,
  deviceRemovalProfiles,
  deviceWords,
  homeKeptWords,
  isHomeDevice,
  type DeviceCapability,
  type HomeKind,
} from "@opensteer/client/computers";
import type { MachineAccessReach, MachineSummary } from "@opensteer/protocol";

export { deviceAsleepDetail, isHomeDevice as isHome };
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
  browser: {
    title: deviceWords("devices.switch.browser"),
    detail: deviceWords("devices.switch.browserDetail"),
  },
  apps: {
    title: deviceWords("devices.switch.apps"),
    detail: deviceWords("devices.switch.appsDetail"),
  },
  files: {
    title: deviceWords("devices.switch.files"),
    detail: deviceWords("devices.switch.filesDetail"),
  },
};

export const homeFixed = "Always on. Your own agents run here.";

export function deviceSwitches(
  machine: MachineSummary,
  options: {
    readonly devicesAvailable: boolean;
    readonly noun?: string;
    /** What the Home is, so its footer never calls a server or Cloud Computer a Mac. */
    readonly homeKind?: HomeKind;
  },
): {
  readonly rows: readonly DeviceSwitchRow[];
  readonly footer: string | null;
  /** Under the switches a person can change: what connected agents need besides them. */
  readonly choose: string | null;
} {
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
    ? homeKeptWords(options.homeKind ?? "mac")
    : !machine.access?.policy
      ? machine.status === "pending"
        ? "These switches appear once this device has connected."
        : "Update Opensteer on your Mac to change what your own agents can use here."
      : !options.devicesAvailable && rows.some(({ key }) => key !== "files")
        ? "Update Opensteer on your Mac to change Browser and Apps."
        : null;
  const choose = rows.some((row) => !row.fixed) ? deviceWords("devices.switch.footer") : null;
  return { rows, footer, choose };
}

/** The switches' section footer: why they can't change, if so, then what agents also need. */
export function deviceSwitchesFooter(switches: {
  readonly footer: string | null;
  readonly choose: string | null;
}): string | null {
  const text = [switches.footer, switches.choose].filter(Boolean).join(" ");
  return text === "" ? null : text;
}

export type DeviceReach = MachineAccessReach;

/** Who may use Terminal and shared folders on a computer: the choices the Host reads today. */
export function deviceReachChoices(access: {
  readonly ownerReachAvailable: boolean;
}): readonly { readonly value: DeviceReach; readonly label: string }[] {
  return [
    { value: "nobody", label: deviceWords("devices.reach.nobody") },
    ...(access.ownerReachAvailable
      ? [{ value: "owner" as const, label: deviceWords("devices.reach.owner") }]
      : []),
    { value: "deployment", label: deviceWords("devices.reach.deployment") },
  ];
}

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
      message: `Your own agents can no longer use this ${options.noun}. Browser profiles kept here are deleted.`,
    };
  return {
    label: "Remove",
    title: `Remove ${machine.name}?`,
    message: [
      "It is signed out and your own agents can't use it.",
      machine.status === "online" ? null : "It finishes the next time it connects.",
      deviceRemovalProfiles(machine, options.profiles) ??
        "Browser profiles kept on it are deleted.",
    ]
      .filter((part): part is string => part !== null)
      .join(" "),
  };
}

export function phoneLeaves(noun: string, deploymentName: string): string {
  return `This ${noun} is removed from ${deploymentName}. Browser profiles kept on this ${noun} for it are deleted.`;
}
