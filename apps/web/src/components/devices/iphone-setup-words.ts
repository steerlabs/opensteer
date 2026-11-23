import type {
  DesktopIphoneSetupReason,
  DesktopIphoneSetupStage,
} from "@opensteer/protocol/desktop";

/**
 * What the person does about a reason outside the setup dialog (the Same Wi‑Fi
 * row): try again once they've acted, start over, or nothing because this Mac
 * can't do it. The dialog itself follows the setup's own `action`.
 */
export type IphoneSetupRecovery = "check" | "restart" | "none";

export interface IphoneSetupWords {
  /** The button that answers it outside the dialog, when that isn't "Try again". */
  readonly action?: string;
  /** Where the person acts, when it's their move. */
  readonly cue?: "On the iPhone" | "On this Mac";
  readonly detail: string;
  /** The exact moves, shown in order where the person reads them. */
  readonly steps?: readonly string[];
  /** A less likely fix, behind a disclosure. */
  readonly more?: { readonly summary: string; readonly lines: readonly string[] };
  /** What setup watches for while it waits; it carries on by itself once it sees it. */
  readonly waiting?: string;
  readonly recovery: IphoneSetupRecovery;
  readonly title: string;
  /** The person can fix it; otherwise it's a problem setup reports. */
  readonly yours: boolean;
}

const replugSteps = [
  "Unplug the iPhone and plug it back in.",
  "Unlock it and leave the screen on.",
] as const;

/** What trying Wi‑Fi again asks the Mac to do after a reason. */
export function wifiRetryAction(
  reason: DesktopIphoneSetupReason | null,
  last: "enable" | "disable" | "pair",
): "enable" | "disable" | "pair" {
  return reason === "wifi-pairing-required" || reason === "wifi-identity-mismatch" ? "pair" : last;
}

/** Each stage in a few words, for the progress rail and the screen reader's step count. */
export const iphoneStageLabels: Readonly<Record<Exclude<DesktopIphoneSetupStage, "done">, string>> =
  {
    mac: "Check this Mac",
    connect: "Plug in the iPhone",
    trust: "Trust this Mac",
    "developer-mode": "Turn on Developer Mode",
    prepare: "Get the iPhone ready",
    wifi: "Choose Wi‑Fi",
    add: "Add it",
  };

/** Plain words and the way forward for each typed reason setup can wait or stop on. */
export function iphoneSetupWords(
  reason: DesktopIphoneSetupReason,
  context: {
    readonly deploymentName: string;
    readonly osVersion: string | null;
    readonly stage: DesktopIphoneSetupStage;
  },
): IphoneSetupWords {
  switch (reason) {
    case "xcode-missing":
      return {
        cue: "On this Mac",
        detail:
          "Opensteer uses Apple’s free developer tools to see and control an iPhone’s screen. It’s a large download, and setup carries on by itself once it’s installed.",
        recovery: "check",
        title: "Install Xcode from the App Store",
        waiting: "Waiting for Xcode to install…",
        yours: true,
      };
    case "xcode-installing":
      return {
        cue: "On this Mac",
        detail:
          "Let the App Store finish downloading and installing Xcode. Setup carries on by itself once it’s installed.",
        recovery: "check",
        title: "Waiting for Xcode to install",
        waiting: "Waiting for Xcode to install…",
        yours: true,
      };
    case "xcode-setup-required":
    case "developer-image-missing":
      return {
        cue: "On this Mac",
        detail:
          "Xcode adds its iPhone support the first time it opens. Agree to its terms, let it finish, then you can quit it.",
        more: {
          summary: "Xcode is open but nothing happens?",
          lines: [
            "In Xcode, open Settings › Components.",
            "Make sure iOS is installed, or click Get next to it.",
          ],
        },
        recovery: "check",
        title: "Open Xcode once",
        waiting: "Waiting for Xcode’s iPhone support…",
        yours: true,
      };
    case "developer-image-incompatible":
      return {
        cue: "On this Mac",
        detail: `${context.osVersion ? `This iPhone runs iOS ${context.osVersion}` : "This iPhone runs a newer iOS"}, which is newer than this Mac’s Xcode. Setup carries on by itself once Xcode is updated.`,
        steps: [
          "Update Xcode in the App Store.",
          "Open Xcode once so it finishes installing iPhone support.",
        ],
        recovery: "check",
        title: "Update Xcode",
        waiting: "Waiting for the newer Xcode…",
        yours: true,
      };
    case "no-phone":
      return {
        cue: "On the iPhone",
        detail: "Use a cable that carries data, then unlock the iPhone.",
        recovery: "check",
        title: "Plug your iPhone into this Mac",
        waiting: "Looking for an iPhone…",
        yours: true,
      };
    case "bridge-not-built":
      return {
        detail: "This copy of Opensteer was built without its iPhone helper.",
        recovery: "none",
        title: "This copy of Opensteer can’t reach iPhones",
        yours: false,
      };
    case "bridge-signature-invalid":
      return {
        detail:
          "Its iPhone helper didn’t pass its signature check, so it wasn’t started. Reinstall Opensteer, then start over.",
        recovery: "restart",
        title: "Opensteer needs reinstalling",
        yours: false,
      };
    case "bridge-protocol-mismatch":
      return {
        detail:
          "Its iPhone helper is from another version. Quit and reopen Opensteer, then start over.",
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
    case "phone-disconnected":
      return {
        cue: "On the iPhone",
        detail: "Plug it back in with the same cable and unlock it.",
        recovery: "check",
        title: "The iPhone was unplugged",
        waiting: "Waiting for the iPhone to come back…",
        yours: true,
      };
    case "owned-by-another-deployment":
      return {
        detail: `Another Opensteer on this Mac already controls it. Remove it there first to add it to ${context.deploymentName}.`,
        recovery: "check",
        title: "This iPhone is set up in another Opensteer",
        yours: true,
      };
    case "identity-mismatch":
      return {
        detail: "The phone that answered isn’t the one you chose. Start over and choose it again.",
        recovery: "restart",
        title: "That’s a different iPhone",
        yours: false,
      };
    case "wifi-not-enabled":
      return {
        detail: "Keep it unlocked and plugged into this Mac, then try again.",
        recovery: "check",
        title: "The iPhone didn’t turn on Wi‑Fi access",
        yours: true,
      };
    case "local-network-permission-required":
      return {
        cue: "On this Mac",
        detail: "macOS asks before an app looks for devices on your Wi‑Fi.",
        recovery: "check",
        steps: ["Open System Settings › Privacy & Security › Local Network.", "Turn on Opensteer."],
        title: "Let Opensteer find the iPhone on your Wi‑Fi",
        waiting: "Waiting for Local Network access…",
        yours: true,
      };
    case "wifi-phone-not-found":
      return {
        cue: "On the iPhone",
        detail:
          "Join it to the same Wi‑Fi as this Mac and unlock it. Some guest and office networks keep devices apart.",
        recovery: "check",
        title: "This Mac can’t find the iPhone on Wi‑Fi",
        waiting: "Looking for the iPhone on Wi‑Fi…",
        yours: true,
      };
    case "wifi-pairing-required":
      return {
        action: "Pair again",
        cue: "On the iPhone",
        detail:
          "Keep it unlocked and plugged into this Mac. If it asks, tap Trust and enter its passcode.",
        recovery: "check",
        title: "Pair the iPhone for Wi‑Fi",
        waiting: "Waiting for the iPhone…",
        yours: true,
      };
    case "wifi-pairing-denied":
      return {
        cue: "On the iPhone",
        detail:
          "Keep it unlocked and plugged into this Mac, try again, and tap Trust when the iPhone asks.",
        recovery: "check",
        title: "The iPhone didn’t trust this Mac",
        yours: true,
      };
    case "wifi-pairing-failed":
      return {
        detail: "Keep it unlocked and plugged into this Mac, then try again.",
        more: {
          summary: "Still not working?",
          lines: ["Restart the iPhone, plug it back in, and try again."],
        },
        recovery: "check",
        title: "Wi‑Fi pairing didn’t finish",
        yours: true,
      };
    case "wifi-transport-unsupported":
      return {
        detail: "It still works while it’s plugged into this Mac.",
        recovery: "none",
        title: "This iPhone can’t be used over Wi‑Fi",
        yours: true,
      };
    case "wifi-identity-mismatch":
      return {
        action: "Pair again",
        detail:
          "Another phone on this network answered for it, so Opensteer didn’t use it. Keep this iPhone plugged in and pair again.",
        recovery: "check",
        title: "A different iPhone answered on Wi‑Fi",
        yours: false,
      };
    case "unsupported-ios":
      return {
        cue: "On the iPhone",
        detail: `Screen control needs iOS 27 or later.${context.osVersion ? ` This iPhone has iOS ${context.osVersion}.` : ""} Update it in Settings › General › Software Update.`,
        recovery: "check",
        title: "This iPhone needs iOS 27",
        waiting: "Waiting for the update…",
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
          "Unlock it. When it asks “Trust This Computer?”, tap Trust and enter the iPhone’s passcode.",
        more: {
          summary: "Don’t see the question?",
          lines: ["Unplug the iPhone and plug it back in while it’s unlocked. It asks again."],
        },
        recovery: "check",
        title: "Tap Trust on your iPhone",
        waiting: "Waiting for you to tap Trust…",
        yours: true,
      };
    case "trust-denied":
      return {
        cue: "On the iPhone",
        detail: "It was told Don’t Trust. That’s easy to undo.",
        steps: [
          "Unplug the iPhone and plug it back in.",
          "Unlock it.",
          "When it asks “Trust This Computer?”, tap Trust and enter its passcode.",
        ],
        more: {
          summary: "It doesn’t ask again?",
          lines: [
            "As a last resort, on the iPhone open Settings › General › Transfer or Reset iPhone › Reset › Reset Location & Privacy.",
            "This makes it ask again about every computer. It also resets the location, camera, photos and other permissions you’ve given apps, so each app asks again. Your data and apps stay.",
          ],
        },
        recovery: "check",
        title: "Plug it in again and tap Trust",
        waiting: "Waiting for you to tap Trust…",
        yours: true,
      };
    case "pairing-revoked":
      return {
        cue: "On the iPhone",
        detail: "Unlock it and tap Trust when it asks about this Mac.",
        recovery: "check",
        title: "The iPhone stopped trusting this Mac",
        waiting: "Waiting for you to tap Trust…",
        yours: true,
      };
    case "pairing-failed":
      return {
        detail: "The iPhone and this Mac didn’t finish pairing.",
        recovery: "check",
        steps: replugSteps,
        title: "Pairing didn’t finish",
        yours: false,
      };
    case "phone-locked":
    case "unlock-required":
    case "lock-state-unknown":
      return {
        cue: "On the iPhone",
        detail: "Opensteer can’t reach it while it’s locked, and never enters your passcode.",
        recovery: "check",
        title: "Unlock your iPhone",
        waiting: "Waiting for you to unlock it…",
        yours: true,
      };
    case "developer-mode-required":
      return {
        cue: "On the iPhone",
        detail: "It lets this Mac see and control the screen. The switch is there now.",
        steps: [
          "Open Settings › Privacy & Security › Developer Mode. It’s near the bottom.",
          "Turn it on and tap Restart.",
          "After the restart, unlock the iPhone, tap Turn On and enter its passcode.",
        ],
        more: {
          summary: "What happens when it restarts?",
          lines: [
            "The iPhone disconnects for a minute or two. Leave it plugged in; setup picks up again by itself when it’s back.",
          ],
        },
        recovery: "check",
        title: "Turn on Developer Mode",
        waiting: "Waiting for Developer Mode…",
        yours: true,
      };
    case "restart-required":
      return {
        cue: "On the iPhone",
        detail: "Developer Mode turns on after a restart. Restart it if it didn’t ask to.",
        steps: ["After the restart, unlock the iPhone, tap Turn On and enter its passcode."],
        recovery: "check",
        title: "Restart the iPhone",
        waiting: "Waiting for the iPhone to restart…",
        yours: true,
      };
    case "waiting-for-phone":
      return {
        cue: "On the iPhone",
        detail:
          "When it’s back, unlock it, tap Turn On and enter its passcode. Keep it plugged in.",
        recovery: "check",
        title: "Your iPhone is restarting",
        waiting: "Waiting for the iPhone to come back…",
        yours: true,
      };
    case "developer-mode-status-unknown":
      return {
        cue: "On the iPhone",
        detail: "Unlock it and check that Settings › Privacy & Security › Developer Mode is on.",
        recovery: "check",
        title: "Check Developer Mode on the iPhone",
        waiting: "Waiting for the iPhone…",
        yours: true,
      };
    case "developer-image-mount-failed":
      return {
        detail: "The iPhone didn’t accept Apple’s developer tools from this Mac.",
        recovery: "check",
        steps: replugSteps,
        title: "Couldn’t get the iPhone ready",
        yours: false,
      };
    case "personalization-network-unavailable":
      return {
        cue: "On this Mac",
        detail:
          "The first time, Apple signs its developer tools for this iPhone online. Connect this Mac to the internet.",
        recovery: "check",
        title: "This step needs the internet",
        waiting: "Waiting for the internet…",
        yours: true,
      };
    case "personalization-rejected":
      return {
        detail: "Update the iPhone and Xcode, then try again.",
        recovery: "check",
        title: "Apple didn’t approve its developer tools for this iPhone",
        yours: false,
      };
    case "phone-in-use":
    case "input-media-conflict":
      return {
        detail: "Another setup or app on this Mac is actively controlling this iPhone.",
        recovery: "check",
        steps: [
          "Finish or close the other setup or app using the iPhone, then try again.",
          "Still busy? Restart the iPhone, unlock it, and try again.",
        ],
        title: "The iPhone is busy",
        waiting: "Waiting for the iPhone to be free…",
        yours: true,
      };
    case "native-service-missing":
    case "protocol-unsupported":
      return {
        detail:
          "Restart the iPhone, unlock it, and update iOS or Xcode on this Mac if updates are available, then try again.",
        recovery: "check",
        title: "This iPhone doesn’t offer what screen control needs",
        yours: false,
      };
    case "tunnel-failed":
      return {
        detail: "This Mac couldn’t open a connection to the iPhone.",
        recovery: "check",
        steps: replugSteps,
        title: "Couldn’t connect to the iPhone",
        yours: false,
      };
    case "screen-off":
    case "screen-state-unknown":
    case "wake-on-phone-required":
      return {
        cue: "On the iPhone",
        detail: "Unlock it and leave the screen on.",
        recovery: "check",
        title: "Wake your iPhone",
        waiting: "Waiting for the screen…",
        yours: true,
      };
    case "screenshot-failed":
    case "geometry-unknown":
    case "geometry-unavailable":
    case "display-configuration-unsupported":
      return {
        cue: "On the iPhone",
        detail: "Unlock it, go to the Home Screen and turn off Screen Mirroring if it’s on.",
        recovery: "check",
        title: "Opensteer couldn’t see the screen",
        waiting: "Waiting for the screen…",
        yours: true,
      };
    case "host-offline":
      return {
        detail: `Check this Mac’s connection, then try again. It won’t be added twice.`,
        recovery: "check",
        title: `Couldn’t reach ${context.deploymentName}`,
        yours: false,
      };
    case "attach-failed":
      return {
        detail: "Try again. It won’t be added twice.",
        recovery: "check",
        title: `Couldn’t add the iPhone to ${context.deploymentName}`,
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
        detail: `It controls the iPhone, so add this Mac to ${context.deploymentName} in Devices first.`,
        recovery: "restart",
        title: "This Mac isn’t one of your devices yet",
        yours: true,
      };
    case "runner-module-not-allowed":
      return {
        detail: `This Mac’s access in ${context.deploymentName} doesn’t include phone screens. Check what it may do on its page in Devices.`,
        recovery: "check",
        title: "This Mac isn’t allowed to control phones",
        yours: true,
      };
    case "driver-conflict":
      return {
        detail: "Disconnect screen control on that Mac first, then try again.",
        recovery: "check",
        title: "Another Mac controls this iPhone",
        yours: true,
      };
    case "phone-already-added":
      return {
        detail: `It’s already one of ${context.deploymentName}’s devices. To set it up again, use Fix setup on its page.`,
        recovery: "check",
        title: "This iPhone is already added",
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
        detail:
          "Opensteer on this Mac is starting screen control. This usually takes a few seconds.",
        recovery: "check",
        title: "Finishing up",
        waiting: "Starting screen control…",
        yours: false,
      };
    case "cancelled":
    case "no-session":
    case "stale-native-epoch":
    case "not-initialized":
      return {
        detail:
          "Opensteer on this Mac stopped this setup. Start over; anything already done carries over.",
        recovery: "restart",
        title: "Setup stopped",
        yours: false,
      };
    default:
      return {
        detail: "Unplug the iPhone, plug it back in and unlock it, then try again.",
        recovery: "check",
        title: `Something went wrong while ${stageWords[context.stage]}`,
        yours: false,
      };
  }
}

const stageWords: Readonly<Record<DesktopIphoneSetupStage, string>> = {
  mac: "checking this Mac",
  connect: "finding the iPhone",
  trust: "pairing with the iPhone",
  "developer-mode": "checking Developer Mode",
  prepare: "getting the iPhone ready",
  wifi: "setting up Wi‑Fi access",
  add: "adding the iPhone",
  done: "finishing",
};
