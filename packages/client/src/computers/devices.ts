import { deviceWords } from "./devices-copy.js";
import { computerStatus, isServiceMachine } from "./computers.js";
import type { AuthSessionSummary } from "@opensteer/core";
import {
  type DesktopDeviceMembership,
  type MachineSummary,
  type OtherDevice,
} from "@opensteer/protocol";
import { hostsDeployment } from "./computers.js";

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

/** Designer copy for a sleeping Device on its detail page. */
export const deviceAsleepExplanation = deviceWords("devices.asleep.explain");

/**
 * Whether the Home currently reports this Device as asleep (disconnected after
 * its Runner reported going to sleep, within the Home's sleep window).
 */
export function isDeviceAsleep(machine: Pick<MachineSummary, "status" | "asleepSince">): boolean {
  return (
    machine.status === "offline" &&
    typeof machine.asleepSince === "string" &&
    machine.asleepSince.length > 0
  );
}

/**
 * Whether the person stopped agents on this Device from the Device itself
 * ("Stop everything on this Mac"), as its Runner told the Home.
 */
export function isDeviceStopped(machine: Pick<MachineSummary, "agentsStoppedSince">): boolean {
  return typeof machine.agentsStoppedSince === "string" && machine.agentsStoppedSince.length > 0;
}

/** "Stopped on Studio Mac · since 10:42 AM", or null when agents are not stopped there. */
export function deviceStoppedLabel(
  machine: Pick<MachineSummary, "agentsStoppedSince" | "name">,
  now = new Date(),
  locale?: string,
): string | null {
  if (!isDeviceStopped(machine)) return null;
  const at = new Date(machine.agentsStoppedSince!);
  const when =
    at.toDateString() === now.toDateString()
      ? at.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })
      : at.toLocaleDateString(locale, { month: "short", day: "numeric" });
  return `Stopped on ${machine.name} · since ${when}`;
}

/** Calm explanation shown on a sleeping Device's page, or null when not asleep. */
export function deviceAsleepDetail(
  machine: Pick<MachineSummary, "status" | "asleepSince">,
): string | null {
  return isDeviceAsleep(machine) ? deviceAsleepExplanation : null;
}

export interface DeviceRow {
  readonly machine: MachineSummary;
  readonly sessions: readonly AuthSessionSummary[];
  readonly label: string;
  readonly status: string;
  readonly asleep: boolean;
  readonly asleepDetail: string | null;
  readonly capabilitySummary: string | null;
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
        asleep: isDeviceAsleep(machine),
        asleepDetail: deviceAsleepDetail(machine),
        capabilitySummary: machine.phoneDisplay ? "Screen control" : null,
        status:
          deviceStoppedLabel(machine) ??
          (isHomeDevice(machine) ? "Home · your agent runs here" : computerStatus(machine).label),
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
  return hostsDeployment(machine);
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
  const capabilities = machine.capabilities;
  if (!capabilities) return [];
  return deviceCapabilities.flatMap((capability): DeviceAccessRow[] => {
    const fact = capabilities[capability];
    if (!fact.supported) return [];
    if (!fact.configurable) return [{ capability, kind: "fixed", reason: "home" }];
    if (!devicesAvailable && capability !== "files")
      return [{ capability, kind: "fixed", reason: "older-host" }];
    return [{ capability, kind: "switch", on: machine.access ? fact.enabled : null }];
  });
}

export function assertDeviceSessionAllowed(
  membership: DesktopDeviceMembership | null | undefined,
): void {
  if (membership?.state === "removed" || membership?.state === "leaving")
    throw new Error("This Mac was removed. Choose Connect again to reconnect.");
  if (membership?.sessionState === "confirming")
    throw new Error("Waiting for the Runner to confirm this Mac is still a device.");
  if (membership?.sessionState === "sign-in-again")
    throw new Error("Sign in again to this Deployment.");
}
