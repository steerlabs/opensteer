import type { AuthSessionSummary } from "@opensteer/core";
import {
  deviceAccess,
  type DesktopDeviceMembership,
  type MachineSummary,
  type OtherDevice,
} from "@opensteer/protocol";
import { hostsDeployment, isServiceMachine } from "./computers.js";

export type DeviceMembership =
  | {
      readonly state:
        | "hosting"
        | "needs-setup"
        | "setting-up"
        | "ready"
        | "removed"
        | "sign-in-again"
        | "not-applicable";
    }
  | { readonly state: "finish-setup"; readonly reason: string };

export interface DeviceMembershipInput {
  readonly applicable: boolean;
  readonly hosting: boolean;
  readonly authenticated: boolean;
  readonly membership: DesktopDeviceMembership | null;
  readonly settingUp?: boolean;
  readonly finishSetupReason?: string | null;
}

export function deviceMembership(input: DeviceMembershipInput): DeviceMembership {
  if (!input.applicable) return { state: "not-applicable" };
  if (input.hosting) return { state: "hosting" };
  if (input.membership?.state === "removed" || input.membership?.state === "leaving")
    return { state: "removed" };
  if (!input.authenticated) return { state: "sign-in-again" };
  if (input.settingUp) return { state: "setting-up" };
  if (input.membership?.state === "active" && input.membership.enrolled === false)
    return input.membership.runnerId
      ? {
          state: "finish-setup",
          reason: input.finishSetupReason ?? "This Mac has not finished joining",
        }
      : { state: "needs-setup" };
  if (input.finishSetupReason) return { state: "finish-setup", reason: input.finishSetupReason };
  if (input.membership?.state === "waiting")
    return { state: "finish-setup", reason: "Waiting for this Opensteer" };
  return { state: input.membership?.state === "active" ? "ready" : "needs-setup" };
}

export interface DeviceRow {
  readonly machine: MachineSummary;
  readonly sessions: readonly AuthSessionSummary[];
  readonly label: string;
  readonly status: string;
  readonly thisDevice: boolean;
}
export interface SignedInDeviceRow {
  readonly session: AuthSessionSummary;
  readonly label: string;
  readonly status: string;
}
export interface DevicesView {
  readonly devices: readonly DeviceRow[];
  readonly alsoSignedIn: readonly SignedInDeviceRow[];
  readonly alsoSignedInCaption: string;
  readonly otherDevices: readonly OtherDevice[];
}
export function devicesView(input: {
  readonly machines: readonly MachineSummary[];
  readonly sessions: readonly AuthSessionSummary[];
  readonly hereId: string | null;
  readonly otherDevices?: readonly OtherDevice[];
}): DevicesView {
  const machines = input.machines.filter((machine) => !isServiceMachine(machine));
  const ids = new Set(machines.map((machine) => machine.id));
  const rank = (machine: MachineSummary) =>
    machine.id === input.hereId ? 0 : isHomeDevice(machine) ? 1 : 2;
  return {
    devices: [...machines]
      .sort((a, b) => rank(a) - rank(b))
      .map((machine) => ({
        machine,
        sessions: input.sessions.filter((session) => session.deviceId === machine.id),
        label: machine.name,
        status: isHomeDevice(machine)
          ? "Home · your agent runs here"
          : machine.status === "online"
            ? "Online"
            : machine.status === "offline"
              ? "Offline"
              : machine.status === "pending"
                ? "Setting up"
                : "Needs update",
        thisDevice: machine.id === input.hereId,
      })),
    alsoSignedIn: input.sessions
      .filter((session) => !session.deviceId || !ids.has(session.deviceId))
      .map((session) => ({
        session,
        label: session.deviceLabel,
        status: session.current
          ? "This window"
          : /Opensteer/i.test(session.deviceLabel)
            ? "Update to finish setup"
            : "Signed in",
      })),
    alsoSignedInCaption: "These run nothing. Your agent can't use them.",
    otherDevices: input.otherDevices ?? [],
  };
}

export function isHomeDevice(machine: MachineSummary): boolean {
  return machine.kind === "home" || hostsDeployment(machine);
}

export type DeviceCapability = "browser" | "apps" | "files";

const deviceCapabilities: readonly DeviceCapability[] = ["browser", "apps", "files"];

export type DeviceAccessRow =
  | {
      readonly capability: DeviceCapability;
      readonly kind: "fixed";
      readonly reason: "home" | "older-host";
    }
  /** `on` is null while the Host has no stored policy for the device. */
  | { readonly capability: DeviceCapability; readonly kind: "switch"; readonly on: boolean | null };

/**
 * Apps needs integrations both granted and advertised, as the Host's gates do: an ordinary
 * Android phone is granted integrations but lends only its browser. The Host keeps a device's
 * last advertised modules while it is offline.
 */
export function deviceAccessRows(
  machine: MachineSummary,
  devicesAvailable: boolean,
): readonly DeviceAccessRow[] {
  const home = isHomeDevice(machine);
  const granted = (module: MachineSummary["allowedModules"][number]) =>
    machine.allowedModules.includes(module);
  const offered: Readonly<Record<DeviceCapability, boolean>> = {
    browser: home || granted("browser"),
    apps: granted("integrations") && machine.modules.integrations !== undefined,
    files: home || (granted("shell") && machine.device?.form !== "phone"),
  };
  const policy = machine.access?.policy;
  const on = policy ? deviceAccess(policy) : null;
  return deviceCapabilities
    .filter((capability) => offered[capability])
    .map((capability): DeviceAccessRow => {
      if (home && capability !== "apps") return { capability, kind: "fixed", reason: "home" };
      if (!devicesAvailable && capability !== "files")
        return { capability, kind: "fixed", reason: "older-host" };
      return { capability, kind: "switch", on: on?.[capability] ?? null };
    });
}

export function assertDeviceSessionAllowed(
  membership: DesktopDeviceMembership | null | undefined,
): void {
  if (membership?.state === "removed" || membership?.state === "leaving")
    throw new Error("This Mac was removed. Choose Set up again to reconnect.");
  if (membership?.sessionState === "confirming")
    throw new Error("Waiting for the Runner to confirm this Mac is still a device.");
  if (membership?.sessionState === "sign-in-again")
    throw new Error("Sign in again to this Deployment.");
}
