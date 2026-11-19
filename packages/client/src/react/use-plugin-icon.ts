import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { HostClient, HostSnapshot } from "../host/client.js";
import { pluginIcons } from "../plugins/icons.js";
import { useHostSelector } from "./use-host-snapshot.js";

const selectConnection = (snapshot: HostSnapshot) => snapshot.connection;
const noSubscription = () => () => undefined;

/**
 * A plugin's icon as an image source: undefined while it is read, null when
 * there is none to draw, when a row shows its fallback mark.
 */
export function usePluginIcon(
  hostClient: HostClient,
  ref: string | null | undefined,
): string | null | undefined {
  const icons = pluginIcons(hostClient);
  const connection = useHostSelector(hostClient, selectConnection);
  const subscribe = useCallback(
    (listener: () => void) => (ref ? icons.subscribe(ref, listener) : noSubscription()),
    [icons, ref],
  );
  const read = useCallback(() => (ref ? icons.image(ref) : null), [icons, ref]);
  const image = useSyncExternalStore(subscribe, read, read);
  useEffect(() => {
    if (ref && connection === "connected") icons.request(ref);
  }, [connection, icons, ref]);
  return image;
}
