import { memo } from "react";
import { type HostClient, type PlaceItem } from "@opensteer/client/host";
import { useTabIcon } from "@opensteer/client/react";
import { AppMark } from "../computer-apps/computer-use-section.js";
import { Icon } from "../icon.js";
import { SiteMark } from "../site-mark.js";

/**
 * A place's mark at 16px: the site's own icon, the app's mark, or the phone
 * or published app's glyph. Site icons are read once per session and reference, on demand,
 * and kept: a row scrolled away and back shows its icon at once.
 */
export const PlaceMark = memo(function PlaceMark({
  hostClient,
  icon,
}: {
  readonly hostClient: HostClient;
  readonly icon: PlaceItem["icon"];
}) {
  if (icon.kind === "opensteer-app") {
    return (
      <span aria-hidden className="place-mark place-mark--glyph">
        <Icon name="app" />
      </span>
    );
  }
  if (icon.kind === "app") {
    return (
      <span aria-hidden className="place-mark">
        <AppMark
          identity={{ bundleId: icon.bundleId, displayName: icon.name, teamId: null }}
          machineId={icon.machineId}
        />
      </span>
    );
  }
  if (icon.kind === "phone") {
    return (
      <span aria-hidden className="place-mark place-mark--glyph">
        <Icon name="phone" />
      </span>
    );
  }
  return (
    <span aria-hidden className="place-mark">
      <SiteIcon hostClient={hostClient} iconRef={icon.ref} tabId={icon.tabId ?? null} />
    </span>
  );
});

function SiteIcon({
  hostClient,
  iconRef,
  tabId,
}: {
  readonly hostClient: HostClient;
  readonly iconRef: string | null;
  readonly tabId: string | null;
}) {
  return <SiteMark favicon={useTabIcon(hostClient, tabId, iconRef)} />;
}
