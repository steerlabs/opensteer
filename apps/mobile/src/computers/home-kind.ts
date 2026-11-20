import type { CloudComputerView } from "@opensteer/control-plane-protocol";
import { homeKind, type HomeKindFact } from "@opensteer/client/computers";
import type { HostSnapshot } from "@opensteer/client/host";
import { useCloudComputer } from "@opensteer/client/react";
import { useMobileClient } from "../ui/mobile-client-context.js";

/** What the Home kind needs from the Host, for callers to read through their own subscription. */
export const selectHomeExposure = (snapshot: HostSnapshot) => snapshot.identityConfig?.exposure;
export const selectHomeDeploymentId = (snapshot: HostSnapshot) => snapshot.deploymentId;
export const selectHomeKind = (snapshot: HostSnapshot) => snapshot.identityConfig?.homeKind;

/**
 * What kind of Home the open Opensteer lives on, as the phone can tell: its exposure from the
 * Host, and the Account's Cloud Computer views for its deployment. A phone never hosts the
 * Home, so a loopback Home is always a Mac elsewhere. `computer` is the Account's view of a
 * Cloud Computer or work Home, when it is one.
 */
export function usePhoneHome(input: {
  readonly exposure: "loopback" | "networked" | undefined;
  readonly homeKind?: "mac" | "server" | "cloud-computer" | undefined;
  readonly deploymentId: string | null;
}): { readonly kind: HomeKindFact; readonly computer: CloudComputerView | null } {
  const views = useCloudComputer(useMobileClient().cloudComputers ?? null).views;
  const { deploymentId } = input;
  const kind = homeKind({
    exposure: input.exposure,
    homeKind: input.homeKind,
    deploymentId,
    hostedHere: false,
    account: views,
  });
  const computer =
    deploymentId === null || views === null
      ? null
      : (views.computers.find((view) => view.deploymentId === deploymentId) ??
        views.work.find(({ computer: view }) => view?.deploymentId === deploymentId)?.computer ??
        null);
  return { kind, computer };
}
