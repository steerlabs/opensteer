import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import type { TabId } from "@opensteer/core";
import type { HostClient, PlaceItem } from "@opensteer/client/host";
import { act, toastFailure } from "../use-action.js";
import { useToast } from "../toast.js";

/**
 * Closing removes tabs from the person's list and nothing more: it never
 * quits an app, stops a phone, stops an agent or stops a server, so it asks
 * nothing first. Nothing here changes what the middle shows: when the tab
 * there leaves the list, its neighbour takes it ([succession](./place-succession.ts)).
 */
const TabCloserContext = createContext<((tabIds: readonly TabId[]) => void) | null>(null);

function useCloseTabs(): (tabIds: readonly TabId[]) => void {
  const close = useContext(TabCloserContext);
  if (!close) throw new Error("Closing tabs is not available here.");
  return close;
}

export function useTabCloser(): (place: Pick<PlaceItem, "key">) => void {
  const close = useCloseTabs();
  return useCallback((place) => close([place.key]), [close]);
}

export function useTabGroupCloser(): (tabIds: readonly TabId[]) => void {
  return useCloseTabs();
}

export function TabCloserProvider({
  children,
  hostClient,
}: {
  readonly children: ReactNode;
  readonly hostClient: HostClient;
}) {
  const toast = useToast();
  const close = useCallback(
    (tabIds: readonly TabId[]) => {
      if (!tabIds.length) return;
      void act(
        hostClient,
        { label: "close", done: "closed", thing: tabIds.length === 1 ? "this tab" : "these tabs" },
        () => hostClient.closeTabs([...tabIds]),
      )
        .then((result) => {
          // Each tab the Host refused is said once, in the app's words.
          if (result.failed.length)
            toast.error(
              result.failed.length === 1
                ? "Couldn't close this tab."
                : `Couldn't close ${result.failed.length} tabs.`,
            );
        })
        .catch((error: unknown) => toastFailure(toast)(error));
    },
    [hostClient, toast],
  );
  const value = useMemo(() => close, [close]);
  return <TabCloserContext.Provider value={value}>{children}</TabCloserContext.Provider>;
}
