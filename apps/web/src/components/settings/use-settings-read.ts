import { presentClientIssue } from "@opensteer/client/feedback";
import { useMemo, useRef } from "react";
import { useDisposedWithView } from "../use-action.js";
import { createClientRead } from "@opensteer/client/reads";
import { useClientRead } from "@opensteer/client/react";
import { useShell } from "../app-shell.js";

/**
 * One settings read through the shared read owner: it keeps what it showed
 * through an outage and says only its own failure, never the connection's.
 */
export function useSettingsRead<T>(read: () => Promise<T>, key: string, remember = false) {
  const { hostClient } = useShell();
  const current = useRef(read);
  current.current = read;
  const resource = useMemo(
    () =>
      createClientRead(hostClient, {
        key,
        label: "settings",
        remember: remember ? "across-mounts" : false,
        read: () => current.current(),
        subscribeInvalidation: (listener) => hostClient.subscribePluginsChanged(listener),
      }),
    [hostClient, key, remember],
  );
  useDisposedWithView(resource);
  const state = useClientRead(resource);
  return {
    ...state,
    error: state.issue ? presentClientIssue(state.issue).title : null,
    reload: state.refresh,
  };
}
