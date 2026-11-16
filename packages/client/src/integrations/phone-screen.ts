import type { DisplayInputEvent, MachineSummary, PhoneDisplayView } from "@opensteer/protocol";
import { deviceMachine, deviceReasonLabel } from "../host/device-projection.js";

/**
 * A phone whose screen a Mac drives, as every client words it. Setup happens on
 * that Mac; everywhere else says where to go rather than offering a flow.
 */
export interface PhoneScreenMac {
  readonly runnerId: string;
  readonly name: string;
  /** False once screen control was disconnected or its Mac removed. */
  readonly attached: boolean;
}

export function phoneScreenMac(machine: MachineSummary): PhoneScreenMac | null {
  const display = deviceMachine(machine).phoneDisplay;
  if (display?.setup.location !== "driver-mac") return null;
  return {
    runnerId: display.setup.driverRunnerId,
    name: display.setup.driverRunnerName,
    attached: display.driver?.role === "screen" && display.driver.attached,
  };
}

export interface PhoneScreenStatus {
  readonly label: string;
  /** What the person does about it, when they can. */
  readonly fix: string | null;
  readonly tone: "online" | "offline" | "waiting";
  /** Setup on the Mac is what's missing. */
  readonly needsSetup: boolean;
}

export function phoneScreenStatus(machine: MachineSummary): PhoneScreenStatus | null {
  const mac = phoneScreenMac(machine);
  const display = deviceMachine(machine).phoneDisplay;
  if (!mac || !display) return null;
  if (!mac.attached)
    return {
      label: "Not connected",
      fix: "Screen control was disconnected. Its approvals are kept for when you set it up again.",
      tone: "offline",
      needsSetup: true,
    };
  const reason = display.control.reason;
  switch (reason?.kind) {
    case undefined:
      return { label: "Ready", fix: null, tone: "online", needsSetup: false };
    case "driver-offline":
      return {
        label: `${mac.name} is offline`,
        fix: `Screen control comes back when ${mac.name} is on and Opensteer is open there.`,
        tone: "offline",
        needsSetup: false,
      };
    case "not-connected":
      return {
        label: "Not plugged in or not on the same Wi‑Fi",
        fix: `Connect it to ${mac.name} with a cable, or join the same Wi‑Fi network.`,
        tone: "offline",
        needsSetup: false,
      };
    case "locked":
      return {
        label: "Locked — unlock your iPhone",
        fix: "Opensteer never enters your passcode.",
        tone: "waiting",
        needsSetup: false,
      };
    case "trust-required":
      return {
        label: "Needs setup",
        fix: `Unlock your iPhone and tap Trust when it asks about ${mac.name}.`,
        tone: "waiting",
        needsSetup: true,
      };
    case "developer-mode-required":
      return {
        label: "Needs setup",
        fix: `Turn on Developer Mode in Settings → Privacy & Security on your iPhone, then finish on ${mac.name}.`,
        tone: "waiting",
        needsSetup: true,
      };
    case "setup-required":
    case "permission-required":
      return { label: "Needs setup", fix: null, tone: "waiting", needsSetup: true };
    case "driver-update-required":
      return {
        label: `Update Opensteer on ${mac.name}`,
        fix: null,
        tone: "waiting",
        needsSetup: false,
      };
    default:
      return { label: deviceReasonLabel(reason), fix: null, tone: "waiting", needsSetup: false };
  }
}

/** Where setup happens: the Mac that drives it, or any of the person's Macs once disconnected. */
export function phoneScreenSetupLine(
  machine: MachineSummary,
): { readonly label: string; readonly detail: string } | null {
  const mac = phoneScreenMac(machine);
  if (!mac) return null;
  return mac.attached
    ? {
        label: `Set up on ${mac.name}`,
        detail: `Open Opensteer on ${mac.name}, the Mac connected to this iPhone.`,
      }
    : {
        label: "Set up again on a Mac",
        detail: "Plug it into one of your Macs and set it up again in Opensteer there.",
      };
}

/** The two ways out, with what each keeps. */
export function phoneScreenDisconnectCopy(phone: string, mac: string) {
  return {
    label: "Disconnect screen control",
    title: "Disconnect screen control?",
    body: `${mac} stops controlling ${phone}, and a task using it now loses it. ${phone} keeps its name, approvals and tab, so you can set it up again on a Mac.`,
    confirm: "Disconnect",
  } as const;
}

export function phoneScreenRemovalCopy(phone: string, mac: string) {
  return {
    label: "Remove this iPhone",
    title: `Remove ${phone}?`,
    body: `Your agent can no longer use it, and its approvals and tab are removed. ${mac} and any other phones it controls stay as they are.`,
    confirm: "Remove",
  } as const;
}

export type PhoneNavigationTo = Extract<DisplayInputEvent, { kind: "nav" }>["to"];
const viewerNavigation: readonly PhoneNavigationTo[] = ["back", "home", "recents", "notifications"];

/** The buttons the Host advertises for this phone that the display wire can carry, in its order. */
export function phoneViewerNavigation(
  phone: PhoneDisplayView | null,
): readonly { readonly to: PhoneNavigationTo; readonly label: string }[] {
  if (!phone?.actions.includes("navigate")) return [];
  return phone.navigationButtons.flatMap(({ id, label }) =>
    viewerNavigation.includes(id as PhoneNavigationTo)
      ? [{ to: id as PhoneNavigationTo, label }]
      : [],
  );
}

/** Whether the viewer may offer Wake or Lock: the stream must allow it and the Host advertise it. */
export function phoneViewerPower(phone: PhoneDisplayView | null, action: "wake" | "lock"): boolean {
  if (phone === null) return true;
  return action === "wake" ? phone.wake : phone.lock === true;
}

export function phoneScreenUnavailableWords(phone: string): string {
  return `Live view isn’t available for ${phone} yet.`;
}
