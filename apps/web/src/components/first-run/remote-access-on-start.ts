import { useEffect, useRef } from "react";
import type { RemoteAccessController } from "@opensteer/client/react";
import { forgetRemoteAccessOnStart, remoteAccessWantedOnStart } from "./setup-memory.js";

/**
 * Turns Remote access on once for an Opensteer the person started on this Mac while signed in:
 * the Home is linked to their account and Remote access comes on, the same steps as pressing
 * "Turn on Remote access", without the press. It never overrides a choice: an Opensteer already
 * on, on a private network, signed out since, or failing once is left as it is, and the wish is
 * forgotten.
 */
export function useRemoteAccessOnStart(
  deploymentId: string | null,
  connect: RemoteAccessController,
): void {
  const started = useRef(false);
  const state = connect.view.state;
  useEffect(() => {
    if (deploymentId === null || !remoteAccessWantedOnStart(deploymentId)) return;
    if (state === "off" || state === "link-activating") {
      if (started.current) return;
      started.current = true;
      connect.act("turn-on");
      return;
    }
    // Still on its way: the next state decides.
    if (state === "loading" || state === "turning-on" || state === "waiting-for-app") return;
    // On, or anything else: failed once, signed out, or someone else's choice. Never asked again.
    forgetRemoteAccessOnStart(deploymentId);
  }, [connect, deploymentId, state]);
}
