import { useCallback, useMemo } from "react";
import {
  newTabTarget,
  pageOpenTarget,
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
import { DeviceLabel } from "../computers/device-label.js";
import { useHereId } from "../computers/here.js";
import { SurfaceSubmenuRow } from "../surface-submenu-row.js";
import { useToast } from "../toast.js";
import { ProfileAvatar, type BrowserPresentation } from "./identity.js";
import { useWorkspace } from "./workspace-context.js";

const selectProfiles = (snapshot: HostSnapshot) => snapshot;
function sameProfiles(left: HostSnapshot, right: HostSnapshot): boolean {
  return (
    left.browserProfiles === right.browserProfiles &&
    left.browserPlacements === right.browserPlacements &&
    left.connection === right.connection &&
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
  const { nav } = useWorkspace();
  const hereId = useHereId();
  const toast = useToast();
  return useCallback(
    (place: PlaceItem, profile: StartPageProfileChoice) => {
      // Only a full web address the page has now is copied.
      const parsed = /^https?:\/\//iu.test(place.tab.url ?? "")
        ? parseNavigationInput(place.tab.url!)
        : null;
      if (parsed?.kind !== "url") {
        toast.error("This page’s address can’t be opened in another profile.");
        return;
      }
      const show = nav.beginPlaceOperation();
      void hostClient
        .openTab(
          pageOpenTarget(newTabTarget(hostClient.getSnapshot(), profile.identity, hereId), parsed.url),
        )
        .then((tab) => {
          show({ kind: "tab", tabId: tab.tabId });
          toast.success(`Opened in ${profile.presentation.name} · the original stays`);
        })
        .catch((error: unknown) => toast.error(actionErrorMessage(error)));
    },
    [hereId, hostClient, nav, toast],
  );
}

/** Every identity a page can be copied into, except the one it already uses. */
export function useOpenInChoices(
  hostClient: HostClient,
  presentation: BrowserPresentation | null,
): readonly StartPageProfileChoice[] {
  const snapshot = useHostSelector(hostClient, selectProfiles, sameProfiles);
  const hereId = useHereId();
  return useMemo(() => {
    const identity = presentation?.identity ?? null;
    return startPageIndex({ snapshot, places: [], localMachineId: hereId }).profiles.filter(
      (profile) => !identity || !sameIdentity(profile.identity, identity),
    );
  }, [hereId, presentation, snapshot]);
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
            <span className="picker__label" title={profile.presentation.name}>
              {profile.presentation.name}
            </span>
            {profile.device ? (
              <DeviceLabel className="picker__device" device={profile.device} />
            ) : null}
          </button>
        ))}
      </div>
    </SurfaceSubmenuRow>
  );
}
