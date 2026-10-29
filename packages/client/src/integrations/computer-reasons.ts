import type { MachineSummary } from "@opensteer/protocol";

/** Why no picture of a computer's app or phone can be asked for now, before any is asked. */
export type ComputerNotReady =
  | "needs-update"
  | "updating"
  | "update-pending"
  | "offline"
  | "connecting"
  | "unsupported"
  | "screen-recording-required"
  | "accessibility-required"
  | "permission-required"
  | "native-unavailable"
  | "paused";

/**
 * Whether a computer can give this view a picture now: the computer not
 * refused for being too old to connect (`needs-update`, the machine's own
 * status), online, the kind of picture the view reads (`supported`: a task's
 * captures, the person's own view, a phone's live display) there, and on a Mac
 * both grants and its helper ready. The person's own view and a task's view
 * decide from this one answer; null when ready. A realtime reconnect is not a
 * reason: the display socket is admitted on its own and says when it drops.
 */
export function computerReadiness(input: {
  readonly machine: MachineSummary | null | undefined;
  readonly phone: boolean;
  readonly supported: boolean;
}): ComputerNotReady | null {
  const { machine } = input;
  if (machine?.status === "updating" || machine?.status === "update-pending") return machine.status;
  if (machine?.status === "needs-update") return "needs-update";
  if (machine?.status !== "online") return "offline";
  // The Host lists a computer's apps as empty from the moment it is back until
  // it says what it can do; until then its other fields are guesses. (Apps this
  // viewer may not see are null, never empty.)
  if (machine.apps?.length === 0) return "connecting";
  if (!input.supported) return "unsupported";
  if (input.phone) return null;
  if (machine.computerUse?.permissions?.screenRecording === "denied")
    return "screen-recording-required";
  if (machine.computerUse?.permissions?.accessibility === "denied") return "accessibility-required";
  if (machine.computerUse?.state === "permission-required") return "permission-required";
  if (machine.computerUse?.state !== "ready") return "native-unavailable";
  return null;
}

/**
 * Whether a computer can give the person's own view of one of its apps, or of
 * the phone it is, a picture now: the answer the view itself reads, so a place
 * that offers to open one can say the same before anything is opened.
 */
export function ownerViewComputerReadiness(
  machine: MachineSummary | null | undefined,
  phone: boolean,
): ComputerNotReady | null {
  return computerReadiness({
    machine,
    phone,
    supported:
      machine !== null &&
      machine !== undefined &&
      (phone
        ? machine.computerUse?.displayStreamSupported === true
        : machine.computerUse?.ownerViewVersion === 2 ||
          machine.computerUse?.ownerViewVersion === 3),
  });
}

/**
 * Whether a new view of a computer's app, or of the phone it is, would show
 * anything now — what a place offering to open one asks. It is the view's own
 * answer, and a phone its owner paused: a view already open sits a pause out
 * and picks up again, but a new one would show nothing.
 */
export function newOwnerViewReadiness(
  machine: MachineSummary | null | undefined,
  phone: boolean,
): ComputerNotReady | null {
  const readiness = ownerViewComputerReadiness(machine, phone);
  const state = machine?.computerUse?.state;
  if (readiness !== null || !phone || state === undefined || state === "ready") return readiness;
  // Pausing is the one thing a phone reports itself as not ready for.
  return state === "permission-required" ? "permission-required" : "paused";
}

/**
 * A computer that can't show its apps, in a word or two where they would be
 * listed. `away` is only waited for; `attention` is its owner's to fix, and
 * the computer's own page says how.
 */
export interface ComputerNotReadyStatus {
  readonly label: string;
  readonly tone: "away" | "attention";
}

export function computerNotReadyStatus(reason: ComputerNotReady): ComputerNotReadyStatus {
  switch (reason) {
    case "offline":
      return { label: "Offline", tone: "away" };
    case "connecting":
      return { label: "Connecting…", tone: "away" };
    case "updating":
      return { label: "Updating…", tone: "away" };
    case "paused":
      return { label: "Paused", tone: "away" };
    case "needs-update":
    case "update-pending":
    case "unsupported":
      return { label: "Needs update", tone: "attention" };
    case "screen-recording-required":
    case "accessibility-required":
    case "permission-required":
      return { label: "Needs permission", tone: "attention" };
    case "native-unavailable":
      return { label: "Unavailable", tone: "attention" };
  }
}

/**
 * Why a view of a computer's app or phone shows no picture, in the person's
 * words: one sentence per reason, the same in the person's own view and a
 * task's, whatever said it — the computer's readiness, a capture, the phone's
 * live display, or the Host refusing a view.
 */
export function computerReasonWords(
  reason: string,
  names: { readonly target: string; readonly machine: string; readonly phone: boolean },
): string {
  switch (reason) {
    case "updating":
      return `Updating Agent Phone on ${names.machine}…`;
    case "update-pending":
      return `Tap Update on ${names.machine}.`;
    case "needs-update":
    case "agent-phone-outdated":
    case "computer-view-needs-update":
      return `Update ${names.phone ? "Agent Phone" : "Opensteer"} on ${names.machine}.`;
    case "offline":
      return `${names.machine} is offline.`;
    case "connecting":
      return `Connecting to ${names.machine}…`;
    case "unsupported":
    case "computer-view-unsupported":
      return `Update Opensteer on ${names.machine} to see ${names.phone ? "it" : names.target} here.`;
    case "window-unreadable":
    case "accessibility-error":
      return `${names.target}’s window can’t be read.`;
    case "encoder-failed":
      return `Video sharing isn’t available on ${names.machine}.`;
    case "capacity":
      return "Close another live view, then open this window again.";
    case "capture-timeout":
      return "macOS couldn’t start sharing this window.";
    case "sharing-stopped":
      return "macOS stopped sharing this window.";
    case "capture-failed":
      return `${names.target}’s window couldn’t be captured.`;
    case "native-unavailable":
    case "computer-view-unavailable":
      return `${names.machine} is unavailable.`;
    case "screen-recording-required":
      return `Allow Screen Recording on ${names.machine} to see ${names.target}.`;
    case "accessibility-required":
      return `Allow Accessibility on ${names.machine} to see ${names.target}.`;
    case "permission-required":
      return `${names.machine} needs permission to show ${names.phone ? "its screen" : names.target}.`;
    case "projection-permission":
      return `Connect ${names.machine} over USB and run setup to allow screen sharing.`;
    case "projection-ended":
      return `${names.machine} stopped sharing its screen.`;
    case "display-failed":
      return `Couldn’t show ${names.machine}’s screen.`;
    case "decoder-unsupported":
      return `This browser can’t show ${names.machine}’s screen.`;
    case "connection-revoked":
    case "computer-view-not-approved":
      return `${names.target} is no longer approved for viewing.`;
    case "waiting":
    case "busy":
      return `Waiting for ${names.phone ? names.machine : names.target}…`;
    case "locked":
      return `${names.machine} is locked.`;
    case "minimized":
      return `${names.target} is minimized on ${names.machine}.`;
    case "window-closed":
      return `${names.target} has no open window on ${names.machine}.`;
    case "target-unavailable":
      return names.phone
        ? `${names.machine} isn’t reachable right now.`
        : `${names.target} has no open window on ${names.machine}.`;
    case "paused":
      return `${names.machine} is paused.`;
    case "protected":
    case "secure-screen":
      return "Hidden while something private is on screen.";
    case "own-app":
    case "opensteer-app":
      return `Open another app on ${names.machine} to watch its screen.`;
    case "screen-off":
      return `${names.machine}’s screen is off.`;
    case "expired":
      return "This view closed after a while unwatched.";
    case "ended":
    case "closed":
    case "computer-view-ended":
    case "computer-view-stale-generation":
      return "This view was closed.";
    case "host-restarted":
      return "Opensteer restarted, so this view closed.";
    case "computer-view-limit":
      return "Too many views are open. Close one and try again.";
    default:
      return `${names.phone ? names.machine : names.target} can’t be shown right now.`;
  }
}
