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
 * The `shell` module is deferred on Windows, so a Windows computer cannot join
 * only to be reached — it has to join running agents. A Personal Deployment
 * admits other computers only to be reached, so on Windows it admits none, and
 * no offer is made. Everywhere else a computer joins with both facts off and
 * the switches on its own page decide the rest.
 */
export function localJoinOffer(input: {
  readonly deploymentKind: "personal" | "server" | null;
  readonly status: DesktopLocalExecutionStatus | null;
}): { readonly runAgents: boolean } | null {
  const { deploymentKind, status } = input;
  if (status === null || !status.available || status.runner.enrolled) return null;
  if (status.platform !== "windows") return { runAgents: false };
  return deploymentKind === "server" ? { runAgents: true } : null;
}
