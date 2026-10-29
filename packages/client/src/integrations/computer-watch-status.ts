import type { DisplayStreamReason } from "@opensteer/protocol";
import type { ComputerUseStop } from "./computer-use-stops.js";
import { computerReasonWords, type ComputerNotReady } from "./computer-reasons.js";
export type DisplayUnavailableReason =
  | DisplayStreamReason
  | "opensteer-app"
  | "protected"
  | "projection-permission"
  | "projection-ended"
  | "display-failed"
  | "decoder-unsupported";
type ComputerUseWatchUnavailableReason =
  "waiting" | "busy" | "ended" | "locked" | "unsupported" | "screen-off" | "paused";

/** What a Watch view says instead of, or over, its picture. */
export interface ComputerWatchStatus {
  readonly words: string;
  /** Something is on its way: the words sit beside a spinner. */
  readonly busy: boolean;
  /**
   * The picture no longer shows what is there, so none is shown. Otherwise the
   * last picture stays, dimmed, under the words.
   */
  readonly clear: boolean;
}

/**
 * The one status a Watch view shows, in the same words on every platform and
 * as the person's own view of the same app or phone: why it is not ready and
 * why a picture is missing come from `computerReadiness` and
 * `computerReasonWords`; only the task's own session — stopping, stopped,
 * finished, the agent not there yet — has words of its own here.
 * Null is the ordinary case: a current picture, and nothing to say about it.
 */
export function computerWatchStatus(input: {
  /** The app in the picture last shown, if any. */
  readonly appName: string | null;
  /** A picture is on screen. */
  readonly displayed: boolean;
  /** The session is still in the computer's list. */
  readonly live: boolean;
  readonly machineName: string;
  /** A phone's display rather than a Mac app. */
  readonly phone: boolean;
  /** Why the computer gives no picture now, before any is asked for (`computerReadiness`). */
  readonly readiness: ComputerNotReady | null;
  readonly reason: ComputerUseWatchUnavailableReason | DisplayUnavailableReason | null;
  readonly retrying: boolean;
  readonly startingWords?: string;
  readonly stop: ComputerUseStop | null;
}): ComputerWatchStatus | null {
  const say = (words: string, extra: Partial<Omit<ComputerWatchStatus, "words">> = {}) => ({
    busy: false,
    clear: false,
    words,
    ...extra,
  });
  const gone = (words: string) => say(words, { clear: true });
  const mac = input.machineName;
  const names = {
    machine: mac,
    phone: input.phone,
    target: input.phone ? mac : (input.appName ?? "This app"),
  };
  if (input.readiness === "connecting")
    return say(computerReasonWords(input.readiness, names), { busy: true, clear: true });
  if (input.readiness !== null) return gone(computerReasonWords(input.readiness, names));
  if (input.stop?.phase === "stopping") return say("Stopping…", { busy: true });
  // Only a Stop the Host answered ended it; a failed one says nothing about
  // why the session later left.
  if (input.stop?.phase === "stopped") return gone(`Stopped using ${mac}`);
  if (!input.live) return gone(`Finished using ${mac}`);
  switch (input.reason) {
    // Macs keep an app listed before its first observation; a phone has no app to wait for.
    case "ended":
      return input.appName ? say(`Waiting for ${input.appName}…`) : gone(`Finished using ${mac}`);
    case "waiting":
      return say(input.appName ? computerReasonWords("waiting", names) : "Waiting for the agent…");
    case "busy":
    case null:
      break;
    default:
      return gone(computerReasonWords(input.reason, names));
  }
  if (input.retrying) {
    return input.displayed
      ? say(`Reconnecting to ${mac}…`, { busy: true })
      : say(`Connecting to ${mac}…`, { busy: true });
  }
  if (!input.displayed)
    return say(
      input.phone ? `Connecting to ${mac}…` : (input.startingWords ?? "Starting window sharing…"),
      { busy: true },
    );
  return null;
}
