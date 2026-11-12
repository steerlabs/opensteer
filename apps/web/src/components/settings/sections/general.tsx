import { resolveDesktopAppBranding } from "@opensteer/protocol/desktop";
import { useDesktopUpdate } from "../../../desktop/update-store.js";
import { Dialog } from "../../dialog.js";
import { useDesktopPlaces } from "../../../desktop/places-context.js";
import { PlaceMenuPlaces } from "../../places/place-menu.js";
import { DesktopUpdatesRow } from "./desktop-updates.js";
import { RemoteDesktopUpdateSection } from "./remote-desktop-update.js";
import { useEffect, useState } from "react";
import { QuietTaskDaysSchema, type QuietTaskDays } from "@opensteer/core";
import {
  requestNotificationPermission,
  resolveNotificationAvailability,
  type NotificationAvailability,
} from "../../../desktop/notifications.js";
import { actionErrorMessage } from "../../../ui-utils.js";
import { useShell } from "../../app-shell.js";
import { settingsPlaceDetail } from "../copy.js";
import { desktopBridge } from "../../../desktop/desktop-bridge.js";
import {
  SectionHeader,
  SettingsError,
  SettingsGroup,
  SettingsRow,
  SettingsSegmented,
  SettingsSwitch,
  StatusText,
  type SettingsView,
} from "../primitives.js";

export function GeneralSection({ view }: { readonly view: SettingsView }) {
  const places = useDesktopPlaces();
  const update = useDesktopUpdate();
  const [switching, setSwitching] = useState(false);
  const { snapshot } = useShell();
  const placeDetail = settingsPlaceDetail({
    facts: view.facts,
    kind: view.kind,
    publicOrigin: snapshot.identityConfig?.publicOrigin,
  });
  return (
    <>
      <SectionHeader title="General" />
      <SettingsGroup heading={null} headingId="settings-general-place">
        <SettingsRow
          action={
            places ? (
              <button className="btn" type="button" onClick={() => setSwitching(true)}>
                Switch…
              </button>
            ) : undefined
          }
          detail={
            view.statusInfo.status === "ready" ? (
              view.deployment?.onThisComputer ? (
                "Running here"
              ) : (
                placeDetail
              )
            ) : (
              <StatusText info={view.statusInfo} />
            )
          }
          title={view.name}
        />
      </SettingsGroup>
      <SettingsGroup heading="Behavior" headingId="settings-general-behavior">
        <QuietTasksRow />
        <SearchSuggestionsRow />
        <NotificationsRow />
      </SettingsGroup>
      <UpdatesGroup view={view} />
      <SettingsGroup heading="About" headingId="settings-general-about">
        <SettingsRow
          title={
            update
              ? `${resolveDesktopAppBranding(update.currentVersion).displayName} ${update.currentVersion}`
              : "Opensteer"
          }
          action={
            <a
              className="btn"
              href="https://github.com/steerlabs/opensteer"
              target="_blank"
              rel="noreferrer"
            >
              Website
            </a>
          }
        />
      </SettingsGroup>
      {switching && places ? (
        <Dialog
          labelledBy="switch-opensteer"
          title="Switch Opensteer"
          onClose={() => setSwitching(false)}
        >
          <PlaceMenuPlaces places={places} onClose={() => setSwitching(false)} />
        </Dialog>
      ) : null}
    </>
  );
}

/** This app's own updates on Desktop, or the hosting computer's when opened remotely. */
function UpdatesGroup({ view }: { readonly view: SettingsView }) {
  const local = useDesktopUpdate();
  const showsLocal = desktopBridge()?.updates?.setChannel !== undefined && local !== null;
  return (
    <>
      {showsLocal ? (
        <SettingsGroup heading="Updates" headingId="settings-general-updates">
          <DesktopUpdatesRow />
        </SettingsGroup>
      ) : null}
      <RemoteDesktopUpdateSection view={view} />
    </>
  );
}

/* ------------------------------------------------------------------------- *
 * Notifications
 * ------------------------------------------------------------------------- */

/**
 * The browser's notification permission, asked for here and nowhere else.
 *
 * A permission prompt that appears on its own, in the middle of reading, is
 * the thing people click Block on — so it is behind a button whose only job is
 * to raise it. Whether the desktop can notify at all is the main process's
 * answer, so the row waits for it rather than assuming either way.
 */
function NotificationsRow() {
  const [availability, setAvailability] = useState<NotificationAvailability | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    let live = true;
    void resolveNotificationAvailability().then(
      (resolved) => {
        if (live) setAvailability(resolved);
      },
      (reason: unknown) => {
        if (live) setFailure(actionErrorMessage(reason));
      },
    );
    return () => {
      live = false;
    };
  }, []);
  if (failure !== null) {
    return (
      <SettingsRow
        detail={`Couldn’t check whether this app can notify you: ${failure}`}
        title="Notifications"
      />
    );
  }
  // Nothing is claimed while the answer is outstanding.
  if (availability === null) return null;
  const detail = {
    denied: "Blocked. Allow them in your browser’s site settings.",
    desktop: "Managed in System Settings",
    granted: "On",
    prompt: "Replies and requests for you",
    unsupported: "Not available here",
  }[availability];
  return (
    <SettingsRow
      action={
        availability === "prompt" ? (
          <button
            className="btn"
            disabled={asking}
            onClick={() => {
              setAsking(true);
              void requestNotificationPermission()
                .then(setAvailability, (reason: unknown) => setFailure(actionErrorMessage(reason)))
                .finally(() => setAsking(false));
            }}
            type="button"
          >
            {asking ? "Asking…" : "Turn on"}
          </button>
        ) : undefined
      }
      detail={detail}
      title="Notifications"
    />
  );
}

function SearchSuggestionsRow() {
  const { hostClient, snapshot } = useShell();
  const [enabled, setEnabled] = useState(hostClient.browserPreferences.showSearchSuggestions);
  if (!snapshot.searchSuggestionsAvailable) return null;
  return (
    <SettingsRow
      title="Search suggestions"
      detail="Uses Google"
      action={
        <SettingsSwitch
          label="Show search suggestions"
          checked={enabled}
          onChange={(next) => {
            hostClient.browserPreferences.showSearchSuggestions = next;
            setEnabled(next);
          }}
        />
      }
    />
  );
}

const quietTaskChoices = [
  { value: "0", label: "Off" },
  { value: "1", label: "1 day" },
  { value: "3", label: "3 days" },
  { value: "7", label: "1 week" },
] as const;

/** When the Host moves this person's untouched tasks to Done, for every device they use. */
function QuietTasksRow() {
  const { hostClient, snapshot } = useShell();
  const [pending, setPending] = useState<QuietTaskDays | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!snapshot.quietTasksAvailable || snapshot.quietTaskDays === null) return null;
  const choose = (value: string) => {
    const days = QuietTaskDaysSchema.parse(Number(value));
    setPending(days);
    setError(null);
    void hostClient
      .setQuietTaskDays(days)
      .catch((cause: unknown) => setError(actionErrorMessage(cause)))
      .finally(() => setPending(null));
  };
  return (
    <>
      <SettingsRow
        action={
          <SettingsSegmented
            label="Move quiet tasks to Done"
            onChange={choose}
            options={quietTaskChoices}
            value={String(pending ?? snapshot.quietTaskDays)}
          />
        }
        className="card__row--choice"
        detail="Finished tasks you’ve read, with nothing waiting on you"
        title="Move quiet tasks to Done"
      />
      <SettingsError message={error} />
    </>
  );
}
