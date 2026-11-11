import { useCallback, useMemo, useRef, type CSSProperties } from "react";
import {
  profileBadgesVisible,
  type HostClient,
  type PlaceBrowserIdentity,
  type PlaceItem,
} from "@opensteer/client/host";
import { readPlaceIndex, useHostSelector } from "@opensteer/client/react";

/**
 * Who a page browses as, drawn: a profile's initial in its tinted disc, or
 * Guest's empty dashed ring. A lettered disc denotes a person; task marks are the
 * agents in a place — and it always stands beside words that say the same.
 */
export function ProfileAvatar({
  identity,
  size,
}: {
  readonly identity: PlaceBrowserIdentity;
  readonly size: 14 | 16 | 18 | 26;
}) {
  if (identity.kind === "guest")
    return (
      <svg aria-hidden className={`pavatar pavatar--guest pavatar--${size}`} viewBox="0 0 14 14">
        <circle className="pavatar__ground" cx="7" cy="7" r="6.4" />
        {/* r 5.6 is 35.2 around: eight even dashes of 2.4 and gaps of 2. */}
        <circle className="pavatar__ring" cx="7" cy="7" r="5.6" />
      </svg>
    );
  return (
    <span
      aria-hidden
      className={`pavatar pavatar--${size}`}
      style={{ "--pavatar-tint": identity.tint } as CSSProperties}
    >
      {identity.initial}
    </span>
  );
}

/** A tab's browsing identity and the computer where it runs. */
export interface BrowserPresentation {
  readonly identity: PlaceBrowserIdentity;
  readonly computer: string;
  readonly computerId: string;
}

export interface BrowserPresentations {
  /** Internal lookup keys; only the profile and computer words are shown. */
  readonly bySession: ReadonlyMap<string, BrowserPresentation>;
  /** Two or more identities are in use: site icons wear profile badges. */
  readonly badges: boolean;
}

/** Each listed tab's profile and computer. */
export function browserPresentations(places: readonly PlaceItem[]): BrowserPresentations {
  const bySession = new Map<string, BrowserPresentation>();
  for (const place of places) {
    if (
      !place.browser ||
      !place.identity ||
      !place.device ||
      bySession.has(place.browser.sessionId)
    )
      continue;
    bySession.set(place.browser.sessionId, {
      identity: place.identity,
      computer: place.device.name,
      computerId: place.device.machineId,
    });
  }
  return { bySession, badges: profileBadgesVisible(places) };
}

export function useBrowserPresentations(places: readonly PlaceItem[]): BrowserPresentations {
  const previous = useRef<BrowserPresentations | null>(null);
  return useMemo(() => {
    previous.current = keptPresentations(previous.current, browserPresentations(places));
    return previous.current;
  }, [places]);
}

/**
 * Every listed tab's presentation, read beside a list that arranges slots:
 * a tab's title or loading changes none of it, so the list does not render.
 */
export function useListedBrowserPresentations(hostClient: HostClient): BrowserPresentations {
  const previous = useRef<BrowserPresentations | null>(null);
  const select = useCallback(() => {
    previous.current = keptPresentations(
      previous.current,
      browserPresentations(readPlaceIndex(hostClient).items),
    );
    return previous.current;
  }, [hostClient]);
  return useHostSelector(hostClient, select);
}

/** Unchanged words keep their objects, so their rows do not re-render. */
function keptPresentations(
  held: BrowserPresentations | null,
  next: BrowserPresentations,
): BrowserPresentations {
  if (!held) return next;
  let changed = held.badges !== next.badges || held.bySession.size !== next.bySession.size;
  const bySession = new Map<string, BrowserPresentation>();
  for (const [sessionId, presentation] of next.bySession) {
    const before = held.bySession.get(sessionId);
    const kept =
      before && JSON.stringify(before) === JSON.stringify(presentation) ? before : presentation;
    if (kept !== before) changed = true;
    bySession.set(sessionId, kept);
  }
  return changed ? { badges: next.badges, bySession } : held;
}

/**
 * The destination in words, for names and tooltips: "Personal · Mac mini". A
 * reader who says where they are hears the computer only when it is elsewhere.
 */
export function browserWords(presentation: BrowserPresentation, hereId?: string | null): string {
  return presentation.computerId === hereId
    ? presentation.identity.name
    : `${presentation.identity.name} · ${presentation.computer}`;
}
