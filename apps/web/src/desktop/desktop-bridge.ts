import type { ViewerClipboardBridge } from "@opensteer/client/editing";
import type {
  DesktopLocalExecutionStatus,
  OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";

type LocalRunnerState = DesktopLocalExecutionStatus["runner"]["state"];

declare global {
  interface Window {
    readonly opensteerDesktop?: OpensteerDesktopBridge & Partial<ViewerClipboardBridge>;
  }
}

export function desktopBridge(): (OpensteerDesktopBridge & Partial<ViewerClipboardBridge>) | null {
  return typeof window === "undefined" ? null : (window.opensteerDesktop ?? null);
}

export function localExecutionAvailable(status: DesktopLocalExecutionStatus | null): boolean {
  return status?.available === true;
}

/** The Runner on this computer, in the words the page reads it in. */
export function localRunnerStateLabel(state: LocalRunnerState): string {
  switch (state) {
    case "disabled":
      return "Off";
    case "starting":
      return "Connecting";
    case "running":
      return "Ready";
    case "stopping":
      return "Turning off";
    case "failed":
      return "Needs attention";
  }
}

/**
 * Whether the computer in front of the reader can join the Deployment on
 * screen, and running what.
 *
 * A Personal Deployment admits other computers only to be reached: agents run
 * on the computer hosting it. The `shell` module is deferred on Windows, so a
 * Windows computer has nothing to be reached for and no offer is made.
 */
export function localJoinOffer(
  status: DesktopLocalExecutionStatus | null,
): { readonly runAgents: false } | null {
  if (status === null || !status.available || status.runner.enrolled) return null;
  return status.platform === "windows" ? null : { runAgents: false };
}
