import { useEffect, useState } from "react";
import type { DeploymentAccessSnapshot } from "@opensteer/protocol/desktop";
import {
  requestNotificationPermission,
  resolveNotificationAvailability,
  type NotificationAvailability,
} from "../../../desktop/notifications.js";
import { actionErrorMessage } from "../../../ui-utils.js";
import {
  supportsPersonalAccountLink,
  usePersonalAccountLink,
  type PersonalAccountLinkController,
  type PersonalAccountLinkOperation,
} from "../../../account/use-personal-account-link.js";
import { useShell } from "../../app-shell.js";
import { deploymentMutationsBlockedReason } from "../../deployment-operation.js";
import { useToast } from "../../toast.js";
import { settingsPlace, settingsWhatThisIs, settingsWhereItRuns } from "../copy.js";
import { useHomeComputer } from "./devices.js";
import {
  SectionHeader,
  SettingsError,
  SettingsRow,
  StatusChip,
  type SettingsView,
} from "../primitives.js";

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
  const cloud = snapshot.identityConfig?.deployment.cloud === true;
  const home = useHomeComputer();
  const place = settingsPlace({
    cloud,
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
            cloud,
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
  const { deploymentAccess, desktopBridge } = useShell();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const supported = desktopBridge !== null && supportsPersonalAccountLink(desktopBridge);
  const controller = usePersonalAccountLink(supported ? desktopBridge : null, deploymentAccess);
  const personalLink = view.facts.onThisComputer
    ? (deploymentAccess?.personalAccountLink ?? null)
    : null;
  const blockedReason = deploymentMutationsBlockedReason(deploymentAccess);
  if (desktopBridge && deploymentAccess?.account.available === false) return null;
  if (!personalLink || !supported) {
    // A server's Account listing is its operator's business, not a reader's.
    return view.kind === "personal" ? (
      <SettingsRow
        detail={`Whether your account lists it is set in Opensteer on ${view.name}.`}
        icon="user"
        title="Your account"
      />
    ) : null;
  }
  const status = personalLink.status;

  function run(operation: PersonalAccountLinkOperation) {
    if (controller.pending !== null) return;
    setError(null);
    setNotice(null);
    const request =
      operation === "link"
        ? controller.link()
        : operation === "unlink"
          ? controller.unlink()
          : controller.repair();
    void request
      .then((outcome) => {
        if (outcome.succeeded) {
          toast.success(outcome.message);
          return;
        }
        // Not a failure and not a success: it stays on the page, next to the
        // button that finishes it.
        setNotice(outcome.message);
      })
      .catch((reason: unknown) => setError(actionErrorMessage(reason)));
  }

  return (
    <>
      <SettingsRow
        action={accountListingActions({
          blocked: blockedReason !== null,
          controller,
          onAct: run,
          status,
        })}
        detail={
          <>
            {accountListingDetail(status)}
            {blockedReason ? <span className="card__row-reason">{blockedReason}</span> : null}
          </>
        }
        icon="user"
        title={
          <>
            Your account
            <span className={accountListingChip(status)}>{accountListingLabel(status)}</span>
          </>
        }
      />
      {notice ? (
        <p aria-live="polite" className="settings-footnote" role="status">
          {notice}
        </p>
      ) : null}
      <SettingsError message={error} />
    </>
  );
}

type AccountLinkStatus = DeploymentAccessSnapshot["personalAccountLink"]["status"];

function accountListingActions({
  blocked,
  controller,
  onAct,
  status,
}: {
  readonly blocked: boolean;
  readonly controller: PersonalAccountLinkController;
  readonly onAct: (operation: PersonalAccountLinkOperation) => void;
  readonly status: AccountLinkStatus;
}) {
  const disabled = blocked || controller.pending !== null;
  const button = (
    operation: PersonalAccountLinkOperation,
    label: string,
    workingLabel: string,
    danger = false,
  ) => (
    <button
      className={danger ? "btn btn--danger btn--small" : "btn btn--small"}
      disabled={disabled}
      key={operation}
      onClick={() => onAct(operation)}
      type="button"
    >
      {controller.pending === operation ? workingLabel : label}
    </button>
  );

  if (status === "needs-repair") {
    return controller.canRepair ? button("repair", "Repair", "Repairing…") : undefined;
  }
  if (status === "activating") {
    return (
      <>
        {controller.canLink ? button("link", "Finish adding", "Finishing…") : null}
        {controller.canUnlink ? button("unlink", "Cancel", "Cancelling…", true) : null}
      </>
    );
  }
  if (controller.canUnlink) return button("unlink", "Remove from Account", "Removing…", true);
  if (controller.canLink) return button("link", "Add to your Account", "Adding…");
  return undefined;
}

function accountListingLabel(status: AccountLinkStatus): string {
  if (status === "linked") return "In your account";
  if (status === "activating") return "Adding…";
  if (status === "unlinking") return "Removing…";
  if (status === "linked-elsewhere") return "Different account";
  if (status === "needs-repair") return "Needs repair";
  if (status === "unavailable") return "Unavailable";
  return "Not in your account";
}

function accountListingChip(status: AccountLinkStatus): string {
  if (status === "linked") return "chip chip--accent";
  if (status === "linked-elsewhere" || status === "needs-repair") return "chip chip--bad";
  if (status === "activating" || status === "unlinking") return "chip chip--warn";
  return "chip";
}

function accountListingDetail(status: AccountLinkStatus): string {
  if (status === "linked-elsewhere") {
    return "This computer is in a different account than the one signed in to this app. Remove it there before adding it here.";
  }
  if (status === "needs-repair") {
    return "This computer’s records and your account’s records disagree. Opensteer has stopped further changes so neither is overwritten.";
  }
  if (status === "unlinking") {
    return "Removing this computer from your account. Its data stays here.";
  }
  if (status === "activating") {
    return "This computer saved the change and is waiting for your account to finish. Finish it or cancel safely.";
  }
  if (status === "unavailable") {
    return "Adding this computer to an account isn’t available.";
  }
  if (status === "linked") {
    return "Shows in your list on every device you sign in on. Files and agents stay on this computer.";
  }
  return "Adding this computer to your account lets you open it from your other devices and use Opensteer-hosted integrations. Workspaces, files, conversations, agents and integration tokens stay on this computer.";
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
