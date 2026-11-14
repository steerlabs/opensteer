import { createContext, useContext, useEffect, useState } from "react";
import type { HostClient } from "../host/client.js";
import type { AssetVariant } from "@opensteer/protocol";
import type { AssetImage } from "../host/asset-urls.js";

export const TranscriptImageContext = createContext<{
  client: HostClient;
  threadId: string;
} | null>(null);
export function useAssetImage(path: string, variant: AssetVariant = "preview") {
  const context = useContext(TranscriptImageContext);
  const client = context?.client;
  const threadId = context?.threadId;
  const snapshot = client?.getSnapshot();
  const deploymentId =
    snapshot?.deploymentShape?.kind === "personal" ? snapshot.deploymentId : null;
  const store = client?.assetUrls;
  const [state, setState] = useState<{ image: AssetImage | null; failed: boolean }>({
    image: null,
    failed: false,
  });
  useEffect(() => {
    let alive = true;
    let generation = 0;
    const load = () => {
      const current = ++generation;
      if (store && deploymentId && threadId)
        void store.image(deploymentId, threadId, path, variant).then(
          (image) => {
            if (alive && current === generation)
              setState((previous) =>
                previous.image?.source === image?.source && previous.failed === (image === null)
                  ? previous
                  : { image, failed: image === null },
              );
          },
          () => {
            if (alive && current === generation) setState({ image: null, failed: true });
          },
        );
    };
    setState({ image: null, failed: false });
    load();
    const release = store?.subscribe(load);
    return () => {
      alive = false;
      release?.();
    };
  }, [store, deploymentId, threadId, path, variant]);
  const [retry, setRetry] = useState(0);
  return {
    retry,
    ...state,
    available: !!(deploymentId && threadId && store),
    deploymentId,
    onError: () => {
      if (store && deploymentId && threadId)
        void store.loadFailed(deploymentId, threadId, path, variant).then((retried) => {
          if (!retried) setState({ image: null, failed: true });
          else setRetry((value) => value + 1);
        });
    },
  };
}
