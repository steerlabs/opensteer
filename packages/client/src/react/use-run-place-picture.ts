import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { HostClient } from "../host/client.js";
import {
  attachRunPlaceDisplay,
  retainRunPlacePicture,
  runPlaceDisplayTarget,
  runPlacePicture,
  subscribeRunPlacePicture,
  type RunPlaceDisplay,
} from "../host/run-place-picture.js";

export function useRunPlacePicture(
  client: HostClient,
  threadId: string,
  runId: string | null,
  visible: boolean,
  displayCapable: boolean,
) {
  const subscribe = useCallback(
    (listener: () => void) => subscribeRunPlacePicture(client, threadId, listener),
    [client, threadId],
  );
  const get = useCallback(
    () => runPlacePicture(client, threadId, runId),
    [client, threadId, runId],
  );
  const picture = useSyncExternalStore(subscribe, get, get);
  useEffect(
    () => (visible ? retainRunPlacePicture(client, threadId, runId, displayCapable) : undefined),
    [client, threadId, runId, visible, displayCapable],
  );
  return picture;
}

export function useRunPlaceDisplay(client: HostClient, threadId: string, placeKey: string | null) {
  const subscribe = useCallback(
    (listener: () => void) => subscribeRunPlacePicture(client, threadId, listener),
    [client, threadId],
  );
  const get = useCallback(() => runPlaceDisplayTarget(client, threadId), [client, threadId]);
  const target = useSyncExternalStore(subscribe, get, get);
  const [held, setHeld] = useState<{
    readonly client: HostClient;
    readonly threadId: string;
    readonly placeKey: string;
    readonly target: typeof target;
    readonly display: RunPlaceDisplay;
  } | null>(null);
  useEffect(() => {
    const display = placeKey === null ? null : attachRunPlaceDisplay(client, threadId, placeKey);
    if (!display || placeKey === null) return;
    setHeld({ client, threadId, placeKey, target, display });
    return display.release;
  }, [client, threadId, placeKey, target]);
  return held?.client === client &&
    held.threadId === threadId &&
    held.placeKey === placeKey &&
    held.target === target
    ? held.display
    : null;
}
