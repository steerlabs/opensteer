import { ownerViewComputerReadiness } from "@opensteer/client/integrations";
import type { ComputerView } from "@opensteer/protocol";
import type { HostSnapshot } from "@opensteer/client/host";

/**
 * One current-state decision controls both polling and the words when it
 * stops: the computer's readiness, shared with a task's view of the same app
 * or phone, then this exact view's own state.
 */
export function ownerViewReadiness(
  machine: HostSnapshot["machines"][number] | null | undefined,
  view: ComputerView | null | undefined,
  phone: boolean,
): string | null {
  const computer = ownerViewComputerReadiness(machine, phone);
  if (
    computer === "needs-update" ||
    computer === "updating" ||
    computer === "update-pending" ||
    computer === "offline"
  )
    return computer;
  if (!view) return "closed";
  if (computer !== null) return computer;
  if (view.state !== "ready") return view.unavailableReason ?? view.state;
  return null;
}

/**
 * What a view that stopped offers. A window the Mac no longer knows (its Opensteer
 * restarted since the tab chose it) is chosen again from the app's windows: opening
 * it again would ask for the same lost window. Everything else opens again.
 */
export function ownerViewRecovery(
  readiness: string | null,
  phone: boolean,
): "choose-window" | "open-again" {
  return !phone && readiness === "window-identity-lost" ? "choose-window" : "open-again";
}
