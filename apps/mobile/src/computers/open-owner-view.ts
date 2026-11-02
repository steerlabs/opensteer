import {
  ownerViewDestination,
  type HostClient,
  type NativeViewerSource,
  type WorkspaceSurfaceDestination,
} from "@opensteer/client/host";
import { sharedDisplayStreams } from "@opensteer/client/integrations";
import { computerAppIdentityKey, type ComputerViewTarget } from "@opensteer/protocol";

/**
 * Opens the person's own view of a Mac app (or one of its windows) or a phone
 * for a person still on the screen that asked. One who left meanwhile gets
 * neither the navigation nor the phone's wake. The view itself is left to
 * expire unwatched: the Host answers an open of a view another device already
 * has with that same view, so closing it here could end what they're watching.
 */
export async function openOwnerView(
  hostClient: HostClient,
  machineId: string,
  target: ComputerViewTarget,
  stillHere: () => boolean,
): Promise<WorkspaceSurfaceDestination | null> {
  const view = await hostClient.openComputerView(machineId, target);
  if (stillHere()) return ownerViewDestination(view);
  sharedDisplayStreams(hostClient).cancelAutoWake({
    kind: "owner-view",
    viewId: view.viewId,
    generation: view.generation,
  });
  return null;
}

/** A phone's own view: the phone's approval names its display. */
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
  const destination = await openOwnerView(hostClient, machineId, target, stillHere);
  return destination?.kind === "phone" && destination.source?.kind === "owner-view"
    ? destination.source
    : null;
}

/**
 * A Mac app's own view again, of the same window when the ended view named
 * one: the app's approval on that Mac names it, by the key its route carries.
 */
export async function openAppOwnerView(
  hostClient: HostClient,
  machineId: string,
  appKey: string,
  windowId: number | undefined,
  stillHere: () => boolean,
): Promise<WorkspaceSurfaceDestination | null> {
  const apps = await hostClient.listApprovedComputerApps();
  const target = apps.find(
    (app) =>
      app.machineId === machineId &&
      app.target.kind === "app" &&
      computerAppIdentityKey(app.target.app) === appKey,
  )?.target;
  if (!stillHere()) return null;
  if (target?.kind !== "app") throw new Error("This app is no longer approved for viewing.");
  return openOwnerView(
    hostClient,
    machineId,
    windowId === undefined ? target : { ...target, window: windowId },
    stillHere,
  );
}
