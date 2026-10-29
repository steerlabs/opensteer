import { useCallback, useMemo } from "react";
import {
  mutationIdempotencyKey,
  parseNavigationInput,
  sameIdentity,
  startPageIndex,
  type HostClient,
  type HostSnapshot,
  type PlaceItem,
  type StartPageProfileChoice,
} from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import { actionErrorMessage } from "../../ui-utils.js";
import { browserTargetViewport } from "../browser/browser-viewport.js";
import { SurfaceSubmenuRow } from "../surface-submenu-row.js";
import { useToast } from "../toast.js";
import { ProfileAvatar, type BrowserPresentation } from "./identity.js";
import { useWorkspace } from "./workspace-context.js";

const selectProfiles = (snapshot: HostSnapshot) => snapshot;
function sameProfiles(left: HostSnapshot, right: HostSnapshot): boolean {
  return (
    left.browserSessions === right.browserSessions &&
    left.browserProfiles === right.browserProfiles &&
    left.browserPlacements === right.browserPlacements &&
    left.connection === right.connection &&
    left.homeWorkspaceId === right.homeWorkspaceId &&
    left.machines === right.machines
  );
}

/**
 * Opens a copy of this exact page in the person's own browser for another
 * identity: the address read from the page now, never its site, never a
 * blank page in its place. The original tab, its history, form, cookies and
 * agent stay where they are.
 */
export function useOpenPageIn(hostClient: HostClient) {
  const { nav, phone } = useWorkspace();
  const toast = useToast();
  return useCallback(
    (place: PlaceItem, profile: StartPageProfileChoice) => {
      if (place.destination.kind !== "browser" || !place.destination.tabId) return;
      const { sessionId, tabId } = place.destination;
      const show = nav.beginPlaceOperation();
      const epoch = hostClient.recentSites.epoch;
      const stage = document.querySelector(".place .browser-stage");
      const viewport = browserTargetViewport(stage?.getBoundingClientRect() ?? null, phone);
      void hostClient
        .readBrowserContextCandidate(sessionId, tabId)
        .then((candidate) => {
          // Only a full web address read from the page itself is copied.
          const parsed = /^https?:\/\//iu.test(candidate.url)
            ? parseNavigationInput(candidate.url)
            : null;
          if (parsed?.kind !== "url")
            throw new Error("This page’s address can’t be opened in another profile.");
          return hostClient
            .openBrowserTab(
              { identity: profile.identity },
              {
                url: parsed.url,
                ...(viewport ? { viewport } : {}),
                idempotencyKey: mutationIdempotencyKey("open-in"),
              },
            )
            .then((opened) => {
              hostClient.recentSites.record(profile.identity, parsed.url, epoch);
              show({ kind: "browser", sessionId: opened.sessionId, tabId: opened.tabId });
              toast.success(`Opened in ${profile.presentation.name} · the original stays`);
            });
        })
        .catch((error: unknown) => toast.error(actionErrorMessage(error)));
    },
    [hostClient, nav, phone, toast],
  );
}

/** Every identity a page can be copied into, except the one it already uses. */
export function useOpenInChoices(
  hostClient: HostClient,
  presentation: BrowserPresentation | null,
): readonly StartPageProfileChoice[] {
  const snapshot = useHostSelector(hostClient, selectProfiles, sameProfiles);
  return useMemo(() => {
    const identity = presentation?.identity ?? null;
    return startPageIndex({ snapshot, places: [] }).profiles.filter(
      (profile) => !identity || !sameIdentity(profile.identity, identity),
    );
  }, [presentation, snapshot]);
}

/**
 * "Open this page in… ▸": a row whose submenu flies out beside it on a
 * press, a hover or →, and goes with ← or Esc.
 */
export function OpenInRow({
  disabled,
  hostClient,
  onDone,
  place,
  presentation,
}: {
  readonly disabled: boolean;
  readonly hostClient: HostClient;
  /** The whole menu closes once a choice is made. */
  readonly onDone: () => void;
  readonly place: PlaceItem;
  readonly presentation: BrowserPresentation | null;
}) {
  const choices = useOpenInChoices(hostClient, presentation);
  const openIn = useOpenPageIn(hostClient);
  return (
    <SurfaceSubmenuRow
      disabled={disabled || choices.length === 0}
      icon="external-link"
      label="Open this page in…"
      menuLabel="Open this page in"
    >
      <div className="picker__section">
        {choices.map((profile) => (
          <button
            className="picker__row"
            key={profile.identity.kind === "guest" ? "guest" : profile.identity.profileId}
            onClick={() => {
              onDone();
              openIn(place, profile);
            }}
            role="menuitem"
            type="button"
          >
            <ProfileAvatar identity={profile.presentation} size={18} />
            <span className="picker__label-stack">
              <span className="picker__label" title={profile.presentation.name}>
                {profile.presentation.name}
              </span>
              <span className="picker__detail">
                {profile.identity.kind === "guest"
                  ? "Without saved sign-ins"
                  : profile.computerLabel}
              </span>
            </span>
          </button>
        ))}
      </div>
    </SurfaceSubmenuRow>
  );
}
