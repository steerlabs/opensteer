import { useMemo } from "react";
import type { TabKind, PlaceEnteredEventView } from "@opensteer/core";
import { computerAppIdentityKey } from "@opensteer/protocol";
import type { HostClient } from "../host/client.js";
import { runPlaceActing } from "../host/run-page.js";
import { runPlacePictureSession } from "../host/run-place.js";
import type { TabDestination } from "../host/surfaces.js";
import { useHostSelector } from "./use-host-snapshot.js";
import { usePlaceActivity, useRunPlace, useRunPlaceBinding } from "./use-places.js";
import { useTab } from "./use-tabs.js";

export interface RunPlaceView {
  readonly placeKey: string;
  readonly destination: TabDestination | null;
  readonly binding?: TabDestination | null;
  /** The Run's session at a window or phone, whose picture the tile shows. */
  readonly sessionId?: string | null;
  /** The page session this device's view of a page tab is bound to. */
  readonly pageSession?: string | null;
  /** The computer of a window or phone, and a window's app key in the Run's session. */
  readonly machineId?: string | null;
  readonly appKey?: string | null;
  readonly title: string;
  readonly site: string | null;
  readonly kind: TabKind;
}

/** A conversation's Run place as both of its pictures show it, with whether its agent acts there now. */
export function useRunPlaceView(
  hostClient: HostClient,
  runId: string | null,
  threadId: string,
): {
  readonly acting: boolean;
  readonly entry: PlaceEnteredEventView | null;
  readonly place: RunPlaceView | null;
} {
  const entry = useRunPlace(hostClient, runId);
  const { destination, binding, sessionId } = useRunPlaceBinding(hostClient, entry);
  const tabId = entry?.data.tabId ?? null;
  const tab = useTab(hostClient, tabId);
  const activity = usePlaceActivity(hostClient, tabId ?? "");
  const acting = useHostSelector(hostClient, (snapshot) =>
    entry === null ? false : runPlaceActing(entry, snapshot, activity, threadId),
  );
  const pageSession = useHostSelector(hostClient, () => {
    const viewer = tabId === null ? null : hostClient.tabViewer(tabId);
    return viewer?.kind === "page" ? viewer.sessionId : null;
  });
  const appKey =
    tab?.kind === "window" && tab.bundleId
      ? computerAppIdentityKey({
          bundleId: tab.bundleId,
          displayName: tab.appName ?? tab.title,
          teamId: null,
        })
      : null;
  const place = useMemo<RunPlaceView | null>(
    () =>
      entry === null
        ? null
        : {
            placeKey: entry.data.tabId,
            destination,
            binding,
            sessionId: runPlacePictureSession(tab?.kind, sessionId, entry.runId, activity),
            pageSession,
            machineId: tab?.computer.computerId ?? null,
            appKey,
            kind: tab?.kind ?? (entry.data.site === null ? "window" : "page"),
            title: entry.data.title,
            site: entry.data.site,
          },
    [activity, appKey, binding, destination, entry, pageSession, sessionId, tab],
  );
  return { acting, entry, place };
}
