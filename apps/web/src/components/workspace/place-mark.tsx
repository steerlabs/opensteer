import { memo, useEffect, useState } from "react";
import {
  browserSiteLabel,
  type HostClient,
  type HostSnapshot,
  type PlaceItem,
} from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import { AppMark } from "../computer-apps/computer-use-section.js";
import { Icon } from "../icon.js";
import { SiteMark } from "../site-mark.js";

/**
 * A place's mark at 16px: the site's own icon, the app's mark, or the phone
 * glyph. Site icons are read once per session and reference, on demand.
 */
export const PlaceMark = memo(function PlaceMark({
  hostClient,
  icon,
  site,
}: {
  readonly hostClient: HostClient;
  readonly icon: PlaceItem["icon"];
  readonly site: string | null;
}) {
  if (icon.kind === "app") {
    return (
      <span aria-hidden className="place-mark">
        <AppMark identity={icon.app} machineId={icon.machineId} />
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
      <SiteIcon hostClient={hostClient} iconRef={icon.ref} sessionId={icon.sessionId} site={site} />
    </span>
  );
});

const iconCaches = new WeakMap<HostClient, Map<string, Promise<string | null>>>();
const selectConnection = (snapshot: HostSnapshot) => snapshot.connection;

function readIcon(hostClient: HostClient, sessionId: string, iconRef: string) {
  const key = `${sessionId}\u0000${iconRef}`;
  let iconCache = iconCaches.get(hostClient);
  if (!iconCache) {
    iconCache = new Map();
    iconCaches.set(hostClient, iconCache);
  }
  let read = iconCache.get(key);
  if (!read) {
    const cache = iconCache;
    read = hostClient
      .readBrowserTabIcon(sessionId, iconRef)
      .catch(() => null)
      .then((src) => {
        // A lost connection or a catalog race says nothing about immutable icon
        // content. Keep successful reads and share work, but let misses recover.
        if (!src && cache.get(key) === read) cache.delete(key);
        return src;
      });
    iconCache.set(key, read);
    // The cache is a courtesy for one screen, not a store: it never outgrows the sidebar.
    if (iconCache.size > 256) iconCache.delete(iconCache.keys().next().value ?? key);
  }
  return read;
}

function SiteIcon({
  hostClient,
  iconRef,
  sessionId,
  site,
}: {
  readonly hostClient: HostClient;
  readonly iconRef: string | null;
  readonly sessionId: string;
  readonly site: string | null;
}) {
  const connection = useHostSelector(hostClient, selectConnection);
  const [favicon, setFavicon] = useState<{
    readonly hostClient: HostClient;
    readonly key: string;
    readonly src: string;
  } | null>(null);
  const key = iconRef ? `${sessionId}:${iconRef}` : null;
  useEffect(() => {
    if (!iconRef || connection !== "connected") return;
    let current = true;
    let timer: number | undefined;
    const read = (attempt: number) => {
      void readIcon(hostClient, sessionId, iconRef).then((src) => {
        if (!current) return;
        if (!src) {
          const delay = [250, 1_000][attempt];
          if (delay !== undefined) timer = window.setTimeout(() => read(attempt + 1), delay);
          return;
        }
        // A placeholder pixel is not an icon; the letter mark reads better than a dot.
        const probe = new Image();
        probe.onload = () => {
          if (current && probe.naturalWidth >= 8)
            setFavicon({ hostClient, key: `${sessionId}:${iconRef}`, src });
        };
        probe.src = src;
      });
    };
    read(0);
    return () => {
      current = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [connection, hostClient, iconRef, sessionId]);
  return (
    <SiteMark
      favicon={favicon?.hostClient === hostClient && favicon.key === key ? favicon.src : null}
      site={site ? browserSiteLabel(site) : null}
    />
  );
}

/** A Mac's outline, after an app's name: muted, named for the reader by its tooltip. */
export function DeviceGlyph({ name }: { readonly name: string }) {
  return (
    <span aria-label={name} className="device-glyph" role="img" title={name}>
      <Icon name="laptop" />
    </span>
  );
}
