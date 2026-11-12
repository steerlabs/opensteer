import { useMemo } from "react";
import {
  RemoteAccessPortError,
  resumePersonalHostAccountLink,
  type HostClient,
  type RemoteAccessPort,
} from "@opensteer/client/host";
import {
  useRemoteAccess,
  type RemoteAccessController,
  type usePersonalRemoteAccess,
} from "@opensteer/client/react";
import type { PersonalRemoteAdministrationStatus } from "@opensteer/protocol";
import { useShell } from "../components/app-shell.js";
import { deploymentNameFrom } from "../components/deployment-name.js";
import { linkAccountThroughPortal } from "../components/settings/link-personal-account.js";
import {
  supportsPersonalAccountLink,
  usePersonalAccountLink,
  type PersonalAccountLinkController,
  type PersonalAccountLinkOutcome,
} from "./use-personal-account-link.js";

/** Outcomes that leave nothing for the next step to build on. */
function refuseUnfinished(outcome: PersonalAccountLinkOutcome): void {
  if (
    outcome.kind === "linked-elsewhere" ||
    outcome.kind === "needs-repair" ||
    outcome.kind === "unavailable"
  )
    throw new RemoteAccessPortError(outcome.message);
}

/**
 * The computer's own app: its journaled link signs in through the browser
 * when it has to, and finishes an activating link itself.
 */
export function desktopRemoteAccessPort(link: PersonalAccountLinkController): RemoteAccessPort {
  return {
    link: async () => refuseUnfinished(await link.link()),
    repair: async () => {
      const outcome = await link.repair();
      if (!outcome.succeeded) throw new RemoteAccessPortError(outcome.message);
    },
  };
}

/** A plain browser: the Account portal signs in and links in a popup. */
export function browserRemoteAccessPort(input: {
  readonly hostClient: HostClient;
  readonly name: string;
  readonly portalOrigin: string | null;
  readonly status: PersonalRemoteAdministrationStatus | null;
}): RemoteAccessPort {
  return {
    link: async ({ activating, signal }) => {
      if (activating) {
        await resumePersonalHostAccountLink(input.hostClient);
        return;
      }
      if (!input.status) throw new RemoteAccessPortError("Still checking. Try again in a moment.");
      await linkAccountThroughPortal({
        authorityEnvelope: input.status.authorityEnvelope,
        hostClient: input.hostClient,
        name: input.name,
        portalOrigin: input.portalOrigin,
        signal,
      });
    },
  };
}

/** "Use from anywhere" for the computer this web or desktop window is attached to. */
export function useWebRemoteAccess(
  remote: ReturnType<typeof usePersonalRemoteAccess>,
): RemoteAccessController {
  const { deploymentAccess, desktopBridge, desktopDeployment, hostClient, snapshot } = useShell();
  const bridge = supportsPersonalAccountLink(desktopBridge) ? desktopBridge : null;
  const link = usePersonalAccountLink(bridge, deploymentAccess);
  const name = deploymentNameFrom(desktopDeployment, snapshot);
  const portalOrigin = snapshot.identityConfig?.portalOrigin ?? null;
  const port = useMemo(
    () =>
      bridge
        ? desktopRemoteAccessPort(link)
        : browserRemoteAccessPort({
            hostClient,
            name: name ?? "Opensteer",
            portalOrigin,
            status: remote.status,
          }),
    [bridge, hostClient, link, name, portalOrigin, remote.status],
  );
  return useRemoteAccess({
    computerName: name,
    hostClient,
    link: bridge ? (link.status?.status ?? null) : null,
    port,
    remote,
    signedIn: bridge && deploymentAccess ? deploymentAccess.account.status === "signed-in" : null,
  });
}
