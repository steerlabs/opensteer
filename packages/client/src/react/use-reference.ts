import { useCallback, useSyncExternalStore } from "react";
import type { HostClient } from "../host/client.js";
import type { ReferenceState } from "../references/contracts.js";
import {
  tabReferenceState,
  type IdReference as Reference,
  type TabReferenceState,
} from "../references/links.js";
import type { ReferenceStore } from "../references/store.js";

const unresolved: ReferenceState = { state: "unresolved" };
export function useReference(
  client: { readonly references: ReferenceStore } | null,
  ref: Reference,
  options: { readonly enabled?: boolean } = {},
): ReferenceState {
  const store = client?.references;
  const id = ref.id;
  const enabled = options.enabled !== false;
  const subscribe = useCallback(
    (listener: () => void) => store?.subscribe(id, listener, { enabled }) ?? (() => {}),
    [store, id, enabled],
  );
  const read = useCallback(() => store?.read(id) ?? unresolved, [store, id]);
  return useSyncExternalStore(subscribe, read, read);
}

/** A tab link's tab while it is in the person's list; the list's own row changes redraw it. */
export function useTabReference(hostClient: HostClient | null, tabId: string): TabReferenceState {
  const tabs = hostClient?.getSnapshot().tabs ?? null;
  const subscribe = useCallback(
    (listener: () => void) => tabs?.subscribe(listener) ?? (() => {}),
    [tabs],
  );
  const read = useCallback(
    (): TabReferenceState => (tabs ? tabReferenceState(tabs, tabId) : unresolvedTab),
    [tabs, tabId],
  );
  return useSyncExternalStore(subscribe, read, read);
}
const unresolvedTab: TabReferenceState = { state: "unresolved" };
