import type { AgentOperationTarget } from "@opensteer/core";
import { useEffect, useSyncExternalStore } from "react";
import {
  approvedAppKey,
  approvedAppNames,
  type ApprovedAppNames,
} from "../host/approved-app-names.js";
import type { HostClient } from "../host/client.js";
import { unwrapRpcResult } from "../host/host-session-client.js";

export type ApprovedAppNamesHost = {
  readonly rpc: Pick<HostClient["rpc"], "integration.computer.apps.approved">;
};

/**
 * One client's approved Mac app names, shared by every view that shows them. It is read only
 * when a view shows a Mac app whose name it does not hold yet, never on a machine's routine
 * change: a newly approved app is named the first time it is shown. A read is a few hundred
 * bytes per approved app (names and ids; the Home sends no icons on it).
 */
class ApprovedAppNamesCache {
  names: ApprovedAppNames = new Map();
  readonly #asked = new Set<string>();
  readonly #listeners = new Set<() => void>();
  #reading: Promise<void> | null = null;
  #again = false;
  readonly #client: ApprovedAppNamesHost;

  constructor(client: ApprovedAppNamesHost) {
    this.#client = client;
  }

  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Whether a name for this key is held, or was asked for and is not approved. */
  known(key: string): boolean {
    return this.names.has(key) || this.#asked.has(key);
  }

  ask(keys: readonly string[]): void {
    const fresh = keys.filter((key) => !this.known(key));
    if (!fresh.length) return;
    for (const key of fresh) this.#asked.add(key);
    if (this.#reading) {
      this.#again = true;
      return;
    }
    this.#reading = this.#read().finally(() => {
      this.#reading = null;
    });
  }

  async #read(): Promise<void> {
    do {
      this.#again = false;
      try {
        const { apps } = unwrapRpcResult(
          await this.#client.rpc["integration.computer.apps.approved"]({}),
        );
        this.names = approvedAppNames(apps);
        for (const listener of this.#listeners) listener();
      } catch {
        // The names stay as they were; a Mac app not yet named shows its trusted name.
      }
    } while (this.#again);
  }
}

const caches = new WeakMap<ApprovedAppNamesHost, ApprovedAppNamesCache>();
function cacheFor(client: ApprovedAppNamesHost): ApprovedAppNamesCache {
  let cache = caches.get(client);
  if (!cache) caches.set(client, (cache = new ApprovedAppNamesCache(client)));
  return cache;
}
const noSubscription = () => () => {};

/**
 * The names of the Mac apps the person approved (`approvedAppNames`), for the targets a view
 * shows. For display only: what an agent reads keeps its own names.
 */
export function useApprovedAppNames(
  client: ApprovedAppNamesHost | null,
  targets: readonly Pick<AgentOperationTarget, "grant">[],
): ApprovedAppNames | null {
  const cache = client ? cacheFor(client) : null;
  const names = useSyncExternalStore(
    cache ? cache.subscribe : noSubscription,
    () => cache?.names ?? null,
  );
  const missing = [
    ...new Set(
      targets.flatMap((target) => {
        const key = approvedAppKey(target);
        return key && !cache?.known(key) ? [key] : [];
      }),
    ),
  ]
    .sort()
    .join("\0");
  useEffect(() => {
    if (cache && missing) cache.ask(missing.split("\0"));
  }, [cache, missing]);
  return names;
}
