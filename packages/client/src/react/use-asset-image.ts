import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { AttachmentIdSchema } from "@opensteer/core";
import type { HostClient } from "../host/client.js";
import type { AssetVariant, AssetSource } from "@opensteer/protocol";
import type { AssetImage } from "../host/asset-urls.js";

export const TranscriptImageContext = createContext<{
  client: HostClient;
  threadId: string | null;
  enabled?: boolean;
} | null>(null);
export function useTranscriptImages(): boolean {
  return useContext(TranscriptImageContext)?.client.getSnapshot().agentImagesAvailable === true;
}
export function useAssetImage(
  source: AssetSource | string,
  variant: AssetVariant = "preview",
  options: { readonly enabled?: boolean } = {},
) {
  const context = useContext(TranscriptImageContext);
  const client = context?.client;
  const threadId = context?.threadId ?? null;
  const subscribeOwner = useCallback(
    (listener: () => void) => client?.subscribe(listener) ?? (() => {}),
    [client],
  );
  const readOwner = useCallback(() => {
    const snapshot = client?.getSnapshot();
    return JSON.stringify([
      snapshot?.deploymentId,
      snapshot?.user?.id,
      snapshot?.sessionId,
      snapshot?.session,
      snapshot?.agentImagesAvailable,
    ]);
  }, [client]);
  const owner = useSyncExternalStore(subscribeOwner, readOwner, readOwner);
  const snapshot = client?.getSnapshot();
  const deploymentId =
    snapshot?.agentImagesAvailable === true && snapshot.session === "authenticated"
      ? snapshot.deploymentId
      : null;
  const store = client?.assetUrls;
  const enabled = options.enabled !== false && context?.enabled !== false;
  const kind = typeof source === "string" ? "path" : source.kind;
  const identity =
    typeof source === "string"
      ? source
      : source.kind === "path"
        ? source.path
        : source.kind === "transcript-image"
          ? source.imageId
          : source.attachmentId;
  const fileSource = useMemo<AssetSource>(
    () =>
      kind === "path"
        ? { kind, path: identity }
        : kind === "transcript-image"
          ? { kind, imageId: identity }
          : { kind, attachmentId: AttachmentIdSchema.parse(identity) },
    [kind, identity],
  );
  const stateKey = JSON.stringify([owner, threadId, kind, identity, variant, enabled]);
  const [state, setState] = useState<{
    key: string;
    image: AssetImage | null;
    failed: boolean;
    updateRequired: boolean;
  }>({
    key: stateKey,
    image: null,
    failed: false,
    updateRequired: false,
  });
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const current = new AbortController();
    controller.current = current;
    let generation = 0;
    const load = () => {
      const version = ++generation;
      if (enabled && store && deploymentId)
        void store
          .imageResult(deploymentId, threadId, fileSource, variant, { signal: current.signal })
          .then(
            (result) => {
              const image = result.status === "ok" ? result : null;
              const updateRequired =
                result.status === "unavailable" && result.updateRequired === true;
              if (!current.signal.aborted && version === generation)
                setState((previous) =>
                  previous.key === stateKey &&
                  previous.image?.source === image?.source &&
                  previous.failed === (image === null) &&
                  previous.updateRequired === updateRequired
                    ? previous
                    : { key: stateKey, image, failed: image === null, updateRequired },
                );
            },
            () => {
              if (!current.signal.aborted && version === generation)
                setState({ key: stateKey, image: null, failed: true, updateRequired: false });
            },
          );
    };
    setState({ key: stateKey, image: null, failed: false, updateRequired: false });
    const release =
      enabled && store && deploymentId
        ? store.subscribeImage(deploymentId, threadId, fileSource, variant, load)
        : undefined;
    load();
    if (enabled && store && deploymentId)
      store.confirm(deploymentId, threadId, fileSource, variant, { signal: current.signal });
    return () => {
      current.abort();
      release?.();
    };
  }, [store, deploymentId, threadId, fileSource, variant, enabled, stateKey]);
  const [retry, setRetry] = useState(0);
  return {
    retry,
    image: state.key === stateKey ? state.image : null,
    failed: state.key === stateKey && state.failed,
    updateRequired: state.key === stateKey && state.updateRequired,
    available: !!(deploymentId && store),
    deploymentId,
    onError: () => {
      const current = controller.current;
      if (enabled && store && deploymentId && current && !current.signal.aborted)
        void store
          .loadFailed(deploymentId, threadId, fileSource, variant, { signal: current.signal })
          .then((retried) => {
            if (current.signal.aborted) return;
            if (!retried)
              setState({ key: stateKey, image: null, failed: true, updateRequired: false });
            else setRetry((value) => value + 1);
          });
    },
  };
}
