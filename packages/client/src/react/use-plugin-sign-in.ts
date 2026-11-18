import { clientScopeKey } from "../connections/connection-controller.js";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { PluginRequirementTarget } from "@opensteer/protocol";
import {
  PluginSignInFlow,
  type PluginSignInClient,
  type PluginSignInState,
  type PluginSignInSurface,
} from "../plugins/sign-in.js";

/**
 * One requirement's sign-in for as long as the screen shows it. It prepares
 * once on mount; leaving the screen stops watching but never cancels.
 */
export function usePluginSignIn(input: {
  readonly client: PluginSignInClient;
  readonly surface: PluginSignInSurface;
  readonly target: PluginRequirementTarget;
  readonly providerName: string;
}): { readonly flow: PluginSignInFlow; readonly state: PluginSignInState } {
  const { client, surface, target, providerName } = input;
  const getScope = useCallback(
    () => clientScopeKey(client.connection.getSnapshot().scope),
    [client],
  );
  const scope = useSyncExternalStore(client.connection.subscribe, getScope, getScope);
  const key = `${target.pluginId}\n${target.requirement}\n${target.scope}`;
  const [flow, setFlow] = useState(
    () => new PluginSignInFlow({ client, surface, target, providerName }),
  );
  useEffect(() => {
    const next = new PluginSignInFlow({ client, surface, target, providerName });
    setFlow(next);
    void next.prepare();
    return () => next.close();
    // The target's identity is its key; a new object for the same target is the same sign-in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, surface, key, providerName, scope]);
  const state = useSyncExternalStore(
    (listener) => flow.subscribe(listener),
    () => flow.getState(),
    () => flow.getState(),
  );
  return { flow, state };
}
