import { pluginChangeAffects } from "@opensteer/client/plugins";
import type { PluginChange } from "@opensteer/protocol";
import { presentClientIssue } from "@opensteer/client/feedback";
import { useMemo, useRef } from "react";
import { createClientRead } from "@opensteer/client/reads";
import { useClientRead } from "@opensteer/client/react";
import { useShell } from "../app-shell.js";

/**
 * One settings read through the shared read owner: it keeps what it showed
 * through an outage and says only its own failure, never the connection's.
 */
export function useSettingsRead<T>(
  read: () => Promise<T>,
  key: string,
  remember = false,
  interest?: PluginChange,
  label = "settings",
) {
  const { hostClient } = useShell();
  const current = useRef(read);
  current.current = read;
  const watched = useRef(interest);
  watched.current = interest;
  const resource = useMemo(
    () =>
      createClientRead(hostClient, {
        key,
        label,
        remember: remember ? "across-mounts" : false,
        read: () => current.current(),
        subscribeInvalidation: (listener) =>
          hostClient.subscribePluginsChanged((change) => {
            if (pluginChangeAffects(change, watched.current?.categories, watched.current?.pluginId))
              listener();
          }),
      }),
    [hostClient, key, remember, label],
  );
  const state = useClientRead(resource);
  return {
    ...state,
    error: state.issue ? presentClientIssue(state.issue).title : null,
    reload: state.refresh,
  };
}
