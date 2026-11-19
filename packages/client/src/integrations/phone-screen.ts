import type { DisplayInputEvent, MachineSummary, PhoneDisplayView } from "@opensteer/protocol";
import { deviceReasonLabel } from "../host/device-projection.js";

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
  const display = machine.phoneDisplay;
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
  const display = machine.phoneDisplay;
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
        label: "Locked",
        fix: "Unlock the iPhone. Opensteer never enters your passcode.",
        tone: "waiting",
        needsSetup: false,
      };
    case "protected":
      return {
        label: "Can’t tell if it’s unlocked",
        fix: "Unlock the iPhone and leave its screen on.",
        tone: "waiting",
        needsSetup: false,
      };
    case "paused":
      return {
        label: "Busy",
        fix: `Quit Xcode or any other app connected to the iPhone on ${mac.name}. If it stays busy, restart the iPhone.`,
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
        fix: "Developer Mode is off on the iPhone. Fix setup to turn it back on.",
        tone: "waiting",
        needsSetup: true,
      };
    case "setup-required":
    case "permission-required":
      return {
        label: "Needs setup",
        fix: `Something on the iPhone or ${mac.name} changed since setup.`,
        tone: "waiting",
        needsSetup: true,
      };
    case "connecting":
    case "unreported":
      return { label: "Connecting…", fix: null, tone: "waiting", needsSetup: false };
    case "driver-update-required":
      return {
        label: `Update Opensteer on ${mac.name}`,
        fix: `Open Opensteer on ${mac.name} and install its update.`,
        tone: "waiting",
        needsSetup: false,
      };
    case "helper-unavailable":
    case "runtime-failed":
      return {
        label: `${mac.name} can’t reach it right now`,
        fix: `Unplug the iPhone and plug it back in, then unlock it. If it keeps happening, restart ${mac.name}.`,
        tone: "waiting",
        needsSetup: false,
      };
    case "unsupported":
      return {
        label: "Can’t be controlled",
        fix: "Screen control needs an iPhone with iOS 27 or later.",
        tone: "offline",
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
        label: `Fix setup on ${mac.name}`,
        detail: `Open Opensteer on ${mac.name}, go to this iPhone’s page and choose Fix setup.`,
      }
    : {
        label: "Set up again on a Mac",
        detail:
          "Plug it into one of your Macs, open its page in Opensteer there and choose Set up again. It keeps its name, approvals and tab.",
      };
}

/**
 * What setting up iPhone screen control takes, said before it starts on every
 * surface. The Mac's own setup checks each one live as it goes.
 */
export const iphoneSetupNeeds = [
  {
    id: "xcode",
    title: "Xcode on the Mac",
    detail:
      "Free from the App Store. It’s over 10 GB, so the first install can take 30 minutes or more.",
  },
  {
    id: "ios",
    title: "An iPhone with iOS 27 or later",
    detail: "It doesn’t need Opensteer installed.",
  },
  {
    id: "cable",
    title: "A cable that carries data",
    detail: "Some charging cables don’t. You can add Wi‑Fi once it’s set up.",
  },
  {
    id: "passcode",
    title: "The iPhone’s passcode and about 10 minutes",
    detail: "You’ll turn on Developer Mode, which restarts the iPhone once.",
  },
] as const;
export type IphoneSetupNeed = (typeof iphoneSetupNeeds)[number]["id"];

/** Where to go when this window can't run setup: only Opensteer on the Mac can reach the iPhone. */
export const iphoneSetupOnMacSteps = [
  "Open Opensteer on the Mac the iPhone will plug into.",
  "Go to Devices, choose Add a device, then iPhone screen control.",
  "Follow along there. Setup moves on by itself as you go.",
] as const;

/** Kept beside a ready iPhone: what keeps it usable when no one is near it. */
export const iphoneScreenKeepAwakeTip =
  "Keep it charging, and set Auto‑Lock to Never in Settings › Display & Brightness if you’ll steer it while you’re away.";

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
    body: `Your agent can no longer use it, and its approvals and tab are removed. ${mac} and any other phones it controls stay as they are. Developer Mode and Trust stay on the iPhone until you turn them off there.`,
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
