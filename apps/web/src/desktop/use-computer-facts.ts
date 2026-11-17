import { useEffect, useRef, useSyncExternalStore } from "react";
import type { DeploymentAccessDeployment } from "@opensteer/protocol/desktop";
import { computersKey, type ComputerFacts, type ComputerFactsStore } from "./computer-facts.js";

/**
 * What each personal Opensteer listed here last said about itself, at once,
 * read again while the list is on screen and whenever the window regains focus.
 */
export function useComputerFacts(
  store: ComputerFactsStore,
  computers: readonly DeploymentAccessDeployment[],
): ReadonlyMap<string, ComputerFacts> {
  const latest = useRef(computers);
  latest.current = computers;
  const key = computersKey(computers);
  useEffect(() => {
    const refresh = () => void store.refresh(latest.current);
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [store, key]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
