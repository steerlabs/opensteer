import { useCallback, useEffect, useRef, useState } from "react";
import { unwrapRpcResult, type HostClient } from "@opensteer/client/host";
import type { BrowserSourceInspection } from "@opensteer/protocol/browser-sources";
import { actionErrorMessage } from "../../ui-utils.js";

const everyMs = 4_000;

/**
 * What each connected Chrome has for one site, kept current while the page is
 * visible: a person fixing something in Chrome sees this screen follow along
 * without pressing anything.
 */
export function useChromeInspection(
  client: Pick<HostClient, "rpc">,
  url: string | null,
  live: boolean,
): {
  readonly error: string | null;
  readonly inspection: BrowserSourceInspection | null;
  readonly refresh: () => void;
} {
  const [inspection, setInspection] = useState<BrowserSourceInspection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const refresh = useCallback(() => {
    if (!url) return;
    const current = ++generation.current;
    void client.rpc["browser.sources.inspect"]({ url })
      .then(unwrapRpcResult)
      .then((result) => {
        if (current !== generation.current) return;
        setInspection(result);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (current === generation.current) setError(actionErrorMessage(reason));
      });
  }, [client, url]);

  useEffect(() => {
    setInspection(null);
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!live || !url) return;
    let timer: number | undefined;
    const schedule = () => {
      window.clearInterval(timer);
      if (document.visibilityState === "visible") timer = window.setInterval(refresh, everyMs);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
      schedule();
    };
    schedule();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [live, refresh, url]);

  return { error, inspection, refresh };
}
