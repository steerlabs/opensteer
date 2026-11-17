import { presentClientIssue } from "@opensteer/client/feedback";
import { useMemo, useRef } from "react";
import { createClientRead } from "@opensteer/client/reads";
import { useClientRead } from "@opensteer/client/react";
import { useShell } from "../app-shell.js";

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
  const state = useClientRead(resource);
  return {
    ...state,
    error: state.issue ? presentClientIssue(state.issue).title : null,
    reload: state.refresh,
  };
}
