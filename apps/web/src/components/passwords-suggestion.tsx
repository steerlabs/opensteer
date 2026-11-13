import { useState, useSyncExternalStore, type ReactNode } from "react";
import {
  passwordsOfferLine,
  passwordsOfferNeedHere,
  passwordsOpenAction,
  passwordsSettingsState,
  passwordsSuggestionAction,
  passwordsSuggestionKey,
  type PasswordsOfferLine,
  type PasswordsSetupOffer,
} from "@opensteer/client/host";
import type { OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { actionErrorMessage } from "../ui-utils.js";
import { useShell } from "./app-shell.js";
import { Icon } from "./icon.js";
import { useHomeComputer } from "./devices/use-home-computer.js";
import { useDesktopPasswordsStatus } from "./use-desktop-passwords-status.js";
import { browserNoticeDismissals } from "./usage-notice.js";

/**
 * The quiet offer of Opensteer Passwords after a sign-in found it lacking.
 * Passwords lives on the Mac, so only the desktop app there has a button;
 * everywhere else names the Mac. The Host wakes the agent once the login
 * exists, so nothing here asks the person to go back and tell it.
 */
export function PasswordsSuggestion({ offer }: { readonly offer: PasswordsSetupOffer }) {
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
  return desktopBridge !== null && desktopDeployment?.onThisComputer ? (
    <OnThisMac bridge={desktopBridge} offer={offer} onDismiss={onDismiss} />
  ) : (
    <SuggestionLine onDismiss={onDismiss}>
      <Words
        line={passwordsOfferLine({
          card: offer.credential === "card",
          computer: home.name ?? "your Mac",
          need: offer.need,
          site: offer.site,
        })}
      />
    </SuggestionLine>
  );
}

function OnThisMac({
  bridge,
  offer,
  onDismiss,
}: {
  readonly bridge: Pick<
    OpensteerDesktopBridge,
    "onPasswordsStatusChanged" | "passwordsOpen" | "passwordsStatus"
  >;
  readonly offer: PasswordsSetupOffer;
  readonly onDismiss: () => void;
}) {
  const { status } = useDesktopPasswordsStatus(bridge);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settings = status === null ? null : passwordsSettingsState(status);
  // The agent's word can be old by the time this draws; this Mac's is current.
  const need = passwordsOfferNeedHere(
    settings?.kind ?? null,
    settings?.kind === "ready" ? settings.agentSignIns : null,
  );
  if (need === null) return null;
  const card = offer.credential === "card";
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
          {need === "not-set-up" && !card ? passwordsSuggestionAction : passwordsOpenAction}
        </button>
      }
      onDismiss={onDismiss}
    >
      {error ?? (
        <Words line={passwordsOfferLine({ card, computer: null, need, site: offer.site })} />
      )}
    </SuggestionLine>
  );
}

function Words({ line }: { readonly line: PasswordsOfferLine }) {
  return (
    <>
      {line.before}
      <strong>{line.name}</strong>
      {line.after}
    </>
  );
}

function SuggestionLine({
  action,
  children,
  onDismiss,
}: {
  readonly action?: ReactNode;
  readonly children: ReactNode;
  readonly onDismiss: () => void;
}) {
  return (
    <div className="transcript__row">
      <div className="passwords-suggestion" role="status">
        <Icon name="key" />
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
