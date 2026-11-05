import { useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  passwordsSettingsState,
  passwordsSuggestionAction,
  passwordsSuggestionDone,
  passwordsSuggestionElsewhere,
  passwordsSuggestionKey,
  passwordsSuggestionLead,
  passwordsSuggestionName,
} from "@opensteer/client/host";
import type { OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { actionErrorMessage } from "../ui-utils.js";
import { useShell } from "./app-shell.js";
import { Icon } from "./icon.js";
import { useHomeComputer } from "./settings/sections/devices.js";
import { useDesktopPasswordsStatus } from "./use-desktop-passwords-status.js";
import { browserNoticeDismissals } from "./usage-notice.js";

/**
 * The quiet offer of Opensteer Passwords after a sign-in found it not set up.
 * Setup needs the Mac itself, so only the desktop app on that Mac has a button;
 * everywhere else names the Mac. Nothing here reaches the agent.
 */
export function PasswordsSuggestion({
  site,
  card = false,
}: {
  readonly site: string;
  readonly card?: boolean;
}) {
  const { desktopBridge, desktopDeployment, snapshot } = useShell();
  const home = useHomeComputer();
  const store = browserNoticeDismissals("opensteer.usage-notices.dismissed");
  const dismissed = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { deploymentId } = snapshot;
  const userId = snapshot.user?.id;
  if (!deploymentId || !userId || dismissed === null) return null;
  const key = passwordsSuggestionKey(deploymentId, userId);
  if (dismissed.has(key)) return null;
  const onDismiss = () => store.dismiss(key);
  return desktopBridge !== null &&
    desktopDeployment?.kind === "personal" &&
    desktopDeployment.onThisComputer ? (
    <OnThisMac card={card} bridge={desktopBridge} onDismiss={onDismiss} site={site} />
  ) : (
    <SuggestionLine onDismiss={onDismiss}>
      <strong>{passwordsSuggestionName}</strong>{" "}
      {card ? "lets agents fill saved cards at checkout." : passwordsSuggestionLead}{" "}
      {card
        ? `Open Passwords on ${home.name ?? "your Mac"} and add a card`
        : passwordsSuggestionElsewhere(home.name)}
    </SuggestionLine>
  );
}

function OnThisMac({
  card,
  bridge,
  onDismiss,
  site,
}: {
  readonly card: boolean;
  readonly bridge: Pick<
    OpensteerDesktopBridge,
    "onPasswordsStatusChanged" | "passwordsOpen" | "passwordsStatus"
  >;
  readonly onDismiss: () => void;
  readonly site: string;
}) {
  const { status } = useDesktopPasswordsStatus(bridge);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The agent's word can be old by the time this draws: the line says "set up"
  // only after this Mac said it wasn't, here, on this screen.
  const offered = useRef(false);
  const state = status === null ? null : passwordsSettingsState(status).kind;
  if (state === "not-set-up" || (card && state === "ready")) {
    offered.current = true;
    return (
      <SuggestionLine
        action={
          <button
            className="btn btn--small btn--primary"
            disabled={opening}
            onClick={() => {
              setOpening(true);
              setError(null);
              bridge
                .passwordsOpen()
                .catch((reason: unknown) => setError(actionErrorMessage(reason)))
                .finally(() => setOpening(false));
            }}
            type="button"
          >
            {card ? "Open Passwords" : passwordsSuggestionAction}
          </button>
        }
        onDismiss={onDismiss}
      >
        {error ?? (
          <>
            <strong>{passwordsSuggestionName}</strong>{" "}
            {card
              ? "Add a card and enable agent use, then ask the agent again."
              : passwordsSuggestionLead}
          </>
        )}
      </SuggestionLine>
    );
  }
  if (state !== "ready" || !offered.current) return null;
  return (
    <SuggestionLine done onDismiss={onDismiss}>
      {passwordsSuggestionDone(site)}
    </SuggestionLine>
  );
}

function SuggestionLine({
  action,
  children,
  done = false,
  onDismiss,
}: {
  readonly action?: ReactNode;
  readonly children: ReactNode;
  readonly done?: boolean;
  readonly onDismiss: () => void;
}) {
  return (
    <div className="transcript__row">
      <div
        className={`passwords-suggestion${done ? " passwords-suggestion--done" : ""}`}
        role="status"
      >
        <Icon name={done ? "check" : "key"} />
        <span className="passwords-suggestion__text">
          <span>{children}</span>
        </span>
        {action}
        <button
          aria-label="Dismiss"
          className="usage-notice__dismiss"
          onClick={onDismiss}
          title="Dismiss"
          type="button"
        >
          <Icon name="close" />
        </button>
      </div>
    </div>
  );
}
