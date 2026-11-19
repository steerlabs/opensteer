import type { PersonalResourceKind } from "@opensteer/protocol/resources";
import { useCallback, useSyncExternalStore } from "react";
import type { HostClient } from "../host/client.js";

const noSubscription = () => () => undefined;

/**
 * Whether a screen's resource kinds could not be read (the Host's inventory too large or
 * malformed, or refused), and its Try again. While it holds, the screen says it could not load,
 * never shows an empty or stale list.
 */
export function useUnreadableResources(
  hostClient: HostClient | null,
  kinds: readonly PersonalResourceKind[],
): { readonly unreadable: boolean; readonly retry: () => void } {
  const key = kinds.join(",");
  const read = useCallback(
    () =>
      (hostClient?.getSnapshot().unreadableResources ?? []).some((kind) =>
        key.split(",").includes(kind),
      ),
    [hostClient, key],
  );
  const unreadable = useSyncExternalStore(hostClient?.subscribe ?? noSubscription, read, read);
  const retry = useCallback(
    () => hostClient?.retryResources?.(key.split(",") as PersonalResourceKind[]),
    [hostClient, key],
  );
  return { unreadable, retry };
}
