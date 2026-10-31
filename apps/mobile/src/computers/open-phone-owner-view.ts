import type { HostClient, NativeViewerSource } from "@opensteer/client/host";
import { sharedDisplayStreams } from "@opensteer/client/integrations";

/**
 * Opens a phone owner view for a person still on the screen that asked. Open
 * arms one wake for the view's first attachment, so a person who left meanwhile
 * gets neither the navigation nor the wake.
 */
export async function openPhoneOwnerView(
  hostClient: HostClient,
  machineId: string,
  stillHere: () => boolean,
): Promise<Extract<NativeViewerSource, { kind: "owner-view" }> | null> {
  const apps = await hostClient.listApprovedComputerApps();
  const target = apps.find(
    (app) => app.machineId === machineId && app.target.kind === "phone",
  )?.target;
  if (!stillHere()) return null;
  if (!target) throw new Error("This phone is no longer approved for viewing.");
  const view = await hostClient.openComputerView(machineId, target);
  const source = { kind: "owner-view" as const, viewId: view.viewId, generation: view.generation };
  if (stillHere()) return source;
  sharedDisplayStreams(hostClient).cancelAutoWake(source);
  return null;
}
