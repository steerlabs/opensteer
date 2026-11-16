import type {
  DesktopIphoneSetupReason,
  DesktopIphoneSetupStatus,
} from "@opensteer/protocol/desktop";

/**
 * What the person does about a setup reason: check again once they've acted,
 * start setup over because the Mac no longer holds it, or nothing because
 * this Mac can't do it at all. Cancel is always offered beside it.
 */
export type IphoneSetupRecovery = "check" | "restart" | "none";

export interface IphoneSetupWords {
  /** Where the person acts, when it's their move. */
  readonly cue?: "On the iPhone" | "On this Mac";
  readonly detail: string;
  /** Steps shown behind "Open instructions", for a fix with more than one move. */
  readonly instructions?: readonly string[];
  readonly recovery: IphoneSetupRecovery;
  readonly title: string;
  /** The person can fix it; otherwise it's a problem setup reports. */
  readonly yours: boolean;
}

const replug = "Unplug the iPhone, plug it back in, unlock it, then check again.";

/** Plain words and one way forward for each typed reason setup can stop on. */
export function iphoneSetupWords(
  reason: DesktopIphoneSetupReason,
  context: {
    readonly deploymentName: string;
    readonly osVersion: string | null;
    readonly step: DesktopIphoneSetupStatus["step"];
  },
): IphoneSetupWords {
  switch (reason) {
    case "no-phone":
      return {
        detail: "Use a cable that carries data and unlock the iPhone, then check again.",
        recovery: "check",
        title: "Plug the iPhone into this Mac",
        yours: true,
      };
    case "bridge-not-built":
      return {
        detail: "This copy of Opensteer was built without its iPhone helper.",
        recovery: "none",
        title: "This build can’t reach iPhones",
        yours: false,
      };
    case "bridge-signature-invalid":
      return {
        detail:
          "Its iPhone helper didn’t pass its signature check, so it wasn’t started. Reinstall Opensteer, then try again.",
        recovery: "restart",
        title: "Opensteer needs reinstalling",
        yours: false,
      };
    case "bridge-protocol-mismatch":
      return {
        detail:
          "Its iPhone helper is from another version. Quit and reopen Opensteer to finish updating.",
        recovery: "restart",
        title: "Opensteer is partway through an update",
        yours: false,
      };
    case "unsupported-mac":
    case "unsupported":
      return {
        detail: "Set it up in Opensteer on a Mac the iPhone can plug into.",
        recovery: "none",
        title: "This computer can’t control an iPhone",
        yours: false,
      };
    case "usbmux-unavailable":
      return {
        detail:
          "macOS didn’t answer when Opensteer asked for plugged-in phones. Unplug the iPhone and plug it back in. If it keeps happening, restart this Mac.",
        recovery: "check",
        title: "This Mac isn’t seeing phones",
        yours: false,
      };
    case "candidate-gone":
      return {
        detail: "Plug it back in and choose it again.",
        recovery: "check",
        title: "That iPhone was unplugged",
        yours: true,
      };
    case "owned-by-another-deployment":
      return {
        detail: `Another Opensteer on this Mac already controls it. Remove it there first to add it to ${context.deploymentName}.`,
        recovery: "check",
        title: "This iPhone is set up elsewhere",
        yours: true,
      };
    case "identity-mismatch":
    case "wifi-identity-mismatch":
      return {
        detail: "The phone that answered isn’t the one you chose. Choose it again.",
        recovery: "check",
        title: "That’s a different iPhone",
        yours: false,
      };
    case "unsupported-ios":
      return {
        detail: `Screen control works with iOS 27.${context.osVersion ? ` This iPhone has iOS ${context.osVersion}.` : ""} Update it in Settings → General → Software Update, then check again.`,
        recovery: "check",
        title: "This iPhone needs iOS 27",
        yours: true,
      };
    case "unsupported-device":
      return {
        detail: "Only an iPhone can be added this way.",
        recovery: "check",
        title: "This isn’t an iPhone",
        yours: false,
      };
    case "trust-required":
    case "trust-pending":
      return {
        cue: "On the iPhone",
        detail:
          "Unlock it, tap Trust when it asks about this Mac, then enter the iPhone’s passcode.",
        instructions: [
          "Don’t see the question? Unplug the iPhone and plug it back in while it’s unlocked.",
          "Then check again here.",
        ],
        recovery: "check",
        title: "Tap Trust on the iPhone",
        yours: true,
      };
    case "trust-denied":
      return {
        cue: "On the iPhone",
        detail:
          "It was told not to trust this Mac. Reset that answer on the iPhone, then plug it back in and tap Trust.",
        instructions: [
          "On the iPhone, open Settings → General → Transfer or Reset iPhone → Reset.",
          "Tap Reset Location & Privacy and enter the passcode. This resets which computers it trusts, not your data.",
          "Unplug the iPhone, plug it back in, unlock it and tap Trust.",
          "Then check again here.",
        ],
        recovery: "check",
        title: "The iPhone didn’t trust this Mac",
        yours: true,
      };
    case "pairing-revoked":
      return {
        cue: "On the iPhone",
        detail: "Unlock it and tap Trust when it asks again, then check again.",
        recovery: "check",
        title: "The iPhone stopped trusting this Mac",
        yours: true,
      };
    case "pairing-failed":
      return {
        detail: replug,
        recovery: "check",
        title: "The iPhone and this Mac didn’t finish pairing",
        yours: false,
      };
    case "phone-locked":
    case "unlock-required":
    case "lock-state-unknown":
      return {
        cue: "On the iPhone",
        detail:
          "Opensteer can’t reach it while it’s locked. Unlock it, keep the screen on, then check again.",
        recovery: "check",
        title: "Unlock the iPhone",
        yours: true,
      };
    case "developer-mode-required":
      return {
        cue: "On the iPhone",
        detail: "It lets this Mac see and control the screen. Turning it on restarts the iPhone.",
        instructions: [
          "Open Settings → Privacy & Security, then Developer Mode near the bottom.",
          "Turn it on and tap Restart.",
          "When the iPhone is back, unlock it, tap Turn On and enter the passcode.",
          "Then check again here.",
        ],
        recovery: "check",
        title: "Turn on Developer Mode",
        yours: true,
      };
    case "restart-required":
      return {
        cue: "On the iPhone",
        detail:
          "After it restarts, unlock it, tap Turn On for Developer Mode and enter the passcode. Then check again.",
        recovery: "check",
        title: "Restart the iPhone",
        yours: true,
      };
    case "waiting-for-phone":
    case "phone-disconnected":
      return {
        detail:
          "It’s restarting or was unplugged. When it’s back on this Mac, unlock it and check again.",
        recovery: "check",
        title: "Waiting for the iPhone",
        yours: true,
      };
    case "developer-mode-status-unknown":
      return {
        cue: "On the iPhone",
        detail:
          "Unlock it and make sure Settings → Privacy & Security → Developer Mode is on, then check again.",
        recovery: "check",
        title: "Opensteer couldn’t tell if Developer Mode is on",
        yours: true,
      };
    case "developer-image-missing":
      return {
        cue: "On this Mac",
        detail:
          "Opensteer uses Apple’s developer files to see and control an iPhone’s screen. They come with Xcode, and you add them once.",
        instructions: [
          "Install Xcode from the App Store.",
          "Open Xcode once and let it finish installing its components.",
          "In Xcode → Settings → Components, make sure iOS is installed.",
          "Then check again here. Xcode doesn’t need to stay open.",
        ],
        recovery: "check",
        title: "This Mac needs Xcode’s iPhone support",
        yours: true,
      };
    case "developer-image-incompatible":
      return {
        cue: "On this Mac",
        detail:
          "Xcode’s iPhone support on this Mac is older than this iPhone. Update Xcode from the App Store, open it once, then check again.",
        recovery: "check",
        title: "Xcode needs an update",
        yours: true,
      };
    case "developer-image-mount-failed":
      return {
        detail: `The iPhone didn’t load Apple’s developer files. ${replug}`,
        recovery: "check",
        title: "Developer services didn’t start",
        yours: false,
      };
    case "personalization-network-unavailable":
      return {
        cue: "On this Mac",
        detail:
          "Apple signs the developer files for each iPhone the first time. Connect this Mac to the internet, then check again.",
        recovery: "check",
        title: "This step needs the internet",
        yours: true,
      };
    case "personalization-rejected":
      return {
        detail: "Update the iPhone and Xcode, then check again.",
        recovery: "check",
        title: "Apple didn’t sign the developer files for this iPhone",
        yours: false,
      };
    case "phone-in-use":
    case "input-media-conflict":
      return {
        cue: "On this Mac",
        detail: "Quit Xcode or any other tool connected to the iPhone, then check again.",
        recovery: "check",
        title: "Another app is using the iPhone",
        yours: true,
      };
    case "native-service-missing":
    case "protocol-unsupported":
      return {
        detail: "Update the iPhone and Xcode, then check again.",
        recovery: "check",
        title: "This iPhone doesn’t offer what screen control needs",
        yours: false,
      };
    case "tunnel-failed":
      return {
        detail: replug,
        recovery: "check",
        title: "Opensteer couldn’t connect to the iPhone",
        yours: false,
      };
    case "screen-off":
    case "screen-state-unknown":
    case "wake-on-phone-required":
      return {
        cue: "On the iPhone",
        detail: "Unlock it and leave the screen on, then check again.",
        recovery: "check",
        title: "Wake the iPhone",
        yours: true,
      };
    case "screenshot-failed":
    case "geometry-unknown":
    case "geometry-unavailable":
    case "display-configuration-unsupported":
      return {
        cue: "On the iPhone",
        detail:
          "Unlock it, go to the Home Screen and turn off screen mirroring if it’s on. Then check again.",
        recovery: "check",
        title: "Opensteer couldn’t see the screen",
        yours: true,
      };
    case "host-offline":
      return {
        detail: `Check this Mac’s connection, then try again. Nothing was added yet.`,
        recovery: "check",
        title: `Couldn’t reach ${context.deploymentName}`,
        yours: false,
      };
    case "host-version-unsupported":
      return {
        detail: `Update Opensteer where ${context.deploymentName} runs, then try again.`,
        recovery: "check",
        title: `${context.deploymentName} needs an update first`,
        yours: false,
      };
    case "runner-not-enrolled":
      return {
        detail: `Add this Mac to ${context.deploymentName} in Devices first. It controls the iPhone.`,
        recovery: "restart",
        title: "This Mac isn’t one of your devices yet",
        yours: true,
      };
    case "runner-module-not-allowed":
      return {
        detail: `What this Mac may do for ${context.deploymentName} doesn’t include phone screens.`,
        recovery: "check",
        title: "This Mac can’t control phones",
        yours: false,
      };
    case "driver-conflict":
      return {
        detail: "Another Mac already controls this iPhone. Detach it there first, then try again.",
        recovery: "check",
        title: "Another Mac controls this iPhone",
        yours: true,
      };
    case "attach-conflict":
    case "device-not-owned":
      return {
        detail: `It changed in ${context.deploymentName} while you were setting it up. Try again.`,
        recovery: "check",
        title: "The iPhone wasn’t added",
        yours: false,
      };
    case "local-mapping-save-failed":
      return {
        detail:
          "This Mac couldn’t save which iPhone it controls. Try again; it won’t be added twice.",
        recovery: "check",
        title: "The iPhone wasn’t saved",
        yours: false,
      };
    case "assignment-pending":
      return {
        detail: "This Mac hasn’t taken the iPhone on yet. Check again in a moment.",
        recovery: "check",
        title: "Still waiting for this Mac",
        yours: false,
      };
    case "cancelled":
    case "no-session":
    case "stale-native-epoch":
    case "not-initialized":
      return {
        detail:
          "Opensteer on this Mac stopped this setup. Start again; anything already done carries over.",
        recovery: "restart",
        title: "Setup stopped",
        yours: false,
      };
    default:
      return {
        detail: replug,
        recovery: "check",
        title: `Setup stopped while ${stepWords[context.step]}`,
        yours: false,
      };
  }
}

const stepWords: Readonly<Record<DesktopIphoneSetupStatus["step"], string>> = {
  attach: "adding the iPhone",
  choose: "finding the iPhone",
  confirm: "adding the iPhone",
  "developer-mode": "checking Developer Mode",
  done: "finishing",
  observe: "looking at the screen",
  prepare: "preparing developer services",
  trust: "pairing with the iPhone",
};
