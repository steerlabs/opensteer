import { browserPagePart, type HostClient } from "@opensteer/client/host";
import type { PlaceContentPart } from "@opensteer/core";
import type { SurfacesRoute } from "../browser/surface-route.js";

export async function voicePlaces(
  hostClient: HostClient,
  route: { readonly name: string; readonly params?: object | undefined } | undefined,
): Promise<readonly PlaceContentPart[]> {
  if (route?.name !== "WorkspaceBrowser") return [];
  const params = route.params as SurfacesRoute | undefined;
  if (!params?.sessionId || !params.tabId) return [];
  const candidate = await hostClient.readBrowserContextCandidate(params.sessionId, params.tabId);
  return /^https?:\/\//iu.test(candidate.url)
    ? [browserPagePart({ auto: true, ...candidate })]
    : [];
}
