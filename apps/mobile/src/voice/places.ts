import { browserPagePart, placeList, type HostClient } from "@opensteer/client/host";
import type { PlaceContentPart } from "@opensteer/core";
import { paramsDestination } from "../browser/surface-route.js";

const nothing = () => Promise.resolve([]);

/**
 * What a spoken message carries about the page that was in front when it was
 * heard, fixed then: that tab, and only while it still shows the same
 * document when read. A later screen never stands in for it.
 */
export function heardPlaces(
  hostClient: HostClient,
  route: { readonly name: string; readonly params?: object | undefined } | undefined,
): () => Promise<readonly PlaceContentPart[]> {
  if (route?.name !== "WorkspaceBrowser") return nothing;
  const destination = paramsDestination(route.params);
  if (destination?.kind !== "browser") return nothing;
  const place = placeList(hostClient.getSnapshot()).find(
    (item) =>
      item.destination.kind === "browser" &&
      item.destination.sessionId === destination.sessionId &&
      item.destination.tabId === destination.tabId,
  );
  const documentId = place?.availability === "ready" ? place.browser?.documentId : null;
  if (!documentId) return nothing;
  return async () => {
    const candidate = await hostClient.readBrowserContextCandidate(
      destination.sessionId,
      destination.tabId,
    );
    return candidate.documentId === documentId && /^https?:\/\//iu.test(candidate.url)
      ? [browserPagePart({ auto: true, ...candidate })]
      : [];
  };
}
