import { ownerViewComputerReadiness } from "@opensteer/client/integrations";
import { computerAppIdentityKey, type ComputerView } from "@opensteer/protocol";
import type { HostSnapshot, WorkspaceSurfaceDestination } from "@opensteer/client/host";

/** Where a person's own view of an app or phone is shown: its exact generation, never a task's session. */
export function ownerViewDestination(view: ComputerView): WorkspaceSurfaceDestination {
  const source = { kind: "owner-view" as const, viewId: view.viewId, generation: view.generation };
  return view.target.kind === "app"
    ? {
        kind: "app",
        machineId: view.machineId,
        appKey: computerAppIdentityKey(view.target.app),
        ...(view.window ? { windowId: view.window.id } : {}),
        source,
      }
    : { kind: "phone", machineId: view.machineId, display: view.target.display, source };
}

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
