import { homeKind, type HomeKindFact } from "@opensteer/client/computers";
import type { HostClient, HostSnapshot } from "@opensteer/client/host";
import { useCloudComputer } from "@opensteer/client/react";
import { useMobileClient, useHostValue } from "../ui/mobile-client-context.js";

const selectExposure = (snapshot: HostSnapshot) => snapshot.identityConfig?.exposure;
const selectDeploymentId = (snapshot: HostSnapshot) => snapshot.deploymentId;

/**
 * What kind of Home the open Opensteer lives on, as the phone can tell: its exposure from the
 * Host, and the Account's Cloud Computer views for its deployment. A phone never hosts the
 * Home, so a loopback Home is always a Mac elsewhere.
 */
export function usePhoneHomeKind(host: HostClient | null): HomeKindFact {
  const views = useCloudComputer(useMobileClient().cloudComputers ?? null).views;
  const exposure = useHostValue(host, selectExposure, undefined);
  const deploymentId = useHostValue(host, selectDeploymentId, null);
  return homeKind({ exposure, deploymentId, hostedHere: false, account: views });
}
