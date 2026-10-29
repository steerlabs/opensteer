import { useMemo, useRef, type CSSProperties } from "react";
import {
  profileBadgesVisible,
  type PlaceBrowserIdentity,
  type PlaceItem,
} from "@opensteer/client/host";

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
  readonly machineId: string;
  /**
   * The computer is named: this identity browses on several computers, or,
   * where this Mac is known, not on it.
   */
  readonly remote: boolean;
}

export interface BrowserPresentations {
  /** Internal lookup keys; only the profile and computer words are shown. */
  readonly bySession: ReadonlyMap<string, BrowserPresentation>;
  /** Two or more identities are in use: site icons wear profile badges. */
  readonly badges: boolean;
}

function identityKey(identity: PlaceBrowserIdentity): string {
  return identity.kind === "guest" ? "guest" : `profile:${identity.profileId}`;
}

/** Each listed tab's profile and computer, with computer words where they tell apart. */
export function browserPresentations(
  places: readonly PlaceItem[],
  localMachineId: string | null,
): BrowserPresentations {
  const sessions: {
    readonly sessionId: string;
    readonly identity: PlaceBrowserIdentity;
    readonly device: NonNullable<PlaceItem["device"]>;
  }[] = [];
  const seen = new Set<string>();
  for (const place of places) {
    if (!place.browser || !place.identity || !place.device || seen.has(place.browser.sessionId))
      continue;
    seen.add(place.browser.sessionId);
    sessions.push({
      sessionId: place.browser.sessionId,
      identity: place.identity,
      device: place.device,
    });
  }
  // The computer distinguishes tabs of one identity only when they run on different machines.
  const computers = new Map<string, Set<string>>();
  for (const session of sessions) {
    const key = identityKey(session.identity);
    computers.set(key, (computers.get(key) ?? new Set()).add(session.device.machineId));
  }
  const bySession = new Map<string, BrowserPresentation>();
  for (const session of sessions) {
    bySession.set(session.sessionId, {
      identity: session.identity,
      computer: session.device.name,
      machineId: session.device.machineId,
      remote:
        (computers.get(identityKey(session.identity))?.size ?? 0) > 1 ||
        (localMachineId !== null && session.device.machineId !== localMachineId),
    });
  }
  return { bySession, badges: profileBadgesVisible(places) };
}

export function useBrowserPresentations(
  places: readonly PlaceItem[],
  localMachineId: string | null,
): BrowserPresentations {
  // Unchanged words keep their objects, so their rows do not re-render.
  const previous = useRef<BrowserPresentations | null>(null);
  return useMemo(() => {
    const next = browserPresentations(places, localMachineId);
    const held = previous.current;
    if (held) {
      const bySession = new Map<string, BrowserPresentation>();
      for (const [sessionId, presentation] of next.bySession) {
        const before = held.bySession.get(sessionId);
        bySession.set(
          sessionId,
          before && JSON.stringify(before) === JSON.stringify(presentation) ? before : presentation,
        );
      }
      previous.current = { badges: next.badges, bySession };
    } else previous.current = next;
    return previous.current;
  }, [places, localMachineId]);
}

/** The chip names the identity, with its computer only where it tells apart. */
export function chipWords(presentation: BrowserPresentation): {
  readonly name: string;
  readonly suffix: string | null;
} {
  return {
    name: presentation.identity.name,
    suffix: presentation.remote ? presentation.computer : null,
  };
}

/** The destination in words, for names and tooltips: "Personal · Mac mini". */
export function browserWords(presentation: BrowserPresentation): string {
  return `${presentation.identity.name} · ${presentation.computer}`;
}

/** What Guest means, said once wherever it is chosen or worn. */
export const guestDetail = "Starts without saved sign-ins. Tabs reopen; sign-ins aren’t saved.";
