import { useCallback, useSyncExternalStore } from "react";
import type { Reference } from "@opensteer/core";
import type { ReferenceState } from "../references/contracts.js";
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
