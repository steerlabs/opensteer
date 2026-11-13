import { useEffect, useRef, useState } from "react";
import type {
  DeploymentAccessDeployment,
  OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";
import { readComputerFacts, type ComputerFacts } from "./computer-facts.js";

/**
 * What each personal Opensteer listed here says about itself, read again when
 * the window regains focus. One that can't be reached keeps what it said last.
 */
export function useComputerFacts(
  bridge: OpensteerDesktopBridge,
  computers: readonly DeploymentAccessDeployment[],
): ReadonlyMap<string, ComputerFacts> {
  const [facts, setFacts] = useState<ReadonlyMap<string, ComputerFacts>>(new Map());
  const latest = useRef(computers);
  latest.current = computers;
  const computerKey = computers
    .map((row) => `${row.id}:${row.canonicalOrigin}`)
    .sort()
    .join(",");
  useEffect(() => {
    let generation = 0;
    const refresh = () => {
      const current = ++generation;
      void Promise.allSettled(
        latest.current.map(
          async (computer) => [computer.id, await readComputerFacts(bridge, computer)] as const,
        ),
      ).then((results) => {
        if (current !== generation) return;
        setFacts((held) => {
          const next = new Map(held);
          for (const result of results)
            if (result.status === "fulfilled") next.set(...result.value);
          return next;
        });
      });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      generation++;
      window.removeEventListener("focus", refresh);
    };
  }, [bridge, computerKey]);
  return facts;
}
