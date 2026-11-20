import {
  deviceWords,
  homeKind,
  serverHomeFacts,
  type HomeKindFact,
} from "@opensteer/client/computers";
import { useCloudComputer } from "@opensteer/client/react";
import type { MachineSummary } from "@opensteer/protocol";
import { useShell } from "../app-shell.js";
import { SettingsGroup, SettingsRow } from "../settings/primitives.js";
import { useCloudComputerAccount } from "../settings/sections/cloud-computer.js";

/**
 * What kind of Home this window's Opensteer lives on, from what the app already knows: the
 * Account's Cloud Computer views (desktop app only), the Host's exposure, and whether this
 * window runs on the Home itself.
 */
export function useHomeKind(): HomeKindFact {
  const { desktopDeployment, snapshot } = useShell();
  const cloud = useCloudComputer(useCloudComputerAccount());
  return homeKind({
    exposure: snapshot.identityConfig?.exposure,
    homeKind: snapshot.identityConfig?.homeKind,
    deploymentId: snapshot.deploymentId,
    hostedHere: desktopDeployment?.onThisComputer === true,
    account: cloud.views,
  });
}

/** The Home page's own facts: running on this Mac, or a server's address, version and owner. */
export function HomeFacts({ machine }: { readonly machine: MachineSummary }) {
  const { snapshot } = useShell();
  const home = useHomeKind();
  if (home.kind === "this-mac")
    return (
      <SettingsGroup heading={null} headingId="device-home-facts">
        <SettingsRow title={deviceWords("home.thisMac")} />
      </SettingsGroup>
    );
  if (home.kind !== "server") return null;
  const facts = serverHomeFacts({
    publicOrigin: snapshot.identityConfig?.publicOrigin ?? null,
    homeMachine: machine,
    personal: snapshot.deploymentShape?.kind === "personal",
    role: snapshot.role,
  });
  if (!facts.address && !facts.version && !facts.owner) return null;
  return (
    <SettingsGroup heading={null} headingId="device-home-facts">
      {facts.address ? (
        <SettingsRow detail={facts.address.value} title={facts.address.label} />
      ) : null}
      {facts.version ? (
        <SettingsRow detail={facts.version.value} title={facts.version.label} />
      ) : null}
      {facts.owner ? <SettingsRow title={facts.owner} /> : null}
    </SettingsGroup>
  );
}
