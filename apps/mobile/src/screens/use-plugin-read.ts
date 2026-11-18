import { type HostClient } from "@opensteer/client/host";
import { pluginChangeAffects } from "@opensteer/client/plugins";
import type { PluginChange } from "@opensteer/protocol";
import { readLine, useScreenRead } from "../ui/client-feedback.js";

export function usePluginRead<T>(
  host: HostClient,
  read: (() => Promise<T>) | null,
  key: string,
  label: string,
  interest?: PluginChange,
) {
  const state = useScreenRead(host, {
    key,
    label,
    read,
    subscribeInvalidation: (invalidate) =>
      host.subscribePluginsChanged((change) => {
        if (pluginChangeAffects(change, interest?.categories, interest?.pluginId)) invalidate();
      }),
  });
  const line = readLine(state, state.refresh);
  return { ...state, line, error: line?.text ?? null, reload: state.refresh };
}
