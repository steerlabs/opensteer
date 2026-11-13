import type { HostClient, HostSnapshot } from "@opensteer/client/host";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import { useEffect } from "react";
import { useIphoneApps, useIphoneAppsState } from "../iphone-apps/context.js";
import { phoneMembership } from "./phone-setup.js";
import { useHostValue } from "../ui/mobile-client-context.js";

/** Not now, after a failed setup, holds for this launch only: setup is never forgotten. */
const notNow = new Set<string>();

export function dismissPhoneSetup(deploymentId: string): void {
  notNow.add(deploymentId);
}

const selectSetupHost = (snapshot: HostSnapshot): string =>
  `${snapshot.connection === "connected"}:${snapshot.iphoneAppsAvailable}`;

/**
 * Pushes Set up this phone over Home once a personal Deployment is open here
 * and this phone is not yet one of its devices. True while it is due, so the
 * notifications intro waits: setup asks for notifications itself.
 */
export function usePhoneSetup(hostClient: HostClient | null, deploymentId: string): boolean {
  const navigation = useNavigation();
  const focused = useIsFocused();
  const iphone = useIphoneAppsState(useIphoneApps());
  const host = useHostValue(hostClient, selectSetupHost, "false:false");
  const [connected, iphoneAppsAvailable] = host.split(":").map((part) => part === "true");
  const due =
    hostClient !== null &&
    connected === true &&
    !notNow.has(deploymentId) &&
    phoneMembership({
      deploymentId,
      host: { iphoneAppsAvailable: iphoneAppsAvailable === true },
      iphone,
    }).state === "needs-setup";
  useEffect(() => {
    if (due && focused) navigation.navigate("SetUpPhone", { deploymentId });
  }, [deploymentId, due, focused, navigation]);
  return due;
}
