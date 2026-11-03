import { useEffect, useState } from "react";
import {
  requestNotificationPermission,
  resolveNotificationAvailability,
  type NotificationAvailability,
} from "../../../desktop/notifications.js";
import { actionErrorMessage } from "../../../ui-utils.js";
import { useShell } from "../../app-shell.js";
import { settingsPlace, settingsWhatThisIs, settingsWhereItRuns } from "../copy.js";
import { useHomeComputer } from "./devices.js";
import { SectionHeader, SettingsRow, StatusChip, type SettingsView } from "../primitives.js";

/**
 * This Opensteer: what it is called, where it runs, and — for a Personal
 * Opensteer on this computer — whether your Account lists it.
 *
 * The page is headed by the same name the Settings corner shows, so the chip
 * and the page it opens read as one thing. Remote access has its own place in
 * Settings and is not repeated here, and a setting that lives on another
 * computer is named there rather than drawn as a control that cannot work.
 */
export function GeneralSection({ view }: { readonly view: SettingsView }) {
  const { snapshot } = useShell();
  const home = useHomeComputer();
  const place = settingsPlace({
    facts: view.facts,
    homeIcon: home.name ? home.icon : null,
    kind: view.kind,
    publicOrigin: snapshot.identityConfig?.publicOrigin,
  });
  return (
    <>
      <SectionHeader
        lead="This Opensteer holds your agents, workspaces and conversations."
        title={view.name}
      />
      <div className="card">
        <SettingsRow
          action={<StatusChip info={view.statusInfo} />}
          detail={settingsWhatThisIs({ facts: view.facts, kind: view.kind, name: view.name })}
          icon={place.icon}
          title={settingsWhereItRuns({
            facts: view.facts,
            kind: view.kind,
            name: view.name,
            publicOrigin: snapshot.identityConfig?.publicOrigin,
          })}
        />
        <AccountListingRow view={view} />
        <NotificationsRow />
        <SearchSuggestionsRow />
      </div>
    </>
  );
}

/* ------------------------------------------------------------------------- *
 * Notifications
 * ------------------------------------------------------------------------- */

const notificationsPurpose =
  "Get a notification when Opensteer replies, needs your approval, or can't finish something.";

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
        detail={`Opensteer could not find out whether this app can notify you: ${failure}`}
        icon="activity"
        title="Notifications"
      />
    );
  }
  // Nothing is claimed while the answer is outstanding.
  if (availability === null) return null;
  if (availability === "desktop") {
    return (
      <SettingsRow
        detail={`${notificationsPurpose} Turn them off for Opensteer in your system settings.`}
        icon="activity"
        title={
          <>
            Notifications
            <span className="chip chip--accent">On</span>
          </>
        }
      />
    );
  }
  if (availability === "unsupported") {
    return (
      <SettingsRow
        detail="This app can't show notifications here. Replies still wait, unread, in their conversations."
        icon="activity"
        title={
          <>
            Notifications
            <span className="chip">Unavailable</span>
          </>
        }
      />
    );
  }
  return (
    <SettingsRow
      action={
        availability === "prompt" ? (
          <button
            className="btn btn--small"
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
      detail={
        availability === "granted"
          ? "While Opensteer is open in this browser, you get a notification when it replies, needs your approval, or can't finish something, unless you are already reading that conversation."
          : availability === "denied"
            ? "This browser is blocking notifications for Opensteer. Allow them in your browser's site settings to turn them back on."
            : notificationsPurpose
      }
      icon="activity"
      title={
        <>
          Notifications
          <span className={availability === "granted" ? "chip chip--accent" : "chip"}>
            {availability === "granted" ? "On" : availability === "denied" ? "Blocked" : "Off"}
          </span>
        </>
      }
    />
  );
}

/* ------------------------------------------------------------------------- *
 * In your Account
 * ------------------------------------------------------------------------- */

/**
 * Being listed in an Account is a property of this Deployment, not a button
 * with a verb — so the row names the property, chips the state, and offers
 * only the moves the access machine currently accepts.
 *
 * Every mutation here only *starts* work. The buttons used to report success
 * the moment the IPC call resolved, milliseconds into an operation that could
 * still open a browser sign-in and fail; they now wait for the access
 * snapshot's operation slot to empty and report what actually happened,
 * including the state that is neither success nor failure.
 */
function AccountListingRow({ view }: { readonly view: SettingsView }) {
  const { desktopBridge, deploymentAccess, snapshot } = useShell();
  if (
    (desktopBridge && deploymentAccess?.account.available === false) ||
    (!desktopBridge && !snapshot.identityConfig?.portalOrigin)
  )
    return null;
  return view.kind === "personal" ? (
    <SettingsRow
      icon="user"
      title="Opensteer Account"
      detail="View and change the linked Account in Devices, from any signed-in device."
    />
  ) : null;
}

function SearchSuggestionsRow() {
  const { hostClient, snapshot } = useShell();
  const [enabled, setEnabled] = useState(hostClient.browserPreferences.showSearchSuggestions);
  if (!snapshot.searchSuggestionsAvailable) return null;
  return (
    <SettingsRow
      icon="search"
      title="Show search suggestions"
      detail="Suggest searches as you type. Sends search words to Google. Saved for you on this device."
      action={
        <button
          aria-label="Show search suggestions"
          aria-checked={enabled}
          role="switch"
          className="btn btn--small"
          type="button"
          onClick={() => {
            hostClient.browserPreferences.showSearchSuggestions = !enabled;
            setEnabled(!enabled);
          }}
        >
          {enabled ? "On" : "Off"}
        </button>
      }
    />
  );
}
