import { useEffect, useState } from "react";
import type { PluginEngineStateView } from "@opensteer/protocol";
import type { HostClient } from "../host/client.js";

/**
 * The plugin engine's state: what the last read said, then each change the
 * Host reports. A new read's state replaces whatever was reported before it.
 */
export function usePluginEngine(
  client: Pick<HostClient, "subscribePluginEngine">,
  initial: PluginEngineStateView | null,
): PluginEngineStateView | null {
  const [reported, setReported] = useState<PluginEngineStateView | null>(null);
  useEffect(() => client.subscribePluginEngine(setReported), [client]);
  useEffect(() => setReported(null), [initial]);
  return reported ?? initial;
}
