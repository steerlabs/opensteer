import { useIphoneApps, useIphoneAppsState } from "../iphone-apps/context.js";
import { useMobileState } from "../ui/mobile-client-context.js";

/**
 * The device this phone is in the Deployment on screen: its own Runner, once
 * it is added to that Deployment. Otherwise the phone is none of its devices,
 * and every device is named.
 */
export function useHereId(): string | null {
  const { enrollment } = useIphoneAppsState(useIphoneApps()).snapshot;
  const { selection } = useMobileState();
  return enrollment?.state === "enrolled" && enrollment.deploymentId === selection.deploymentId
    ? enrollment.runnerId
    : null;
}
