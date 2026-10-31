import { useEffect, useMemo, useRef } from "react";
import { placeList, threadInDirectory, type HostClient } from "@opensteer/client/host";
import {
  listedScreenSurface,
  preparedPresentation,
  type ScreenPresentationPort,
  type ScreenPresentationReceipt,
  type ScreenShowTarget,
} from "@opensteer/client/screen";
import { heardPlaceParts } from "./composer-context.js";
import { interactionBusy, interactionRevision, observeInteraction } from "./interaction.js";
import {
  destinationPlaceKey,
  isSettingsPath,
  placeSelection,
  type WorkspaceNavigation,
} from "./navigation.js";

const busy: ScreenPresentationReceipt = { outcome: "superseded", reason: "busy" };
const closed: ScreenPresentationReceipt = { outcome: "unavailable", reason: "closed" };

/** The runtime's presentation port, reading the navigation as it is whenever it is asked. */
export function useScreenPresentation(
  hostClient: HostClient,
  nav: WorkspaceNavigation,
): ScreenPresentationPort {
  const latest = useRef(nav);
  latest.current = nav;
  useEffect(() => observeInteraction(), []);
  return useMemo(() => webScreenPresentation(hostClient, () => latest.current), [hostClient]);
}

/**
 * Shows what an agent asked to show through the same address the person's own
 * choices write: the conversation, the place in the middle, or both as one
 * history entry. Nothing here opens, focuses or starts anything, and the route
 * changes only in `commitIfCurrent`.
 */
export function webScreenPresentation(
  hostClient: HostClient,
  nav: () => WorkspaceNavigation,
): ScreenPresentationPort {
  const blocked = () =>
    isSettingsPath(nav().address().pathname) || interactionBusy() ? busy : null;
  const resolve = (target: ScreenShowTarget) => {
    const snapshot = hostClient.getSnapshot();
    const { conversationId, surface } = target;
    if (
      conversationId !== undefined &&
      conversationId !== snapshot.homeThreadId &&
      !threadInDirectory(conversationId, snapshot)
    )
      return null;
    const place = surface ? listedScreenSurface(placeList(snapshot), surface) : null;
    if (surface && !place) return null;
    return {
      ...(conversationId === undefined ? {} : { path: nav().threadPath(conversationId) }),
      ...(place ? { place: place.destination } : {}),
    };
  };
  return {
    capture() {
      const revision = interactionRevision();
      const { pathname, search } = nav().address();
      const snapshot = hostClient.getSnapshot();
      const threadId = /^\/threads\/([^/]+)$/u.exec(pathname)?.[1];
      const currentThreadId = threadId === undefined ? undefined : decodeURIComponent(threadId);
      const selection = placeSelection(new URLSearchParams(search));
      const key = selection.kind === "place" ? destinationPlaceKey(selection.destination) : null;
      const place = key ? (placeList(snapshot).find((item) => item.key === key) ?? null) : null;
      return {
        interactionRevision: revision,
        ...(currentThreadId === undefined || currentThreadId === snapshot.homeThreadId
          ? {}
          : { currentThreadId }),
        places: heardPlaceParts(hostClient, place),
      };
    },
    blocked,
    async prepare(target, signal) {
      signal.throwIfAborted();
      let route: ReturnType<typeof resolve> = null;
      return preparedPresentation({
        signal,
        refusal: () => {
          const refused = blocked();
          if (refused) return refused;
          route = resolve(target);
          return route ? null : closed;
        },
        commit: () => {
          nav().present(route!);
          // The router holds the new entry once the call returns: that is the route commit.
          return Promise.resolve({ outcome: "applied" });
        },
      });
    },
  };
}
