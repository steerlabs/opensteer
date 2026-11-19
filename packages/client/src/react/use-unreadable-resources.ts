import type { PersonalResourceKind } from "@opensteer/protocol/resources";
import { useCallback, useSyncExternalStore } from "react";
import type { HostClient } from "../host/client.js";

const noSubscription = () => () => undefined;

/**
 * Whether a screen's resource kinds could not be read (refused, malformed, or past the runaway
 * ceiling), whether a complete inventory of them is still held, and Try again. With one held the
 * screen keeps it on screen with its controls, so the person can remove what is too large, and
 * says above it that it could not be refreshed; with none held it says only that.
 */
export function useUnreadableResources(
  hostClient: HostClient | null,
  kinds: readonly PersonalResourceKind[],
): { readonly unreadable: boolean; readonly held: boolean; readonly retry: () => void } {
  const key = kinds.join(",");
  const read = useCallback(() => {
    const snapshot = hostClient?.getSnapshot();
    const wanted = key.split(",");
    const unreadable = (snapshot?.unreadableResources ?? []).some((kind) => wanted.includes(kind));
    const held = wanted.every((kind) =>
      snapshot?.loadedResources.includes(kind as PersonalResourceKind),
    );
    return unreadable ? (held ? "held" : "none") : "readable";
  }, [hostClient, key]);
  const state = useSyncExternalStore(hostClient?.subscribe ?? noSubscription, read, read);
  const retry = useCallback(
    () => hostClient?.retryResources?.(key.split(",") as PersonalResourceKind[]),
    [hostClient, key],
  );
  return { unreadable: state !== "readable", held: state === "held", retry };
}
