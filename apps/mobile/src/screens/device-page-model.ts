import { deviceRemovalProfiles, hostsDeployment } from "@opensteer/client/computers";
import { deviceAccess, type MachineAccessPolicy, type MachineSummary } from "@opensteer/protocol";

export type DeviceSwitchKey = "browser" | "apps" | "files";

/** One line of "Your agent can use": a live switch, or a fact Home cannot change. */
export interface DeviceSwitchRow {
  readonly key: DeviceSwitchKey;
  readonly title: string;
  readonly detail: string;
  readonly fixed: boolean;
  readonly value: boolean;
  readonly disabled: boolean;
}

const copy: Readonly<Record<DeviceSwitchKey, { readonly title: string; readonly detail: string }>> =
  {
    browser: { title: "Browser", detail: "Open and use tabs" },
    apps: { title: "Apps", detail: "See and control apps" },
    files: { title: "Files and commands", detail: "Read files and run commands" },
  };

export const homeFixed = "Always on. Your agent runs here.";
export const homeFooter = "Your Opensteer lives on this Mac, so it can't be removed.";

export function isHome(machine: MachineSummary): boolean {
  return machine.kind === "home" || hostsDeployment(machine);
}

/**
 * The switches a device's page offers, from its enrollment's fixed ceiling:
 * a switch never offers what the device can't lend. Offline devices keep
 * editable switches; a Host without `devices-v1` can change only files.
 */
export function deviceSwitches(
  machine: MachineSummary,
  options: { readonly devicesAvailable: boolean; readonly noun?: string },
): { readonly rows: readonly DeviceSwitchRow[]; readonly footer: string | null } {
  const home = isHome(machine);
  const policy = machine.access?.policy ?? null;
  const on = policy === null ? null : deviceAccess(policy);
  const modules = new Set(machine.allowedModules);
  const offers: Readonly<Record<DeviceSwitchKey, boolean>> = {
    browser: modules.has("browser"),
    apps: modules.has("integrations") || machine.computerUse !== null,
    files: modules.has("shell"),
  };
  const rows = (["browser", "apps", "files"] as const)
    .filter((key) => offers[key])
    .map((key): DeviceSwitchRow => {
      const fixed = home && key !== "apps";
      const needsDevices = key !== "files" && !options.devicesAvailable;
      return {
        key,
        title: copy[key].title,
        detail: fixed
          ? homeFixed
          : key === "browser" && options.noun !== undefined
            ? `Open and use tabs on this ${options.noun}`
            : copy[key].detail,
        fixed,
        value: fixed || (on?.[key] ?? false),
        disabled: fixed || on === null || needsDevices,
      };
    });
  const footer = home
    ? homeFooter
    : policy === null
      ? machine.status === "pending"
        ? "These switches appear once this device has connected."
        : "Update Opensteer on your Mac to change what your agent can use here."
      : !options.devicesAvailable && rows.some(({ key }) => key !== "files")
        ? "Update Opensteer on your Mac to change Browser and Apps."
        : null;
  return { rows, footer };
}

/**
 * One switch changed, the rest kept. Files on restores what was there before
 * it was turned off, with commands and forwarding on; off is `reach: nobody`
 * with everything else kept, so turning it on again restores it.
 */
export function withSwitch(
  policy: MachineAccessPolicy,
  key: DeviceSwitchKey,
  on: boolean,
): MachineAccessPolicy {
  if (key === "browser") return { ...policy, browser: on };
  if (key === "apps") return { ...policy, apps: on };
  return on
    ? {
        ...policy,
        reach: policy.reach === "nobody" ? "owner" : policy.reach,
        commands: true,
        forwarding: true,
      }
    : { ...policy, reach: "nobody" };
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
  if (isHome(machine) || !machine.revocable) return null;
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
