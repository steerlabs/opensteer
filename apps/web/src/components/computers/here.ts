import { useOptionalWorkspace } from "../workspace/workspace-context.js";

// The mock preview stands at a device by `?mock-here=<runner id>`, as a desktop would.
const previewHereId =
  import.meta.env.VITE_OPENSTEER_USE_MOCK === "true"
    ? new URLSearchParams(window.location.search).get("mock-here")
    : null;

/**
 * The device this window is on: on desktop, this Mac as its Runner names it.
 * A browser can't say which computer it is on, so it is at none of them.
 */
export function useHereId(): string | null {
  return useOptionalWorkspace()?.localMachine?.machineId ?? previewHereId;
}
