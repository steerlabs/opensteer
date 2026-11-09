import { useCallback, useSyncExternalStore } from "react";
import { useIphoneApps } from "../iphone-apps/context.js";

/**
 * The Runner this phone is in the Deployment being viewed, or null where it is
 * not one of its devices: the `hereId` of `deviceElsewhere` and `orderDevices`.
 * Only an enrolled phone is a device; a phone still being added, or added to
 * another Deployment, is at none of this one's.
 */
export function useHereDeviceId(deploymentId: string): string | null {
  const controller = useIphoneApps();
  const read = useCallback(() => {
    const enrollment = controller.getState().snapshot.enrollment;
    return enrollment?.state === "enrolled" && enrollment.deploymentId === deploymentId
      ? enrollment.runnerId
      : null;
  }, [controller, deploymentId]);
  return useSyncExternalStore(controller.subscribe, read, read);
}
