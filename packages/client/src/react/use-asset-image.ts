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
import type { AssetVariant, FileSource } from "@opensteer/protocol";
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
  source: FileSource | string,
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
        : source.attachmentId;
  const fileSource = useMemo<FileSource>(
    () =>
      kind === "path"
        ? { kind, path: identity }
        : { kind, attachmentId: AttachmentIdSchema.parse(identity) },
    [kind, identity],
  );
  const stateKey = JSON.stringify([owner, threadId, kind, identity, variant, enabled]);
  const [state, setState] = useState<{ key: string; image: AssetImage | null; failed: boolean }>({
    key: stateKey,
    image: null,
    failed: false,
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
          .image(deploymentId, threadId, fileSource, variant, { signal: current.signal })
          .then(
            (image) => {
              if (!current.signal.aborted && version === generation)
                setState((previous) =>
                  previous.key === stateKey &&
                  previous.image?.source === image?.source &&
                  previous.failed === (image === null)
                    ? previous
                    : { key: stateKey, image, failed: image === null },
                );
            },
            () => {
              if (!current.signal.aborted && version === generation)
                setState({ key: stateKey, image: null, failed: true });
            },
          );
    };
    setState({ key: stateKey, image: null, failed: false });
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
    available: !!(deploymentId && store),
    deploymentId,
    onError: () => {
      const current = controller.current;
      if (enabled && store && deploymentId && current && !current.signal.aborted)
        void store
          .loadFailed(deploymentId, threadId, fileSource, variant, { signal: current.signal })
          .then((retried) => {
            if (current.signal.aborted) return;
            if (!retried) setState({ key: stateKey, image: null, failed: true });
            else setRetry((value) => value + 1);
          });
    },
  };
}
